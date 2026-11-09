import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';

export const MAX_REMOTE_MEDIA_IMAGES = 400;

export class MediaZipSkuMappingDto {
  @ApiProperty({ pattern: '^[A-Za-z0-9_.-]{1,40}$' })
  @IsString() @Matches(/^[A-Za-z0-9_.-]{1,40}$/)
  sku!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  productId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  variantId!: string;
}

export class CreateMediaZipMappingManifestDto {
  @ApiProperty({ type: [MediaZipSkuMappingDto], minItems: 1, maxItems: 12000 })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(12000) @ValidateNested({ each: true }) @Type(() => MediaZipSkuMappingDto)
  mappings!: MediaZipSkuMappingDto[];

  @ApiProperty({ description: 'Confirms rights to use every image in subsequent ZIP batches linked to this manifest.' })
  @IsBoolean()
  rightsAttested!: boolean;
}

export class CreateMediaZipImportDto {
  @ApiProperty({ format: 'uuid', required: false }) @IsOptional() @IsUUID()
  fileUploadId?: string;

  @ApiProperty({ format: 'uuid' }) @IsUUID()
  mappingManifestId!: string;

  @ApiProperty({ type: [Object], minItems: 1, maxItems: MAX_REMOTE_MEDIA_IMAGES, required: false })
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(MAX_REMOTE_MEDIA_IMAGES) @ValidateNested({ each: true }) @Type(() => RemoteMediaImageDto)
  remoteImages?: RemoteMediaImageDto[];
}

export class RemoteMediaImageDto {
  @ApiProperty({ pattern: '^[A-Za-z0-9_.-]{1,40}$' }) @IsString() @Matches(/^[A-Za-z0-9_.-]{1,40}$/)
  sku!: string;

  @ApiProperty({ minimum: 1, maximum: 99 }) @IsInt() @Min(1) @Max(99)
  slot!: number;

  @ApiProperty({ maxLength: 2048 }) @IsString() @MaxLength(2048) @Matches(/^https:\/\//i)
  url!: string;
}
