import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { IdentityInfrastructure } from '../identity/identity-infrastructure';
import { canonicalizeOptionSignature, CategoryAttributeRule } from './category-attribute-validator';
import { NormalizedProductCreate, ProductMutationContext, validateProductAttributes, validateVariantAttributes } from './product-draft.service';
import { CreateProductVariantDto, DeactivateProductVariantDto, UpdateProductDraftDto, UpdateProductVariantDto } from './product-draft.dto';

interface ProductRow { id: string; brand_id: string; category_id: string; style_code: string; title: string; description: string; category_schema_version: number; content_version: number; row_version: string; publication_state: string; qc_state: string; }
interface VariantRow { id: string; brand_id: string; product_id: string; sku: string; options: Record<string, string>; option_signature: string; weight_g: number | null; gtin: string | null; variant_state: string; row_version: string; sku_locked_at: string | null; category_id: string; category_schema_version: number; product_row_version: string; publication_state: string; }

@Injectable()
export class ProductDraftPostgresRepository {
  constructor(private readonly infrastructure: IdentityInfrastructure) {}

  async create(input: NormalizedProductCreate, context: ProductMutationContext): Promise<Record<string, unknown>> {
    return this.transaction((client) => this.createInTransaction(input, context, client));
  }

  async createInTransaction(input: NormalizedProductCreate, context: ProductMutationContext, client: PoolClient): Promise<Record<string, unknown>> {
      await this.authorize(client, context);
      const requestHash = hash({ input, sourceKind: context.sourceKind ?? 'MANUAL', sourceReference: context.sourceReference ?? null });
      const replay = await this.replay(client, context, 'createBrandProduct', requestHash);
      if (replay) return replay;
      const category = await this.category(client, context, input.categoryCode, input.categorySchemaVersion);
      const attributes = validateProductAttributes(category.id, category.schema_version_id, category.version,
        category.validator_version, category.rules, input.attributes);
      const inserted = await client.query<ProductRow>(
        `INSERT INTO catalogue.products(brand_id,category_id,style_code,title,description,category_schema_version,publication_state,qc_state)
         SELECT $1,$2,$3,$4,$5,$6,'DRAFT','NOT_SUBMITTED'
          WHERE EXISTS (SELECT 1 FROM brands.brands b JOIN access.effective_permissions ep ON ep.user_id=$7 AND ep.permission_code='catalog.write'
            AND ((ep.scope_type='global' AND ep.brand_id IS NULL) OR (ep.scope_type='brand' AND ep.brand_id=b.id))
            WHERE b.id=$1 AND b.onboarding_state='approved')
         RETURNING id,brand_id,category_id,style_code,title,description,category_schema_version,content_version,row_version,publication_state,qc_state`,
        [context.brandId, category.id, input.styleCode, input.title, input.description, input.categorySchemaVersion, context.userId]);
      const product = inserted.rows[0];
      if (!product) throw failure('PRODUCT_ACCESS_DENIED');
      await this.saveAttributes(client, context.brandId, product, category, attributes);
      const variantIds: string[] = [];
      for (const candidate of input.variants) {
        if (Object.keys(candidate).some((key) => !['sku', 'options', 'weightG'].includes(key))
          || typeof candidate.sku !== 'string' || !/^[A-Za-z0-9_.-]{1,40}$/.test(candidate.sku)
          || !candidate.options || typeof candidate.options !== 'object' || Array.isArray(candidate.options)
          || !Object.values(candidate.options as Record<string, unknown>).every((value) => typeof value === 'string')
          || (candidate.weightG !== undefined && (!Number.isSafeInteger(candidate.weightG) || Number(candidate.weightG) < 0))) throw failure('PRODUCT_DRAFT_INVALID');
        const optionSignature = canonicalizeOptionSignature(candidate.options as Record<string, unknown>);
        const variant = await client.query<{ id: string }>(
          `INSERT INTO catalogue.product_variants(brand_id,product_id,sku,option_signature,options,weight_g)
           VALUES($1,$2,$3,$4,$5::jsonb,$6) RETURNING id`,
          [context.brandId, product.id, candidate.sku.normalize('NFC').trim(), optionSignature, JSON.stringify(candidate.options), candidate.weightG ?? null]);
        variantIds.push(variant.rows[0].id);
        const variantValues = candidate.options as Record<string, unknown>;
        const variantAttributes = validateVariantAttributes(category.id, category.schema_version_id, category.version,
          category.validator_version, category.rules, variantValues);
        await this.saveVariantAttributes(client, context.brandId, product, variant.rows[0].id, category, variantAttributes);
        await this.lineage(client, context, product.id, [
          `variants.${variant.rows[0].id}.sku`, `variants.${variant.rows[0].id}.options`,
          ...(candidate.weightG === undefined ? [] : [`variants.${variant.rows[0].id}.weightG`]),
        ]);
      }
      await this.lineage(client, context, product.id, ['styleCode', 'title', 'description', 'categoryCode', 'categorySchemaVersion', ...Object.keys(attributes).map((key) => `attributes.${key}`)]);
      const response = { productId: product.id, publicationState: 'DRAFT', contentVersion: 1, rowVersion: 1,
        variantIds, qcState: 'NOT_SUBMITTED', categorySchemaVersion: input.categorySchemaVersion };
      await this.receipt(client, context, 'createBrandProduct', requestHash, product.id, response);
      return response;
  }

  async update(productId: string, patch: UpdateProductDraftDto, expectedRowVersion: number, context: ProductMutationContext): Promise<Record<string, unknown>> {
    return this.transaction((client) => this.updateInTransaction(productId, patch, expectedRowVersion, context, client));
  }

  async updateInTransaction(productId: string, patch: UpdateProductDraftDto, expectedRowVersion: number,
    context: ProductMutationContext, client: PoolClient): Promise<Record<string, unknown>> {
      await this.authorize(client, context);
      const requestHash = hash({ productId, expectedRowVersion, patch, sourceKind: context.sourceKind ?? 'MANUAL', sourceReference: context.sourceReference ?? null });
      const replay = await this.replay(client, context, 'updateBrandProduct', requestHash);
      if (replay) return replay;
      const beforeResult = await client.query<ProductRow>(
        `SELECT p.id,p.brand_id,p.category_id,p.style_code,p.title,p.description,p.category_schema_version,p.content_version,p.row_version,p.publication_state,p.qc_state
           FROM catalogue.products p WHERE p.id=$1 AND p.brand_id=$2 FOR UPDATE`, [productId, context.brandId]);
      const before = beforeResult.rows[0];
      if (!before) throw failure('PRODUCT_NOT_FOUND');
      if (!['DRAFT', 'INCOMPLETE', 'PENDING_REVIEW', 'APPROVED', 'RE_REVIEW', 'REJECTED'].includes(before.publication_state)) throw failure('PRODUCT_STATE_RESTRICTED');
      if (Number(before.row_version) !== expectedRowVersion) throw failure('PRODUCT_ROW_VERSION_CONFLICT');
      const existingAttributes = await this.loadAttributes(client, before);
      const mergedAttributes = { ...existingAttributes, ...(patch.attributes ?? {}) };
      const version = patch.categorySchemaVersion ?? before.category_schema_version;
      const category = await this.categoryById(client, context, before.category_id, version);
      const attributes = validateProductAttributes(category.id, category.schema_version_id, category.version,
        category.validator_version, category.rules, mergedAttributes);
      // These rows have a non-deferrable composite FK to the parent's schema pin.
      // Remove them first; the transaction restores them if the CAS or insert fails.
      await client.query('DELETE FROM catalogue.product_attribute_values WHERE brand_id=$1 AND product_id=$2', [context.brandId, productId]);
      const next = await client.query<ProductRow>(
        `UPDATE catalogue.products p
            SET title=$4, description=$5, category_schema_version=$6,
                publication_state=CASE WHEN p.publication_state IN ('PENDING_REVIEW','APPROVED','RE_REVIEW','REJECTED') THEN 'RE_REVIEW' ELSE p.publication_state END,
                qc_state=CASE WHEN p.publication_state IN ('PENDING_REVIEW','APPROVED','RE_REVIEW','REJECTED') THEN 'NOT_SUBMITTED' ELSE p.qc_state END,
                content_version=p.content_version+1, row_version=p.row_version+1, updated_at=now()
          WHERE p.id=$1 AND p.brand_id=$2 AND p.row_version=$3
            AND EXISTS (SELECT 1 FROM access.effective_permissions ep WHERE ep.user_id=$7 AND ep.permission_code='catalog.write'
              AND ((ep.scope_type='global' AND ep.brand_id IS NULL) OR (ep.scope_type='brand' AND ep.brand_id=$2)))
            AND EXISTS (SELECT 1 FROM brands.brands b WHERE b.id=$2 AND b.onboarding_state='approved')
          RETURNING p.id,p.brand_id,p.category_id,p.style_code,p.title,p.description,p.category_schema_version,p.content_version,p.row_version,p.publication_state,p.qc_state`,
        [productId, context.brandId, expectedRowVersion, patch.title ?? before.title, patch.description ?? before.description,
          version, context.userId]);
      if (!next.rows[0]) throw failure('PRODUCT_ROW_VERSION_CONFLICT');
      const updated = next.rows[0];
      await this.saveAttributes(client, context.brandId, updated, category, attributes);
      const paths = [
        ...(patch.title === undefined ? [] : ['title']), ...(patch.description === undefined ? [] : ['description']),
        ...(patch.categorySchemaVersion === undefined ? [] : ['categorySchemaVersion']),
        ...Object.keys(patch.attributes ?? {}).map((key) => `attributes.${key}`),
      ];
      await this.lineage(client, context, productId, paths);
      const variants = await client.query<{ id: string; sku: string; options: Record<string, string>; variant_state: string }>(
        'SELECT id,sku,options,variant_state FROM catalogue.product_variants WHERE brand_id=$1 AND product_id=$2 ORDER BY id', [context.brandId, productId]);
      const response = productDetail(updated, attributes, variants.rows);
      await this.receipt(client, context, 'updateBrandProduct', requestHash, productId, response);
      return response;
  }

  async createVariant(productId: string, input: CreateProductVariantDto, expectedProductVersion: number,
    context: ProductMutationContext): Promise<Record<string, unknown>> {
    return this.transaction(async (client) => {
      await this.authorize(client, context);
      const requestHash = hash({ productId, input, sourceKind: context.sourceKind ?? 'MANUAL', sourceReference: context.sourceReference ?? null });
      const replay = await this.replay(client, context, 'createProductVariant', requestHash);
      if (replay) return replay;
      const productResult = await client.query<ProductRow>(
        `SELECT p.id,p.brand_id,p.category_id,p.style_code,p.title,p.description,p.category_schema_version,p.content_version,p.row_version,p.publication_state,p.qc_state
           FROM catalogue.products p WHERE p.id=$1 AND p.brand_id=$2 FOR UPDATE`, [productId, context.brandId]);
      const product = productResult.rows[0];
      if (!product) throw failure('PRODUCT_NOT_FOUND');
      if (!['DRAFT', 'INCOMPLETE', 'PENDING_REVIEW', 'APPROVED', 'RE_REVIEW', 'REJECTED'].includes(product.publication_state)) throw failure('PRODUCT_STATE_RESTRICTED');
      if (Number(product.row_version) !== expectedProductVersion) throw failure('PRODUCT_ROW_VERSION_CONFLICT');
      const category = await this.categoryById(client, context, product.category_id, product.category_schema_version);
      const attributes = validateVariantAttributes(category.id, category.schema_version_id, category.version, category.validator_version, category.rules, input.options);
      const signature = canonicalizeOptionSignature(input.options);
      const inserted = await client.query<VariantRow>(
        `INSERT INTO catalogue.product_variants(brand_id,product_id,sku,option_signature,options,weight_g)
         SELECT $1,$2,$3,$4,$5::jsonb,$6
          WHERE EXISTS (SELECT 1 FROM access.effective_permissions ep WHERE ep.user_id=$7 AND ep.permission_code='catalog.write'
            AND ((ep.scope_type='global' AND ep.brand_id IS NULL) OR (ep.scope_type='brand' AND ep.brand_id=$1)))
            AND EXISTS (SELECT 1 FROM brands.brands b WHERE b.id=$1 AND b.onboarding_state='approved')
         RETURNING id,brand_id,product_id,sku,options,option_signature,weight_g,gtin,variant_state,row_version,sku_locked_at`,
        [context.brandId, productId, input.sku, signature, JSON.stringify(input.options), input.weightG ?? null, context.userId]);
      const variant = inserted.rows[0];
      if (!variant) throw failure('VARIANT_ACCESS_DENIED');
      await this.saveVariantAttributes(client, context.brandId, product, variant.id, category, attributes);
      const bumped = await client.query(
        `UPDATE catalogue.products p SET row_version=p.row_version+1,content_version=p.content_version+1,
             publication_state=CASE WHEN p.publication_state IN ('PENDING_REVIEW','APPROVED','RE_REVIEW','REJECTED') THEN 'RE_REVIEW' ELSE p.publication_state END,
             qc_state=CASE WHEN p.publication_state IN ('PENDING_REVIEW','APPROVED','RE_REVIEW','REJECTED') THEN 'NOT_SUBMITTED' ELSE p.qc_state END,updated_at=now()
          WHERE p.id=$1 AND p.brand_id=$2 AND p.row_version=$3
            AND EXISTS (SELECT 1 FROM access.effective_permissions ep WHERE ep.user_id=$4 AND ep.permission_code='catalog.write'
              AND ((ep.scope_type='global' AND ep.brand_id IS NULL) OR (ep.scope_type='brand' AND ep.brand_id=$2)))
            AND EXISTS (SELECT 1 FROM brands.brands b WHERE b.id=$2 AND b.onboarding_state='approved')`,
        [productId, context.brandId, expectedProductVersion, context.userId]);
      if (bumped.rowCount !== 1) throw failure('PRODUCT_ROW_VERSION_CONFLICT');
      await this.lineage(client, context, productId, [
        `variants.${variant.id}.sku`, `variants.${variant.id}.options`,
        ...(input.weightG === undefined ? [] : [`variants.${variant.id}.weightG`]),
        ...Object.keys(attributes).map((key) => `variants.${variant.id}.attributes.${key}`),
      ]);
      const response = { ...variantDetail(variant, attributes, 'created', context.requestId), parentRowVersion: expectedProductVersion + 1 };
      await this.receipt(client, context, 'createProductVariant', requestHash, productId, response);
      return response;
    });
  }

  async updateVariant(productId: string, variantId: string, patch: UpdateProductVariantDto, expectedRowVersion: number,
    context: ProductMutationContext): Promise<Record<string, unknown>> {
    return this.transaction(async (client) => {
      await this.authorize(client, context);
      const requestHash = hash({ productId, variantId, expectedRowVersion, patch, sourceKind: context.sourceKind ?? 'MANUAL', sourceReference: context.sourceReference ?? null });
      const replay = await this.replay(client, context, 'updateProductVariant', requestHash);
      if (replay) return replay;
      const found = await this.variantForUpdate(client, productId, variantId, context);
      if (!found) throw failure('VARIANT_NOT_FOUND');
      if (Number(found.product_row_version) !== expectedRowVersion) throw failure('PRODUCT_ROW_VERSION_CONFLICT');
      if (found.variant_state !== 'DRAFT') throw failure('VARIANT_STATE_RESTRICTED');
      if (found.sku_locked_at !== null && patch.options !== undefined) throw failure('VARIANT_STATE_RESTRICTED');
      const category = await this.categoryById(client, context, found.category_id, found.category_schema_version);
      const existingAttributes = await this.loadVariantAttributes(client, found.id);
      for (const key of Object.keys(found.options)) delete existingAttributes[key];
      const options = patch.options ?? found.options;
      const nextValues = { ...existingAttributes, ...options };
      const attributes = validateVariantAttributes(category.id, category.schema_version_id, category.version, category.validator_version, category.rules, nextValues);
      const signature = canonicalizeOptionSignature(options);
      const updated = await client.query<VariantRow>(
        `UPDATE catalogue.product_variants v SET options=$5::jsonb,option_signature=$6,weight_g=$7,gtin=$8,
             row_version=v.row_version+1,updated_at=now()
          WHERE v.id=$1 AND v.product_id=$2 AND v.brand_id=$3 AND v.row_version=$4 AND v.variant_state='DRAFT'
            AND EXISTS (SELECT 1 FROM access.effective_permissions ep WHERE ep.user_id=$9 AND ep.permission_code='catalog.write'
              AND ((ep.scope_type='global' AND ep.brand_id IS NULL) OR (ep.scope_type='brand' AND ep.brand_id=$3)))
            AND EXISTS (SELECT 1 FROM brands.brands b WHERE b.id=$3 AND b.onboarding_state='approved')
          RETURNING v.id,v.brand_id,v.product_id,v.sku,v.options,v.option_signature,v.weight_g,v.gtin,v.variant_state,v.row_version,v.sku_locked_at`,
        [variantId, productId, context.brandId, Number(found.row_version), JSON.stringify(options), signature,
          patch.weightG ?? found.weight_g, patch.gtin === undefined ? found.gtin : patch.gtin, context.userId]);
      if (!updated.rows[0]) throw failure('VARIANT_ROW_VERSION_CONFLICT');
      await this.saveVariantAttributes(client, context.brandId,
        { id: found.product_id, category_id: found.category_id, category_schema_version: found.category_schema_version },
        variantId, category, attributes);
      await this.bumpProductContentVersion(client, productId, context, found);
      const paths = [
        ...(patch.options === undefined ? [] : ['options']), ...(patch.weightG === undefined ? [] : ['weightG']),
        ...(patch.gtin === undefined ? [] : ['gtin']), ...(patch.reasonCode === undefined ? [] : ['reasonCode']),
      ].map((path) => `variants.${variantId}.${path}`);
      await this.lineage(client, context, productId, paths);
      const response = { ...variantDetail(updated.rows[0], attributes, 'updated', context.requestId),
        parentRowVersion: Number(found.product_row_version) + 1 };
      await this.receipt(client, context, 'updateProductVariant', requestHash, productId, response);
      return response;
    });
  }

  async deactivateVariant(productId: string, variantId: string, input: DeactivateProductVariantDto, expectedRowVersion: number,
    context: ProductMutationContext): Promise<Record<string, unknown>> {
    return this.transaction(async (client) => {
      await this.authorize(client, context);
      const requestHash = hash({ productId, variantId, expectedRowVersion, input, sourceKind: context.sourceKind ?? 'MANUAL', sourceReference: context.sourceReference ?? null });
      const replay = await this.replay(client, context, 'deactivateProductVariant', requestHash);
      if (replay) return replay;
      const found = await this.variantForUpdate(client, productId, variantId, context);
      if (!found) throw failure('VARIANT_NOT_FOUND');
      if (Number(found.product_row_version) !== expectedRowVersion) throw failure('PRODUCT_ROW_VERSION_CONFLICT');
      if (input.expectedVariantVersion !== undefined && Number(found.row_version) !== input.expectedVariantVersion) throw failure('VARIANT_ROW_VERSION_CONFLICT');
      if (found.variant_state !== 'DRAFT') throw failure('VARIANT_STATE_RESTRICTED');
      const references = await client.query<{ referenced: boolean }>(
        `SELECT (
          EXISTS(SELECT 1 FROM catalogue.variant_prices p WHERE p.brand_id=$1 AND p.variant_id=$2)
          OR EXISTS(SELECT 1 FROM media.product_media m WHERE m.brand_id=$1 AND m.variant_id=$2)
          OR EXISTS(SELECT 1 FROM inventory.stock_balances s WHERE s.brand_id=$1 AND s.variant_id=$2)
          OR EXISTS(SELECT 1 FROM imports.import_rows i WHERE i.brand_id=$1 AND i.target_variant_id=$2)
          OR EXISTS(SELECT 1 FROM imports.external_variant_maps m WHERE m.brand_id=$1 AND m.variant_id=$2)
          OR EXISTS(SELECT 1 FROM imports.import_effect_receipts r WHERE r.brand_id=$1 AND r.target_variant_id=$2)
          OR $3::timestamptz IS NOT NULL
        ) AS referenced`, [context.brandId, variantId, found.sku_locked_at]);
      if (references.rows[0]?.referenced) throw failure('VARIANT_REFERENCED');
      const updated = await client.query<VariantRow>(
        `UPDATE catalogue.product_variants v SET variant_state='INACTIVE',row_version=v.row_version+1,updated_at=now()
          WHERE v.id=$1 AND v.product_id=$2 AND v.brand_id=$3 AND v.row_version=$4 AND v.variant_state='DRAFT'
            AND EXISTS (SELECT 1 FROM access.effective_permissions ep WHERE ep.user_id=$5 AND ep.permission_code='catalog.write'
              AND ((ep.scope_type='global' AND ep.brand_id IS NULL) OR (ep.scope_type='brand' AND ep.brand_id=$3)))
            AND EXISTS (SELECT 1 FROM brands.brands b WHERE b.id=$3 AND b.onboarding_state='approved')
          RETURNING v.id,v.brand_id,v.product_id,v.sku,v.options,v.option_signature,v.weight_g,v.gtin,v.variant_state,v.row_version,v.sku_locked_at`,
        [variantId, productId, context.brandId, Number(found.row_version), context.userId]);
      if (!updated.rows[0]) throw failure('VARIANT_ROW_VERSION_CONFLICT');
      await this.bumpProductContentVersion(client, productId, context, found);
      await this.lineage(client, context, productId, [`variants.${variantId}.variantState`, `variants.${variantId}.deactivationReason`]);
      const response = { ...variantDetail(updated.rows[0], {}, 'deactivated', context.requestId), reasonCode: input.reasonCode,
        parentRowVersion: Number(found.product_row_version) + 1 };
      await this.receipt(client, context, 'deactivateProductVariant', requestHash, productId, response);
      return response;
    });
  }

  private async variantForUpdate(client: PoolClient, productId: string, variantId: string, context: ProductMutationContext): Promise<VariantRow | undefined> {
    const result = await client.query<VariantRow>(
      `SELECT v.id,v.brand_id,v.product_id,v.sku,v.options,v.option_signature,v.weight_g,v.gtin,v.variant_state,v.row_version,v.sku_locked_at,
              p.category_id,p.category_schema_version,p.row_version AS product_row_version,p.publication_state
         FROM catalogue.product_variants v JOIN catalogue.products p ON p.id=v.product_id AND p.brand_id=v.brand_id
        WHERE v.id=$1 AND v.product_id=$2 AND v.brand_id=$3
          AND p.publication_state IN ('DRAFT','INCOMPLETE','PENDING_REVIEW','APPROVED','RE_REVIEW','REJECTED') FOR UPDATE OF v,p`,
      [variantId, productId, context.brandId]);
    return result.rows[0];
  }

  private async bumpProductContentVersion(client: PoolClient, productId: string, context: ProductMutationContext, found: VariantRow): Promise<void> {
    const bumped = await client.query(
      `UPDATE catalogue.products p SET content_version=p.content_version+1,row_version=p.row_version+1,
           publication_state=CASE WHEN p.publication_state IN ('PENDING_REVIEW','APPROVED','RE_REVIEW','REJECTED') THEN 'RE_REVIEW' ELSE p.publication_state END,
           qc_state=CASE WHEN p.publication_state IN ('PENDING_REVIEW','APPROVED','RE_REVIEW','REJECTED') THEN 'NOT_SUBMITTED' ELSE p.qc_state END,
           updated_at=now()
        WHERE p.id=$1 AND p.brand_id=$2 AND p.row_version=$3
          AND EXISTS(SELECT 1 FROM access.effective_permissions ep WHERE ep.user_id=$4 AND ep.permission_code='catalog.write'
            AND ((ep.scope_type='global' AND ep.brand_id IS NULL) OR (ep.scope_type='brand' AND ep.brand_id=$2)))`,
      [productId, context.brandId, found.product_row_version, context.userId]);
    if (bumped.rowCount !== 1) throw failure('PRODUCT_ROW_VERSION_CONFLICT');
  }

  private async saveVariantAttributes(client: PoolClient, brandId: string, product: Pick<ProductRow, 'id'|'category_id'|'category_schema_version'>,
    variantId: string, category: SchemaInfo, values: Record<string, unknown>): Promise<void> {
    await client.query('DELETE FROM catalogue.variant_attribute_values WHERE brand_id=$1 AND variant_id=$2', [brandId, variantId]);
    const rules = new Map(category.rules.filter((rule) => rule.scope === 'variant').map((rule) => [rule.code, rule]));
    for (const [code, value] of Object.entries(values)) {
      const rule = rules.get(code); if (!rule) throw failure('VARIANT_ATTRIBUTE_INVALID');
      const typed: Record<string, unknown> = { val_text: null, val_integer: null, val_decimal: null, val_bool: null, val_date: null, val_enum: null, val_json: null, unit_code: null };
      switch (rule.valueType) {
        case 'text': typed.val_text = value; break;
        case 'integer': typed.val_integer = value; break;
        case 'decimal': typed.val_decimal = value; break;
        case 'boolean': typed.val_bool = value; break;
        case 'enum': typed.val_enum = value; break;
        case 'date': typed.val_date = value; break;
        case 'multi_enum': typed.val_json = JSON.stringify(value); break;
        case 'measurement': typed.val_json = JSON.stringify(value); typed.unit_code = (value as { unitCode: string }).unitCode; break;
      }
      await client.query(
        `INSERT INTO catalogue.variant_attribute_values(brand_id,product_id,variant_id,category_id,category_schema_version,attribute_id,schema_version_id,frozen_rule_id,val_text,val_integer,val_decimal,val_bool,val_date,val_enum,val_json,unit_code)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16)`,
        [brandId, product.id, variantId, category.id, category.version, rule.attributeId, category.schema_version_id, rule.id,
          typed.val_text, typed.val_integer, typed.val_decimal, typed.val_bool, typed.val_date, typed.val_enum, typed.val_json, typed.unit_code]);
    }
  }

  private async loadVariantAttributes(client: PoolClient, variantId: string): Promise<Record<string, unknown>> {
    const result = await client.query<Record<string, unknown>>(
      `SELECT r.attribute_code AS code,r.value_type,v.val_text,v.val_integer,v.val_decimal,v.val_bool,v.val_date,v.val_enum,v.val_json,v.unit_code
         FROM catalogue.variant_attribute_values v JOIN catalogue.category_schema_attribute_rules r ON r.id=v.frozen_rule_id
        WHERE v.variant_id=$1`, [variantId]);
    return Object.fromEntries(result.rows.map((row) => {
      let value: unknown;
      switch (row.value_type) {
        case 'text': value = row.val_text; break; case 'integer': value = Number(row.val_integer); break;
        case 'decimal': value = String(row.val_decimal); break; case 'boolean': value = row.val_bool; break;
        case 'enum': value = row.val_enum; break; case 'date': value = row.val_date; break;
        case 'multi_enum': value = row.val_json; break;
        case 'measurement': value = { ...(row.val_json as object), unitCode: row.unit_code }; break;
        default: value = null;
      }
      return [String(row.code), value];
    }));
  }

  private async authorize(client: PoolClient, context: ProductMutationContext): Promise<void> {
    const result = await client.query<{ allowed: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM brands.brands b JOIN access.effective_permissions ep ON ep.user_id=$2 AND ep.permission_code='catalog.write'
          AND ((ep.scope_type='global' AND ep.brand_id IS NULL) OR (ep.scope_type='brand' AND ep.brand_id=b.id))
         WHERE b.id=$1 AND b.onboarding_state='approved'
       ) AS allowed`, [context.brandId, context.userId]);
    if (!result.rows[0]?.allowed) throw failure('PRODUCT_ACCESS_DENIED');
  }

  private async category(client: PoolClient, context: ProductMutationContext, code: string, version: number): Promise<SchemaInfo> {
    const result = await client.query<{ id: string; code: string; version_id: string; version: number; validator_version: string; state: string; active: boolean; is_leaf: boolean }>(
      `SELECT c.id,c.code,v.id AS version_id,v.version,v.validator_version,v.state,c.active,
              NOT EXISTS(SELECT 1 FROM catalogue.categories child WHERE child.parent_id=c.id) AS is_leaf
         FROM catalogue.categories c JOIN catalogue.category_schema_versions v ON v.category_id=c.id AND v.version=$3
        WHERE c.code=$2 AND EXISTS (SELECT 1 FROM brands.brands b JOIN access.effective_permissions ep ON ep.user_id=$4 AND ep.permission_code='catalog.write'
          AND ((ep.scope_type='global' AND ep.brand_id IS NULL) OR (ep.scope_type='brand' AND ep.brand_id=b.id))
          WHERE b.id=$1 AND b.onboarding_state='approved')`, [context.brandId, code, version, context.userId]);
    const row = result.rows[0];
    if (!row || row.state !== 'PUBLISHED' || !row.active || !row.is_leaf) throw failure('PRODUCT_CATEGORY_INVALID');
    return this.loadSchemaRules(client, row.id, row.code, row.version_id, row.version, row.validator_version);
  }

  private async categoryById(client: PoolClient, context: ProductMutationContext, categoryId: string, version: number): Promise<SchemaInfo> {
    const result = await client.query<{ id: string; code: string; version_id: string; version: number; validator_version: string; state: string; active: boolean; is_leaf: boolean }>(
      `SELECT c.id,c.code,v.id AS version_id,v.version,v.validator_version,v.state,c.active,
              NOT EXISTS(SELECT 1 FROM catalogue.categories child WHERE child.parent_id=c.id) AS is_leaf
         FROM catalogue.categories c JOIN catalogue.category_schema_versions v ON v.category_id=c.id AND v.version=$2
        WHERE c.id=$1 AND EXISTS (SELECT 1 FROM brands.brands b JOIN access.effective_permissions ep ON ep.user_id=$3 AND ep.permission_code='catalog.write'
          AND ((ep.scope_type='global' AND ep.brand_id IS NULL) OR (ep.scope_type='brand' AND ep.brand_id=b.id))
          WHERE b.id=$4 AND b.onboarding_state='approved')`, [categoryId, version, context.userId, context.brandId]);
    const row = result.rows[0];
    if (!row || row.state !== 'PUBLISHED' || !row.active || !row.is_leaf) throw failure('PRODUCT_CATEGORY_INVALID');
    return this.loadSchemaRules(client, row.id, row.code, row.version_id, row.version, row.validator_version);
  }

  private async loadSchemaRules(client: PoolClient, id: string, code: string, versionId: string, version: number, validatorVersion: string): Promise<SchemaInfo> {
    const result = await client.query<Record<string, unknown>>(
      `SELECT id,attribute_id,attribute_code AS code,display_label AS "displayLabel",scope_type AS scope,value_type,allowed_values,unit_code,required_by_default,conditional_ast,min_values,max_values
         FROM catalogue.category_schema_attribute_rules WHERE schema_version_id=$1 ORDER BY scope_type,attribute_code`, [versionId]);
    const rules = result.rows.map((row) => ({ id: String(row.id), attributeId: String(row.attribute_id), code: String(row.code),
      scope: row.scope as 'product'|'variant', displayLabel: String(row.displayLabel), valueType: row.value_type as CategoryAttributeRule['valueType'],
      allowedValues: row.allowed_values as unknown[]|null, unitCode: row.unit_code as string|null,
      requiredByDefault: row.required_by_default as boolean, conditionalAst: row.conditional_ast,
      minValues: row.min_values as number|null, maxValues: row.max_values as number|null }));
    return { id, code, schema_version_id: versionId, version, validator_version: validatorVersion, rules };
  }

  private async saveAttributes(client: PoolClient, brandId: string, product: ProductRow, category: SchemaInfo, values: Record<string, unknown>): Promise<void> {
    await client.query('DELETE FROM catalogue.product_attribute_values WHERE brand_id=$1 AND product_id=$2', [brandId, product.id]);
    const rules = new Map(category.rules.filter((rule) => rule.scope === 'product').map((rule) => [rule.code, rule]));
    for (const [code, value] of Object.entries(values)) {
      const rule = rules.get(code); if (!rule) throw failure('PRODUCT_ATTRIBUTE_INVALID');
      const typed: Record<string, unknown> = { val_text: null, val_integer: null, val_decimal: null, val_bool: null, val_date: null, val_enum: null, val_json: null, unit_code: null };
      switch (rule.valueType) {
        case 'text': typed.val_text = value; break;
        case 'integer': typed.val_integer = value; break;
        case 'decimal': typed.val_decimal = value; break;
        case 'boolean': typed.val_bool = value; break;
        case 'enum': typed.val_enum = value; break;
        case 'date': typed.val_date = value; break;
        case 'multi_enum': typed.val_json = JSON.stringify(value); break;
        case 'measurement': typed.val_json = JSON.stringify(value); typed.unit_code = (value as { unitCode: string }).unitCode; break;
      }
      await client.query(
        `INSERT INTO catalogue.product_attribute_values(brand_id,product_id,category_id,category_schema_version,attribute_id,schema_version_id,frozen_rule_id,val_text,val_integer,val_decimal,val_bool,val_date,val_enum,val_json,unit_code)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15)`,
        [brandId, product.id, category.id, category.version, rule.attributeId, category.schema_version_id, rule.id,
          typed.val_text, typed.val_integer, typed.val_decimal, typed.val_bool, typed.val_date, typed.val_enum, typed.val_json, typed.unit_code]);
    }
  }

  private async loadAttributes(client: PoolClient, product: ProductRow): Promise<Record<string, unknown>> {
    const result = await client.query<Record<string, unknown>>(
      `SELECT r.attribute_code AS code,r.value_type,v.val_text,v.val_integer,v.val_decimal,v.val_bool,v.val_date,v.val_enum,v.val_json,v.unit_code
         FROM catalogue.product_attribute_values v JOIN catalogue.category_schema_attribute_rules r ON r.id=v.frozen_rule_id
        WHERE v.brand_id=$1 AND v.product_id=$2`, [product.brand_id, product.id]);
    return Object.fromEntries(result.rows.map((row) => {
      let value: unknown;
      switch (row.value_type) {
        case 'text': value = row.val_text; break; case 'integer': value = Number(row.val_integer); break;
        case 'decimal': value = String(row.val_decimal); break; case 'boolean': value = row.val_bool; break;
        case 'enum': value = row.val_enum; break; case 'date': value = row.val_date; break;
        case 'multi_enum': value = row.val_json; break;
        case 'measurement': value = { ...(row.val_json as object), unitCode: row.unit_code }; break;
        default: value = null;
      }
      return [String(row.code), value];
    }));
  }

  private async lineage(client: PoolClient, context: ProductMutationContext, productId: string, paths: string[]): Promise<void> {
    for (const path of new Set(paths)) await client.query(
      `INSERT INTO catalogue.product_field_lineage(brand_id,product_id,field_path,source_kind,source_reference,actor_user_id)
       VALUES($1,$2,$3,$4,$5,$6)`, [context.brandId, productId, path, context.sourceKind ?? 'MANUAL', context.sourceReference ?? null, context.userId]);
  }

  private async replay(client: PoolClient, context: ProductMutationContext, operation: string, requestHash: string): Promise<Record<string, unknown>|null> {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${context.brandId}:${context.userId}:${operation}:${context.idempotencyKey}`]);
    const result = await client.query<{ request_sha256: string; response_payload: Record<string, unknown> }>(
      `SELECT request_sha256,response_payload FROM catalogue.product_mutation_receipts
        WHERE brand_id=$1 AND actor_user_id=$2 AND operation=$3 AND idempotency_key=$4`,
      [context.brandId, context.userId, operation, context.idempotencyKey]);
    if (!result.rows[0]) return null;
    if (result.rows[0].request_sha256.trim() !== requestHash) throw failure('PRODUCT_IDEMPOTENCY_CONFLICT');
    return result.rows[0].response_payload;
  }

  private async receipt(client: PoolClient, context: ProductMutationContext, operation: string, requestHash: string, productId: string, response: Record<string, unknown>): Promise<void> {
    await client.query(
      `INSERT INTO catalogue.product_mutation_receipts(brand_id,actor_user_id,operation,idempotency_key,request_sha256,product_id,response_payload)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [context.brandId, context.userId, operation, context.idempotencyKey, requestHash, productId, JSON.stringify(response)]);
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const pool = this.infrastructure.pool;
    if (!pool) throw failure('PRODUCT_DATABASE_UNAVAILABLE');
    let client: PoolClient;
    try { client = await pool.connect(); }
    catch { throw failure('PRODUCT_DATABASE_UNAVAILABLE'); }
    try { await client.query('BEGIN'); const value = await work(client); await client.query('COMMIT'); return value; }
    catch (error) {
      try { await client.query('ROLLBACK'); } catch { throw failure('PRODUCT_DATABASE_UNAVAILABLE'); }
      const code = (error as { code?: string }|null)?.code;
      if (code === '23505') throw failure('PRODUCT_CONFLICT');
      if (code?.startsWith('22')) throw failure('PRODUCT_ATTRIBUTE_INVALID');
      if (code?.startsWith('08') || ['ECONNREFUSED','ECONNRESET','ETIMEDOUT','57P01'].includes(code ?? '')) throw failure('PRODUCT_DATABASE_UNAVAILABLE');
      throw error;
    } finally { client.release(); }
  }
}

interface SchemaInfo { id: string; code: string; schema_version_id: string; version: number; validator_version: string; rules: CategoryAttributeRule[]; }

function productDetail(product: ProductRow, attributes: Record<string, unknown>, variants: Array<{ id: string; sku: string; options: Record<string, string>; variant_state: string }>): Record<string, unknown> {
  return { id: product.id, brandId: product.brand_id, categoryId: product.category_id,
    styleCode: product.style_code, title: product.title, description: product.description,
    publicationState: product.publication_state, contentVersion: product.content_version,
    rowVersion: Number(product.row_version), categorySchemaVersion: product.category_schema_version,
    variants: variants.map((variant) => ({ id: variant.id, productId: product.id,
      brandId: product.brand_id, sku: variant.sku, options: variant.options, variantState: variant.variant_state })),
    mediaLinks: [], attributes, qcState: product.qc_state };
}
function variantDetail(variant: VariantRow, attributes: Record<string, unknown>, status: string, requestId: string): Record<string, unknown> {
  return { id: variant.id, brandId: variant.brand_id, productId: variant.product_id, sku: variant.sku,
    options: variant.options, optionSignature: variant.option_signature, weightG: variant.weight_g, gtin: variant.gtin,
    variantState: variant.variant_state, rowVersion: Number(variant.row_version), attributes, status, requestId };
}
function hash(value: unknown): string { return createHash('sha256').update(stable(value)).digest('hex'); }
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function failure(code: string): Error & { code: string } { return Object.assign(new Error(code), { code }); }
