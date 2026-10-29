import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class MfaEnrollmentCodeRequestDto {
  @ApiProperty({ type: 'string', pattern: '^\\d{6}$', example: '123456', description: 'Six-digit TOTP from the authenticator app. Synthetic example only.' })
  @IsString()
  @Matches(/^\d{6}$/)
  code!: string;
}

export class MfaStepUpRequestDto {
  @ApiProperty({ type: 'string', pattern: '^(?:\\d{6}|[A-Z2-7]{26})$', example: '123456', description: 'Six-digit TOTP or one 26-character recovery code. Synthetic example only.' })
  @Transform(({ value }) => typeof value === 'string' ? value.trim().replace(/-/g, '').toUpperCase() : value)
  @IsString()
  @MaxLength(32)
  @Matches(/^(?:\d{6}|[A-Z2-7]{26})$/)
  code!: string;
}

export class MfaStatusResponseDto {
  @ApiProperty({ enum: ['not_enrolled', 'enrollment_pending', 'enabled'], example: 'not_enrolled' })
  @IsIn(['not_enrolled', 'enrollment_pending', 'enabled'])
  state!: 'not_enrolled' | 'enrollment_pending' | 'enabled';

  @ApiProperty({ type: 'integer', minimum: 0, maximum: 10, example: 0 })
  @IsInt()
  @Min(0)
  @Max(10)
  recoveryCodesRemaining!: number;
}

export class MfaEnrollmentResponseDto {
  @ApiProperty({ enum: ['enrollment_pending'], example: 'enrollment_pending' })
  state!: 'enrollment_pending';

  @ApiProperty({ format: 'uri', example: 'otpauth://totp/Renivet:00000000-0000-4000-8000-000000000000?secret=JBSWY3DPEHPK3PXP&issuer=Renivet&algorithm=SHA1&digits=6&period=30', description: 'Contains the authenticator secret. Shown only in the start response and never returned by status or retries.' })
  provisioningUri!: string;

  @ApiProperty({ type: 'integer', example: 600 })
  expiresInSeconds!: number;
}

export class MfaEnabledResponseDto {
  @ApiProperty({ enum: ['enabled'], example: 'enabled' })
  state!: 'enabled';

  @ApiProperty({ type: 'array', items: { type: 'string', pattern: '^[A-Z2-7]{26}$' }, example: ['JBSWY3DPEHPK3PXPJBSWY3DPEH'] , description: 'One-time recovery codes. Save them now; the API stores only SHA-256 digests and never returns them again.' })
  recoveryCodes!: string[];

  @ApiProperty({ type: 'string', example: 'synthetic-csrf-proof-for-rotated-session' })
  csrfToken!: string;
}

export class MfaStepUpResponseDto {
  @ApiProperty({ enum: ['elevated'], example: 'elevated' })
  authenticationState!: 'elevated';

  @ApiProperty({ type: 'string', example: 'synthetic-csrf-proof-for-rotated-session' })
  csrfToken!: string;
}

export class MfaRevocationResponseDto {
  @ApiProperty({ enum: ['revoked'], example: 'revoked' })
  status!: 'revoked';
}
