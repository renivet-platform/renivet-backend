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
import { isPasswordAllowed, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './passwords';

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
    description: 'A 15–128 character passphrase. No composition rule is imposed.',
    example: 'synthetic example passphrase only',
  })
  @IsString()
  @MaxLength(PASSWORD_MAX_LENGTH * 2)
  @Validate(AcceptedPassphraseConstraint)
  password!: string;
}

export class RegisterRequestDto extends AuthCredentialsDto {}

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

export class AuthErrorDto {
  @ApiProperty({ enum: ['AUTH_INPUT_INVALID', 'AUTHENTICATION_FAILED', 'AUTH_RATE_LIMITED', 'AUTH_SERVICE_UNAVAILABLE', 'AUTH_INTERNAL_ERROR'] })
  code!: string;

  @ApiProperty({ example: 'The request could not be processed.' })
  message!: string;

  @ApiProperty({ example: 'req-1' })
  requestId!: string;
}
