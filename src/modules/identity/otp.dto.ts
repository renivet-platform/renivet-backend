import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsString, Matches, MaxLength, MinLength, Validate, ValidateIf, ValidatorConstraint } from 'class-validator';
import { OtpChannel, OtpPurpose } from './otp-challenge.service';
import { isPasswordAllowed, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './passwords';

@ValidatorConstraint({ name: 'recoveryPassword', async: false })
class RecoveryPasswordConstraint {
  validate(value: unknown): boolean { return isPasswordAllowed(value); }
  defaultMessage(): string { return 'The request could not be processed.'; }
}

export class OtpIssueRequestDto {
  @ApiProperty({ enum: ['email', 'phone'], example: 'email' })
  @IsIn(['email', 'phone'])
  channel!: OtpChannel;

  @ApiProperty({ enum: ['email_verification', 'phone_verification', 'phone_login', 'phone_registration', 'password_recovery'], example: 'email_verification' })
  @IsIn(['email_verification', 'phone_verification', 'phone_login', 'phone_registration', 'password_recovery'])
  purpose!: OtpPurpose;

  @ApiProperty({ example: 'buyer@example.test', description: 'Email address or E.164 phone number. The requested channel and purpose must match.' })
  @IsString()
  @MinLength(3)
  @MaxLength(254)
  destination!: string;
}

export class OtpVerifyRequestDto {
  @ApiProperty({ enum: ['email_verification', 'phone_verification', 'phone_login', 'phone_registration', 'password_recovery'], example: 'email_verification' })
  @IsIn(['email_verification', 'phone_verification', 'phone_login', 'phone_registration', 'password_recovery'])
  purpose!: OtpPurpose;

  @ApiProperty({ pattern: '^[0-9]{6}$', example: '123456', description: 'Six-digit synthetic example. Real codes are delivered out of band.' })
  @IsString()
  @Matches(/^[0-9]{6}$/)
  code!: string;

  @ApiPropertyOptional({ type: 'string', minLength: PASSWORD_MIN_LENGTH, maxLength: PASSWORD_MAX_LENGTH, example: 'synthetic replacement passphrase', description: 'Required only for password_recovery; accepted as an 8–128 character passphrase and stored only as an Argon2id hash.' })
  @ValidateIf((request: OtpVerifyRequestDto) => request.purpose === 'password_recovery')
  @IsString()
  @MaxLength(PASSWORD_MAX_LENGTH * 2)
  @Validate(RecoveryPasswordConstraint)
  newPassword?: string;
}

export class OtpAcceptedDto {
  @ApiProperty({ enum: ['accepted'], example: 'accepted' })
  status!: 'accepted';

  @ApiProperty({ format: 'uuid', example: '37a7d0bf-8414-4f75-bd11-311c7a442d84', description: 'Opaque challenge reference; unknown contacts receive an unusable synthetic reference to keep results enumeration-neutral.' })
  challengeId!: string;
}

export class OtpVerifiedDto {
  @ApiProperty({ enum: ['verified'], example: 'verified' })
  status!: 'verified';
}

export class OtpAuthenticatedDto {
  @ApiProperty({ enum: ['authenticated'], example: 'authenticated' })
  authenticationState!: 'authenticated';

  @ApiProperty({ example: { id: '7d785d72-ea2c-44bb-9d82-87b272112b32' } })
  user!: { id: string };
}
