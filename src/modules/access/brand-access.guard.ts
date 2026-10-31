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
import { readSessionToken, SessionService } from '../identity/session.service';
import { BrandAccessRepository } from './brand-access.repository';

const authorizedContexts = new WeakSet<object>();

export const REQUIRE_BRAND_PERMISSION = 'renivet:require-brand-permission';
const PERMISSION_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function RequireBrandPermission(permission: string): MethodDecorator & ClassDecorator {
  return SetMetadata(REQUIRE_BRAND_PERMISSION, permission);
}

export interface BrandAccessContext {
  readonly userId: string;
  readonly brandId: string;
  readonly permission: string;
}

function issueBrandAccessContext(userId: string, brandId: string, permission: string): BrandAccessContext {
  const authorized = Object.freeze({ userId, brandId, permission });
  authorizedContexts.add(authorized);
  return authorized;
}

export interface SqlPredicate {
  readonly sql: string;
  readonly parameters: readonly [string, string, string];
}

/** Build a parameterized same-statement brand + current-permission predicate. */
export function buildBrandScopePredicate(
  tableAlias: string,
  context: BrandAccessContext,
  firstParameter = 1,
): SqlPredicate {
  if (!context || typeof context !== 'object' || !authorizedContexts.has(context)) {
    throw new TypeError('A server-authorized brand context is required');
  }
  if (!/^[a-z_][a-z0-9_]*$/i.test(tableAlias)) throw new TypeError('A safe SQL table alias is required');
  if (!Number.isSafeInteger(firstParameter) || firstParameter < 1) throw new TypeError('A positive SQL parameter position is required');
  const brand = `$${firstParameter}`;
  const user = `$${firstParameter + 1}`;
  const permission = `$${firstParameter + 2}`;
  return {
    sql: `${tableAlias}.brand_id = ${brand} AND EXISTS (
      SELECT 1 FROM access.effective_permissions AS live_permission
      WHERE live_permission.user_id = ${user}
        AND live_permission.permission_code = ${permission}
        AND (
          (live_permission.scope_type = 'global' AND live_permission.brand_id IS NULL)
          OR (live_permission.scope_type = 'brand' AND live_permission.brand_id = ${brand})
        )
    )`,
    parameters: [context.brandId, context.userId, context.permission],
  };
}

export interface BrandAccessRequest {
  headers: Record<string, string | string[] | undefined>;
  params?: Record<string, unknown>;
  brandAccess?: BrandAccessContext;
}

@Injectable()
export class BrandAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly access: BrandAccessRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const permission = this.reflector.get<string>(REQUIRE_BRAND_PERMISSION, context.getHandler())
      ?? this.reflector.get<string>(REQUIRE_BRAND_PERMISSION, context.getClass());
    if (typeof permission !== 'string' || !PERMISSION_PATTERN.test(permission)) {
      throw new HttpException({ code: 'AUTH_POLICY_CONFIGURATION_ERROR', message: 'The operation could not be authorized.' }, 500);
    }

    const request = context.switchToHttp().getRequest<BrandAccessRequest>();
    const token = readSessionToken(request.headers.cookie);
    if (!token) throw new UnauthorizedException({ code: 'AUTHENTICATION_FAILED', message: 'The session could not be verified.' });
    const rawBrandId = request.params?.brandId;
    if (typeof rawBrandId !== 'string' || !UUID_PATTERN.test(rawBrandId)) {
      throw this.denied();
    }

    let session: Awaited<ReturnType<SessionService['authenticate']>>;
    try {
      session = await this.sessions.authenticate(token);
    } catch (error) {
      const candidate = error as { status?: number };
      if (candidate.status === 503) {
        throw new HttpException({ code: 'AUTH_SERVICE_UNAVAILABLE', message: 'Authorization is temporarily unavailable.' }, 503);
      }
      throw new UnauthorizedException({ code: 'AUTHENTICATION_FAILED', message: 'The session could not be verified.' });
    }

    let allowed: boolean;
    try {
      allowed = await this.access.hasPermission(session.userId, rawBrandId, permission);
    } catch {
      throw new HttpException({ code: 'AUTH_SERVICE_UNAVAILABLE', message: 'Authorization is temporarily unavailable.' }, 503);
    }
    if (!allowed) throw this.denied();

    request.brandAccess = issueBrandAccessContext(session.userId, rawBrandId, permission);
    return true;
  }

  private denied(): ForbiddenException {
    return new ForbiddenException({ code: 'BRAND_ACCESS_DENIED', message: 'The operation could not be authorized.' });
  }
}
