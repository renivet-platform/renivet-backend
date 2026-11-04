import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { AuthHttpError } from '../identity/auth.service';

interface Request { id?: string; }
interface Reply { status(code: number): Reply; send(payload: unknown): void; }

@Catch()
export class MediaExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const reply = http.getResponse<Reply>();
    let status = 500;
    let code = 'MEDIA_INTERNAL_ERROR';
    let message = 'The media request could not be completed.';
    let details: unknown;
    if (exception instanceof AuthHttpError) {
      status = exception.status;
      ({ code, message } = exception.publicResponse);
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      const candidate = body && typeof body === 'object' ? body as { code?: unknown; message?: unknown; details?: unknown } : undefined;
      if (status < 500) {
        if (typeof candidate?.code === 'string') code = candidate.code;
        if (typeof candidate?.message === 'string') message = candidate.message;
        if (candidate?.details && typeof candidate.details === 'object') details = candidate.details;
      }
    } else if (exception && typeof exception === 'object') {
      const candidate = exception as { status?: unknown; code?: unknown; message?: unknown };
      if (typeof candidate.status === 'number') status = candidate.status;
      if (typeof candidate.code === 'string') code = candidate.code;
      if (typeof candidate.message === 'string' && status < 500) message = candidate.message;
    }
    reply.status(status).send({ code, message, ...(details ? { details } : {}), requestId: request.id ?? 'unavailable' });
  }
}
