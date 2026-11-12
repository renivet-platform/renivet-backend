import { Body, Controller, HttpCode, Post, Req, Res, UseFilters, UsePipes, ValidationPipe } from '@nestjs/common';
import {
  ApiAcceptedResponse, ApiBadRequestResponse, ApiBody, ApiCookieAuth, ApiForbiddenResponse,
  ApiHeader, ApiInternalServerErrorResponse, ApiOperation, ApiServiceUnavailableResponse,
  ApiTooManyRequestsResponse, ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthHttpError } from './auth.service';
import { AuthExceptionFilter } from './auth-exception.filter';
import { AuthErrorDto } from './auth.dto';
import { ConfigService } from '@nestjs/config';
import { PhoneContactService } from './phone-contact.service';
import { PhoneContactAcceptedDto, SetPhoneForVerificationDto } from './phone-contact.dto';
import { csrfMatches, CsrfRejectedError, readSessionToken, SessionService } from './session.service';

interface PhoneContactRequestContext {
  ip: string;
  headers: Record<string, string | string[] | undefined>;
}

interface CacheResponse {
  header(name: string, value: string): void;
}

const authRequestValidation = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
  exceptionFactory: () => new AuthHttpError(400, 'AUTH_INPUT_INVALID', 'The request could not be processed.'),
});

@Controller('auth')
@UseFilters(AuthExceptionFilter)
export class PhoneContactController {
  constructor(
    private readonly sessions: SessionService,
    private readonly contacts: PhoneContactService,
    private readonly configuration: ConfigService,
  ) {}

  @Post('phone')
  @HttpCode(202)
  @UsePipes(authRequestValidation)
  @ApiCookieAuth('renivetSession')
  @ApiOperation({
    operationId: 'setPhoneForVerification',
    summary: 'Attach an Indian mobile number to the authenticated account for verification',
    description: 'Requires an active first-party session cookie, exact allowlisted Origin, same-origin fetch metadata, and session-bound X-CSRF-Token. It stores the contact as unverified; the separate phone_verification challenge sends and verifies the code. A number already owned by another account is rejected without identifying that account. Phone-number login is not provided.',
  })
  @ApiBody({ type: SetPhoneForVerificationDto })
  @ApiAcceptedResponse({ description: 'The phone number is attached as an unverified contact.', type: PhoneContactAcceptedDto, headers: { 'Cache-Control': { schema: { type: 'string', example: 'no-store' } } } })
  @ApiBadRequestResponse({ description: 'AUTH_INPUT_INVALID. The number is malformed, not supported, or cannot be attached.', type: AuthErrorDto })
  @ApiHeader({ name: 'Origin', required: true, description: 'Must exactly match one configured AUTH_ALLOWED_ORIGINS origin.' })
  @ApiHeader({ name: 'Sec-Fetch-Site', required: true, description: 'Must be same-origin.' })
  @ApiHeader({ name: 'X-CSRF-Token', required: true, description: 'Session-bound proof returned by GET /auth/session.' })
  @ApiUnauthorizedResponse({ description: 'AUTHENTICATION_FAILED. The session is missing, expired, revoked, or invalid.', type: AuthErrorDto })
  @ApiForbiddenResponse({ description: 'CSRF_VALIDATION_FAILED. Origin, fetch metadata, or CSRF proof is invalid.', type: AuthErrorDto })
  @ApiTooManyRequestsResponse({ description: 'AUTH_RATE_LIMITED. Phone changes are limited by user and source IP.', type: AuthErrorDto })
  @ApiServiceUnavailableResponse({ description: 'AUTH_SERVICE_UNAVAILABLE. The session, rate-limit store, or identity store is unavailable.', type: AuthErrorDto })
  @ApiInternalServerErrorResponse({ description: 'AUTH_INTERNAL_ERROR. Unexpected failure with a safe public response.', type: AuthErrorDto })
  async setPhone(
    @Body() request: SetPhoneForVerificationDto,
    @Req() context: PhoneContactRequestContext,
    @Res({ passthrough: true }) response: CacheResponse,
  ): Promise<PhoneContactAcceptedDto> {
    const token = readSessionToken(context.headers.cookie);
    const session = await this.sessions.authenticate(token);
    const origins = this.configuration.get<string[]>('AUTH_ALLOWED_ORIGINS') ?? [];
    if (!token || !csrfMatches(context.headers, origins, this.sessions.expectedCsrf(token))) throw new CsrfRejectedError();

    const result = await this.contacts.setPhoneForVerification(session.userId, request.phone, context.ip);
    response.header('Cache-Control', 'no-store');
    return result;
  }
}
