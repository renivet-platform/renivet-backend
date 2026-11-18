import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { BrandAccessGuard } from './brand-access.guard';
import { BrandAccessRepository } from './brand-access.repository';
import { PlatformPermissionGuard } from './platform-permission.guard';
import { BrandMembershipController } from './brand-membership.controller';
import { AdminAuditController } from './admin-audit.controller';

@Module({
  imports: [IdentityModule],
  providers: [BrandAccessRepository, BrandAccessGuard, PlatformPermissionGuard],
  controllers: [BrandMembershipController, AdminAuditController],
  exports: [BrandAccessGuard, BrandAccessRepository, PlatformPermissionGuard],
})
export class AccessModule {}
