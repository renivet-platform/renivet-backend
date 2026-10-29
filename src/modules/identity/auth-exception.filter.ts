import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { AuthHttpError } from './auth.service';
import { AuthRateLimitExceededError, AuthRateLimitUnavailableError } from './rate-limiter';

interface FastifyAuthRequest {
  id?: string;
}

interface FastifyAuthReply {
  status(code: number): FastifyAuthReply;
  header(name: string, value: string): FastifyAuthReply;
  send(payload: unknown): void;
}

const safeNestAuthErrors: Record<string, { status: number; message: string }> = {
  AUTHENTICATION_FAILED: { status: 401, message: 'The session could not be verified.' },
  AUTH_MFA_STEP_UP_REQUIRED: { status: 403, message: 'A recent MFA step-up is required.' },
  AUTH_SERVICE_UNAVAILABLE: { status: 503, message: 'Authentication is temporarily unavailable.' },
  AUTH_POLICY_CONFIGURATION_ERROR: { status: 500, message: 'The operation could not be authorized.' },
};

@Catch()
export class AuthExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyAuthRequest>();
    const reply = http.getResponse<FastifyAuthReply>();

    let status = 500;
    let code = 'AUTH_INTERNAL_ERROR';
    let message = 'Authentication could not be completed.';

    if (exception instanceof AuthHttpError) {
      ({ status } = exception);
      ({ code, message } = exception.publicResponse);
      if (status === 429 && exception.retryAfterSeconds) {
        reply.header('Retry-After', String(exception.retryAfterSeconds));
      }
    } else if (exception instanceof AuthRateLimitExceededError) {
      status = 429;
      code = 'AUTH_RATE_LIMITED';
      message = 'Authentication is temporarily unavailable.';
      reply.header('Retry-After', String(exception.retryAfterSeconds));
    } else if (exception instanceof AuthRateLimitUnavailableError) {
      status = 503;
      code = 'AUTH_SERVICE_UNAVAILABLE';
      message = 'Authentication is temporarily unavailable.';
    } else if (exception instanceof HttpException) {
      const response = exception.getResponse();
      const candidateCode = typeof response === 'object' && response !== null && 'code' in response
        ? (response as { code?: unknown }).code
        : undefined;
      const safe = typeof candidateCode === 'string' ? safeNestAuthErrors[candidateCode] : undefined;
      if (safe && exception.getStatus() === safe.status) {
        status = safe.status;
        code = candidateCode as string;
        message = safe.message;
      }
    }

    reply.status(status).send({ code, message, requestId: request.id ?? 'unavailable' });
  }
}
