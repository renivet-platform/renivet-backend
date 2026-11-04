import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class PriceActionReceiptDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() status!: string;
  @ApiProperty() requestId!: string;
  @ApiPropertyOptional({ minimum: 1, type: 'integer' }) rowVersion?: number;
}

export class PriceVersionDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) variantId!: string;
  @ApiProperty({ type: 'string', enum: ['INR'] }) currency!: 'INR';
  @ApiProperty({ minimum: 0, type: 'integer' }) amountMinor!: number;
  @ApiProperty({ minimum: 1, type: 'integer' }) mrpMinor!: number;
  @ApiProperty({ enum: ['DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'] }) priceState!: string;
  @ApiProperty({ format: 'date-time' }) validFrom!: string;
  @ApiPropertyOptional({ format: 'date-time', nullable: true }) validTo?: string | null;
  @ApiPropertyOptional({ minimum: 1, type: 'integer' }) rowVersion?: number;
}

export class PriceHistoryDto {
  @ApiProperty({ type: [PriceVersionDto] }) items!: PriceVersionDto[];
  @ApiPropertyOptional({ type: 'string', nullable: true }) nextCursor?: string | null;
}

export class PriceErrorDto {
  @ApiProperty() code!: string;
  @ApiProperty() message!: string;
  @ApiProperty() requestId!: string;
  @ApiPropertyOptional({ type: 'object', additionalProperties: true }) details?: Record<string, unknown>;
}
