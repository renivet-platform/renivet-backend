import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { AuthHttpError } from '../identity/auth.service';

interface ImportRequest { id?: string }
interface Reply { status(code: number): Reply; send(payload: unknown): void }

@Catch()
export class ImportExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<ImportRequest>();
    const reply = http.getResponse<Reply>();
    let status = 500;
    let code = 'IMPORT_INTERNAL_ERROR';
    let message = 'The import request could not be completed.';
    if (exception instanceof AuthHttpError) {
      status = exception.status;
      ({ code, message } = exception.publicResponse);
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (body && typeof body === 'object') {
        const safe = body as { code?: unknown; message?: unknown };
        if (typeof safe.code === 'string') code = safe.code;
        if (typeof safe.message === 'string' && status < 500) message = safe.message;
      }
    }
    reply.status(status).send({ code, message, requestId: request.id ?? 'unavailable' });
  }
}
