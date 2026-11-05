import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { AuthHttpError } from '../identity/auth.service';
import { ClaimsError } from './claims.service';

interface Request { id?: string; }
interface Reply { status(code: number): Reply; send(payload: unknown): void; }
const ERRORS: Record<string, { status: number; message: string }> = {
  CLAIM_PROPOSAL_INVALID: { status: 422, message: 'The sustainability claim proposal is invalid.' },
  CLAIM_REQUEST_INVALID: { status: 422, message: 'The claim request is invalid.' },
  CLAIM_IF_MATCH_INVALID: { status: 422, message: 'A valid If-Match version is required.' },
  CLAIM_DECISION_INVALID: { status: 422, message: 'The claim decision is invalid.' },
  CLAIM_NOT_FOUND: { status: 404, message: 'The requested claim was not found.' },
  CLAIM_MAKER_CHECKER_CONFLICT: { status: 403, message: 'A claim submitter cannot review that claim.' },
  CLAIM_EVIDENCE_NOT_ELIGIBLE: { status: 409, message: 'The claim evidence is not eligible for verification.' },
  CLAIM_EVIDENCE_EXPIRY_CONFLICT: { status: 409, message: 'The claim expires after its supporting evidence.' },
  CLAIM_REVIEW_STATE_CONFLICT: { status: 409, message: 'The claim is no longer in a reviewable state.' },
  CLAIM_PRODUCT_NOT_FOUND: { status: 404, message: 'The requested product was not found.' },
  CLAIM_REVISION_REQUIRED: { status: 409, message: 'The product has no published revision for this claim.' },
  CLAIM_EVIDENCE_NOT_ACCESSIBLE: { status: 404, message: 'One or more evidence files are not accessible.' },
  CLAIM_PERMISSION_REVOKED: { status: 403, message: 'The claim operation is not authorized.' },
  CLAIM_VERSION_CONFLICT: { status: 412, message: 'The product version has changed.' },
  CLAIM_IDEMPOTENCY_CONFLICT: { status: 409, message: 'The idempotency key conflicts with an earlier request.' },
  CLAIM_CONFLICT: { status: 409, message: 'The claim conflicts with existing data.' },
  CLAIM_DATABASE_UNAVAILABLE: { status: 503, message: 'Claim storage is temporarily unavailable.' },
  CLAIM_INTERNAL_ERROR: { status: 500, message: 'The claim operation could not be completed.' },
};

@Catch()
export class ClaimsExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp(); const request = http.getRequest<Request>(); const reply = http.getResponse<Reply>();
    if (exception instanceof AuthHttpError) {
      reply.status(exception.status).send({ ...exception.publicResponse, requestId: request.id ?? 'unavailable' }); return;
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus(); const body = exception.getResponse();
      const candidate = body && typeof body === 'object' ? body as { code?: unknown; message?: unknown } : undefined;
      reply.status(status).send({ code: typeof candidate?.code === 'string' ? candidate.code : 'CLAIM_REQUEST_INVALID',
        message: typeof candidate?.message === 'string' ? candidate.message : 'The claim request could not be processed.', requestId: request.id ?? 'unavailable' }); return;
    }
    const code = exception instanceof ClaimsError ? exception.code : 'CLAIM_INTERNAL_ERROR';
    const error = ERRORS[code] ?? ERRORS.CLAIM_INTERNAL_ERROR!;
    reply.status(error.status).send({ code, message: error.message, requestId: request.id ?? 'unavailable' });
  }
}
