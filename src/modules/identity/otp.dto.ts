import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { OtpChannel, OtpPurpose } from './otp-challenge.service';

export class OtpIssueRequestDto {
  @ApiProperty({ enum: ['email', 'phone'], example: 'email' })
  @IsIn(['email', 'phone'])
  channel!: OtpChannel;

  @ApiProperty({ enum: ['email_verification', 'phone_verification'], example: 'email_verification' })
  @IsIn(['email_verification', 'phone_verification'])
  purpose!: OtpPurpose;

  @ApiProperty({ example: 'buyer@example.test', description: 'Email address or E.164 phone number. The requested channel and purpose must match.' })
  @IsString()
  @MinLength(3)
  @MaxLength(254)
  destination!: string;
}

export class OtpVerifyRequestDto {
  @ApiProperty({ enum: ['email_verification', 'phone_verification'], example: 'email_verification' })
  @IsIn(['email_verification', 'phone_verification'])
  purpose!: OtpPurpose;

  @ApiProperty({ pattern: '^[0-9]{6}$', example: '123456', description: 'Six-digit synthetic example. Real codes are delivered out of band.' })
  @IsString()
  @Matches(/^[0-9]{6}$/)
  code!: string;
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
