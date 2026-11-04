import {
  Body, Controller, ForbiddenException, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Req,
  UnprocessableEntityException, UseFilters, UseGuards, UsePipes, ValidationPipe,
} from '@nestjs/common';
import {
  ApiBody, ApiCookieAuth, ApiExtension, ApiHeader, ApiNotFoundResponse, ApiOperation, ApiParam,
  ApiResponse, ApiServiceUnavailableResponse, ApiTags, ApiUnauthorizedResponse, SchemaObject,
} from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { MfaGuard, RequireMfa } from '../../common/guards/require-mfa';
import { BrandAccessGuard, BrandAccessRequest, RequireBrandPermission } from '../access/brand-access.guard';
import { csrfMatches, readSessionToken, SessionService } from '../identity/session.service';
import { BeginMediaUploadDto, CompleteMediaUploadDto } from './media.dto';
import { MediaService } from './media.service';
import { MediaExceptionFilter } from './media-exception.filter';

interface MediaRequest extends BrandAccessRequest { id?: string; }
const VALIDATION = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true,
  exceptionFactory: () => new UnprocessableEntityException({ code: 'MEDIA_UPLOAD_INVALID', message: 'The media request is invalid.' }) });
const ERROR_SCHEMA = { type: 'object', required: ['code', 'message', 'requestId'], properties: {
  code: { type: 'string' }, message: { type: 'string' }, requestId: { type: 'string' }, details: { type: 'object', additionalProperties: true },
} };
const UPLOAD_INTENT_SCHEMA = { type: 'object', required: ['mediaAssetId','uploadMethod','uploadUrl','expiresAt','headers'], properties: {
  mediaAssetId: { type: 'string', format: 'uuid' }, uploadMethod: { type: 'string', const: 'PUT' },
  uploadUrl: { type: 'string', format: 'uri' }, expiresAt: { type: 'string', format: 'date-time' },
  headers: { type: 'object', additionalProperties: { type: 'string' } },
} };
const ACTION_RECEIPT_SCHEMA = { type: 'object', required: ['id','status','requestId'], properties: {
  id: { type: 'string', format: 'uuid' }, status: { type: 'string' }, requestId: { type: 'string' }, rowVersion: { type: 'integer', minimum: 1 },
} };
const MEDIA_STATUS_SCHEMA = { type: 'object', required: ['id','scanState','rightsState'], properties: {
  id: { type: 'string', format: 'uuid' }, scanState: { type: 'string' }, rightsState: { type: 'string' },
  derivativeState: { type: 'string' }, safePreviewUrl: { type: ['string','null'], format: 'uri' },
} };

@ApiTags('Media')
@ApiCookieAuth('sessionCookie')
@Controller('brands/:brandId/media')
@UseGuards(BrandAccessGuard)
@UseFilters(MediaExceptionFilter)
export class MediaController {
  constructor(private readonly media: MediaService, private readonly sessions: SessionService, private readonly config: ConfigService) {}

  @Post('uploads')
  @HttpCode(201)
  @UseGuards(MfaGuard)
  @UsePipes(VALIDATION)
  @RequireBrandPermission('media.write')
  @RequireMfa('media.write')
  @ApiParam({ name: 'brandId', type: 'string', format: 'uuid' })
  @ApiExtension('x-renivet-permission', 'media.write')
  @ApiExtension('x-renivet-implementation-wave', 'W2')
  @ApiExtension('x-renivet-security-review', ['W1 effective permissions', 'scoped resource SQL', 'cookie CSRF policy', 'immutable audit'])
  @ApiExtension('x-renivet-csrf-policy', 'W1 session-bound X-CSRF-Token, allowlisted Origin, and Sec-Fetch-Site same-origin validation required; MFA step-up and live media.write permission are required.')
  @ApiOperation({ operationId: 'beginMediaUpload', summary: 'Issue a short-lived private image upload intent', description: 'Creates a brand-owned pending media asset and returns a five-minute DigitalOcean Spaces PUT capability. Linear: REN2-66.' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: { type: 'string', minLength: 1, maxLength: 120 } })
  @ApiBody({ schema: { type: 'object', required: ['fileName','mimeType','byteLength','rightsAttested'], additionalProperties: false, properties: {
    fileName: { type: 'string' }, mimeType: { type: 'string' },
    byteLength: { type: 'integer', minimum: 1, description: 'Images are limited to 10 MiB.' },
    rightsAttested: { type: 'boolean' }, sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
  } } })
  @ApiResponse({ status: 201, description: 'Short-lived private storage upload intent.', schema: UPLOAD_INTENT_SCHEMA as unknown as SchemaObject })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 403, description: 'Brand permission, MFA, or CSRF denied.', schema: ERROR_SCHEMA })
  @ApiNotFoundResponse({ description: 'Brand was not found or is not accessible.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 409, description: 'Idempotency conflict or expired intent.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 422, description: 'Image request failed validation.', schema: ERROR_SCHEMA })
  @ApiServiceUnavailableResponse({ description: 'Storage or malware scanning is unavailable.', schema: ERROR_SCHEMA })
  async begin(@Body() body: BeginMediaUploadDto, @Req() request: MediaRequest, @Headers('Idempotency-Key') key?: string) {
    const context = await this.mutationContext(request, key);
    return this.media.begin(body, context);
  }

  @Post(':mediaId/complete')
  @HttpCode(202)
  @UseGuards(MfaGuard)
  @UsePipes(VALIDATION)
  @RequireBrandPermission('catalog.write')
  @RequireMfa('media.write')
  @ApiParam({ name: 'brandId', type: 'string', format: 'uuid' })
  @ApiParam({ name: 'mediaId', type: 'string', format: 'uuid' })
  @ApiExtension('x-renivet-permission', 'catalog.write')
  @ApiExtension('x-renivet-guard', 'brand')
  @ApiExtension('x-renivet-implementation-wave', 'W2')
  @ApiExtension('x-renivet-csrf-policy', 'W1 session-bound X-CSRF-Token, allowlisted Origin and Sec-Fetch-Site same-origin validation required; media.write MFA step-up is required.')
  @ApiOperation({ operationId: 'completeMediaUpload', summary: 'Validate and scan a completed media upload', description: 'Checks brand-bound object metadata, byte length, magic bytes, SHA-256, ClamAV result, rights attestation and private derivatives. Linear: REN2-66.' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: { type: 'string', minLength: 1, maxLength: 120 } })
  @ApiBody({ schema: { type: 'object', required: ['sha256','sizeBytes'], properties: {
    sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' }, sizeBytes: { type: 'integer', minimum: 1 },
  } } })
  @ApiResponse({ status: 202, description: 'Media scan lifecycle receipt.', schema: ACTION_RECEIPT_SCHEMA as unknown as SchemaObject })
  @ApiResponse({ status: 400, description: 'Malformed media ID.', schema: ERROR_SCHEMA })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 403, description: 'Brand permission, MFA, or CSRF denied.', schema: ERROR_SCHEMA })
  @ApiNotFoundResponse({ description: 'Media asset is not accessible.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 409, description: 'Upload is not available, expired, or conflicts with an earlier request.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 412, description: 'Media version is stale.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 422, description: 'Media content, malware scan, or rights validation failed.', schema: ERROR_SCHEMA })
  @ApiServiceUnavailableResponse({ description: 'Storage, scanner, or database is temporarily unavailable.', schema: ERROR_SCHEMA })
  async complete(@Param('mediaId', new ParseUUIDPipe()) mediaId: string, @Body() body: CompleteMediaUploadDto,
    @Req() request: MediaRequest, @Headers('Idempotency-Key') key?: string) {
    const context = await this.mutationContext(request, key);
    return this.media.complete(mediaId, body, context);
  }

  @Get(':mediaId')
  @RequireBrandPermission('catalog.read')
  @ApiParam({ name: 'brandId', type: 'string', format: 'uuid' })
  @ApiParam({ name: 'mediaId', type: 'string', format: 'uuid' })
  @ApiExtension('x-renivet-permission', 'catalog.read')
  @ApiExtension('x-renivet-guard', 'brand')
  @ApiExtension('x-renivet-implementation-wave', 'W2')
  @ApiOperation({ operationId: 'getMediaAssetStatus', summary: 'Read brand-owned media processing status', description: 'Returns scan and rights state, derivative state, and a short-lived private preview URL only for clean assets. Linear: REN2-66.' })
  @ApiResponse({ status: 200, description: 'Media asset status.', schema: MEDIA_STATUS_SCHEMA as unknown as SchemaObject })
  @ApiResponse({ status: 400, description: 'Malformed media ID.', schema: ERROR_SCHEMA })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 403, description: 'Brand permission denied.', schema: ERROR_SCHEMA })
  @ApiNotFoundResponse({ description: 'Media asset is not accessible.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 409, description: 'Media resource conflict.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 412, description: 'Media version is stale.', schema: ERROR_SCHEMA })
  @ApiResponse({ status: 422, description: 'Media identifier failed validation.', schema: ERROR_SCHEMA })
  @ApiServiceUnavailableResponse({ description: 'Media status storage is unavailable.', schema: ERROR_SCHEMA })
  async status(@Param('mediaId', new ParseUUIDPipe()) mediaId: string, @Req() request: MediaRequest) {
    const access = request.brandAccess!;
    return this.media.status(mediaId, {
      brandId: access.brandId, userId: access.userId, permission: access.permission,
      requestId: request.id ?? `media-status:${mediaId}`,
    });
  }

  private async mutationContext(request: MediaRequest, key: string | undefined) {
    if (!key || !/^[A-Za-z0-9._:-]{1,120}$/.test(key)) {
      throw new UnprocessableEntityException({ code: 'MEDIA_UPLOAD_INVALID', message: 'A valid idempotency key is required.' });
    }
    const token = readSessionToken(request.headers.cookie);
    if (!token) throw new ForbiddenException({ code: 'CSRF_REJECTED', message: 'The operation could not be authorized.' });
    const session = await this.sessions.authenticate(token);
    const origins = this.config.get<string[]>('AUTH_ALLOWED_ORIGINS') ?? [];
    if (!csrfMatches(request.headers, origins, this.sessions.expectedCsrf(token))) {
      throw new ForbiddenException({ code: 'CSRF_REJECTED', message: 'The operation could not be authorized.' });
    }
    const access = request.brandAccess!;
    return { brandId: access.brandId, userId: session.userId, permission: access.permission,
      requestId: request.id ?? `media:${key}`, idempotencyKey: key };
  }
}
