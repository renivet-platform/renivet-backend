import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { IdentityInfrastructure } from '../identity/identity-infrastructure';
import { AttachProductMediaDto, UpdateProductMediaDto } from './product-media.dto';
import { ProductMediaError, ProductMediaMutationContext, ProductMediaRepositoryPort, productMediaRequestHash } from './product-media.service';

interface LinkRow {
  id: string; brand_id: string; product_id: string; variant_id: string | null; media_asset_id: string;
  display_role: string; display_order: number; alt_text: string; scan_state: string; rights_state: string;
  derivative_state: string; detached_at: Date | null;
}

@Injectable()
export class ProductMediaPostgresRepository implements ProductMediaRepositoryPort {
  constructor(private readonly infrastructure: IdentityInfrastructure) {}

  attach(productId: string, input: AttachProductMediaDto, context: ProductMediaMutationContext): Promise<Record<string, unknown>> {
    return this.transaction(async (client) => {
      await this.lockAuthorizedProduct(client, productId, context);
      const operation = 'attachProductMedia';
      const requestHash = productMediaRequestHash({ productId, input });
      const replay = await this.replay(client, productId, operation, requestHash, context);
      if (replay) return replay;
      const asset = await client.query<{ id: string }>(
        `SELECT a.id FROM media.media_assets a
          JOIN brands.brands b ON b.id=a.brand_id AND b.onboarding_state='approved'
         WHERE a.id=$1 AND a.brand_id=$2 AND a.scan_state='CLEAN' AND a.derivative_state='READY'
           AND a.rights_state IN ('ATTESTED','REVIEWED')
           AND EXISTS (SELECT 1 FROM access.effective_permissions ep WHERE ep.user_id=$3
             AND ep.permission_code=$4 AND ((ep.scope_type='global' AND ep.brand_id IS NULL)
               OR (ep.scope_type='brand' AND ep.brand_id=$2))) FOR SHARE OF a`,
        [input.mediaAssetId, context.brandId, context.userId, context.permission]);
      if (!asset.rowCount) {
        const visible = await client.query(`SELECT 1 FROM media.media_assets WHERE id=$1 AND brand_id=$2`, [input.mediaAssetId, context.brandId]);
        if (!visible.rowCount) throw fail(404, 'PRODUCT_MEDIA_NOT_FOUND');
        throw fail(422, 'PRODUCT_MEDIA_ASSET_NOT_READY');
      }
      if (input.variantId) {
        const variant = await client.query(`SELECT 1 FROM catalogue.product_variants
          WHERE id=$1 AND product_id=$2 AND brand_id=$3 AND variant_state <> 'ARCHIVED' FOR SHARE`,
        [input.variantId, productId, context.brandId]);
        if (!variant.rowCount) throw fail(422, 'PRODUCT_MEDIA_VARIANT_MISMATCH');
      }
      const rows = await this.lockGallery(client, productId, input.variantId ?? null, context.brandId);
      if (input.displayOrder > rows.length) throw fail(422, 'PRODUCT_MEDIA_ORDER_INVALID');
      if (rows.some((row) => row.media_asset_id === input.mediaAssetId)) throw fail(409, 'PRODUCT_MEDIA_DUPLICATE');
      const beforeGallery = gallerySnapshot(rows);
      const provisionalOrder = rows.reduce((max, row) => Math.max(max, Number(row.display_order)), -1) + rows.length + 1;
      if (provisionalOrder > 2147483647) throw fail(409, 'PRODUCT_MEDIA_ORDER_RANGE_EXHAUSTED');
      const inserted = await client.query<LinkRow>(
        `INSERT INTO media.product_media(brand_id,product_id,variant_id,media_asset_id,display_role,display_order,alt_text)
         VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [context.brandId, productId, input.variantId ?? null, input.mediaAssetId, input.displayRole, provisionalOrder, input.altText ?? '']);
      const ordered = [...rows]; ordered.splice(input.displayOrder, 0, inserted.rows[0]);
      await this.writeOrder(client, ordered);
      await this.touchProduct(client, productId, context);
      const link = await this.getLink(client, inserted.rows[0].id, productId, context.brandId);
      const response = toLink(link);
      const afterRows = await this.lockGallery(client, productId, input.variantId ?? null, context.brandId);
      await this.audit(client, link, context, operation, beforeGallery, gallerySnapshot(afterRows));
      await this.receipt(client, context, operation, requestHash, productId, response);
      return response;
    });
  }

  update(productId: string, linkId: string, input: UpdateProductMediaDto, productVersion: number,
    context: ProductMediaMutationContext): Promise<Record<string, unknown>> {
    return this.transaction(async (client) => {
      const product = await this.lockAuthorizedProduct(client, productId, context);
      const operation = 'updateProductMediaLink';
      const requestHash = productMediaRequestHash({ productId, linkId, input, productVersion });
      const replay = await this.replay(client, productId, operation, requestHash, context);
      if (replay) return replay;
      if (product.rowVersion !== productVersion) throw fail(412, 'PRODUCT_MEDIA_VERSION_CONFLICT');
      const current = await this.getActiveLinkForUpdate(client, productId, linkId, context.brandId);
      if (!current) throw fail(404, 'PRODUCT_MEDIA_NOT_FOUND');
      const gallery = await this.lockGallery(client, productId, current.variant_id, context.brandId);
      const beforeGallery = gallerySnapshot(gallery);
      const order = input.displayOrder ?? current.display_order;
      if (order >= gallery.length) throw fail(422, 'PRODUCT_MEDIA_ORDER_INVALID');
      await client.query(`UPDATE media.product_media SET display_role=$4,alt_text=$5
        WHERE id=$1 AND product_id=$2 AND brand_id=$3 AND detached_at IS NULL`,
      [linkId, productId, context.brandId, input.displayRole ?? current.display_role, input.altText ?? current.alt_text]);
      if (order !== current.display_order) {
        const at = gallery.findIndex((row) => row.id === linkId);
        gallery.splice(at, 1); gallery.splice(order, 0, current);
        await this.writeOrder(client, gallery);
      } else {
        await client.query(`UPDATE media.product_media SET updated_at=now()
          WHERE id=$1 AND product_id=$2 AND brand_id=$3 AND detached_at IS NULL`, [linkId, productId, context.brandId]);
      }
      await this.touchProduct(client, productId, context);
      const link = await this.getLink(client, linkId, productId, context.brandId);
      const response = toLink(link);
      const afterRows = await this.lockGallery(client, productId, current.variant_id, context.brandId);
      await this.audit(client, link, context, operation, beforeGallery, gallerySnapshot(afterRows));
      await this.receipt(client, context, operation, requestHash, productId, response);
      return response;
    });
  }

  detach(productId: string, linkId: string, productVersion: number,
    context: ProductMediaMutationContext): Promise<Record<string, unknown>> {
    return this.transaction(async (client) => {
      const product = await this.lockAuthorizedProduct(client, productId, context);
      const operation = 'detachProductMedia';
      const requestHash = productMediaRequestHash({ productId, linkId, productVersion });
      const replay = await this.replay(client, productId, operation, requestHash, context);
      if (replay) return replay;
      if (product.rowVersion !== productVersion) throw fail(412, 'PRODUCT_MEDIA_VERSION_CONFLICT');
      const current = await this.getActiveLinkForUpdate(client, productId, linkId, context.brandId);
      if (!current) throw fail(404, 'PRODUCT_MEDIA_NOT_FOUND');
      const gallery = await this.lockGallery(client, productId, current.variant_id, context.brandId);
      const beforeGallery = gallerySnapshot(gallery);
      await client.query(`UPDATE media.product_media SET detached_at=now(),updated_at=now()
        WHERE id=$1 AND product_id=$2 AND brand_id=$3 AND detached_at IS NULL`, [linkId, productId, context.brandId]);
      const remaining = gallery.filter((row) => row.id !== linkId);
      await this.writeOrder(client, remaining);
      const nextVersion = await this.touchProduct(client, productId, context);
      const detached = await this.getLink(client, linkId, productId, context.brandId);
      const response = { id: linkId, status: 'DETACHED', requestId: context.requestId, rowVersion: nextVersion };
      const afterRows = await this.lockGallery(client, productId, current.variant_id, context.brandId);
      await this.audit(client, detached, context, operation, beforeGallery, gallerySnapshot(afterRows));
      await this.receipt(client, context, operation, requestHash, productId, response);
      return response;
    });
  }

  private async lockAuthorizedProduct(client: PoolClient, productId: string, context: ProductMediaMutationContext): Promise<{ rowVersion: number }> {
    const result = await client.query<{ id: string; publication_state: string; row_version: string | number }>(
      `SELECT p.id,p.publication_state,p.row_version FROM catalogue.products p
        JOIN brands.brands b ON b.id=p.brand_id AND b.onboarding_state='approved'
       WHERE p.id=$1 AND p.brand_id=$2
         AND EXISTS (SELECT 1 FROM access.effective_permissions ep WHERE ep.user_id=$3 AND ep.permission_code=$4
           AND ((ep.scope_type='global' AND ep.brand_id IS NULL) OR (ep.scope_type='brand' AND ep.brand_id=$2)))
       FOR UPDATE OF p`, [productId, context.brandId, context.userId, context.permission]);
    if (!result.rows[0]) throw fail(404, 'PRODUCT_MEDIA_PRODUCT_NOT_FOUND');
    if (['ARCHIVED','RESTRICTED'].includes(result.rows[0].publication_state)) throw fail(409, 'PRODUCT_MEDIA_PRODUCT_RESTRICTED');
    return { rowVersion: Number(result.rows[0].row_version) };
  }

  private async lockGallery(client: PoolClient, productId: string, variantId: string | null, brandId: string): Promise<LinkRow[]> {
    return (await client.query<LinkRow>(
      `SELECT pm.*,a.scan_state,a.rights_state,a.derivative_state FROM media.product_media pm
         JOIN media.media_assets a ON a.id=pm.media_asset_id AND a.brand_id=pm.brand_id
        WHERE pm.product_id=$1 AND pm.brand_id=$2 AND pm.variant_id IS NOT DISTINCT FROM $3::uuid AND pm.detached_at IS NULL
        ORDER BY pm.display_order,pm.id FOR UPDATE OF pm`, [productId, brandId, variantId])).rows;
  }

  private async getActiveLinkForUpdate(client: PoolClient, productId: string, linkId: string, brandId: string): Promise<LinkRow | undefined> {
    return (await client.query<LinkRow>(
      `SELECT pm.*,a.scan_state,a.rights_state,a.derivative_state FROM media.product_media pm
        JOIN media.media_assets a ON a.id=pm.media_asset_id AND a.brand_id=pm.brand_id
       WHERE pm.id=$1 AND pm.product_id=$2 AND pm.brand_id=$3 AND pm.detached_at IS NULL FOR UPDATE OF pm`,
      [linkId, productId, brandId])).rows[0];
  }

  private async getLink(client: PoolClient, linkId: string, productId: string, brandId: string): Promise<LinkRow> {
    const result = await client.query<LinkRow>(
      `SELECT pm.*,a.scan_state,a.rights_state,a.derivative_state FROM media.product_media pm
        JOIN media.media_assets a ON a.id=pm.media_asset_id AND a.brand_id=pm.brand_id
       WHERE pm.id=$1 AND pm.product_id=$2 AND pm.brand_id=$3`, [linkId, productId, brandId]);
    if (!result.rows[0]) throw fail(404, 'PRODUCT_MEDIA_NOT_FOUND');
    return result.rows[0];
  }

  private async writeOrder(client: PoolClient, rows: LinkRow[]): Promise<void> {
    if (!rows.length) return;
    const max = Math.max(...rows.map((row) => Number(row.display_order)));
    const offset = max + rows.length + 1;
    if (max + offset > 2147483647) throw fail(409, 'PRODUCT_MEDIA_ORDER_RANGE_EXHAUSTED');
    await client.query(`UPDATE media.product_media SET display_order=display_order+$4
      WHERE brand_id=$1 AND product_id=$2 AND variant_id IS NOT DISTINCT FROM $3::uuid AND detached_at IS NULL`,
    [rows[0].brand_id, rows[0].product_id, rows[0].variant_id, offset]);
    for (const [index, row] of rows.entries()) {
      const changed = Number(row.display_order) !== index;
      await client.query(`UPDATE media.product_media SET display_order=$4,updated_at=CASE WHEN $5 THEN now() ELSE updated_at END
        WHERE id=$1 AND product_id=$2 AND brand_id=$3 AND detached_at IS NULL`,
      [row.id, row.product_id, row.brand_id, index, changed]);
    }
  }

  private async touchProduct(client: PoolClient, productId: string, context: ProductMediaMutationContext): Promise<number> {
    const updated = await client.query<{ row_version: string | number }>(
      `UPDATE catalogue.products SET content_version=content_version+1,row_version=row_version+1,
          qc_state='NOT_SUBMITTED',
          publication_state=CASE WHEN publication_state IN ('PENDING_REVIEW','APPROVED') THEN 'RE_REVIEW' ELSE publication_state END,
          updated_at=now()
        WHERE id=$1 AND brand_id=$2 AND publication_state NOT IN ('ARCHIVED','RESTRICTED')
          AND EXISTS (SELECT 1 FROM access.effective_permissions ep WHERE ep.user_id=$3 AND ep.permission_code=$4
            AND ((ep.scope_type='global' AND ep.brand_id IS NULL) OR (ep.scope_type='brand' AND ep.brand_id=$2)))
        RETURNING row_version`,
      [productId, context.brandId, context.userId, context.permission]);
    if (updated.rowCount !== 1) throw fail(409, 'PRODUCT_MEDIA_PRODUCT_RESTRICTED');
    return Number(updated.rows[0].row_version);
  }

  private async replay(client: PoolClient, productId: string, operation: string, requestHash: string,
    context: ProductMediaMutationContext): Promise<Record<string, unknown> | null> {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [`${context.brandId}:${context.userId}:${operation}:${context.idempotencyKey}`]);
    const result = await client.query<{ request_sha256: string; response_payload: Record<string, unknown> }>(
      `SELECT request_sha256,response_payload FROM catalogue.product_mutation_receipts
        WHERE brand_id=$1 AND actor_user_id=$2 AND operation=$3 AND idempotency_key=$4 AND product_id=$5`,
      [context.brandId, context.userId, operation, context.idempotencyKey, productId]);
    if (!result.rows[0]) return null;
    if (result.rows[0].request_sha256.trim() !== requestHash) throw fail(409, 'PRODUCT_MEDIA_IDEMPOTENCY_CONFLICT');
    return result.rows[0].response_payload;
  }

  private async receipt(client: PoolClient, context: ProductMediaMutationContext, operation: string, requestHash: string,
    productId: string, response: Record<string, unknown>): Promise<void> {
    await client.query(`INSERT INTO catalogue.product_mutation_receipts
      (brand_id,actor_user_id,operation,idempotency_key,request_sha256,product_id,response_payload)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [context.brandId, context.userId, operation, context.idempotencyKey, requestHash, productId, JSON.stringify(response)]);
  }

  private async audit(client: PoolClient, link: LinkRow, context: ProductMediaMutationContext, operation: string,
    before: Record<string, unknown> | null, after: Record<string, unknown>): Promise<void> {
    await client.query(`INSERT INTO media.product_media_audit_events
      (brand_id,product_id,product_media_id,media_asset_id,actor_user_id,request_id,event_name,before_snapshot,after_snapshot)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)`,
    [link.brand_id, link.product_id, link.id, link.media_asset_id, context.userId, context.requestId, operation,
      before === null ? null : JSON.stringify(before), JSON.stringify(after)]);
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const pool = this.infrastructure.pool;
    if (!pool) throw fail(503, 'PRODUCT_MEDIA_DATABASE_UNAVAILABLE');
    let client: PoolClient;
    try { client = await pool.connect(); } catch { throw fail(503, 'PRODUCT_MEDIA_DATABASE_UNAVAILABLE'); }
    try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
    catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (error instanceof ProductMediaError) throw error;
      const code = (error as { code?: string } | null)?.code;
      if (code === '23505') throw fail(409, 'PRODUCT_MEDIA_CONFLICT');
      if (code === '23503') throw fail(422, 'PRODUCT_MEDIA_REFERENCE_INVALID');
      if (code?.startsWith('08') || ['ECONNREFUSED','ECONNRESET','ETIMEDOUT','57P01'].includes(code ?? '')) {
        throw fail(503, 'PRODUCT_MEDIA_DATABASE_UNAVAILABLE');
      }
      throw error;
    } finally { client.release(); }
  }
}

function toLink(row: LinkRow): Record<string, unknown> {
  return { id: row.id, mediaAssetId: row.media_asset_id, productId: row.product_id, variantId: row.variant_id,
    displayRole: row.display_role, displayOrder: Number(row.display_order),
    scanState: row.scan_state, rightsState: row.rights_state };
}
function gallerySnapshot(rows: LinkRow[]): Record<string, unknown> {
  return { links: rows.map((row) => ({ ...toLink(row), altText: row.alt_text })) };
}
function fail(status: number, code: string): ProductMediaError { return new ProductMediaError(status, code); }
