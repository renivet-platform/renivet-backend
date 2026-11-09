import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RetryCatalogImportDto {
  @ApiProperty({ type: 'string', enum: ['FAILED_ONLY'] })
  @IsIn(['FAILED_ONLY'])
  mode!: 'FAILED_ONLY';

  @ApiPropertyOptional({ type: 'array', maxItems: 64, items: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,63}$' } })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(64)
  @IsString({ each: true })
  @Matches(/^[A-Z][A-Z0-9_]{0,63}$/, { each: true })
  errorCodes?: string[];
}

export type ImportResultFormat = 'json' | 'csv';
