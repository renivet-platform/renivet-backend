import { Body, Controller, ForbiddenException, Get, Headers, Param, ParseUUIDPipe, Put, Query, StreamableFile, UnprocessableEntityException, UseFilters } from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { MediaService } from './media.service';
import { MediaExceptionFilter } from './media-exception.filter';
import { LocalMediaStorage } from './local-media-storage';
import { mediaObjectKey } from './spaces-media-storage';
import { MAX_MEDIA_UPLOAD_BYTES } from './media-validation';

@Controller('brands/:brandId/media')
@UseFilters(MediaExceptionFilter)
export class LocalMediaTransferController {
  constructor(private readonly media: MediaService, private readonly storage: LocalMediaStorage,
    private readonly config: ConfigService) {}

  @Put('local-uploads/:mediaId/:nonce')
  @ApiExcludeEndpoint()
  async upload(@Param('brandId', new ParseUUIDPipe()) brandId: string,
    @Param('mediaId', new ParseUUIDPipe()) mediaId: string, @Param('nonce', new ParseUUIDPipe()) nonce: string,
    @Headers('x-renivet-local-upload-token') capability: string | undefined, @Headers('content-type') contentType: string | undefined,
    @Headers('content-length') contentLength: string | undefined, @Headers('origin') origin: string | undefined,
    @Body() body: Buffer): Promise<{ status: string }> {
    this.requireEnabled();
    this.requireAllowedOrigin(origin);
    const size = Number(contentLength);
    if (!capability || !contentType || !Number.isSafeInteger(size) || size < 1 || size > MAX_MEDIA_UPLOAD_BYTES) {
      throw new UnprocessableEntityException({ code: 'MEDIA_UPLOAD_INVALID', message: 'The media upload request is invalid.' });
    }
    if (!Buffer.isBuffer(body) || body.length !== size) {
      throw new UnprocessableEntityException({ code: 'MEDIA_UPLOAD_INVALID', message: 'The media upload request is incomplete.' });
    }
    await this.media.acceptLocalUpload({ brandId, mediaId, nonce, contentType: contentType.toLowerCase(),
      contentLength: size, bytes: body, capability });
    return { status: 'stored' };
  }

  @Get('local-previews/:mediaId/:variant')
  @ApiExcludeEndpoint()
  async preview(@Param('brandId', new ParseUUIDPipe()) brandId: string,
    @Param('mediaId', new ParseUUIDPipe()) mediaId: string, @Param('variant') variant: string,
    @Query('token') capability: string | undefined) {
    this.requireEnabled();
    if (!capability || !['preview', 'thumbnail'].includes(variant)) throw new ForbiddenException();
    let bytes: Buffer;
    try { bytes = await this.storage.readLocalPreview({ key: mediaObjectKey(brandId, mediaId, variant as 'preview' | 'thumbnail'), capability }); }
    catch { throw new ForbiddenException(); }
    return new StreamableFile(bytes, { type: 'image/webp', disposition: 'inline', length: bytes.length });
  }

  private requireEnabled(): void {
    if (!this.storage.isConfigured()) throw new ForbiddenException();
  }

  private requireAllowedOrigin(origin: string | undefined): void {
    const allowed = this.config.get<string[]>('AUTH_ALLOWED_ORIGINS') ?? [];
    if (!origin || !allowed.includes(origin)) throw new ForbiddenException();
  }
}
