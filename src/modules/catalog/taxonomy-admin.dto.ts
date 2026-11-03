import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsObject, IsString, IsUUID, Min } from 'class-validator';
import { TaxonomyRuleInput } from './taxonomy-admin.service';

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
