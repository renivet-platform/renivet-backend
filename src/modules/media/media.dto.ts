import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { MAX_MEDIA_UPLOAD_BYTES } from './media-validation';

export class BeginMediaUploadDto {
  @ApiProperty({ example: 'front-view.png', description: 'Display name only; the server stores a sanitized basename up to 160 characters.' })
  @IsString()
  fileName!: string;

  @ApiProperty({ enum: ['image/jpeg', 'image/png', 'image/webp'] })
  @IsIn(['image/jpeg', 'image/png', 'image/webp'])
  mimeType!: 'image/jpeg' | 'image/png' | 'image/webp';

  @ApiProperty({ minimum: 1, description: 'Images are limited to 10 MiB.' })
  @IsInt() @Min(1) @Max(MAX_MEDIA_UPLOAD_BYTES)
  byteLength!: number;

  @ApiProperty({ description: 'Confirms the brand has the rights required to use this asset.' })
  @IsBoolean()
  rightsAttested!: boolean;

  @ApiPropertyOptional({ pattern: '^[0-9a-f]{64}$' })
  @IsOptional() @IsString() @Matches(/^[a-f0-9]{64}$/i)
  sha256?: string;
}

export class CompleteMediaUploadDto {
  @ApiProperty({ pattern: '^[0-9a-f]{64}$' })
  @IsString() @Matches(/^[a-f0-9]{64}$/i)
  sha256!: string;

  @ApiProperty({ minimum: 1, description: 'Images are limited to 10 MiB.' })
  @IsInt() @Min(1) @Max(MAX_MEDIA_UPLOAD_BYTES)
  sizeBytes!: number;
}
