import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { AuthHttpError } from '../identity/auth.service';

interface Request { id?: string; }
interface Reply { status(code: number): Reply; send(payload: unknown): void; }

@Catch()
export class ProductDraftExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const reply = http.getResponse<Reply>();
    let status = 500;
    let code = 'PRODUCT_DRAFT_INTERNAL_ERROR';
    let message = 'The product draft could not be saved.';
    if (exception instanceof AuthHttpError) {
      status = exception.status;
      ({ code, message } = exception.publicResponse);
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      const candidate = body && typeof body === 'object' ? body as { code?: unknown; message?: unknown } : undefined;
      if (typeof candidate?.code === 'string') code = candidate.code;
      if (typeof candidate?.message === 'string') message = candidate.message;
    }
    reply.status(status).send({ code, message, requestId: request.id ?? 'unavailable' });
  }
}
