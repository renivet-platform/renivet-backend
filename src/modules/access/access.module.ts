import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { BrandAccessGuard } from './brand-access.guard';
import { BrandAccessRepository } from './brand-access.repository';
import { PlatformPermissionGuard } from './platform-permission.guard';

@Module({
  imports: [IdentityModule],
  providers: [BrandAccessRepository, BrandAccessGuard, PlatformPermissionGuard],
  exports: [BrandAccessGuard, BrandAccessRepository, PlatformPermissionGuard],
})
export class AccessModule {}
