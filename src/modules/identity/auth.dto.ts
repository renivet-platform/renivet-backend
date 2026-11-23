import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsString,
  MaxLength,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { isPasswordAllowed, isNewPasswordAllowed, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, NEW_PASSWORD_MIN_LENGTH } from './passwords';

@ValidatorConstraint({ name: 'acceptedPassphrase', async: false })
class AcceptedPassphraseConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return isPasswordAllowed(value);
  }
}

export class AuthCredentialsDto {
  @ApiProperty({ format: 'email', maxLength: 254, example: 'buyer@example.test', description: 'Canonicalized by trimming surrounding whitespace and lowercasing before lookup and storage.' })
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({
    type: 'string',
    minLength: PASSWORD_MIN_LENGTH,
    maxLength: PASSWORD_MAX_LENGTH,
    description: 'An 8–128 character passphrase. No composition rule is imposed.',
    example: 'synthetic example passphrase only',
  })
  @IsString()
  @MaxLength(PASSWORD_MAX_LENGTH * 2)
  @Validate(AcceptedPassphraseConstraint)
  password!: string;
}

@ValidatorConstraint({ name: 'newAccountPassphrase', async: false })
class NewAccountPassphraseConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean { return isNewPasswordAllowed(value); }
}

export class RegisterRequestDto extends AuthCredentialsDto {
  @ApiProperty({ type: 'string', minLength: NEW_PASSWORD_MIN_LENGTH, maxLength: PASSWORD_MAX_LENGTH,
    description: 'New accounts require a 15–128 character passphrase. Existing accounts may still sign in with older credentials.' })
  @Validate(NewAccountPassphraseConstraint)
  override password!: string;
}

export class PasswordSessionRequestDto extends AuthCredentialsDto {}

export class RegistrationAcceptedDto {
  @ApiProperty({ enum: ['accepted'], example: 'accepted' })
  status!: 'accepted';
}

export class AuthenticatedUserDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;
}

export class PasswordSessionResponseDto {
  @ApiProperty({ enum: ['authenticated'], example: 'authenticated' })
  authenticationState!: 'authenticated';

  @ApiProperty({ type: AuthenticatedUserDto })
  user!: AuthenticatedUserDto;
}

export class CurrentSessionResponseDto extends PasswordSessionResponseDto {
  // Wire profile fields in the authenticated response; generated OpenAPI artifacts
  // remain unchanged until the explicitly reviewed session contract update.
  profile!: { displayName: string | null; email: string | null };

  @ApiProperty({ minLength: 32, description: 'Session-bound CSRF proof for same-origin mutations.' })
  csrfToken!: string;

  @ApiProperty({ enum: ['enforced', 'deferred'], description: 'Server-owned policy; deferred is available only in development or test.' })
  mfaEnforcementMode!: 'enforced' | 'deferred';

  @ApiProperty({ type: 'object', properties: {
    signInMethod: { type: 'string', enum: ['phone', 'email_password'] },
    phoneVerified: { type: 'boolean' },
  } })
  account!: { signInMethod: 'phone' | 'email_password'; phoneVerified: boolean };

  @ApiProperty({ type: 'object', properties: {
    kind: { type: 'string', enum: ['storefront', 'operations', 'brands'] },
    brands: { type: 'array', items: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, name: { type: 'string' } } } },
  } })
  destination!: { kind: 'storefront' } | { kind: 'operations' } | { kind: 'brands'; brands: Array<{ id: string; name: string }> };
}

export class AuthErrorDto {
  @ApiProperty({ enum: ['AUTH_INPUT_INVALID', 'AUTHENTICATION_FAILED', 'AUTH_RATE_LIMITED', 'AUTH_SERVICE_UNAVAILABLE', 'AUTH_INTERNAL_ERROR', 'AUTH_MFA_PROOF_INVALID', 'AUTH_MFA_STEP_UP_REQUIRED', 'AUTH_MFA_ENROLLMENT_UNAVAILABLE', 'CSRF_VALIDATION_FAILED'] })
  code!: string;

  @ApiProperty({ example: 'The request could not be processed.' })
  message!: string;

  @ApiProperty({ example: 'req-1' })
  requestId!: string;
}
