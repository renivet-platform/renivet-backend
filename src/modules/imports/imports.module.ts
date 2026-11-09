import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AccessModule } from '../access/access.module';
import { IdentityModule } from '../identity/identity.module';
import { ImportUploadController } from './import-upload.controller';

@Module({ imports: [ConfigModule, IdentityModule, AccessModule], controllers: [ImportUploadController] })
export class ImportsModule {}
