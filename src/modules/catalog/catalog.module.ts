import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { MfaGuard } from '../../common/guards/require-mfa';
import { AccessModule } from '../access/access.module';
import { BrandAccessRepository } from '../access/brand-access.repository';
import { PlatformPermissionGuard } from '../access/platform-permission.guard';
import { IdentityModule } from '../identity/identity.module';
import { SessionService } from '../identity/session.service';
import { CatalogReadController } from './catalog-read.controller';
import { CatalogReadPostgresRepository } from './catalog-read.repository';
import { CATALOG_READ_REPOSITORY, CatalogReadService } from './catalog-read.service';
import { TaxonomyAdminController } from './taxonomy-admin.controller';
import { TaxonomyAdminPostgresRepository } from './taxonomy-admin.repository';
import { TAXONOMY_ADMIN_REPOSITORY, TaxonomyAdminService } from './taxonomy-admin.service';
import { ProductDraftController } from './product-draft.controller';
import { ProductDraftPostgresRepository } from './product-draft.repository';
import { PRODUCT_DRAFT_REPOSITORY, ProductDraftService } from './product-draft.service';
import { PriceController } from './price.controller';
import { PriceReviewController } from './price-review.controller';
import { PricePostgresRepository } from './price.repository';
import { PRICE_REPOSITORY, PriceService } from './price.service';
import { ClaimsController } from './claims.controller';
import { ClaimsPostgresRepository } from './claims.repository';
import { CLAIMS_REPOSITORY, ClaimsService } from './claims.service';

// W2 taxonomy administration, brand reads, and progressive parent draft writes.
@Module({
  imports: [ConfigModule, IdentityModule, AccessModule],
  controllers: [TaxonomyAdminController, CatalogReadController, ProductDraftController, PriceController, PriceReviewController, ClaimsController],
  providers: [
    TaxonomyAdminPostgresRepository,
    { provide: TAXONOMY_ADMIN_REPOSITORY, useExisting: TaxonomyAdminPostgresRepository },
    TaxonomyAdminService,
    CatalogReadPostgresRepository,
    { provide: CATALOG_READ_REPOSITORY, useExisting: CatalogReadPostgresRepository },
    CatalogReadService,
    ProductDraftPostgresRepository,
    { provide: PRODUCT_DRAFT_REPOSITORY, useExisting: ProductDraftPostgresRepository },
    ProductDraftService,
    PricePostgresRepository,
    { provide: PRICE_REPOSITORY, useExisting: PricePostgresRepository },
    PriceService,
    ClaimsPostgresRepository,
    { provide: CLAIMS_REPOSITORY, useExisting: ClaimsPostgresRepository },
    ClaimsService,
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
