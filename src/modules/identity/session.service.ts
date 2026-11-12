import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { AuthHttpError } from './auth.service';

export interface SessionRepositoryPort {
  findAndTouchSession(tokenHash: string, idleTtlSeconds: number, absoluteTtlSeconds: number): Promise<{ sessionId: string; userId: string; expiresAt: Date; mfaVerifiedAt: Date | null } | null>;
  revokeSession(tokenHash: string): Promise<boolean>;
}

export class SessionDeniedError extends AuthHttpError {
  constructor() { super(401, 'AUTHENTICATION_FAILED', 'The session could not be verified.'); }
}

export class CsrfRejectedError extends AuthHttpError {
  constructor() { super(403, 'CSRF_VALIDATION_FAILED', 'The request could not be processed.'); }
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function deriveCsrfToken(sessionToken: string, key: string): string {
  return createHmac('sha256', key).update(`renivet-csrf-v1\0${sessionToken}`).digest('base64url');
}

const SESSION_COOKIE_NAME = '__Host-renivet_session';
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Read exactly one valid first-party session cookie; ambiguous headers fail closed. */
export function readSessionToken(cookieHeader: string | string[] | undefined): string | undefined {
  if (Array.isArray(cookieHeader) && cookieHeader.length !== 1) return undefined;
  const header = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
  const matches = header?.split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${SESSION_COOKIE_NAME}=`)) ?? [];
  if (matches.length !== 1) return undefined;
  const token = matches[0]?.slice(SESSION_COOKIE_NAME.length + 1);
  return token && SESSION_TOKEN_PATTERN.test(token) ? token : undefined;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function validateCsrfRequest(
  headers: Record<string, string | string[] | undefined>,
  allowedOrigins: string[],
  expectedToken: string,
): boolean {
  const one = (value: string | string[] | undefined): string | undefined =>
    typeof value === 'string' ? value : value?.length === 1 ? value[0] : undefined;
  const origin = one(headers.origin);
  const fetchSite = one(headers['sec-fetch-site']);
  const csrf = one(headers['x-csrf-token']);
  return Boolean(origin && allowedOrigins.includes(origin) && fetchSite === 'same-origin' && csrf && safeEqual(csrf, expectedToken));
}

export class SessionService {
  constructor(
    private readonly repository: SessionRepositoryPort,
    private readonly csrfKey: string | undefined,
    private readonly idleTtlSeconds = 1_800,
    private readonly absoluteTtlSeconds = 604_800,
  ) {}

  async authenticate(sessionToken: string | undefined): Promise<{ sessionId: string; userId: string; csrfToken: string; expiresInSeconds: number; mfaVerifiedAt: Date | null }> {
    if (!sessionToken || !/^[A-Za-z0-9_-]{43}$/.test(sessionToken) || !this.csrfKey || this.csrfKey.length < 32) {
      throw new SessionDeniedError();
    }
    let session: { sessionId: string; userId: string; expiresAt: Date; mfaVerifiedAt: Date | null } | null;
    try {
      session = await this.repository.findAndTouchSession(hashSessionToken(sessionToken), this.idleTtlSeconds, this.absoluteTtlSeconds);
    } catch {
      throw new AuthHttpError(503, 'AUTH_SERVICE_UNAVAILABLE', 'Authentication is temporarily unavailable.');
    }
    if (!session) throw new SessionDeniedError();
    // Round down so the browser's cookie never outlives the exact server expiry.
    const expiresInSeconds = Math.max(0, Math.floor((session.expiresAt.getTime() - Date.now()) / 1_000));
    return {
      sessionId: session.sessionId,
      userId: session.userId,
      csrfToken: deriveCsrfToken(sessionToken, this.csrfKey),
      expiresInSeconds,
      mfaVerifiedAt: session.mfaVerifiedAt,
    };
  }

  async logout(sessionToken: string | undefined): Promise<void> {
    if (!sessionToken || !/^[A-Za-z0-9_-]{43}$/.test(sessionToken)) throw new SessionDeniedError();
    try {
      if (!await this.repository.revokeSession(hashSessionToken(sessionToken))) throw new SessionDeniedError();
    } catch (error) {
      if (error instanceof AuthHttpError) throw error;
      throw new AuthHttpError(503, 'AUTH_SERVICE_UNAVAILABLE', 'Authentication is temporarily unavailable.');
    }
  }

  expectedCsrf(sessionToken: string): string {
    if (!this.csrfKey || this.csrfKey.length < 32) throw new AuthHttpError(503, 'AUTH_SERVICE_UNAVAILABLE', 'Authentication is temporarily unavailable.');
    return deriveCsrfToken(sessionToken, this.csrfKey);
  }
}

export function csrfMatches(headers: Record<string, string | string[] | undefined>, origins: string[], token: string): boolean {
  return validateCsrfRequest(headers, origins, token);
}
