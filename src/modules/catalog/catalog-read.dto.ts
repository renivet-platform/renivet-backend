import { ApiProperty, ApiPropertyOptional, ApiSchema, ApiSchemaOptions } from '@nestjs/swagger';
import type { ApiPropertyOptions } from '@nestjs/swagger';

export class CategorySummaryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ minimum: 1, type: 'integer' }) schemaVersion!: number;
  @ApiProperty({ format: 'uuid', nullable: true, type: 'string' }) parentId!: string | null;
  @ApiProperty() isLeaf!: boolean;
  @ApiProperty() isActive!: boolean;
  @ApiProperty({ minimum: 1, type: 'integer' }) currentSchemaVersion!: number;
  @ApiPropertyOptional({ type: [String] }) pathCodes!: string[];
}

export class AttributeDefinitionDto {
  @ApiProperty() code!: string;
  @ApiProperty({ enum: ['PRODUCT', 'VARIANT'] }) scope!: 'PRODUCT' | 'VARIANT';
  @ApiProperty({ enum: ['text', 'integer', 'decimal', 'boolean', 'enum', 'multi_enum', 'date', 'measurement'] }) type!: string;
  @ApiProperty() required!: boolean;
  @ApiPropertyOptional({ type: 'object', nullable: true } as unknown as ApiPropertyOptions) condition?: Record<string, unknown> | null;
  @ApiPropertyOptional({ type: [String] }) allowedValues?: string[];
  @ApiPropertyOptional({ format: 'uuid' }) schemaVersionId?: string;
  @ApiPropertyOptional() validatorVersion?: string;
  @ApiPropertyOptional({ type: 'object', nullable: true } as unknown as ApiPropertyOptions) conditionalAst?: Record<string, unknown> | null;
  @ApiPropertyOptional({ enum: ['product', 'variant'] }) scopeType?: 'product' | 'variant';
}

@ApiSchema({ additionalProperties: false } as unknown as ApiSchemaOptions)
export class PagedCategoriesDto {
  @ApiProperty({ type: [CategorySummaryDto] }) items!: CategorySummaryDto[];
  @ApiPropertyOptional({ type: 'string', nullable: true }) nextCursor?: string | null;
}

@ApiSchema({ additionalProperties: false } as unknown as ApiSchemaOptions)
export class PagedAttributeDefinitionsDto {
  @ApiProperty({ type: [AttributeDefinitionDto] }) items!: AttributeDefinitionDto[];
  @ApiPropertyOptional({ type: 'string', nullable: true }) nextCursor?: string | null;
}

@ApiSchema({ additionalProperties: false } as unknown as ApiSchemaOptions)
export class CategorySchemaVersionReadDto {
  @ApiProperty({ format: 'uuid' }) categoryId!: string;
  @ApiProperty({ minimum: 1, type: 'integer' }) version!: number;
  @ApiProperty({ enum: ['DRAFT', 'PUBLISHED'] }) state!: 'DRAFT' | 'PUBLISHED';
  @ApiProperty() validatorVersion!: string;
  @ApiProperty({ pattern: '^[0-9a-f]{64}$' }) rulesetSha256!: string;
  @ApiProperty({ type: [AttributeDefinitionDto] }) attributes!: AttributeDefinitionDto[];
}

export class CategoryReadErrorDto {
  @ApiProperty() code!: string;
  @ApiProperty() message!: string;
  @ApiProperty() requestId!: string;
  @ApiPropertyOptional({ type: 'object', additionalProperties: true }) details?: Record<string, unknown>;
}
