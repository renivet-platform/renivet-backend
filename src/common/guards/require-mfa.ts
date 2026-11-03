import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MfaService } from '../../modules/identity/mfa.service';
import { readSessionToken, SessionService } from '../../modules/identity/session.service';

export type PrivilegedAction = 'brand.manage' | 'staff.manage' | 'finance.evidence.manage' | 'taxonomy.manage' | 'taxonomy.approve';
export const REQUIRE_MFA_ACTION = 'renivet:require-mfa-action';
export const MFA_STEP_UP_MAX_AGE_SECONDS = 300;

export function RequireMfa(action: PrivilegedAction): MethodDecorator & ClassDecorator {
  return SetMetadata(REQUIRE_MFA_ACTION, action);
}

export function hasRecentMfa(mfaVerifiedAt: Date | null | undefined, maxAgeSeconds: number, nowMs = Date.now()): boolean {
  if (!(mfaVerifiedAt instanceof Date) || !Number.isFinite(mfaVerifiedAt.getTime())) return false;
  const ageMs = nowMs - mfaVerifiedAt.getTime();
  return ageMs >= 0 && ageMs <= maxAgeSeconds * 1_000;
}

interface GuardRequest {
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
  authSession?: { userId: string; sessionId: string };
}

@Injectable()
export class MfaGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly mfa: MfaService,
    private readonly now: () => number = Date.now,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const action = this.reflector.get<PrivilegedAction>(REQUIRE_MFA_ACTION, context.getHandler())
      ?? this.reflector.get<PrivilegedAction>(REQUIRE_MFA_ACTION, context.getClass());
    if (!action || !['brand.manage', 'staff.manage', 'finance.evidence.manage', 'taxonomy.manage', 'taxonomy.approve'].includes(action)) {
      throw new HttpException({ code: 'AUTH_POLICY_CONFIGURATION_ERROR', message: 'The operation could not be authorized.' }, 500);
    }

    const request = context.switchToHttp().getRequest<GuardRequest>();
    const sessionToken = readSessionToken(request.headers.cookie);
    if (!sessionToken) {
      await this.audit(action, null, null, false, request.ip ?? 'unknown');
      throw new UnauthorizedException({ code: 'AUTHENTICATION_FAILED', message: 'The session could not be verified.' });
    }
    const session = await this.sessions.authenticate(sessionToken).catch(async (error: unknown) => {
      await this.audit(action, null, null, false, request.ip ?? 'unknown');
      throw this.sessionError(error);
    });

    const allowed = Boolean(session && hasRecentMfa(session.mfaVerifiedAt, MFA_STEP_UP_MAX_AGE_SECONDS, this.now()));
    await this.audit(action, session?.userId ?? null, session?.sessionId ?? null, allowed, request.ip ?? 'unknown');
    if (!allowed || !session) {
      throw new ForbiddenException({ code: 'AUTH_MFA_STEP_UP_REQUIRED', message: 'A recent MFA step-up is required.' });
    }
    request.authSession = { userId: session.userId, sessionId: session.sessionId };
    return true;
  }

  private async audit(action: PrivilegedAction, userId: string | null, sessionId: string | null, allowed: boolean, ipAddress: string): Promise<void> {
    try { await this.mfa.auditPrivilegedDecision({ action, userId, sessionId, allowed, ipAddress }); }
    catch { throw new HttpException({ code: 'AUTH_SERVICE_UNAVAILABLE', message: 'Authentication is temporarily unavailable.' }, 503); }
  }

  private sessionError(error: unknown): HttpException {
    const candidate = error as { status?: number; publicResponse?: { code?: string; message?: string } };
    const status = candidate.status === 503 ? 503 : 401;
    return status === 503
      ? new HttpException({ code: 'AUTH_SERVICE_UNAVAILABLE', message: 'Authentication is temporarily unavailable.' }, 503)
      : new UnauthorizedException({ code: candidate.publicResponse?.code ?? 'AUTHENTICATION_FAILED', message: 'The session could not be verified.' });
  }
}
