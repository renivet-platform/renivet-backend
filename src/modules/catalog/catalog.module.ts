import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { MfaGuard } from '../../common/guards/require-mfa';
import { AccessModule } from '../access/access.module';
import { BrandAccessRepository } from '../access/brand-access.repository';
import { PlatformPermissionGuard } from '../access/platform-permission.guard';
import { IdentityModule } from '../identity/identity.module';
import { SessionService } from '../identity/session.service';
import { TaxonomyAdminController } from './taxonomy-admin.controller';
import { TaxonomyAdminPostgresRepository } from './taxonomy-admin.repository';
import { TAXONOMY_ADMIN_REPOSITORY, TaxonomyAdminService } from './taxonomy-admin.service';

// REN2-58 registers only the two reviewed global taxonomy schema operations.
@Module({
  imports: [ConfigModule, IdentityModule, AccessModule],
  controllers: [TaxonomyAdminController],
  providers: [
    TaxonomyAdminPostgresRepository,
    { provide: TAXONOMY_ADMIN_REPOSITORY, useExisting: TaxonomyAdminPostgresRepository },
    TaxonomyAdminService,
    {
      provide: PlatformPermissionGuard,
      useFactory: (reflector: Reflector, sessions: SessionService, access: BrandAccessRepository) =>
        new PlatformPermissionGuard(reflector, sessions, access),
      inject: [Reflector, SessionService, BrandAccessRepository],
    },
    MfaGuard,
  ],
})
export class CatalogModule {}
