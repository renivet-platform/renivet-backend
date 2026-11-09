import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsString, Matches, Max, Min, MaxLength, MinLength, IsUUID } from 'class-validator';

export const IMPORT_SOURCE_KINDS = ['RENIVET_CSV', 'RENIVET_XLSX', 'SHOPIFY_CSV', 'UNIWARE_CSV', 'GENERIC_CSV'] as const;
export const IMPORT_UPLOAD_SOURCE_KINDS = [...IMPORT_SOURCE_KINDS, 'MEDIA_ZIP'] as const;
export const IMPORT_MIME_TYPES = ['text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/zip'] as const;
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
export const MAX_MEDIA_ZIP_IMPORT_BYTES = 100 * 1024 * 1024;

export class BeginCatalogImportUploadDto {
  @ApiProperty({ enum: IMPORT_UPLOAD_SOURCE_KINDS })
  @IsIn(IMPORT_UPLOAD_SOURCE_KINDS)
  sourceKind!: typeof IMPORT_UPLOAD_SOURCE_KINDS[number];

  @ApiProperty({ maxLength: 160, description: 'Display name only; the server generates the storage path.' })
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @MinLength(1) @MaxLength(160)
  fileName!: string;

  @ApiProperty({ enum: IMPORT_MIME_TYPES })
  @IsIn(IMPORT_MIME_TYPES)
  mimeType!: typeof IMPORT_MIME_TYPES[number];

  @ApiProperty({ minimum: 1, maximum: MAX_MEDIA_ZIP_IMPORT_BYTES })
  @IsInt() @Min(1) @Max(MAX_MEDIA_ZIP_IMPORT_BYTES)
  byteLength!: number;

  @ApiProperty({ pattern: '^[a-f0-9]{64}$' })
  @IsString() @Matches(/^[a-f0-9]{64}$/i)
  sha256!: string;
}

export class CreateCatalogImportDto {
  @ApiProperty({ enum: IMPORT_SOURCE_KINDS })
  @IsIn(IMPORT_SOURCE_KINDS)
  sourceKind!: typeof IMPORT_SOURCE_KINDS[number];

  @ApiProperty({ format: 'date-time' })
  @IsDateString()
  sourceAsOf!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  fileUploadId!: string;

  @ApiProperty({ enum: ['CREATE_ONLY','UPDATE_MATCHED','SKIP_EXISTING','REVIEW_CONFLICT'] })
  @IsIn(['CREATE_ONLY','UPDATE_MATCHED','SKIP_EXISTING','REVIEW_CONFLICT'])
  mode!: 'CREATE_ONLY' | 'UPDATE_MATCHED' | 'SKIP_EXISTING' | 'REVIEW_CONFLICT';
}
