import { Body, Controller, HttpCode, Param, Post, Req, UseFilters, UsePipes, ValidationPipe } from '@nestjs/common';
import {
  ApiAcceptedResponse, ApiBadRequestResponse, ApiBody, ApiInternalServerErrorResponse,
  ApiOperation, ApiParam, ApiResponse, ApiServiceUnavailableResponse, ApiTooManyRequestsResponse, ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthHttpError } from './auth.service';
import { AuthExceptionFilter } from './auth-exception.filter';
import { AuthErrorDto } from './auth.dto';
import { OtpChallengeService } from './otp-challenge.service';
import { OtpAcceptedDto, OtpIssueRequestDto, OtpVerifiedDto, OtpVerifyRequestDto } from './otp.dto';

interface OtpRequestContext { ip: string; }

const otpValidation = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
  exceptionFactory: () => new AuthHttpError(400, 'AUTH_INPUT_INVALID', 'The request could not be processed.'),
});

@Controller('auth/challenges')
@UseFilters(AuthExceptionFilter)
export class OtpController {
  constructor(private readonly challenges: OtpChallengeService) {}

  @Post()
  @HttpCode(202)
  @UsePipes(otpValidation)
  @ApiOperation({
    operationId: 'createOtpChallenge',
    summary: 'Request an email or phone verification or recovery challenge',
    description: 'Public operation with no authentication or permission requirement. Creates a short-lived one-use challenge for an eligible contact and purpose. Password recovery is available only to an active account with verified email and an active password credential; unknown and ineligible contacts receive a neutral accepted response. Recovery proof is purpose-bound and is required to replace the password. Email requires complete SMTP configuration; phone requires complete Fast2SMS DLT configuration. Missing provider configuration sends no message. Verification: Linear REN2-22; password recovery: REN2-23; candidate routes remain subject to D04 owner approval.',
  })
  @ApiBody({ type: OtpIssueRequestDto })
  @ApiAcceptedResponse({ description: 'Neutral accepted result; does not reveal contact registration or delivery state.', type: OtpAcceptedDto })
  @ApiBadRequestResponse({ description: 'AUTH_INPUT_INVALID. Invalid channel/purpose pair or malformed destination.', type: AuthErrorDto })
  @ApiTooManyRequestsResponse({ description: 'AUTH_RATE_LIMITED. Per-IP, identity, purpose, cooldown, or resend limit exceeded.', type: AuthErrorDto })
  @ApiServiceUnavailableResponse({ description: 'AUTH_SERVICE_UNAVAILABLE. Redis, PostgreSQL, OTP proof configuration, or delivery provider is unavailable.', type: AuthErrorDto })
  @ApiInternalServerErrorResponse({ description: 'AUTH_INTERNAL_ERROR. Unexpected failure with a safe response.', type: AuthErrorDto })
  create(@Body() request: OtpIssueRequestDto, @Req() context: OtpRequestContext): Promise<OtpAcceptedDto> {
    return this.challenges.issue(request, context.ip);
  }

  @Post(':challengeId/verify')
  @HttpCode(200)
  @UsePipes(otpValidation)
  @ApiOperation({
    operationId: 'verifyOtpChallenge',
    summary: 'Verify a one-use challenge or reset a password through recovery',
    description: 'Public operation with no authentication or permission requirement. A successful verification proof marks only the bound contact as verified and issues no session. A password_recovery proof additionally requires a newPassword, atomically replaces the active Argon2id password credential, increments its version, and revokes every existing session. Invalid, expired, wrong-purpose, exhausted, or replayed proofs share one generic denial. Linear: REN2-22 verification and REN2-23 password recovery; candidate route remains subject to D04 owner approval.',
  })
  @ApiBody({ type: OtpVerifyRequestDto })
  @ApiParam({ name: 'challengeId', required: true, description: 'Opaque UUID returned by the challenge request operation.', schema: { type: 'string', format: 'uuid', example: '37a7d0bf-8414-4f75-bd11-311c7a442d84' } })
  @ApiResponse({ status: 200, description: 'The challenge is consumed and its bound contact is verified.', type: OtpVerifiedDto })
  @ApiBadRequestResponse({ description: 'AUTH_INPUT_INVALID. Malformed request.', type: AuthErrorDto })
  @ApiUnauthorizedResponse({ description: 'AUTHENTICATION_FAILED. Generic challenge denial.', type: AuthErrorDto })
  @ApiTooManyRequestsResponse({ description: 'AUTH_RATE_LIMITED. Per-IP or concurrent challenge limit exceeded.', type: AuthErrorDto })
  @ApiServiceUnavailableResponse({ description: 'AUTH_SERVICE_UNAVAILABLE. Redis, PostgreSQL, or OTP proof configuration is unavailable.', type: AuthErrorDto })
  @ApiInternalServerErrorResponse({ description: 'AUTH_INTERNAL_ERROR. Unexpected failure with a safe response.', type: AuthErrorDto })
  verify(@Param('challengeId') challengeId: string, @Body() request: OtpVerifyRequestDto, @Req() context: OtpRequestContext): Promise<OtpVerifiedDto> {
    return this.challenges.verify({ ...request, challengeId }, context.ip);
  }
}
