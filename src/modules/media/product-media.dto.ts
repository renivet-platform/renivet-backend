import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';

export class AttachProductMediaDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() mediaAssetId!: string;
  @ApiPropertyOptional({ type: 'string', format: 'uuid', nullable: true }) @IsOptional() @IsUUID() variantId?: string | null;
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(64) displayRole!: string;
  @ApiProperty({ type: 'integer', minimum: 0 }) @IsInt() @Min(0) @Max(2147483647) displayOrder!: number;
  @ApiPropertyOptional({ maxLength: 500 }) @IsOptional() @IsString() @MaxLength(500) altText?: string;
}

export class UpdateProductMediaDto {
  @ApiPropertyOptional({ minimum: 0 }) @IsOptional() @IsInt() @Min(0) @Max(2147483647) displayOrder?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(1) @MaxLength(64) displayRole?: string;
  @ApiPropertyOptional({ maxLength: 500 }) @IsOptional() @IsString() @MaxLength(500) altText?: string;
}
