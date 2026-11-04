import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsObject, IsOptional, IsString, Min, MinLength } from 'class-validator';

export class CreateProductDraftDto {
  @ApiProperty({ maxLength: 128 }) @IsString() @MinLength(1) styleCode!: string;
  @ApiProperty({ maxLength: 128 }) @IsString() @MinLength(1) categoryCode!: string;
  @ApiProperty({ minimum: 1 }) @IsInt() @Min(1) categorySchemaVersion!: number;
  @ApiProperty({ maxLength: 200 }) @IsString() @MinLength(1) title!: string;
  @ApiPropertyOptional({ maxLength: 10000 }) @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional({ type: 'object', additionalProperties: true }) @IsOptional() @IsObject() attributes?: Record<string, unknown>;
  @ApiPropertyOptional({ type: 'array', items: { type: 'object' } }) @IsOptional() variants?: Array<Record<string, unknown>>;
}

export class UpdateProductDraftDto {
  @ApiPropertyOptional({ maxLength: 200 }) @IsOptional() @IsString() @MinLength(1) title?: string;
  @ApiPropertyOptional({ maxLength: 10000 }) @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional({ minimum: 1 }) @IsOptional() @IsInt() @Min(1) categorySchemaVersion?: number;
  @ApiPropertyOptional({ type: 'object', additionalProperties: true }) @IsOptional() @IsObject() attributes?: Record<string, unknown>;
}

export class ProductDraftErrorDto { @ApiProperty() code!: string; @ApiProperty() message!: string; @ApiProperty() requestId!: string; }
