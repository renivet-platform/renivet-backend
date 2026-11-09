import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsObject, IsOptional, IsString, MaxLength, ArrayMaxSize } from 'class-validator';

export class SaveImportMappingDto {
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' }, example: { 'Product Name': 'title', SKU: 'sku' } })
  @IsObject()
  fieldMappings!: Record<string, string>;

  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' }, example: { Tops: 'apparel-tops' } })
  @IsObject()
  categoryMappings!: Record<string, string>;

  @ApiPropertyOptional({ type: 'array', items: { type: 'string' }, maxItems: 80 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(80)
  @IsString({ each: true })
  @MaxLength(128, { each: true })
  fieldMask?: string[];
}

\n