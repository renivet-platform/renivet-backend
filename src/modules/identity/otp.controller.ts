import { Body, Controller, HttpCode, Param, Post, Req, Res, UseFilters, UsePipes, ValidationPipe } from '@nestjs/common';
import {
  ApiExtraModels,
  ApiAcceptedResponse, ApiBadRequestResponse, ApiBody, ApiInternalServerErrorResponse,
  ApiOperation, ApiParam, ApiResponse, ApiServiceUnavailableResponse, ApiTooManyRequestsResponse, ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { getSchemaPath } from '@nestjs/swagger';
import { AuthHttpError } from './auth.service';
import { AuthExceptionFilter } from './auth-exception.filter';
import { AuthErrorDto } from './auth.dto';
import { OtpChallengeService } from './otp-challenge.service';
import { OtpAcceptedDto, OtpAuthenticatedDto, OtpIssueRequestDto, OtpVerifiedDto, OtpVerifyRequestDto } from './otp.dto';

interface OtpRequestContext { ip: string; }
interface CookieResponse { header(name: string, value: string): void; }
const sessionCookieName = '__Host-renivet_session';

const otpValidation = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
  exceptionFactory: () => new AuthHttpError(400, 'AUTH_INPUT_INVALID', 'The request could not be processed.'),
});

@Controller('auth/challenges')
@ApiExtraModels(OtpVerifiedDto, OtpAuthenticatedDto)
@UseFilters(AuthExceptionFilter)
export class OtpController {
  constructor(private readonly challenges: OtpChallengeService) {}

  @Post()
  @HttpCode(202)
  @UsePipes(otpValidation)
  @ApiOperation({
    operationId: 'createOtpChallenge',
    summary: 'Request an email or phone verification, phone-login, or recovery challenge',
    description: 'Public operation with no authentication or permission requirement. Creates a short-lived one-use challenge for an eligible contact and purpose. phone_login is available only for active accounts with an already verified phone. Password recovery is available only to an active account with verified email and an active password credential; unknown and ineligible contacts receive a neutral accepted response. Email requires complete SMTP configuration; phone requires complete Fast2SMS DLT configuration. Missing provider configuration sends no message. Verification: Linear REN2-22; recovery: REN2-23.',
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
    summary: 'Verify a one-use challenge, sign in by phone, or reset a password through recovery',
    description: 'Public operation with no authentication or permission requirement. email_verification and phone_verification mark the bound contact verified and issue no session. phone_login requires a purpose-bound code for an already verified phone on an active account, then atomically consumes the challenge and creates a first-party session. password_recovery requires a newPassword, atomically replaces the active Argon2id password credential, increments its version, and revokes every existing session. Invalid, expired, wrong-purpose, exhausted, or replayed proofs share one generic denial. Verification: Linear REN2-22; recovery: REN2-23.',
  })
  @ApiBody({ type: OtpVerifyRequestDto })
  @ApiParam({ name: 'challengeId', required: true, description: 'Opaque UUID returned by the challenge request operation.', schema: { type: 'string', format: 'uuid', example: '37a7d0bf-8414-4f75-bd11-311c7a442d84' } })
  @ApiResponse({ status: 200, description: 'The challenge is consumed. Phone login additionally issues a secure session cookie.', schema: { oneOf: [{ $ref: getSchemaPath(OtpVerifiedDto) }, { $ref: getSchemaPath(OtpAuthenticatedDto) }] }, headers: { 'Set-Cookie': { schema: { type: 'string', example: '__Host-renivet_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA; Path=/; Max-Age=1800; HttpOnly; Secure; SameSite=Lax' } }, 'Cache-Control': { schema: { type: 'string', example: 'no-store' } } } })
  @ApiBadRequestResponse({ description: 'AUTH_INPUT_INVALID. Malformed request.', type: AuthErrorDto })
  @ApiUnauthorizedResponse({ description: 'AUTHENTICATION_FAILED. Generic challenge denial.', type: AuthErrorDto })
  @ApiTooManyRequestsResponse({ description: 'AUTH_RATE_LIMITED. Per-IP or concurrent challenge limit exceeded.', type: AuthErrorDto })
  @ApiServiceUnavailableResponse({ description: 'AUTH_SERVICE_UNAVAILABLE. Redis, PostgreSQL, or OTP proof configuration is unavailable.', type: AuthErrorDto })
  @ApiInternalServerErrorResponse({ description: 'AUTH_INTERNAL_ERROR. Unexpected failure with a safe response.', type: AuthErrorDto })
  async verify(@Param('challengeId') challengeId: string, @Body() request: OtpVerifyRequestDto, @Req() context: OtpRequestContext, @Res({ passthrough: true }) response: CookieResponse): Promise<OtpVerifiedDto | OtpAuthenticatedDto> {
    const result = await this.challenges.verify({ ...request, challengeId }, context.ip);
    response.header('Cache-Control', 'no-store');
    if (result.status === 'authenticated') {
      response.header('Set-Cookie', `${sessionCookieName}=${result.sessionToken}; Path=/; Max-Age=${result.expiresInSeconds}; HttpOnly; Secure; SameSite=Lax`);
      return { authenticationState: 'authenticated', user: { id: result.userId } };
    }
    return result;
  }
}
