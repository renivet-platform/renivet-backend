import { createHash, randomUUID } from 'node:crypto';
import { Body, ConflictException, Controller, ForbiddenException, Get, Headers, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Req, ServiceUnavailableException, UnprocessableEntityException, UseFilters, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiExtension, ApiHeader, ApiNotFoundResponse, ApiOperation, ApiParam, ApiResponse, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { MfaGuard, RequireMfa } from '../../common/guards/require-mfa';
import { BrandAccessGuard, BrandAccessRequest, RequireBrandPermission } from '../access/brand-access.guard';
import { IdentityInfrastructure } from '../identity/identity-infrastructure';
import { csrfMatches, readSessionToken, SessionService } from '../identity/session.service';
import { MediaExceptionFilter } from './media-exception.filter';
import { CreateMediaZipImportDto, CreateMediaZipMappingManifestDto, MAX_REMOTE_MEDIA_IMAGES } from './media-zip.dto';

interface MediaZipRequest extends BrandAccessRequest { id?: string; }
const VALIDATION = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true,
  exceptionFactory: () => new UnprocessableEntityException({ code: 'MEDIA_ZIP_REQUEST_INVALID', message: 'The media ZIP request is invalid.' }) });
const ERROR_SCHEMA = { type: 'object', required: ['code','message','requestId'], properties: {
  code: { type: 'string' }, message: { type: 'string' }, requestId: { type: 'string' },
} };
const MANIFEST_SCHEMA = { type: 'object', required: ['id','status','requestId'], properties: {
  id: { type: 'string', format: 'uuid' }, status: { type: 'string' }, requestId: { type: 'string' },
} };
const BATCH_SCHEMA = { type: 'object', required: ['id','status','rowVersion','requestId'], properties: {
  id: { type: 'string', format: 'uuid' }, status: { type: 'string', enum: ['QUEUED','PROCESSING','PARTIAL','SUCCEEDED','FAILED'] }, rowVersion: { type: 'integer', minimum: 1 }, requestId: { type: 'string' },
} };
const BATCH_STATUS_SCHEMA = { type: 'object', required: ['id','status','rowVersion','effectCount','succeededCount','failedCount','errorCode'], properties: {
  id: { type: 'string', format: 'uuid' }, status: { type: 'string', enum: ['QUEUED','PROCESSING','PARTIAL','SUCCEEDED','FAILED'] }, rowVersion: { type: 'integer', minimum: 1 },
  effectCount: { type: 'integer', minimum: 0 }, succeededCount: { type: 'integer', minimum: 0 }, failedCount: { type: 'integer', minimum: 0 },
  errorCode: { type: 'string', nullable: true },
} };

@ApiTags('Media')
@ApiCookieAuth('sessionCookie')
@Controller('brands/:brandId/media')
@UseGuards(BrandAccessGuard)
@UseFilters(MediaExceptionFilter)
export class MediaZipController {
  constructor(private readonly infrastructure: IdentityInfrastructure, private readonly sessions: SessionService,
    private readonly config: ConfigService) {}

  @Post('zip-mapping-manifests')
  @HttpCode(201)
  @UseGuards(MfaGuard)
  @UsePipes(VALIDATION)
  @RequireBrandPermission('media.write')
  @RequireMfa('media.write')
  @ApiParam({ name: 'brandId', type: 'string', format: 'uuid' })
  @ApiExtension('x-renivet-permission', 'media.write')
  @ApiExtension('x-renivet-implementation-wave', 'W2')
  @ApiExtension('x-renivet-csrf-policy', 'W1 session-bound CSRF, allowlisted Origin, same-origin fetch metadata, media.write and MFA required.')
  @ApiOperation({ operationId: 'createMediaZipMappingManifest', summary: 'Save a brand-owned immutable SKU-to-variant image mapping', description: 'Validates the brand-owned product/variant/SKU triples and records the user media-rights attestation. Later ZIP batches pin this immutable mapping. Linear: REN2-82.' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: { type: 'string', minLength: 1, maxLength: 120 } })
  @ApiBody({ schema: { type: 'object', additionalProperties: false, required: ['mappings','rightsAttested'], properties: {
    mappings: { type: 'array', minItems: 1, maxItems: 12000, items: { type: 'object', additionalProperties: false,
      required: ['sku','productId','variantId'], properties: { sku: { type: 'string', pattern: '^[A-Za-z0-9_.-]{1,40}$' }, productId: { type: 'string', format: 'uuid' }, variantId: { type: 'string', format: 'uuid' } } } },
    rightsAttested: { type: 'boolean', enum: [true] },
  } } })
  @ApiResponse({ status: 201, description: 'Immutable media mapping saved.', schema: MANIFEST_SCHEMA })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 403, description: 'Brand permission, CSRF, or MFA denied.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 409, description: 'The idempotency key conflicts with an earlier request.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 422, description: 'SKU mappings or rights attestation are invalid.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 503, description: 'Mapping storage is unavailable.', schema: ERROR_SCHEMA })
  async createManifest(@Body() input: CreateMediaZipMappingManifestDto, @Req() request: MediaZipRequest,
    @Headers('Idempotency-Key') key?: string) {
    const context = await this.mutationContext(request, key);
    if (input.rightsAttested !== true) throw new UnprocessableEntityException({ code: 'MEDIA_RIGHTS_ATTESTATION_REQUIRED', message: 'Rights attestation is required for this media batch.' });
    const mappings = input.mappings.map((entry) => ({ sku: entry.sku.trim(), productId: entry.productId.toLowerCase(), variantId: entry.variantId.toLowerCase() }))
      .sort((a, b) => a.sku.toUpperCase().localeCompare(b.sku.toUpperCase(), 'en-US'));
    if (new Set(mappings.map((entry) => entry.sku.toUpperCase())).size !== mappings.length
      || new Set(mappings.map((entry) => entry.variantId)).size !== mappings.length) {
      throw new UnprocessableEntityException({ code: 'MEDIA_ZIP_MAPPING_DUPLICATE', message: 'Each SKU and variant must appear once.' });
    }
    const requestSha256 = sha256({ mappings, rightsAttested: true });
    const pool = this.infrastructure.pool;
    if (!pool) throw new ServiceUnavailableException({ code: 'MEDIA_DATABASE_UNAVAILABLE', message: 'Media mapping storage is unavailable.' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`media-zip-manifest:${context.brandId}:${context.idempotencyKey}`]);
      const existing = await client.query<{ id: string; request_sha256: string }>(
        'SELECT id,request_sha256 FROM media.zip_mapping_manifests WHERE brand_id=$1 AND idempotency_key=$2 FOR UPDATE',
        [context.brandId, context.idempotencyKey]);
      if (existing.rows[0]) {
        if (existing.rows[0].request_sha256.trim() !== requestSha256) throw new ConflictException({ code: 'MEDIA_ZIP_IDEMPOTENCY_CONFLICT', message: 'The idempotency key was already used for another mapping.' });
        await client.query('COMMIT');
        return { id: existing.rows[0].id, status: 'SAVED', requestId: context.requestId };
      }
      const variants = await client.query<{ id: string; product_id: string; sku_norm: string }>(
        `SELECT v.id,v.product_id,v.sku_norm FROM catalogue.product_variants v
         JOIN catalogue.products p ON p.id=v.product_id AND p.brand_id=v.brand_id
         WHERE v.brand_id=$1 AND v.id=ANY($2::uuid[]) AND v.variant_state <> 'ARCHIVED'
           AND EXISTS (SELECT 1 FROM access.effective_permissions ep WHERE ep.user_id=$3 AND ep.permission_code='media.write'
             AND ((ep.scope_type='global' AND ep.brand_id IS NULL) OR (ep.scope_type='brand' AND ep.brand_id=$1)))
         FOR SHARE OF v,p`,
        [context.brandId, mappings.map((entry) => entry.variantId), context.userId]);
      const actual = new Map(variants.rows.map((variant) => [variant.id, variant]));
      if (actual.size !== mappings.length || mappings.some((entry) => {
        const row = actual.get(entry.variantId);
        return !row || row.product_id !== entry.productId || row.sku_norm !== entry.sku.toUpperCase();
      })) throw new UnprocessableEntityException({ code: 'MEDIA_ZIP_MAPPING_TARGET_INVALID', message: 'Every SKU must match an active variant owned by this brand.' });
      const id = randomUUID();
      await client.query('INSERT INTO media.zip_mapping_manifests(id,brand_id,created_by,idempotency_key,request_sha256,rights_attested) VALUES($1,$2,$3,$4,$5,true)',
        [id, context.brandId, context.userId, context.idempotencyKey, requestSha256]);
      await client.query(`INSERT INTO media.zip_mapping_manifest_items(manifest_id,brand_id,sku,product_id,variant_id)
        SELECT $1,$2,x.sku,x.product_id,x.variant_id FROM unnest($3::text[],$4::uuid[],$5::uuid[]) AS x(sku,product_id,variant_id)`,
      [id, context.brandId, mappings.map((entry) => entry.sku), mappings.map((entry) => entry.productId), mappings.map((entry) => entry.variantId)]);
      await client.query(`INSERT INTO media.zip_import_audit_events(brand_id,manifest_id,actor_user_id,request_id,event_name,payload_sha256)
        VALUES($1,$2,$3,$4,'mapping_created',$5)`, [context.brandId, id, context.userId, context.requestId, requestSha256]);
      await client.query('COMMIT');
      return { id, status: 'SAVED', requestId: context.requestId };
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
  }

  @Post('zip-imports')
  @HttpCode(202)
  @UseGuards(MfaGuard)
  @UsePipes(VALIDATION)
  @RequireBrandPermission('media.write')
  @RequireMfa('media.write')
  @ApiParam({ name: 'brandId', type: 'string', format: 'uuid' })
  @ApiExtension('x-renivet-permission', 'media.write')
  @ApiExtension('x-renivet-implementation-wave', 'W2')
  @ApiExtension('x-renivet-csrf-policy', 'W1 session-bound CSRF, allowlisted Origin, same-origin fetch metadata, media.write and MFA required.')
  @ApiOperation({ operationId: 'createMediaZipImport', summary: 'Queue a secure brand-owned image ZIP import', description: 'Consumes a private MEDIA_ZIP file upload and pins an immutable brand SKU/product/variant mapping. Emits a durable outbox event; no media asset is attachable until malware, rights and derivative checks succeed. Linear: REN2-82.' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: { type: 'string', minLength: 1, maxLength: 120 } })
  @ApiBody({ schema: { type: 'object', additionalProperties: false, required: ['mappingManifestId'], properties: {
    fileUploadId: { type: 'string', format: 'uuid' }, mappingManifestId: { type: 'string', format: 'uuid' },
    remoteImages: { type: 'array', minItems: 1, maxItems: MAX_REMOTE_MEDIA_IMAGES, items: { type: 'object', additionalProperties: false,
      required: ['sku','slot','url'], properties: { sku: { type: 'string', pattern: '^[A-Za-z0-9_.-]{1,40}$' }, slot: { type: 'integer', minimum: 1, maximum: 99 }, url: { type: 'string', maxLength: 2048, pattern: '^https://' } } } },
  }, oneOf: [{ required: ['fileUploadId'] }, { required: ['remoteImages'] }] } })
  @ApiResponse({ status: 202, description: 'Durable media ZIP batch queued.', schema: BATCH_SCHEMA })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 403, description: 'Brand permission, CSRF, or MFA denied.', schema: ERROR_SCHEMA })
  @ApiNotFoundResponse({ description: 'The upload or mapping is not accessible.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 409, description: 'The upload was consumed or the idempotency key conflicts.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 422, description: 'The file upload is not a valid MEDIA_ZIP upload.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 503, description: 'Media queue storage is unavailable.', schema: ERROR_SCHEMA })
  async createImport(@Body() input: CreateMediaZipImportDto, @Req() request: MediaZipRequest,
    @Headers('Idempotency-Key') key?: string) {
    const context = await this.mutationContext(request, key);
    const isZip = typeof input.fileUploadId === 'string';
    if (isZip === Array.isArray(input.remoteImages) || (isZip && input.remoteImages !== undefined)) {
      throw new UnprocessableEntityException({ code: 'MEDIA_ZIP_SOURCE_INVALID', message: 'Choose one ZIP upload or a list of remote images.' });
    }
    const remoteImages = (input.remoteImages ?? []).map((item) => ({ sku: item.sku.trim(), slot: item.slot, url: item.url.trim() }))
      .sort((a, b) => a.sku.toUpperCase().localeCompare(b.sku.toUpperCase(), 'en-US') || a.slot - b.slot);
    if (!isZip && (remoteImages.length === 0 || new Set(remoteImages.map((item) => `${item.sku.toUpperCase()}#${item.slot}`)).size !== remoteImages.length
      || remoteImages.some((item) => !isSafeRemoteUrlShape(item.url)))) {
      throw new UnprocessableEntityException({ code: 'MEDIA_ZIP_SOURCE_INVALID', message: 'The remote image list is invalid.' });
    }
    const requestSha256 = sha256({ fileUploadId: input.fileUploadId?.toLowerCase() ?? null,
      mappingManifestId: input.mappingManifestId.toLowerCase(), remoteImages: remoteImages.map((item) => ({ ...item, sku: item.sku.toUpperCase() })) });
    const pool = this.infrastructure.pool;
    if (!pool) throw new ServiceUnavailableException({ code: 'MEDIA_DATABASE_UNAVAILABLE', message: 'Media queue storage is unavailable.' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`media-zip-import:${context.brandId}:${context.idempotencyKey}`]);
      const prior = await client.query<{ id: string; state: string; row_version: number; request_sha256: string }>(
        'SELECT id,state,row_version,request_sha256 FROM media.zip_import_batches WHERE brand_id=$1 AND idempotency_key=$2 FOR UPDATE',
        [context.brandId, context.idempotencyKey]);
      if (prior.rows[0]) {
        if (prior.rows[0].request_sha256.trim() !== requestSha256) throw new ConflictException({ code: 'MEDIA_ZIP_IDEMPOTENCY_CONFLICT', message: 'The idempotency key was already used for another ZIP request.' });
        await client.query('COMMIT');
        return { id: prior.rows[0].id, status: prior.rows[0].state, rowVersion: prior.rows[0].row_version, requestId: context.requestId };
      }
      const resources = isZip ? await client.query<{ upload_id: string; created_by: string }>(
        `SELECT u.id AS upload_id,u.created_by FROM imports.import_uploads u
         JOIN media.zip_mapping_manifests m ON m.id=$3 AND m.brand_id=u.brand_id AND m.rights_attested=true
         WHERE u.id=$1 AND u.brand_id=$2 AND u.created_by=$4 AND u.source_kind='MEDIA_ZIP' AND u.mime_type='application/zip'
           AND u.status='PENDING' AND u.expires_at>now()
           AND EXISTS (SELECT 1 FROM access.effective_permissions ep WHERE ep.user_id=$4 AND ep.permission_code='media.write'
             AND ((ep.scope_type='global' AND ep.brand_id IS NULL) OR (ep.scope_type='brand' AND ep.brand_id=$2)))
           AND EXISTS (SELECT 1 FROM access.effective_permissions ep WHERE ep.user_id=$4 AND ep.permission_code='catalog.write'
             AND ((ep.scope_type='global' AND ep.brand_id IS NULL) OR (ep.scope_type='brand' AND ep.brand_id=$2)))
         FOR UPDATE OF u`, [input.fileUploadId, context.brandId, input.mappingManifestId, context.userId])
        : await client.query<{ upload_id: string; created_by: string }>(
          `SELECT NULL::uuid AS upload_id,m.created_by FROM media.zip_mapping_manifests m
           WHERE m.id=$1 AND m.brand_id=$2 AND m.rights_attested=true
             AND EXISTS (SELECT 1 FROM access.effective_permissions ep WHERE ep.user_id=$3 AND ep.permission_code='media.write'
               AND ((ep.scope_type='global' AND ep.brand_id IS NULL) OR (ep.scope_type='brand' AND ep.brand_id=$2)))
             AND EXISTS (SELECT 1 FROM access.effective_permissions ep WHERE ep.user_id=$3 AND ep.permission_code='catalog.write'
               AND ((ep.scope_type='global' AND ep.brand_id IS NULL) OR (ep.scope_type='brand' AND ep.brand_id=$2)))
           FOR UPDATE OF m`, [input.mappingManifestId, context.brandId, context.userId]);
      if (!resources.rowCount) throw new NotFoundException({ code: 'MEDIA_ZIP_RESOURCE_NOT_FOUND', message: 'The upload or mapping is not available.' });
      if (!isZip) {
        const targets = await client.query<{ sku_norm: string | null }>(
          `SELECT mi.sku_norm FROM unnest($1::text[],$2::smallint[]) AS x(sku,slot)
           LEFT JOIN media.zip_mapping_manifest_items mi ON mi.manifest_id=$3 AND mi.brand_id=$4 AND mi.sku_norm=upper(btrim(x.sku))`,
          [remoteImages.map((item) => item.sku), remoteImages.map((item) => item.slot), input.mappingManifestId, context.brandId]);
        if (targets.rowCount !== remoteImages.length || targets.rows.some((row) => !row.sku_norm)) {
          throw new UnprocessableEntityException({ code: 'MEDIA_ZIP_MAPPING_TARGET_INVALID', message: 'Every remote image SKU must exist in the saved brand mapping.' });
        }
      }
      const batchId = randomUUID();
      await client.query(`INSERT INTO media.zip_import_batches(id,brand_id,file_upload_id,source_kind,mapping_manifest_id,created_by,idempotency_key,request_sha256)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [batchId, context.brandId, input.fileUploadId ?? null, isZip ? 'MEDIA_ZIP' : 'REMOTE_URL', input.mappingManifestId,
        context.userId, context.idempotencyKey, requestSha256]);
      if (isZip) {
        const consumed = await client.query(`UPDATE imports.import_uploads SET status='CONSUMED',consumed_at=now()
          WHERE id=$1 AND brand_id=$2 AND status='PENDING'`, [input.fileUploadId, context.brandId]);
        if (!consumed.rowCount) throw new ConflictException({ code: 'MEDIA_ZIP_UPLOAD_CONSUMED', message: 'The ZIP upload is no longer available.' });
      } else {
        await client.query(`INSERT INTO media.zip_import_remote_items(batch_id,brand_id,mapping_manifest_id,sku,slot,source_url,source_url_sha256)
          SELECT $1,$2,$3,x.sku,x.slot,x.url,x.url_hash FROM unnest($4::text[],$5::smallint[],$6::text[],$7::text[])
            AS x(sku,slot,url,url_hash)`, [batchId, context.brandId, input.mappingManifestId, remoteImages.map((item) => item.sku),
          remoteImages.map((item) => item.slot), remoteImages.map((item) => item.url), remoteImages.map((item) => sha256(item.url))]);
      }
      await client.query(`INSERT INTO platform.outbox_events(aggregate_type,aggregate_id,event_type,event_version,event_payload,event_key)
        VALUES('media.zip_import',$1,'media.zip_import.requested',1,$2::jsonb,$3)`,
      [batchId, JSON.stringify({ brandId: context.brandId, batchId }), `media-zip-import:${batchId}`]);
      await client.query(`INSERT INTO media.zip_import_audit_events(brand_id,batch_id,manifest_id,actor_user_id,request_id,event_name,payload_sha256)
        VALUES($1,$2,$3,$4,$5,'batch_queued',$6)`, [context.brandId, batchId, input.mappingManifestId, context.userId, context.requestId, requestSha256]);
      await client.query('COMMIT');
      return { id: batchId, status: 'QUEUED', rowVersion: 1, requestId: context.requestId };
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
  }

  @Get('zip-imports/:batchId')
  @RequireBrandPermission('media.write')
  @ApiParam({ name: 'brandId', type: 'string', format: 'uuid' })
  @ApiParam({ name: 'batchId', type: 'string', format: 'uuid' })
  @ApiExtension('x-renivet-permission', 'media.write')
  @ApiExtension('x-renivet-implementation-wave', 'W2')
  @ApiOperation({ operationId: 'getMediaZipImportStatus', summary: 'Read a brand-owned media ZIP batch result', description: 'Returns only batch state and per-image outcome counts; cross-brand and missing batch IDs are indistinguishable. Linear: REN2-82.' })
  @ApiResponse({ status: 200, description: 'Media ZIP batch state and counts.', schema: BATCH_STATUS_SCHEMA })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 403, description: 'Brand permission denied.', schema: ERROR_SCHEMA })
  @ApiNotFoundResponse({ description: 'The batch is not accessible.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 422, description: 'Malformed media ZIP batch ID.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 503, description: 'Media status storage is unavailable.', schema: ERROR_SCHEMA })
  async getImportStatus(@Param('batchId', new ParseUUIDPipe()) batchId: string, @Req() request: MediaZipRequest) {
    const pool = this.infrastructure.pool;
    if (!pool) throw new ServiceUnavailableException({ code: 'MEDIA_DATABASE_UNAVAILABLE', message: 'Media status storage is unavailable.' });
    const result = await pool.query<{ id: string; state: string; row_version: number; failure_code: string | null; effect_count: string; succeeded_count: string; failed_count: string }>(
      `SELECT b.id,b.state,b.row_version,b.failure_code,count(e.id)::text AS effect_count,
        count(e.id) FILTER (WHERE e.state='SUCCEEDED')::text AS succeeded_count,
        count(e.id) FILTER (WHERE e.state='FAILED')::text AS failed_count
       FROM media.zip_import_batches b LEFT JOIN media.zip_import_effects e ON e.batch_id=b.id AND e.brand_id=b.brand_id
       WHERE b.id=$1 AND b.brand_id=$2 GROUP BY b.id`, [batchId, request.brandAccess!.brandId]);
    const row = result.rows[0];
    if (!row) throw new NotFoundException({ code: 'MEDIA_ZIP_BATCH_NOT_FOUND', message: 'The batch is not available.' });
    return { id: row.id, status: row.state, rowVersion: Number(row.row_version), effectCount: Number(row.effect_count),
      succeededCount: Number(row.succeeded_count), failedCount: Number(row.failed_count), errorCode: row.failure_code };
  }

  private async mutationContext(request: MediaZipRequest, key: string | undefined) {
    if (!key || !/^[A-Za-z0-9._:-]{1,120}$/.test(key)) throw new UnprocessableEntityException({ code: 'MEDIA_ZIP_REQUEST_INVALID', message: 'A valid idempotency key is required.' });
    const token = readSessionToken(request.headers.cookie);
    if (!token) throw new ForbiddenException({ code: 'CSRF_REJECTED', message: 'The operation could not be authorized.' });
    const session = await this.sessions.authenticate(token);
    const origins = this.config.get<string[]>('AUTH_ALLOWED_ORIGINS') ?? [];
    if (!csrfMatches(request.headers, origins, this.sessions.expectedCsrf(token))) throw new ForbiddenException({ code: 'CSRF_REJECTED', message: 'The operation could not be authorized.' });
    return { brandId: request.brandAccess!.brandId, userId: session.userId, permission: request.brandAccess!.permission,
      requestId: safeRequestId(request.id, `media-zip:${key}`), idempotencyKey: key };
  }
}

function sha256(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function safeRequestId(value: string | undefined, fallback: string): string {
  return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : fallback;
}
function isSafeRemoteUrlShape(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443')
      && !!url.hostname && !url.hostname.endsWith('.') && !url.hostname.includes('%') && !url.hash;
  } catch { return false; }
}
