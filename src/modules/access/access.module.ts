import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { BrandAccessGuard } from './brand-access.guard';
import { BrandAccessRepository } from './brand-access.repository';
import { PlatformPermissionGuard } from './platform-permission.guard';
import { BrandMembershipController } from './brand-membership.controller';

@Module({
  imports: [IdentityModule],
  providers: [BrandAccessRepository, BrandAccessGuard, PlatformPermissionGuard],
  controllers: [BrandMembershipController],
  exports: [BrandAccessGuard, BrandAccessRepository, PlatformPermissionGuard],
})
export class AccessModule {}
