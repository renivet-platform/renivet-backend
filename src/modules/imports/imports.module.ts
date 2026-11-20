import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { MfaGuard } from '../../common/guards/require-mfa';
import { AccessModule } from '../access/access.module';
import { IdentityModule } from '../identity/identity.module';
import { MfaService } from '../identity/mfa.service';
import { SessionService } from '../identity/session.service';
import { ImportUploadController } from './import-upload.controller';
import { ImportHistoryController } from './import-history.controller';
import { BrandImportCategoryRequestsController, AdminImportCategoryRequestsController } from './import-category-requests.controller';
import { ImportPreviewController } from './import-preview.controller';
import { ImportPreviewService } from './import-preview.service';
import { ImportConfirmationController } from './import-confirmation.controller';
import { ImportConfirmationService } from './import-confirmation.service';
import { ProductDraftPostgresRepository } from '../catalog/product-draft.repository';
import { ProductMediaPostgresRepository } from '../media/product-media.repository';
import { ImportRecoveryController } from './import-recovery.controller';
import { ImportRecoveryService } from './import-recovery.service';
import { ImportRetryEventHandler } from './import-retry-event.handler';

@Module({ imports: [ConfigModule, IdentityModule, AccessModule], controllers: [BrandImportCategoryRequestsController, AdminImportCategoryRequestsController, ImportHistoryController, ImportUploadController, ImportPreviewController, ImportConfirmationController, ImportRecoveryController],
  providers: [ImportPreviewService, ImportConfirmationService, ImportRecoveryService, ImportRetryEventHandler, ProductDraftPostgresRepository, ProductMediaPostgresRepository, {
    provide: MfaGuard,
    useFactory: (reflector: Reflector, sessions: SessionService, mfa: MfaService, configuration: ConfigService) =>
      new MfaGuard(reflector, sessions, mfa, Date.now, configuration.get<'enforced' | 'deferred'>('MFA_ENFORCEMENT_MODE') ?? 'enforced'),
    inject: [Reflector, SessionService, MfaService, ConfigService],
  }] })
export class ImportsModule {}
