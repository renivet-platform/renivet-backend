import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UseFilters,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiHeader,
  ApiInternalServerErrorResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { AuthHttpError } from './auth.service';
import { AuthExceptionFilter } from './auth-exception.filter';
import { AuthErrorDto } from './auth.dto';
import { MfaService } from './mfa.service';
import { MfaEnabledResponseDto, MfaEnrollmentCodeRequestDto, MfaEnrollmentResponseDto, MfaRevocationResponseDto, MfaStatusResponseDto, MfaStepUpRequestDto, MfaStepUpResponseDto } from './mfa.dto';
import { csrfMatches, CsrfRejectedError, SessionService } from './session.service';

interface MfaRequestContext {
  ip: string;
  headers: Record<string, string | string[] | undefined>;
}

interface CookieResponse {
  header(name: string, value: string): void;
}

const sessionCookieName = '__Host-renivet_session';
const authRequestValidation = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
  exceptionFactory: () => new AuthHttpError(400, 'AUTH_INPUT_INVALID', 'The request could not be processed.'),
});

@Controller('auth')
@UseFilters(AuthExceptionFilter)
export class MfaController {
  constructor(
    private readonly sessions: SessionService,
    private readonly mfa: MfaService,
    private readonly configuration: ConfigService,
  ) {}

  @Get('mfa')
  @ApiCookieAuth('renivetSession')
  @ApiOperation({
    operationId: 'getMfaStatus',
    summary: 'Inspect the authenticated account MFA status',
    description: 'Requires the first-party session cookie. Returns factor state and remaining recovery-code count only; it never returns an authenticator secret, TOTP, or recovery code. Linear: REN2-24.',
  })
  @ApiOkResponse({ description: 'Current MFA enrollment state without factor material.', type: MfaStatusResponseDto })
  @ApiUnauthorizedResponse({ description: 'AUTHENTICATION_FAILED. The session is missing, expired, revoked, or invalid.', type: AuthErrorDto })
  @ApiServiceUnavailableResponse({ description: 'AUTH_SERVICE_UNAVAILABLE. The identity store is unavailable.', type: AuthErrorDto })
  @ApiInternalServerErrorResponse({ description: 'AUTH_INTERNAL_ERROR. Unexpected failure with a safe public message.', type: AuthErrorDto })
  async getStatus(@Req() context: MfaRequestContext, @Res({ passthrough: true }) response: CookieResponse): Promise<MfaStatusResponseDto> {
    const session = await this.sessions.authenticate(this.readSessionCookie(context.headers.cookie));
    response.header('Cache-Control', 'no-store');
    return this.mfa.status(session.userId);
  }

  @Post('mfa/enrollments')
  @HttpCode(200)
  @ApiCookieAuth('renivetSession')
  @ApiOperation({
    operationId: 'beginMfaEnrollment',
    summary: 'Begin authenticator-app MFA enrollment',
    description: 'Requires an authenticated session, exact allowlisted Origin, Sec-Fetch-Site: same-origin, and session-bound X-CSRF-Token. Creates one short-lived pending TOTP factor and returns its provisioning URI once. One active or unexpired pending factor is allowed. Linear: REN2-24.',
  })
  @ApiOkResponse({ description: 'One-time authenticator provisioning URI, expiring after 10 minutes.', type: MfaEnrollmentResponseDto, headers: { 'Cache-Control': { schema: { type: 'string', example: 'no-store' } } } })
  @ApiConflictResponse({ description: 'AUTH_MFA_ENROLLMENT_UNAVAILABLE. A factor is already pending or enabled.', type: AuthErrorDto })
  @ApiHeader({ name: 'Origin', required: true, description: 'Must exactly match a configured AUTH_ALLOWED_ORIGINS origin.', example: 'http://127.0.0.1:3000' })
  @ApiHeader({ name: 'Sec-Fetch-Site', required: true, description: 'Must be same-origin.', example: 'same-origin' })
  @ApiHeader({ name: 'X-CSRF-Token', required: true, description: 'Session-bound proof returned by GET /auth/session.' })
  @ApiUnauthorizedResponse({ description: 'AUTHENTICATION_FAILED. The session is not active.', type: AuthErrorDto })
  @ApiForbiddenResponse({ description: 'CSRF_VALIDATION_FAILED. Origin, fetch metadata, or CSRF evidence is invalid.', type: AuthErrorDto })
  @ApiTooManyRequestsResponse({ description: 'AUTH_RATE_LIMITED. Enrollment request limit exceeded.', type: AuthErrorDto })
  @ApiServiceUnavailableResponse({ description: 'AUTH_SERVICE_UNAVAILABLE. MFA encryption key, Redis, PostgreSQL or audit storage is unavailable.', type: AuthErrorDto })
  @ApiInternalServerErrorResponse({ description: 'AUTH_INTERNAL_ERROR. Unexpected failure with a safe public message.', type: AuthErrorDto })
  async beginEnrollment(@Req() context: MfaRequestContext, @Res({ passthrough: true }) response: CookieResponse): Promise<MfaEnrollmentResponseDto> {
    const { session } = await this.authenticatedMutation(context);
    const result = await this.mfa.beginEnrollment({ userId: session.userId, sessionId: session.sessionId, ipAddress: context.ip });
    response.header('Cache-Control', 'no-store');
    response.header('Pragma', 'no-cache');
    return result;
  }

  @Post('mfa/enrollments/verify')
  @HttpCode(200)
  @UsePipes(authRequestValidation)
  @ApiCookieAuth('renivetSession')
  @ApiOperation({
    operationId: 'confirmMfaEnrollment',
    summary: 'Confirm the authenticator factor and reveal recovery codes',
    description: 'Requires an authenticated session, exact allowlisted Origin, same-origin fetch metadata, and session-bound CSRF proof. A valid TOTP activates the pending factor, rotates the session, and returns ten 128-bit recovery codes once. TOTP enrollment proof cannot be replayed. Linear: REN2-24.',
  })
  @ApiBody({ type: MfaEnrollmentCodeRequestDto })
  @ApiOkResponse({ description: 'Activated factor, one-time recovery codes, rotated secure session cookie, and fresh CSRF proof.', type: MfaEnabledResponseDto, headers: { 'Set-Cookie': { schema: { type: 'string', example: '__Host-renivet_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA; Path=/; Max-Age=1800; HttpOnly; Secure; SameSite=Lax' } }, 'Cache-Control': { schema: { type: 'string', example: 'no-store' } } } })
  @ApiBadRequestResponse({ description: 'AUTH_INPUT_INVALID. Code is not a six-digit TOTP.', type: AuthErrorDto })
  @ApiHeader({ name: 'Origin', required: true, description: 'Must exactly match a configured AUTH_ALLOWED_ORIGINS origin.' })
  @ApiHeader({ name: 'Sec-Fetch-Site', required: true, description: 'Must be same-origin.', example: 'same-origin' })
  @ApiHeader({ name: 'X-CSRF-Token', required: true, description: 'Session-bound proof returned by GET /auth/session.' })
  @ApiUnauthorizedResponse({ description: 'AUTHENTICATION_FAILED or AUTH_MFA_PROOF_INVALID. Session/factor proof is invalid, expired, or replayed.', type: AuthErrorDto })
  @ApiForbiddenResponse({ description: 'CSRF_VALIDATION_FAILED. Origin, fetch metadata, or CSRF evidence is invalid.', type: AuthErrorDto })
  @ApiTooManyRequestsResponse({ description: 'AUTH_RATE_LIMITED. Enrollment verification limit exceeded.', type: AuthErrorDto })
  @ApiServiceUnavailableResponse({ description: 'AUTH_SERVICE_UNAVAILABLE. MFA encryption key, Redis, PostgreSQL or audit storage is unavailable.', type: AuthErrorDto })
  @ApiInternalServerErrorResponse({ description: 'AUTH_INTERNAL_ERROR. Unexpected failure with a safe public message.', type: AuthErrorDto })
  async confirmEnrollment(
    @Body() request: MfaEnrollmentCodeRequestDto,
    @Req() context: MfaRequestContext,
    @Res({ passthrough: true }) response: CookieResponse,
  ): Promise<MfaEnabledResponseDto> {
    const { session, token } = await this.authenticatedMutation(context);
    const result = await this.mfa.confirmEnrollment({
      userId: session.userId, sessionId: session.sessionId, sessionToken: token,
      code: request.code, ipAddress: context.ip,
    });
    response.header('Set-Cookie', this.sessionCookie(result.sessionToken, result.expiresInSeconds));
    response.header('Cache-Control', 'no-store');
    response.header('Pragma', 'no-cache');
    return {
      state: result.state,
      recoveryCodes: result.recoveryCodes,
      csrfToken: this.sessions.expectedCsrf(result.sessionToken),
    };
  }

  @Post('mfa/step-up')
  @HttpCode(200)
  @UsePipes(authRequestValidation)
  @ApiCookieAuth('renivetSession')
  @ApiOperation({
    operationId: 'stepUpWithMfa',
    summary: 'Elevate the current session with TOTP or a recovery code',
    description: 'Requires an authenticated session and the same-origin CSRF protections. Valid TOTP or an unused recovery code is consumed atomically, the opaque session is rotated, and only the new server-side session receives an MFA verification timestamp. Elevation is fresh for 300 seconds. Linear: REN2-24.',
  })
  @ApiBody({ type: MfaStepUpRequestDto })
  @ApiOkResponse({ description: 'Elevated session cookie and fresh CSRF proof.', type: MfaStepUpResponseDto, headers: { 'Set-Cookie': { schema: { type: 'string', example: '__Host-renivet_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA; Path=/; Max-Age=1800; HttpOnly; Secure; SameSite=Lax' } }, 'Cache-Control': { schema: { type: 'string', example: 'no-store' } } } })
  @ApiBadRequestResponse({ description: 'AUTH_INPUT_INVALID. Proof is neither a six-digit TOTP nor a 26-character recovery code.', type: AuthErrorDto })
  @ApiHeader({ name: 'Origin', required: true, description: 'Must exactly match a configured AUTH_ALLOWED_ORIGINS origin.' })
  @ApiHeader({ name: 'Sec-Fetch-Site', required: true, description: 'Must be same-origin.', example: 'same-origin' })
  @ApiHeader({ name: 'X-CSRF-Token', required: true, description: 'Session-bound proof returned by GET /auth/session.' })
  @ApiUnauthorizedResponse({ description: 'AUTHENTICATION_FAILED or AUTH_MFA_PROOF_INVALID. Session, factor, or one-time recovery proof is invalid or replayed.', type: AuthErrorDto })
  @ApiForbiddenResponse({ description: 'CSRF_VALIDATION_FAILED. Origin, fetch metadata, or CSRF evidence is invalid.', type: AuthErrorDto })
  @ApiTooManyRequestsResponse({ description: 'AUTH_RATE_LIMITED. MFA verification limit exceeded.', type: AuthErrorDto })
  @ApiServiceUnavailableResponse({ description: 'AUTH_SERVICE_UNAVAILABLE. MFA encryption key, Redis, PostgreSQL or audit storage is unavailable.', type: AuthErrorDto })
  @ApiInternalServerErrorResponse({ description: 'AUTH_INTERNAL_ERROR. Unexpected failure with a safe public message.', type: AuthErrorDto })
  async stepUp(
    @Body() request: MfaStepUpRequestDto,
    @Req() context: MfaRequestContext,
    @Res({ passthrough: true }) response: CookieResponse,
  ): Promise<MfaStepUpResponseDto> {
    const { session, token } = await this.authenticatedMutation(context);
    const result = await this.mfa.stepUp({
      userId: session.userId, sessionId: session.sessionId, sessionToken: token,
      code: request.code, ipAddress: context.ip,
    });
    response.header('Set-Cookie', this.sessionCookie(result.sessionToken, result.expiresInSeconds));
    response.header('Cache-Control', 'no-store');
    return { authenticationState: 'elevated', csrfToken: this.sessions.expectedCsrf(result.sessionToken) };
  }

  @Delete('mfa/factor')
  @HttpCode(200)
  @ApiCookieAuth('renivetSession')
  @ApiOperation({
    operationId: 'revokeMfaFactor',
    summary: 'Revoke the current authenticator factor',
    description: 'Requires an authenticated session, same-origin CSRF protections, and a successful step-up no older than 300 seconds. Revocation erases encrypted factor material, consumes remaining recovery codes, revokes all user sessions, and expires the current cookie. There is no support bypass. Linear: REN2-24.',
  })
  @ApiOkResponse({ description: 'Factor revoked and current secure session cookie expired.', type: MfaRevocationResponseDto, headers: { 'Set-Cookie': { schema: { type: 'string', example: '__Host-renivet_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax' } }, 'Cache-Control': { schema: { type: 'string', example: 'no-store' } } } })
  @ApiHeader({ name: 'Origin', required: true, description: 'Must exactly match a configured AUTH_ALLOWED_ORIGINS origin.' })
  @ApiHeader({ name: 'Sec-Fetch-Site', required: true, description: 'Must be same-origin.', example: 'same-origin' })
  @ApiHeader({ name: 'X-CSRF-Token', required: true, description: 'Session-bound proof returned by GET /auth/session or the latest MFA response.' })
  @ApiUnauthorizedResponse({ description: 'AUTHENTICATION_FAILED. The session is not active.', type: AuthErrorDto })
  @ApiForbiddenResponse({ description: 'CSRF_VALIDATION_FAILED or AUTH_MFA_STEP_UP_REQUIRED. CSRF or fresh MFA evidence is invalid.', type: AuthErrorDto })
  @ApiTooManyRequestsResponse({ description: 'AUTH_RATE_LIMITED. Authentication limit exceeded.', type: AuthErrorDto })
  @ApiServiceUnavailableResponse({ description: 'AUTH_SERVICE_UNAVAILABLE. PostgreSQL or audit storage is unavailable.', type: AuthErrorDto })
  @ApiInternalServerErrorResponse({ description: 'AUTH_INTERNAL_ERROR. Unexpected failure with a safe public message.', type: AuthErrorDto })
  async revokeFactor(@Req() context: MfaRequestContext, @Res({ passthrough: true }) response: CookieResponse): Promise<MfaRevocationResponseDto> {
    const { session, token } = await this.authenticatedMutation(context);
    await this.mfa.revokeFactor({ userId: session.userId, sessionId: session.sessionId, sessionToken: token, ipAddress: context.ip });
    response.header('Set-Cookie', `${sessionCookieName}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
    response.header('Cache-Control', 'no-store');
    return { status: 'revoked' };
  }

  private async authenticatedMutation(context: MfaRequestContext): Promise<{
    session: Awaited<ReturnType<SessionService['authenticate']>>;
    token: string;
  }> {
    const token = this.readSessionCookie(context.headers.cookie);
    const session = await this.sessions.authenticate(token);
    const origins = this.configuration.get<string[]>('AUTH_ALLOWED_ORIGINS') ?? [];
    if (!csrfMatches(context.headers, origins, this.sessions.expectedCsrf(token!))) throw new CsrfRejectedError();
    return { session, token: token! };
  }

  private readSessionCookie(header: string | string[] | undefined): string | undefined {
    if (Array.isArray(header) && header.length !== 1) return undefined;
    const value = Array.isArray(header) ? header[0] : header;
    const cookies = value?.split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${sessionCookieName}=`)) ?? [];
    if (cookies.length !== 1) return undefined;
    const token = cookies[0]?.slice(sessionCookieName.length + 1);
    return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
  }

  private sessionCookie(token: string, maxAge: number): string {
    return `${sessionCookieName}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
  }
}
