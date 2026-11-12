import { Transform } from 'class-transformer';
import { IsString, Matches, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SetPhoneForVerificationDto {
  @ApiProperty({
    example: '+919876543210',
    pattern: '^\\+91[6-9][0-9]{9}$',
    description: 'Indian mobile number in E.164 format. This number remains unverified until a separate phone OTP challenge succeeds.',
  })
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @MaxLength(13)
  @Matches(/^\+91[6-9][0-9]{9}$/)
  phone!: string;
}

export class PhoneContactAcceptedDto {
  @ApiProperty({ enum: ['accepted'], example: 'accepted' })
  status!: 'accepted';

  @ApiProperty({ example: true, description: 'False when the same number is already verified on this account.' })
  verificationRequired!: boolean;
}
