import { applyDecorators, UseGuards } from '@nestjs/common';
import { RequireMfa } from '../../common/guards/require-mfa';
import { MfaGuard } from '../../common/guards/require-mfa';
import { PlatformPermissionGuard, RequirePlatformPermission } from './platform-permission.guard';

export type GlobalTaxonomyPermission = 'taxonomy.manage' | 'taxonomy.approve';

/**
 * Protects global taxonomy operations with a global W1 permission and a fresh
 * persisted MFA step-up. Cookie-authenticated mutations must also use the
 * application's CSRF guard.
 */
export function RequireGlobalTaxonomyPermission(permission: GlobalTaxonomyPermission): MethodDecorator & ClassDecorator {
  return applyDecorators(
    RequirePlatformPermission(permission),
    RequireMfa(permission),
    UseGuards(PlatformPermissionGuard, MfaGuard),
  );
}
