import { Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { BrandAccessContext } from '../access/brand-access.guard';
import { IdentityInfrastructure } from '../identity/identity-infrastructure';

export interface CatalogReadRepository {
  listCategories(context: BrandAccessContext, cursor: string | null, limit: number): Promise<{ items: Record<string, unknown>[]; nextCursor: string | null }>;
  getCategoryAttributes(context: BrandAccessContext, categoryId: string, cursor: string | null, limit: number): Promise<{ items: Record<string, unknown>[]; nextCursor: string | null }>;
  getCategorySchemaVersion(context: BrandAccessContext, categoryId: string, version: number): Promise<Record<string, unknown>>;
}

interface PermissionRow { readonly authorized: boolean; }
interface CategoryRow extends PermissionRow {
  readonly id: string | null;
  readonly code: string | null;
  readonly name: string | null;
  readonly parent_id: string | null;
  readonly schema_version: number | null;
  readonly active: boolean | null;
  readonly is_leaf: boolean | null;
  readonly path_codes: string[] | null;
}
interface AttributeRow extends PermissionRow {
  readonly category_exists: boolean;
  readonly schema_version_id: string | null;
  readonly schema_version: number | null;
  readonly validator_version: string | null;
  readonly attribute_code: string | null;
  readonly scope_type: 'product' | 'variant' | null;
  readonly value_type: string | null;
  readonly required_by_default: boolean | null;
  readonly conditional_ast: Record<string, unknown> | null;
  readonly allowed_values: unknown;
}
interface CategoryVersionRow extends AttributeRow {
  readonly version_id: string | null;
  readonly category_id: string | null;
  readonly selected_version: number | null;
  readonly state: string | null;
  readonly selected_validator_version: string | null;
  readonly ruleset_sha256: string | null;
}

@Injectable()
export class CatalogReadPostgresRepository implements CatalogReadRepository {
  constructor(private readonly infrastructure: IdentityInfrastructure) {}

  async listCategories(context: BrandAccessContext, cursor: string | null, limit: number): Promise<{ items: Record<string, unknown>[]; nextCursor: string | null }> {
    const cursorId = cursor === null ? null : decodeUuidCursor(cursor);
    return this.query(async (pool) => {
      const result = await pool.query<CategoryRow>(
        `WITH RECURSIVE permission_check AS (
           SELECT EXISTS (
             SELECT 1 FROM access.effective_permissions ep
              WHERE ep.user_id=$1 AND ep.permission_code=$3
                AND ((ep.scope_type='global' AND ep.brand_id IS NULL)
                  OR (ep.scope_type='brand' AND ep.brand_id=$2))
           ) AS allowed
         ), paths AS (
           SELECT c.id, c.parent_id, c.code, ARRAY[c.code]::text[] AS path_codes
             FROM catalogue.categories c WHERE c.parent_id IS NULL
           UNION ALL
           SELECT child.id, child.parent_id, child.code, parent.path_codes || child.code
             FROM catalogue.categories child JOIN paths parent ON child.parent_id=parent.id
         ), page AS (
           SELECT c.id, c.code, c.name, c.parent_id, c.schema_version, c.active,
                  NOT EXISTS (SELECT 1 FROM catalogue.categories child WHERE child.parent_id=c.id) AS is_leaf,
                  paths.path_codes
             FROM catalogue.categories c JOIN paths ON paths.id=c.id
             CROSS JOIN permission_check auth
            WHERE auth.allowed AND ($4::uuid IS NULL OR c.id > $4::uuid)
            ORDER BY c.id LIMIT $5
         )
         SELECT permission_check.allowed AS authorized, page.* FROM permission_check LEFT JOIN page ON true
         ORDER BY page.id NULLS LAST`,
        [context.userId, context.brandId, context.permission, cursorId, limit + 1],
      );
      assertAuthorized(result.rows[0]);
      const rows = result.rows.filter((row) => row.id !== null);
      const hasMore = rows.length > limit;
      const selected = hasMore ? rows.slice(0, limit) : rows;
      const items = selected.map((row) => ({
        id: row.id!, code: row.code!, name: row.name!,
        schemaVersion: row.schema_version ?? 1,
        parentId: row.parent_id,
        isLeaf: row.is_leaf!, isActive: row.active!,
        currentSchemaVersion: row.schema_version ?? 1,
        pathCodes: row.path_codes!,
      }));
      return { items, nextCursor: hasMore ? encodeUuidCursor(selected[selected.length - 1].id!) : null };
    });
  }

  async getCategoryAttributes(context: BrandAccessContext, categoryId: string, cursor: string | null, limit: number): Promise<{ items: Record<string, unknown>[]; nextCursor: string | null }> {
    return this.query(async (pool) => {
      const result = await pool.query<AttributeRow>(
        `WITH permission_check AS (
           SELECT EXISTS (
             SELECT 1 FROM access.effective_permissions ep
              WHERE ep.user_id=$1 AND ep.permission_code=$3
                AND ((ep.scope_type='global' AND ep.brand_id IS NULL)
                  OR (ep.scope_type='brand' AND ep.brand_id=$2))
           ) AS allowed
         ), selected_version AS (
           SELECT c.id AS category_id, v.id AS schema_version_id, v.version, v.validator_version
             FROM catalogue.categories c LEFT JOIN catalogue.category_schema_versions v
               ON v.category_id=c.id AND v.version=c.schema_version AND v.state='PUBLISHED'
            WHERE c.id=$4
         ), page AS (
           SELECT r.attribute_code, r.scope_type, r.value_type, r.required_by_default,
                  r.conditional_ast, r.allowed_values, selected_version.schema_version_id,
                  selected_version.version AS schema_version, selected_version.validator_version
             FROM selected_version JOIN catalogue.category_schema_attribute_rules r
               ON r.schema_version_id=selected_version.schema_version_id
             CROSS JOIN permission_check auth
            WHERE auth.allowed
              AND ($5::text IS NULL OR (r.scope_type,r.attribute_code) > ($5::text,$6::text))
            ORDER BY r.scope_type,r.attribute_code LIMIT $7
         )
         SELECT permission_check.allowed AS authorized, EXISTS(SELECT 1 FROM selected_version) AS category_exists,
                page.* FROM permission_check LEFT JOIN page ON true`,
        [context.userId, context.brandId, context.permission, categoryId,
          cursor === null ? null : decodeAttributeCursor(cursor).scope,
          cursor === null ? null : decodeAttributeCursor(cursor).code, limit + 1],
      );
      assertAuthorized(result.rows[0]);
      if (!result.rows[0]?.category_exists) throw readError('CATEGORY_NOT_FOUND');
      const versionId = result.rows.find((row) => row.schema_version_id)?.schema_version_id;
      const decoded = cursor === null ? null : decodeAttributeCursor(cursor);
      if (decoded && decoded.schemaVersionId !== versionId) throw readError('CATEGORY_CURSOR_VERSION_CHANGED');
      const rows = result.rows.filter((row) => row.attribute_code !== null);
      const hasMore = rows.length > limit;
      const selected = hasMore ? rows.slice(0, limit) : rows;
      return {
        items: selected.map(attributeDefinition),
        nextCursor: hasMore ? encodeAttributeCursor(versionId!, selected[selected.length - 1].scope_type!, selected[selected.length - 1].attribute_code!) : null,
      };
    });
  }

  async getCategorySchemaVersion(context: BrandAccessContext, categoryId: string, version: number): Promise<Record<string, unknown>> {
    return this.query(async (pool) => {
      const result = await pool.query<CategoryVersionRow>(
        `WITH permission_check AS (
           SELECT EXISTS (
             SELECT 1 FROM access.effective_permissions ep
              WHERE ep.user_id=$1 AND ep.permission_code=$3
                AND ((ep.scope_type='global' AND ep.brand_id IS NULL)
                  OR (ep.scope_type='brand' AND ep.brand_id=$2))
           ) AS allowed
         ), selected_version AS (
           SELECT v.id, v.category_id, v.version, v.state, v.validator_version, v.ruleset_sha256
             FROM catalogue.category_schema_versions v
            WHERE v.category_id=$4 AND v.version=$5 AND v.state='PUBLISHED'
         ), rules AS (
           SELECT r.attribute_code, r.scope_type, r.value_type, r.required_by_default,
                  r.conditional_ast, r.allowed_values, selected_version.id AS schema_version_id,
                  selected_version.version AS schema_version, selected_version.validator_version
             FROM selected_version JOIN catalogue.category_schema_attribute_rules r
               ON r.schema_version_id=selected_version.id
         )
         SELECT permission_check.allowed AS authorized, selected_version.id AS version_id,
                selected_version.category_id, selected_version.version AS selected_version,
                selected_version.state, selected_version.validator_version AS selected_validator_version,
                selected_version.ruleset_sha256, rules.*
           FROM permission_check LEFT JOIN selected_version ON true LEFT JOIN rules ON true`,
        [context.userId, context.brandId, context.permission, categoryId, version],
      );
      assertAuthorized(result.rows[0]);
      const first = result.rows[0];
      if (!first?.version_id || !first.ruleset_sha256) throw readError('CATEGORY_SCHEMA_VERSION_NOT_FOUND');
      return {
        categoryId: first.category_id,
        version: first.selected_version,
        state: first.state,
        validatorVersion: first.selected_validator_version,
        rulesetSha256: first.ruleset_sha256.trim(),
        attributes: result.rows.filter((row) => row.attribute_code !== null).map(attributeDefinition),
      };
    });
  }

  private async query<T>(operation: (pool: Pool) => Promise<T>): Promise<T> {
    const pool = this.infrastructure.pool;
    if (!pool) throw readError('CATALOG_READ_UNAVAILABLE');
    try { return await operation(pool); }
    catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code?.startsWith('08') || ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', '57P01'].includes(code ?? '')) {
        throw readError('CATALOG_READ_UNAVAILABLE');
      }
      throw error;
    }
  }
}

function attributeDefinition(row: AttributeRow): Record<string, unknown> {
  const condition = row.conditional_ast ?? null;
  const allowedValues = Array.isArray(row.allowed_values) && row.allowed_values.every((item) => typeof item === 'string')
    ? row.allowed_values : undefined;
  return {
    code: row.attribute_code,
    scope: row.scope_type === 'product' ? 'PRODUCT' : 'VARIANT',
    type: row.value_type,
    required: row.required_by_default,
    condition,
    ...(allowedValues === undefined ? {} : { allowedValues }),
    schemaVersionId: row.schema_version_id,
    validatorVersion: row.validator_version,
    conditionalAst: condition,
    scopeType: row.scope_type,
  };
}

function assertAuthorized(row: PermissionRow | undefined): void {
  if (!row?.authorized) throw readError('CATALOG_READ_FORBIDDEN');
}

function encodeUuidCursor(id: string): string { return Buffer.from(id, 'utf8').toString('base64url'); }
function decodeUuidCursor(cursor: string): string {
  let value = '';
  try { value = Buffer.from(cursor, 'base64url').toString('utf8'); } catch { /* handled below */ }
  if (Buffer.from(value, 'utf8').toString('base64url') !== cursor
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw readError('CATEGORY_CURSOR_INVALID');
  }
  return value;
}

interface AttributeCursor { readonly schemaVersionId: string; readonly scope: 'product' | 'variant'; readonly code: string; }
function encodeAttributeCursor(schemaVersionId: string, scope: 'product' | 'variant', code: string): string {
  return Buffer.from(JSON.stringify({ schemaVersionId, scope, code } satisfies AttributeCursor), 'utf8').toString('base64url');
}
function decodeAttributeCursor(cursor: string): AttributeCursor {
  let value: unknown;
  try { value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { throw readError('CATEGORY_CURSOR_INVALID'); }
  if (Buffer.from(JSON.stringify(value), 'utf8').toString('base64url') !== cursor || !value || typeof value !== 'object') throw readError('CATEGORY_CURSOR_INVALID');
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).length !== 3 || typeof candidate.schemaVersionId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate.schemaVersionId)
    || !['product', 'variant'].includes(candidate.scope as string)
    || typeof candidate.code !== 'string' || !candidate.code || candidate.code.length > 128) throw readError('CATEGORY_CURSOR_INVALID');
  return candidate as unknown as AttributeCursor;
}

function readError(code: string): Error { return Object.assign(new Error(code), { code }); }
