import { createHash, randomUUID } from 'node:crypto';
import { Body, ConflictException, Controller, ForbiddenException, Headers, HttpCode, NotFoundException, Post, Req, ServiceUnavailableException, UnprocessableEntityException, UseFilters, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiExtension, ApiHeader, ApiNotFoundResponse, ApiOperation, ApiParam, ApiResponse, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { MfaGuard, RequireMfa } from '../../common/guards/require-mfa';
import { BrandAccessGuard, BrandAccessRequest, RequireBrandPermission } from '../access/brand-access.guard';
import { IdentityInfrastructure } from '../identity/identity-infrastructure';
import { csrfMatches, readSessionToken, SessionService } from '../identity/session.service';
import { BeginCatalogImportUploadDto, CreateCatalogImportDto } from './import-upload.dto';
import { readXlsxWorkbook, MAX_IMPORT_FILE_BYTES } from './import-workbook-reader';
import { detectImportFormatProfile, mapImportWorkbook } from './import-format-profiles';
import { parseCatalogCsv } from './import-csv-parser';
import { ImportExceptionFilter } from './import-exception.filter';

interface ImportRequest extends BrandAccessRequest { id?: string }
const VALIDATION = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true,
  exceptionFactory: () => new UnprocessableEntityException({ code: 'IMPORT_UPLOAD_INVALID', message: 'The import upload request is invalid.' }) });
const ERROR_SCHEMA = { type: 'object', required: ['code', 'message', 'requestId'], properties: {
  code: { type: 'string' }, message: { type: 'string' }, requestId: { type: 'string' }, details: { type: 'object', additionalProperties: true },
} };
const UPLOAD_INTENT_SCHEMA = { type: 'object', required: ['fileUploadId','uploadMethod','uploadUrl','expiresAt','headers'], properties: {
  fileUploadId: { type: 'string', format: 'uuid' }, uploadMethod: { type: 'string', const: 'PUT' },
  uploadUrl: { type: 'string', format: 'uri' }, expiresAt: { type: 'string', format: 'date-time' },
  headers: { type: 'object', additionalProperties: { type: 'string' } },
}, additionalProperties: false };
const ACCEPTED_SCHEMA = { type: 'object', required: ['batchId','status'], properties: {
  batchId: { type: 'string', format: 'uuid' }, status: { type: 'string', const: 'RECEIVED' },
} };
function auditRequestId(requestId: string | undefined, fallback: string): string {
  return requestId && /^[A-Za-z0-9._:-]{1,128}$/.test(requestId) ? requestId : fallback;
}

@ApiTags('Imports')
@ApiCookieAuth('sessionCookie')
@Controller('brands/:brandId/product-imports')
@UseGuards(BrandAccessGuard)
@UseFilters(ImportExceptionFilter)
export class ImportUploadController {
  private client: S3Client | null = null;
  constructor(private readonly infrastructure: IdentityInfrastructure, private readonly sessions: SessionService,
    private readonly config: ConfigService) {}

  @Post('uploads')
  @HttpCode(201)
  @UseGuards(MfaGuard)
  @UsePipes(VALIDATION)
  @RequireBrandPermission('imports.write')
  @RequireMfa('imports.write')
  @ApiParam({ name: 'brandId', type: 'string', format: 'uuid' })
  @ApiExtension('x-renivet-permission', 'imports.write')
  @ApiExtension('x-renivet-implementation-wave', 'W2')
  @ApiExtension('x-renivet-csrf-policy', 'W1 session-bound X-CSRF-Token, allowlisted Origin, and Sec-Fetch-Site same-origin validation required; imports.write permission and MFA step-up are required.')
  @ApiOperation({ operationId: 'beginCatalogImportUpload', summary: 'Create a private source-file upload intent', description: 'Creates a brand-bound, short-lived upload capability for one CSV/XLSX file. The file remains private and is not applied to catalog or inventory.' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: { type: 'string', minLength: 1, maxLength: 120 } })
  @ApiBody({ schema: { type: 'object', additionalProperties: false, required: ['sourceKind','fileName','mimeType','byteLength','sha256'], properties: {
    sourceKind: { type: 'string', enum: ['RENIVET_CSV','RENIVET_XLSX','SHOPIFY_CSV','UNIWARE_CSV','GENERIC_CSV'] },
    fileName: { type: 'string', minLength: 1, maxLength: 160 },
    mimeType: { type: 'string', enum: ['text/csv','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'] },
    byteLength: { type: 'integer', minimum: 1, maximum: 10485760 },
    sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  } } })
  @ApiResponse({ status: 201, description: 'Short-lived private source-file upload intent.', schema: UPLOAD_INTENT_SCHEMA })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 403, description: 'Brand permission, MFA, or CSRF denied.', schema: ERROR_SCHEMA })
  @ApiNotFoundResponse({ description: 'Brand was not found or is not accessible.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 409, description: 'Idempotency conflict or expired intent.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 422, description: 'File metadata is invalid.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 503, description: 'Storage or database is unavailable.', schema: ERROR_SCHEMA })
  async begin(@Body() input: BeginCatalogImportUploadDto, @Req() request: ImportRequest, @Headers('Idempotency-Key') key?: string) {
    if (!key || !/^[A-Za-z0-9._:-]{1,120}$/.test(key)) {
      throw new UnprocessableEntityException({ code: 'IMPORT_UPLOAD_INVALID', message: 'A valid idempotency key is required.' });
    }
    if ((input.sourceKind === 'RENIVET_XLSX') !== (input.mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')) {
      throw new UnprocessableEntityException({ code: 'IMPORT_SOURCE_KIND_CONFLICT', message: 'The file format does not match the source type.' });
    }
    const token = readSessionToken(request.headers.cookie);
    if (!token) throw new ForbiddenException({ code: 'CSRF_REJECTED', message: 'The operation could not be authorized.' });
    const session = await this.sessions.authenticate(token);
    const origins = this.config.get<string[]>('AUTH_ALLOWED_ORIGINS') ?? [];
    if (!csrfMatches(request.headers, origins, this.sessions.expectedCsrf(token))) {
      throw new ForbiddenException({ code: 'CSRF_REJECTED', message: 'The operation could not be authorized.' });
    }
    const endpoint = this.config.get<string>('MEDIA_SPACES_ENDPOINT');
    const bucket = this.config.get<string>('MEDIA_SPACES_BUCKET')?.trim();
    const region = this.config.get<string>('MEDIA_SPACES_REGION')?.trim();
    const accessKeyId = this.config.get<string>('MEDIA_SPACES_ACCESS_KEY_ID')?.trim();
    const secretAccessKey = this.config.get<string>('MEDIA_SPACES_SECRET_ACCESS_KEY')?.trim();
    let parsedEndpoint: URL;
    try { parsedEndpoint = new URL(endpoint ?? ''); } catch { throw new ServiceUnavailableException({ code: 'IMPORT_STORAGE_UNAVAILABLE', message: 'Import storage is unavailable.' }); }
    if (parsedEndpoint.protocol !== 'https:' || !(parsedEndpoint.hostname === 'digitaloceanspaces.com'
      || parsedEndpoint.hostname.endsWith('.digitaloceanspaces.com'))
      || parsedEndpoint.username || parsedEndpoint.password || parsedEndpoint.search || parsedEndpoint.hash
      || parsedEndpoint.pathname !== '/' || !bucket || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)
      || !region || !/^[a-z0-9-]{2,32}$/.test(region) || !accessKeyId || !secretAccessKey) {
      throw new ServiceUnavailableException({ code: 'IMPORT_STORAGE_UNAVAILABLE', message: 'Import storage is unavailable.' });
    }
    const pool = this.infrastructure.pool;
    if (!pool) throw new ServiceUnavailableException({ code: 'IMPORT_DATABASE_UNAVAILABLE', message: 'Import storage is unavailable.' });
    const access = request.brandAccess!;
    const existing = await pool.query(`SELECT * FROM imports.import_uploads u WHERE u.brand_id=$1 AND u.idempotency_key=$2
      AND EXISTS (SELECT 1 FROM access.effective_permissions p WHERE p.user_id=$3 AND p.permission_code='imports.write'
        AND ((p.scope_type='global' AND p.brand_id IS NULL) OR (p.scope_type='brand' AND p.brand_id=$1)))`, [access.brandId, key, session.userId]);
    let row = existing.rows[0];
    if (row && (row.source_kind !== input.sourceKind || row.file_name !== input.fileName || row.mime_type !== input.mimeType
      || row.byte_length !== input.byteLength || row.source_sha256.trim() !== input.sha256.toLowerCase())) {
      throw new ConflictException({ code: 'IMPORT_IDEMPOTENCY_CONFLICT', message: 'The idempotency key was already used for different file metadata.' });
    }
    const fileUploadId: string = row?.id ?? randomUUID();
    const storageKey: string = row?.storage_key ?? `brands/${access.brandId}/imports/${fileUploadId}/source`;
    if (!row) {
      const inserted = await pool.query(`WITH created AS (
        INSERT INTO imports.import_uploads
        (id,brand_id,source_kind,file_name,mime_type,byte_length,source_sha256,storage_key,idempotency_key,created_by,expires_at)
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now()+interval '5 minutes'
        WHERE EXISTS (SELECT 1 FROM access.effective_permissions p WHERE p.user_id=$10 AND p.permission_code='imports.write'
          AND ((p.scope_type='global' AND p.brand_id IS NULL) OR (p.scope_type='brand' AND p.brand_id=$2)))
        ON CONFLICT (brand_id,idempotency_key) DO NOTHING
        RETURNING id,brand_id
      ), audit_event AS (
        INSERT INTO access.security_audit_events (actor_user_id,action,subject_type,subject_id,request_id,payload_hash)
        SELECT $10,'imports.upload_intent.created','imports.file_upload',id,$11,$12 FROM created
        RETURNING subject_id
      ) SELECT id FROM created`,
      [fileUploadId, access.brandId, input.sourceKind, input.fileName, input.mimeType, input.byteLength, input.sha256.toLowerCase(), storageKey, key, session.userId,
        auditRequestId(request.id, `upload:${key}`), createHash('sha256').update(JSON.stringify({ brandId: access.brandId, sourceKind: input.sourceKind,
          mimeType: input.mimeType, byteLength: input.byteLength, sourceSha256: input.sha256.toLowerCase() })).digest('hex')]);
      if (!inserted.rowCount) {
        const raced = await pool.query(`SELECT * FROM imports.import_uploads u WHERE u.brand_id=$1 AND u.idempotency_key=$2
          AND EXISTS (SELECT 1 FROM access.effective_permissions p WHERE p.user_id=$3 AND p.permission_code='imports.write'
            AND ((p.scope_type='global' AND p.brand_id IS NULL) OR (p.scope_type='brand' AND p.brand_id=$1)))`, [access.brandId, key, session.userId]);
        row = raced.rows[0];
        if (!row) throw new ForbiddenException({ code: 'BRAND_ACCESS_DENIED', message: 'The operation could not be authorized.' });
        if (row.source_kind !== input.sourceKind || row.file_name !== input.fileName || row.mime_type !== input.mimeType
          || row.byte_length !== input.byteLength || row.source_sha256.trim() !== input.sha256.toLowerCase()) {
          throw new ConflictException({ code: 'IMPORT_IDEMPOTENCY_CONFLICT', message: 'The idempotency key was already used for different file metadata.' });
        }
      }
    }
    if (row && (row.status !== 'PENDING' || new Date(row.expires_at).getTime() <= Date.now())) {
      throw new ConflictException({ code: 'IMPORT_UPLOAD_EXPIRED', message: 'The upload intent is no longer available.' });
    }
    this.client ??= new S3Client({ endpoint: parsedEndpoint.origin, region, forcePathStyle: false,
      credentials: { accessKeyId, secretAccessKey } });
    const command = new PutObjectCommand({ Bucket: bucket, Key: storageKey, ContentType: input.mimeType,
      ContentLength: input.byteLength, ACL: 'private', Metadata: { 'renivet-brand-id': access.brandId,
        'renivet-import-upload-id': fileUploadId, 'renivet-sha256': input.sha256.toLowerCase() }, CacheControl: 'private, no-store' });
    const expiresAt = row?.expires_at ?? new Date(Date.now() + 5 * 60_000);
    const expiresIn = Math.max(1, Math.min(300, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000)));
    let uploadUrl: string;
    try { uploadUrl = await getSignedUrl(this.client, command, { expiresIn }); }
    catch { throw new ServiceUnavailableException({ code: 'IMPORT_STORAGE_UNAVAILABLE', message: 'Import storage is unavailable.' }); }
    return { fileUploadId, uploadMethod: 'PUT', uploadUrl, expiresAt: new Date(expiresAt).toISOString(), headers: {
      'content-type': input.mimeType, 'x-amz-acl': 'private', 'x-amz-meta-renivet-brand-id': access.brandId,
      'x-amz-meta-renivet-import-upload-id': fileUploadId, 'x-amz-meta-renivet-sha256': input.sha256.toLowerCase(),
    } };
  }

  @Post()
  @HttpCode(202)
  @UseGuards(MfaGuard)
  @UsePipes(VALIDATION)
  @RequireBrandPermission('imports.write')
  @RequireMfa('imports.write')
  @ApiParam({ name: 'brandId', type: 'string', format: 'uuid' })
  @ApiExtension('x-renivet-permission', 'imports.write')
  @ApiExtension('x-renivet-implementation-wave', 'W2')
  @ApiExtension('x-renivet-csrf-policy', 'W1 session-bound X-CSRF-Token, allowlisted Origin, and Sec-Fetch-Site same-origin validation required; imports.write permission and MFA step-up are required.')
  @ApiOperation({ operationId: 'createCatalogImport', summary: 'Stage a brand-owned catalog import batch', description: 'Verifies and parses the private uploaded source, stores normalized rows and row-level errors in an immutable batch, and does not write product or stock records.' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: { type: 'string', minLength: 1, maxLength: 120 } })
  @ApiBody({ schema: { type: 'object', required: ['sourceKind','sourceAsOf','fileUploadId','mode'], properties: {
    sourceKind: { type: 'string', enum: ['RENIVET_CSV','RENIVET_XLSX','SHOPIFY_CSV','UNIWARE_CSV','GENERIC_CSV'] },
    sourceAsOf: { type: 'string', format: 'date-time' }, fileUploadId: { type: 'string', format: 'uuid' },
    mode: { type: 'string', enum: ['CREATE_ONLY','UPDATE_MATCHED','SKIP_EXISTING','REVIEW_CONFLICT'] },
  } } })
  @ApiResponse({ status: 202, description: 'Import batch accepted for review.', schema: ACCEPTED_SCHEMA })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 403, description: 'Brand permission, MFA, or CSRF denied.', schema: ERROR_SCHEMA })
  @ApiNotFoundResponse({ description: 'Upload is not accessible.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 409, description: 'Upload was already consumed, expired, or conflicts with this request.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 422, description: 'File metadata or content is invalid.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 503, description: 'Storage or database is unavailable.', schema: ERROR_SCHEMA })
  async create(@Body() input: CreateCatalogImportDto, @Req() request: ImportRequest, @Headers('Idempotency-Key') key?: string) {
    if (!key || !/^[A-Za-z0-9._:-]{1,120}$/.test(key)) {
      throw new UnprocessableEntityException({ code: 'IMPORT_BATCH_INVALID', message: 'A valid idempotency key is required.' });
    }
    const token = readSessionToken(request.headers.cookie);
    if (!token) throw new ForbiddenException({ code: 'CSRF_REJECTED', message: 'The operation could not be authorized.' });
    const session = await this.sessions.authenticate(token);
    const origins = this.config.get<string[]>('AUTH_ALLOWED_ORIGINS') ?? [];
    if (!csrfMatches(request.headers, origins, this.sessions.expectedCsrf(token))) {
      throw new ForbiddenException({ code: 'CSRF_REJECTED', message: 'The operation could not be authorized.' });
    }
    const pool = this.infrastructure.pool;
    if (!pool) throw new ServiceUnavailableException({ code: 'IMPORT_DATABASE_UNAVAILABLE', message: 'Import storage is unavailable.' });
    const access = request.brandAccess!;
    const stored = await pool.query(`SELECT * FROM imports.import_uploads u WHERE u.id=$1 AND u.brand_id=$2
      AND EXISTS (SELECT 1 FROM access.effective_permissions p WHERE p.user_id=$3 AND p.permission_code='imports.write'
        AND ((p.scope_type='global' AND p.brand_id IS NULL) OR (p.scope_type='brand' AND p.brand_id=$2)))`, [input.fileUploadId, access.brandId, session.userId]);
    const upload = stored.rows[0];
    if (!upload) throw new NotFoundException({ code: 'IMPORT_UPLOAD_NOT_FOUND', message: 'The upload is not available.' });
    if (upload.source_kind !== input.sourceKind) throw new ConflictException({ code: 'IMPORT_SOURCE_KIND_CONFLICT', message: 'The uploaded file does not match this import request.' });
    if (upload.status === 'CONSUMED') {
      const prior = await pool.query('SELECT id,source_kind,source_as_of,requested_policy FROM imports.import_batches WHERE file_upload_id=$1 AND brand_id=$2', [upload.id, access.brandId]);
      if (prior.rows[0]) {
        const policy = prior.rows[0].requested_policy ?? {};
        if (prior.rows[0].source_kind === input.sourceKind && new Date(prior.rows[0].source_as_of).toISOString() === new Date(input.sourceAsOf).toISOString()
          && policy.mode === input.mode && policy.idempotencyKey === key) return { batchId: prior.rows[0].id, status: 'RECEIVED' };
        throw new ConflictException({ code: 'IMPORT_IDEMPOTENCY_CONFLICT', message: 'The upload was already used for a different import request.' });
      }
      throw new ConflictException({ code: 'IMPORT_UPLOAD_CONSUMED', message: 'The upload is no longer available.' });
    }
    if (upload.status !== 'PENDING' || new Date(upload.expires_at).getTime() <= Date.now()) {
      throw new ConflictException({ code: 'IMPORT_UPLOAD_EXPIRED', message: 'The upload is no longer available.' });
    }
    const endpoint = this.config.get<string>('MEDIA_SPACES_ENDPOINT');
    const bucket = this.config.get<string>('MEDIA_SPACES_BUCKET')?.trim();
    const region = this.config.get<string>('MEDIA_SPACES_REGION')?.trim();
    const accessKeyId = this.config.get<string>('MEDIA_SPACES_ACCESS_KEY_ID')?.trim();
    const secretAccessKey = this.config.get<string>('MEDIA_SPACES_SECRET_ACCESS_KEY')?.trim();
    let storageEndpoint: URL;
    try { storageEndpoint = new URL(endpoint ?? ''); } catch { throw new ServiceUnavailableException({ code: 'IMPORT_STORAGE_UNAVAILABLE', message: 'Import storage is unavailable.' }); }
    if (!(storageEndpoint.hostname === 'digitaloceanspaces.com' || storageEndpoint.hostname.endsWith('.digitaloceanspaces.com'))
      || storageEndpoint.protocol !== 'https:' || storageEndpoint.username || storageEndpoint.password || storageEndpoint.search
      || storageEndpoint.hash || storageEndpoint.pathname !== '/' || !bucket || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)
      || !region || !/^[a-z0-9-]{2,32}$/.test(region) || !accessKeyId || !secretAccessKey) {
      throw new ServiceUnavailableException({ code: 'IMPORT_STORAGE_UNAVAILABLE', message: 'Import storage is unavailable.' });
    }
    this.client ??= new S3Client({ endpoint: storageEndpoint.origin, region, forcePathStyle: false,
      credentials: { accessKeyId, secretAccessKey } });
    let bytes: Buffer;
    try {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: bucket, Key: upload.storage_key }));
      if (!Number.isSafeInteger(head.ContentLength) || head.ContentLength !== upload.byte_length || Number(head.ContentLength) > MAX_IMPORT_FILE_BYTES
        || head.ContentType !== upload.mime_type || head.Metadata?.['renivet-brand-id'] !== access.brandId
        || head.Metadata?.['renivet-import-upload-id'] !== upload.id || head.Metadata?.['renivet-sha256'] !== upload.source_sha256.trim()) {
        throw new UnprocessableEntityException({ code: 'IMPORT_UPLOAD_METADATA_MISMATCH', message: 'The uploaded file failed verification.' });
      }
      const object = await this.client.send(new GetObjectCommand({ Bucket: bucket, Key: upload.storage_key }));
      if (!object.Body) throw new Error('missing object body');
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of object.Body as AsyncIterable<Uint8Array>) {
        size += chunk.length;
        if (size > MAX_IMPORT_FILE_BYTES) throw new UnprocessableEntityException({ code: 'IMPORT_FILE_LIMIT_EXCEEDED', message: 'The uploaded file is too large.' });
        chunks.push(Buffer.from(chunk));
      }
      bytes = Buffer.concat(chunks, size);
    } catch (error) {
      if (error instanceof UnprocessableEntityException) throw error;
      throw new ServiceUnavailableException({ code: 'IMPORT_STORAGE_UNAVAILABLE', message: 'Import storage is unavailable.' });
    }
    if (bytes.length !== upload.byte_length || createHash('sha256').update(bytes).digest('hex') !== upload.source_sha256.trim()) {
      throw new UnprocessableEntityException({ code: 'IMPORT_CHECKSUM_MISMATCH', message: 'The uploaded file failed verification.' });
    }
    let parsed;
    try {
      if (upload.mime_type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
        if (input.sourceKind !== 'RENIVET_XLSX') throw new UnprocessableEntityException({ code: 'IMPORT_SOURCE_KIND_CONFLICT', message: 'The file format does not match the source type.' });
        const sheets = await readXlsxWorkbook(bytes);
        const profile = detectImportFormatProfile({ sourceKind: 'RENIVET_XLSX', sheets });
        parsed = mapImportWorkbook({ profile, sheets });
      } else {
        if (input.sourceKind === 'RENIVET_XLSX') throw new UnprocessableEntityException({ code: 'IMPORT_SOURCE_KIND_CONFLICT', message: 'The file format does not match the source type.' });
        parsed = parseCatalogCsv({ bytes, sourceKind: input.sourceKind, sourceAsOf: input.sourceAsOf });
      }
    } catch (error) {
      if (error instanceof UnprocessableEntityException) throw error;
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'IMPORT_FILE_INVALID';
      throw new UnprocessableEntityException({ code, message: 'The source file could not be parsed.' });
    }
    const rowErrors = new Map(parsed.rowErrors.map((issue) => [issue.sourceRowNumber, issue.code]));
    const canonicalByRow = new Map(parsed.catalogRows.map((record, index) => [parsed.catalogRowNumbers[index], record]));
    const batchId = randomUUID();
    const immutableStorageKey = `brands/${access.brandId}/imports/${upload.id}/committed/${batchId}`;
    try {
      await this.client.send(new PutObjectCommand({ Bucket: bucket, Key: immutableStorageKey, Body: bytes,
        ContentLength: bytes.length, ContentType: upload.mime_type, ACL: 'private', CacheControl: 'private, no-store',
        Metadata: { 'renivet-brand-id': access.brandId, 'renivet-import-upload-id': upload.id,
          'renivet-source-sha256': upload.source_sha256.trim(), 'renivet-import-batch-id': batchId } }));
    } catch {
      throw new ServiceUnavailableException({ code: 'IMPORT_STORAGE_UNAVAILABLE', message: 'Import storage is unavailable.' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query(`SELECT * FROM imports.import_uploads WHERE id=$1 AND brand_id=$2 FOR UPDATE`, [upload.id, access.brandId]);
      const current = locked.rows[0];
      if (!current || current.status !== 'PENDING' || new Date(current.expires_at).getTime() <= Date.now()) {
        const prior = await client.query('SELECT id,source_kind,source_as_of,requested_policy FROM imports.import_batches WHERE file_upload_id=$1 AND brand_id=$2', [upload.id, access.brandId]);
        if (prior.rows[0]) {
          const policy = prior.rows[0].requested_policy ?? {};
          if (prior.rows[0].source_kind === input.sourceKind && new Date(prior.rows[0].source_as_of).toISOString() === new Date(input.sourceAsOf).toISOString()
            && policy.mode === input.mode && policy.idempotencyKey === key) {
            await client.query('COMMIT'); return { batchId: prior.rows[0].id, status: 'RECEIVED' };
          }
          throw new ConflictException({ code: 'IMPORT_IDEMPOTENCY_CONFLICT', message: 'The upload was already used for a different import request.' });
        }
        throw new ConflictException({ code: 'IMPORT_UPLOAD_CONSUMED', message: 'The upload is no longer available.' });
      }
      const inserted = await client.query(`INSERT INTO imports.import_batches
        (id,brand_id,source_kind,source_sha256,raw_storage_key,schema_version,source_as_of,job_state,requested_policy,created_by,file_upload_id)
        SELECT $1,$2,$3,$4,$5,$6,$7,'RECEIVED',$8::jsonb,$9,$10
        WHERE EXISTS (SELECT 1 FROM access.effective_permissions p WHERE p.user_id=$9 AND p.permission_code='imports.write'
          AND ((p.scope_type='global' AND p.brand_id IS NULL) OR (p.scope_type='brand' AND p.brand_id=$2)))
      RETURNING id`, [batchId, access.brandId, input.sourceKind, upload.source_sha256.trim(), immutableStorageKey,
        `${parsed.profileId}@${parsed.profileVersion}`, input.sourceAsOf, JSON.stringify({ mode: input.mode, idempotencyKey: key, profileId: parsed.profileId, profileVersion: parsed.profileVersion, provisional: true }), session.userId, upload.id]);
      if (!inserted.rowCount) throw new ForbiddenException({ code: 'BRAND_ACCESS_DENIED', message: 'The operation could not be authorized.' });
      for (const source of parsed.rawRows) {
        const code = rowErrors.get(source.sourceRowNumber);
        await client.query(`INSERT INTO imports.import_rows (batch_id,brand_id,source_row_number,raw_record,canonical_record,validation_errors,row_state)
          VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7)`, [batchId, access.brandId, source.sourceRowNumber,
          JSON.stringify(source.rawRecord), canonicalByRow.has(source.sourceRowNumber) ? JSON.stringify(canonicalByRow.get(source.sourceRowNumber)) : null,
          JSON.stringify(code ? [{ code }] : []), code ? 'INVALID' : 'STAGED']);
      }
      const auditPayloadHash = createHash('sha256').update(JSON.stringify({ brandId: access.brandId, fileUploadId: upload.id,
        batchId, sourceKind: input.sourceKind, profileId: parsed.profileId, profileVersion: parsed.profileVersion,
        catalogRows: parsed.catalogRows.length, stockObservations: parsed.stockObservations.length, invalidRows: parsed.rowErrors.length })).digest('hex');
      await client.query(`INSERT INTO access.security_audit_events
        (actor_user_id,action,subject_type,subject_id,request_id,payload_hash)
        VALUES ($1,'imports.catalog_batch.staged','imports.batch',$2,$3,$4)`, [session.userId, batchId,
        auditRequestId(request.id, `batch:${batchId}`), auditPayloadHash]);
      await client.query(`UPDATE imports.import_uploads SET status='CONSUMED',consumed_at=now()
        WHERE id=$1 AND brand_id=$2 AND status='PENDING'`, [upload.id, access.brandId]);
      await client.query('COMMIT');
      return { batchId, status: 'RECEIVED' };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
}
