import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { AuthHttpError } from '../identity/auth.service';
import { PriceError } from './price.service';

interface Request { id?: string; }
interface Reply { status(code: number): Reply; send(payload: unknown): void; }

const PUBLIC_ERRORS: Record<string, { status: number; message: string }> = {
  PRICE_PROPOSAL_INVALID: { status: 422, message: 'The price proposal is invalid.' },
  PRICE_REQUEST_INVALID: { status: 422, message: 'The price request is invalid.' },
  PRICE_IF_MATCH_INVALID: { status: 422, message: 'A valid If-Match version is required.' },
  PRICE_VARIANT_NOT_FOUND: { status: 404, message: 'The requested variant was not found.' },
  PRICE_PRICE_NOT_FOUND: { status: 404, message: 'The requested price proposal was not found.' },
  PRICE_PERMISSION_REVOKED: { status: 403, message: 'The price operation is not authorized.' },
  PRICE_VERSION_CONFLICT: { status: 409, message: 'The variant price version has changed.' },
  PRICE_IDEMPOTENCY_CONFLICT: { status: 409, message: 'The idempotency key conflicts with an earlier request.' },
  PRICE_WINDOW_CONFLICT: { status: 409, message: 'An approved price already covers part of this effective window.' },
  PRICE_DECISION_INVALID: { status: 422, message: 'The price decision is invalid.' },
  PRICE_MAKER_CHECKER_CONFLICT: { status: 403, message: 'The proposal creator cannot decide their own price proposal.' },
  PRICE_REVIEW_STATE_CONFLICT: { status: 409, message: 'The price proposal is no longer pending.' },
  PRICE_DATA_INVALID: { status: 500, message: 'Stored price data could not be returned.' },
  PRICE_DATABASE_UNAVAILABLE: { status: 503, message: 'Price storage is temporarily unavailable.' },
  PRICE_INTERNAL_ERROR: { status: 500, message: 'The price operation could not be completed.' },
};

@Catch()
export class PriceExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const reply = http.getResponse<Reply>();
    if (exception instanceof AuthHttpError) {
      reply.status(exception.status).send({ ...exception.publicResponse, requestId: request.id ?? 'unavailable' });
      return;
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const candidate = isRecord(body) ? body : {};
      reply.status(status).send({ code: typeof candidate.code === 'string' ? candidate.code : 'PRICE_REQUEST_INVALID',
        message: typeof candidate.message === 'string' ? candidate.message : 'The price request could not be processed.',
        requestId: request.id ?? 'unavailable' });
      return;
    }
    const code = exception instanceof PriceError ? exception.code : 'PRICE_INTERNAL_ERROR';
    const publicError = PUBLIC_ERRORS[code] ?? PUBLIC_ERRORS.PRICE_INTERNAL_ERROR!;
    reply.status(publicError.status).send({ code, message: publicError.message, requestId: request.id ?? 'unavailable' });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
