import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsString, Matches, Min } from 'class-validator';

export class ConfirmCatalogImportDto {
  @ApiProperty({ pattern: '^[a-f0-9]{64}$' })
  @IsString() @Matches(/^[a-f0-9]{64}$/i)
  previewHash!: string;

  @ApiProperty({ minimum: 1 })
  @IsInt() @Min(1)
  previewRevision!: number;

  @ApiProperty()
  @IsBoolean()
  allowPartial!: boolean;
}
