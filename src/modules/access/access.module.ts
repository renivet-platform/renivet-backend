import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { BrandAccessGuard } from './brand-access.guard';
import { BrandAccessRepository } from './brand-access.repository';
import { PlatformPermissionGuard } from './platform-permission.guard';
import { BrandMembershipController } from './brand-membership.controller';
import { BrandTeamController } from './brand-team.controller';
import { BrandTeamService } from './brand-team.service';

@Module({
  imports: [IdentityModule],
  providers: [BrandAccessRepository, BrandAccessGuard, PlatformPermissionGuard, BrandTeamService],
  controllers: [BrandMembershipController, BrandTeamController],
  exports: [BrandAccessGuard, BrandAccessRepository, PlatformPermissionGuard],
})
export class AccessModule {}
