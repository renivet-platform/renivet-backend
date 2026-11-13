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
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBody,
  ApiCookieAuth,
  ApiHeader,
  ApiInternalServerErrorResponse,
  ApiOperation,
  ApiResponse,
  ApiServiceUnavailableResponse,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthHttpError, AuthService } from './auth.service';
import { AuthExceptionFilter } from './auth-exception.filter';
import { CsrfRejectedError, csrfMatches, readSessionToken, SessionService } from './session.service';
import { ConfigService } from '@nestjs/config';
import {
  AuthErrorDto,
  PasswordSessionRequestDto,
  PasswordSessionResponseDto,
  RegisterRequestDto,
  RegistrationAcceptedDto,
} from './auth.dto';

interface AuthenticatedRequestContext {
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
export class AuthController {
  constructor(private readonly authentication: AuthService, private readonly sessions: SessionService, private readonly configuration: ConfigService) {}

  @Post('register')
  @HttpCode(202)
  @UsePipes(authRequestValidation)
  @ApiOperation({
    operationId: 'registerWithEmailAndPassword',
    summary: 'Begin first-party email registration',
    description: 'Public endpoint; no authentication or permission is required. Creates a pending-verification account. A duplicate canonical email receives the same accepted response. Email verification is performed by the separate OTP workflow. Linear: REN2-21.',
  })
  @ApiBody({ type: RegisterRequestDto })
  @ApiAcceptedResponse({ description: 'Generic accepted result; does not reveal whether the email is already registered.', type: RegistrationAcceptedDto })
  @ApiBadRequestResponse({ description: 'AUTH_INPUT_INVALID. Invalid email, unsupported fields, or password outside the 8 to 128 character policy.', type: AuthErrorDto })
  @ApiTooManyRequestsResponse({ description: 'AUTH_RATE_LIMITED. Registration limit exceeded.', type: AuthErrorDto, headers: { 'Retry-After': { description: 'Seconds before retrying.', schema: { type: 'integer', example: 900 } } } })
  @ApiServiceUnavailableResponse({ description: 'AUTH_SERVICE_UNAVAILABLE. PostgreSQL or Redis is unavailable; registration fails closed.', type: AuthErrorDto })
  @ApiInternalServerErrorResponse({ description: 'AUTH_INTERNAL_ERROR. Unexpected failure with a safe public message.', type: AuthErrorDto })
  async register(
    @Body() request: RegisterRequestDto,
    @Req() context: AuthenticatedRequestContext,
  ): Promise<RegistrationAcceptedDto> {
    return this.authentication.register(request, context.ip);
  }

  @Post('sessions')
  @HttpCode(200)
  @UsePipes(authRequestValidation)
  @ApiOperation({
    operationId: 'createPasswordSession',
    summary: 'Authenticate with a verified email and password',
    description: 'Public endpoint; no existing authentication or permission is required. Unknown, inactive, unverified, and incorrect credentials share one failure response. Success issues an opaque host-only cookie; only its SHA-256 digest is stored. Linear: REN2-21.',
  })
  @ApiBody({ type: PasswordSessionRequestDto })
  @ApiResponse({
    status: 200,
    description: 'Authenticated minimal identity and opaque session cookie.',
    type: PasswordSessionResponseDto,
    schema: { example: { authenticationState: 'authenticated', user: { id: '7d785d72-ea2c-44bb-9d82-87b272112b32' } } },
    headers: {
      'Set-Cookie': { description: 'HttpOnly; Secure; SameSite=Lax; Path=/; no Domain attribute.', schema: { type: 'string', example: '__Host-renivet_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA; Path=/; Max-Age=1800; HttpOnly; Secure; SameSite=Lax' } },
    },
  })
  @ApiBadRequestResponse({ description: 'AUTH_INPUT_INVALID. Invalid input.', type: AuthErrorDto })
  @ApiUnauthorizedResponse({ description: 'AUTHENTICATION_FAILED. Generic credential verification failure.', type: AuthErrorDto })
  @ApiTooManyRequestsResponse({ description: 'AUTH_RATE_LIMITED. Authentication limit exceeded.', type: AuthErrorDto, headers: { 'Retry-After': { description: 'Seconds before retrying.', schema: { type: 'integer', example: 900 } } } })
  @ApiServiceUnavailableResponse({ description: 'AUTH_SERVICE_UNAVAILABLE. PostgreSQL or Redis is unavailable; authentication fails closed.', type: AuthErrorDto })
  @ApiInternalServerErrorResponse({ description: 'AUTH_INTERNAL_ERROR. Unexpected failure with a safe public message.', type: AuthErrorDto })
  async createPasswordSession(
    @Body() request: PasswordSessionRequestDto,
    @Req() context: AuthenticatedRequestContext,
    @Res({ passthrough: true }) response: CookieResponse,
  ): Promise<PasswordSessionResponseDto> {
    const result = await this.authentication.login(request, context.ip, readSessionToken(context.headers.cookie));
    response.header('Cache-Control', 'no-store');
    response.header(
      'Set-Cookie',
      `${sessionCookieName}=${result.sessionToken}; Path=/; Max-Age=${result.expiresInSeconds}; HttpOnly; Secure; SameSite=Lax`,
    );
    return {
      authenticationState: 'authenticated',
      user: { id: result.userId },
    };
  }

  @Get('session')
  @ApiCookieAuth('renivetSession')
  @ApiOperation({ operationId: 'getCurrentSession', summary: 'Inspect the authenticated first-party session', description: 'Requires a valid opaque session cookie. Returns a minimal user identity and a session-bound CSRF token for same-origin mutations. Idle expiry is extended up to the seven-day absolute limit. Linear: REN2-23.' })
  @ApiResponse({ status: 200, description: 'Active identity and session-bound CSRF token; refreshes the session cookie to its server-calculated idle expiry, capped by its absolute expiry.', headers: { 'Cache-Control': { description: 'Sensitive session response must not be cached.', schema: { type: 'string', example: 'no-store' } }, 'Set-Cookie': { description: 'Refreshed host-only session cookie, capped at the server-calculated idle/absolute expiry.', schema: { type: 'string', example: '__Host-renivet_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA; Path=/; Max-Age=1800; HttpOnly; Secure; SameSite=Lax' } } }, schema: { example: { authenticationState: 'authenticated', user: { id: '7d785d72-ea2c-44bb-9d82-87b272112b32' }, csrfToken: 'synthetic-csrf-token' } } })
  @ApiUnauthorizedResponse({ description: 'AUTHENTICATION_FAILED. Missing, expired, revoked or invalid session.', type: AuthErrorDto })
  @ApiServiceUnavailableResponse({ description: 'AUTH_SERVICE_UNAVAILABLE. Session store or CSRF configuration is unavailable.', type: AuthErrorDto })
  @ApiInternalServerErrorResponse({ description: 'AUTH_INTERNAL_ERROR. Unexpected failure with a safe public message.', type: AuthErrorDto })
  async getSession(@Req() context: AuthenticatedRequestContext, @Res({ passthrough: true }) response: CookieResponse): Promise<{ authenticationState: 'authenticated'; user: { id: string }; csrfToken: string }> {
    const session = await this.sessions.authenticate(readSessionToken(context.headers.cookie));
    response.header('Cache-Control', 'no-store');
    const token = readSessionToken(context.headers.cookie)!;
    response.header(
      'Set-Cookie',
      `${sessionCookieName}=${token}; Path=/; Max-Age=${session.expiresInSeconds}; HttpOnly; Secure; SameSite=Lax`,
    );
    return { authenticationState: 'authenticated', user: { id: session.userId }, csrfToken: session.csrfToken };
  }

  @Delete('session')
  @HttpCode(200)
  @ApiCookieAuth('renivetSession')
  @ApiOperation({ operationId: 'logoutCurrentSession', summary: 'Revoke the current session', description: 'Requires a valid session cookie, exact allowlisted Origin, Sec-Fetch-Site: same-origin, and the session-bound X-CSRF-Token returned by GET /auth/session. Revocation is server-side before the cookie is expired. Linear: REN2-23.' })
  @ApiResponse({ status: 200, description: 'Session revoked and host-only cookie expired.', schema: { example: { status: 'logged_out' } } })
  @ApiHeader({ name: 'Origin', required: true, description: 'Must exactly match one configured AUTH_ALLOWED_ORIGINS origin.', example: 'https://app.example.test' })
  @ApiHeader({ name: 'Sec-Fetch-Site', required: true, description: 'Must be same-origin.', example: 'same-origin' })
  @ApiHeader({ name: 'X-CSRF-Token', required: true, description: 'Must equal the session-bound proof returned by GET /auth/session.' })
  @ApiUnauthorizedResponse({ description: 'AUTHENTICATION_FAILED. Session is not active.', type: AuthErrorDto })
  @ApiResponse({ status: 403, description: 'CSRF_VALIDATION_FAILED. Origin, fetch metadata or CSRF evidence is invalid.', type: AuthErrorDto })
  @ApiServiceUnavailableResponse({ description: 'AUTH_SERVICE_UNAVAILABLE. Session store or CSRF configuration is unavailable.', type: AuthErrorDto })
  @ApiInternalServerErrorResponse({ description: 'AUTH_INTERNAL_ERROR. Unexpected failure with a safe public message.', type: AuthErrorDto })
  async logout(@Req() context: AuthenticatedRequestContext, @Res({ passthrough: true }) response: CookieResponse): Promise<{ status: 'logged_out' }> {
    const token = readSessionToken(context.headers.cookie);
    if (!token) await this.sessions.authenticate(token);
    const origins = this.configuration.get<string[]>('AUTH_ALLOWED_ORIGINS') ?? [];
    if (!csrfMatches(context.headers, origins, this.sessions.expectedCsrf(token!))) {
      throw new CsrfRejectedError();
    }
    await this.sessions.logout(token);
    response.header('Set-Cookie', `${sessionCookieName}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
    response.header('Cache-Control', 'no-store');
    return { status: 'logged_out' };
  }

}
