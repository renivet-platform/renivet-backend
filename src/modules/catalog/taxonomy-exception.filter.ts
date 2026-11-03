import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { AuthHttpError } from '../identity/auth.service';

interface FastifyRequest { id?: string }
interface FastifyReply {
  status(code: number): FastifyReply;
  send(payload: unknown): void;
}

const SAFE_CODES: Record<number, { code: string; message: string }> = {
  400: { code: 'CATEGORY_SCHEMA_INVALID', message: 'The request could not be processed.' },
  401: { code: 'AUTHENTICATION_FAILED', message: 'The session could not be verified.' },
  403: { code: 'PLATFORM_ACCESS_DENIED', message: 'The operation could not be authorized.' },
  404: { code: 'TAXONOMY_CATEGORY_NOT_FOUND', message: 'The requested category was not found.' },
  409: { code: 'TAXONOMY_VERSION_CONFLICT', message: 'The taxonomy version changed or the request conflicts with an earlier operation.' },
  412: { code: 'TAXONOMY_VERSION_CONFLICT', message: 'The taxonomy version changed or the request conflicts with an earlier operation.' },
  422: { code: 'CATEGORY_SCHEMA_INVALID', message: 'The category schema proposal is invalid.' },
  503: { code: 'AUTH_SERVICE_UNAVAILABLE', message: 'The service is temporarily unavailable.' },
};

@Catch()
export class TaxonomyExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    let status = 500;
    let code = 'AUTH_INTERNAL_ERROR';
    let message = 'Taxonomy administration could not be completed.';

    if (exception instanceof AuthHttpError) {
      status = exception.status;
      ({ code, message } = exception.publicResponse);
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const fallback = SAFE_CODES[status] ?? { code: 'AUTH_INTERNAL_ERROR', message };
      const payload = exception.getResponse();
      const candidate = payload && typeof payload === 'object' ? payload as { code?: unknown; message?: unknown } : undefined;
      code = typeof candidate?.code === 'string' ? candidate.code : fallback.code;
      message = typeof candidate?.message === 'string' ? candidate.message : fallback.message;
    }

    reply.status(status).send({ code, message, requestId: request.id ?? 'unavailable' });
  }
}
