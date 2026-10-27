import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
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
    }

    reply.status(status).send({ code, message, requestId: request.id ?? 'unavailable' });
  }
}
