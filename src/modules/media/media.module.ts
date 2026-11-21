import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { MfaGuard } from '../../common/guards/require-mfa';
import { AccessModule } from '../access/access.module';
import { IdentityModule } from '../identity/identity.module';
import { MfaService } from '../identity/mfa.service';
import { SessionService } from '../identity/session.service';
import { ClamAvMediaScanner } from './clamav-media-scanner';
import { StagingUnscannedMediaScanner } from './staging-unscanned-media-scanner';
import { MediaController } from './media.controller';
import { LocalMediaTransferController } from './local-media-transfer.controller';
import { LocalMediaStorage } from './local-media-storage';
import { MediaPostgresRepository } from './media.repository';
import { ProductMediaController } from './product-media.controller';
import { ProductMediaPostgresRepository } from './product-media.repository';
import { ProductMediaService } from './product-media.service';
import { MEDIA_IMAGE_PROCESSOR, MEDIA_SCANNER, MEDIA_STORAGE, MediaScannerPort } from './media-ports';
import { MediaService } from './media.service';
import { SharpMediaImageProcessor } from './sharp-media-image-processor';
import { SpacesMediaStorage } from './spaces-media-storage';

@Module({
  imports: [ConfigModule, IdentityModule, AccessModule],
  controllers: [MediaController, LocalMediaTransferController, ProductMediaController],
  providers: [
    MediaPostgresRepository,
    ProductMediaPostgresRepository,
    SpacesMediaStorage,
    LocalMediaStorage,
    ClamAvMediaScanner,
    StagingUnscannedMediaScanner,
    SharpMediaImageProcessor,
    { provide: MEDIA_STORAGE, useFactory: (local: LocalMediaStorage, spaces: SpacesMediaStorage) =>
      local.isConfigured() ? local : spaces, inject: [LocalMediaStorage, SpacesMediaStorage] },
    { provide: MEDIA_SCANNER, useFactory: (config: ConfigService, clamAv: ClamAvMediaScanner, unscanned: StagingUnscannedMediaScanner) =>
      config.get<string>('NODE_ENV') === 'staging' && config.get<string>('MEDIA_MALWARE_SCAN_MODE') === 'skip-staging'
        ? unscanned : clamAv, inject: [ConfigService, ClamAvMediaScanner, StagingUnscannedMediaScanner] },
    { provide: MEDIA_IMAGE_PROCESSOR, useExisting: SharpMediaImageProcessor },
    {
      provide: MediaService,
      useFactory: (repository: MediaPostgresRepository, storage: SpacesMediaStorage,
        scanner: MediaScannerPort, processor: SharpMediaImageProcessor) =>
        new MediaService(repository, storage, scanner, processor),
      inject: [MediaPostgresRepository, MEDIA_STORAGE, MEDIA_SCANNER, MEDIA_IMAGE_PROCESSOR],
    },
    {
      provide: ProductMediaService,
      useFactory: (repository: ProductMediaPostgresRepository) => new ProductMediaService(repository),
      inject: [ProductMediaPostgresRepository],
    },
    {
      provide: MfaGuard,
      useFactory: (reflector: Reflector, sessions: SessionService, mfa: MfaService, configuration: ConfigService) =>
        new MfaGuard(reflector, sessions, mfa, Date.now, configuration.get<'enforced' | 'deferred'>('MFA_ENFORCEMENT_MODE') ?? 'enforced'),
      inject: [Reflector, SessionService, MfaService, ConfigService],
    },
  ],
})
export class MediaModule {}
