import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AccessModule } from '../access/access.module';
import { IdentityModule } from '../identity/identity.module';
import { ImportUploadController } from './import-upload.controller';
import { ImportPreviewController } from './import-preview.controller';
import { ImportPreviewService } from './import-preview.service';

@Module({ imports: [ConfigModule, IdentityModule, AccessModule], controllers: [ImportUploadController, ImportPreviewController], providers: [ImportPreviewService] })
export class ImportsModule {}
