import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  Optional,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ApiExtension } from '@nestjs/swagger';
import { MfaService } from '../../modules/identity/mfa.service';
import { readSessionToken, SessionService } from '../../modules/identity/session.service';

export type PrivilegedAction = 'brand.manage' | 'brand_membership.review' | 'staff.manage' | 'finance.evidence.manage' | 'taxonomy.manage' | 'taxonomy.approve' | 'pricing.approve' | 'catalog.review' | 'catalog.publish' | 'catalog.restrict' | 'media.write' | 'imports.write' | 'imports.confirm' | 'inventory.adjust.approve';
export type MfaEnforcementMode = 'enforced' | 'deferred';
export const REQUIRE_MFA_ACTION = 'renivet:require-mfa-action';
export const MFA_STEP_UP_MAX_AGE_SECONDS = 300;

/** Creation/import operations use authenticated sessions + scoped permissions + CSRF, without authenticator prompts. */
export const NO_STEP_UP_ACTIONS = new Set<PrivilegedAction>(['taxonomy.manage', 'imports.write', 'imports.confirm', 'media.write']);

export function RequireMfa(action: PrivilegedAction): MethodDecorator & ClassDecorator {
  return applyDecorators(
    SetMetadata(REQUIRE_MFA_ACTION, action),
    ApiExtension('x-renivet-mfa-enforcement', {
      default: 'deferred',
      deferral: 'Authenticator step-up is deferred platform-wide until explicitly enabled; authenticated sessions, scoped permissions, CSRF, audit and independent approval remain required.',
    }),
  );
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
  private readonly enforcementMode: MfaEnforcementMode;

  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly mfa: MfaService,
    @Optional()
    private readonly now: () => number = Date.now,
    @Optional()
    @Inject(ConfigService)
    configurationOrMode: ConfigService | MfaEnforcementMode = 'deferred',
  ) {
    this.enforcementMode = typeof configurationOrMode === 'string'
      ? configurationOrMode
      : configurationOrMode.get<MfaEnforcementMode>('MFA_ENFORCEMENT_MODE') ?? 'deferred';
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const action = this.reflector.get<PrivilegedAction>(REQUIRE_MFA_ACTION, context.getHandler())
      ?? this.reflector.get<PrivilegedAction>(REQUIRE_MFA_ACTION, context.getClass());
    if (!action || !['brand.manage', 'brand_membership.review', 'staff.manage', 'finance.evidence.manage', 'taxonomy.manage', 'taxonomy.approve', 'pricing.approve', 'catalog.review', 'catalog.publish', 'catalog.restrict', 'media.write', 'imports.write', 'imports.confirm', 'inventory.adjust.approve'].includes(action)) {
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

    const allowed = Boolean(session && ((this.enforcementMode === 'deferred' || NO_STEP_UP_ACTIONS.has(action))
      || hasRecentMfa(session.mfaVerifiedAt, MFA_STEP_UP_MAX_AGE_SECONDS, this.now())));
    await this.audit(action, session?.userId ?? null, session?.sessionId ?? null, allowed, request.ip ?? 'unknown');
    if (!allowed || !session) {
      throw new ForbiddenException({ code: 'AUTH_MFA_STEP_UP_REQUIRED', message: 'A recent MFA step-up is required.' });
    }
    request.authSession = { userId: session.userId, sessionId: session.sessionId };
    return true;
  }

  private async audit(action: PrivilegedAction, userId: string | null, sessionId: string | null, allowed: boolean, ipAddress: string): Promise<void> {
    try { await this.mfa.auditPrivilegedDecision({ action, userId, sessionId, allowed, ipAddress, mfaEnforcementMode: this.enforcementMode }); }
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
