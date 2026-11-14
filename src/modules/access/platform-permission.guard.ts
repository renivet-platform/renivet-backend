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

export const REQUIRE_PLATFORM_PERMISSION = 'renivet:require-platform-permission';
export const REQUIRE_PLATFORM_ADMIN_PERMISSION = 'renivet:require-platform-admin-permission';
const PERMISSION_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;

export function RequirePlatformPermission(permission: string): MethodDecorator & ClassDecorator {
  return SetMetadata(REQUIRE_PLATFORM_PERMISSION, permission);
}

export function RequirePlatformAdminPermission(permission: string): MethodDecorator & ClassDecorator {
  return (target: object, propertyKey?: string | symbol, descriptor?: PropertyDescriptor) => {
    SetMetadata(REQUIRE_PLATFORM_ADMIN_PERMISSION, true)(target, propertyKey as string, descriptor!);
    SetMetadata(REQUIRE_PLATFORM_PERMISSION, permission)(target, propertyKey as string, descriptor!);
  };
}

interface PlatformPermissionRequest {
  headers: Record<string, string | string[] | undefined>;
  platformPermission?: { readonly userId: string; readonly permission: string };
}

/** Authorize platform-wide actions only from a global W1 permission grant. */
@Injectable()
export class PlatformPermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly access: BrandAccessRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const permission = this.reflector.get<string>(REQUIRE_PLATFORM_PERMISSION, context.getHandler())
      ?? this.reflector.get<string>(REQUIRE_PLATFORM_PERMISSION, context.getClass());
    if (typeof permission !== 'string' || !PERMISSION_PATTERN.test(permission)) {
      throw new HttpException({ code: 'AUTH_POLICY_CONFIGURATION_ERROR', message: 'The operation could not be authorized.' }, 500);
    }

    const request = context.switchToHttp().getRequest<PlatformPermissionRequest>();
    const token = readSessionToken(request.headers.cookie);
    if (!token) throw new UnauthorizedException({ code: 'AUTHENTICATION_FAILED', message: 'The session could not be verified.' });

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
      const adminOnly = this.reflector.get<boolean>(REQUIRE_PLATFORM_ADMIN_PERMISSION, context.getHandler())
        ?? this.reflector.get<boolean>(REQUIRE_PLATFORM_ADMIN_PERMISSION, context.getClass()) ?? false;
      allowed = adminOnly
        ? await this.access.hasGlobalAdminPermission(session.userId, permission)
        : await this.access.hasGlobalPermission(session.userId, permission);
    } catch {
      throw new HttpException({ code: 'AUTH_SERVICE_UNAVAILABLE', message: 'Authorization is temporarily unavailable.' }, 503);
    }
    if (!allowed) {
      throw new ForbiddenException({ code: 'PLATFORM_ACCESS_DENIED', message: 'The operation could not be authorized.' });
    }

    request.platformPermission = Object.freeze({ userId: session.userId, permission });
    return true;
  }
}
