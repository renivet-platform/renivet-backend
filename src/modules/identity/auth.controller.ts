import {
  Body,
  Controller,
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
  ApiInternalServerErrorResponse,
  ApiOperation,
  ApiResponse,
  ApiServiceUnavailableResponse,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthHttpError, AuthService } from './auth.service';
import { AuthExceptionFilter } from './auth-exception.filter';
import {
  AuthErrorDto,
  PasswordSessionRequestDto,
  PasswordSessionResponseDto,
  RegisterRequestDto,
  RegistrationAcceptedDto,
} from './auth.dto';

interface AuthenticatedRequestContext {
  ip: string;
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
  constructor(private readonly authentication: AuthService) {}

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
  @ApiBadRequestResponse({ description: 'AUTH_INPUT_INVALID. Invalid email, unsupported fields, or password outside the 15 to 128 character policy.', type: AuthErrorDto })
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
    const result = await this.authentication.login(request, context.ip);
    response.header(
      'Set-Cookie',
      `${sessionCookieName}=${result.sessionToken}; Path=/; Max-Age=${result.expiresInSeconds}; HttpOnly; Secure; SameSite=Lax`,
    );
    return {
      authenticationState: 'authenticated',
      user: { id: result.userId },
    };
  }
}
