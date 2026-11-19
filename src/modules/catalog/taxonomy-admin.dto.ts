import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsObject, IsOptional, IsString, IsUUID, Matches, MaxLength, Min, MinLength } from 'class-validator';
import { TaxonomyRuleInput } from './taxonomy-admin.service';

export class CreateTaxonomyCategoryDto {
  @IsString()
  @Matches(/^[a-z][a-z0-9_]{2,63}$/)
  code!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(100)
  name!: string;

  @IsOptional()
  @IsUUID()
  parentId?: string;
}

export class CategorySchemaProposalDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  categoryId!: string;

  @ApiProperty({ minimum: 1, type: 'integer' })
  @IsInt()
  @Min(1)
  version!: number;

  @IsObject()
  ruleset!: { attributes: TaxonomyRuleInput[]; [key: string]: unknown };

  @ApiProperty({ example: 'w2-attribute-validator-v1' })
  @IsString()
  validatorVersion!: string;
}

export class CategoryActivationDto {
  @ApiProperty({ example: 'PILOT_APPROVED', pattern: '^[A-Z][A-Z0-9_]{0,63}$' })
  @IsString()
  @MaxLength(64)
  @Matches(/^[A-Z][A-Z0-9_]{0,63}$/)
  reasonCode!: string;
}

export class TaxonomyActionReceiptDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  status!: string;

  @ApiProperty()
  requestId!: string;

  @ApiProperty({ minimum: 1, type: 'integer', required: false })
  rowVersion?: number;
}

export class TaxonomyErrorDto {
  @ApiProperty()
  code!: string;

  @ApiProperty()
  message!: string;

  @ApiProperty()
  requestId!: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  details?: Record<string, unknown>;
}
