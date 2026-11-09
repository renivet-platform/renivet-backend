import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AccessModule } from '../access/access.module';
import { IdentityModule } from '../identity/identity.module';
import { ImportUploadController } from './import-upload.controller';
import { ImportPreviewController } from './import-preview.controller';
import { ImportPreviewService } from './import-preview.service';
import { ImportConfirmationController } from './import-confirmation.controller';
import { ImportConfirmationService } from './import-confirmation.service';
import { ProductDraftPostgresRepository } from '../catalog/product-draft.repository';
import { ProductMediaPostgresRepository } from '../media/product-media.repository';

@Module({ imports: [ConfigModule, IdentityModule, AccessModule], controllers: [ImportUploadController, ImportPreviewController, ImportConfirmationController],
  providers: [ImportPreviewService, ImportConfirmationService, ProductDraftPostgresRepository, ProductMediaPostgresRepository] })
export class ImportsModule {}
