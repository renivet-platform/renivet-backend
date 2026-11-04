import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AccessModule } from '../access/access.module';
import { IdentityModule } from '../identity/identity.module';
import { ClamAvMediaScanner } from './clamav-media-scanner';
import { MediaController } from './media.controller';
import { MediaPostgresRepository } from './media.repository';
import { MEDIA_IMAGE_PROCESSOR, MEDIA_SCANNER, MEDIA_STORAGE } from './media-ports';
import { MediaService } from './media.service';
import { SharpMediaImageProcessor } from './sharp-media-image-processor';
import { SpacesMediaStorage } from './spaces-media-storage';

@Module({
  imports: [ConfigModule, IdentityModule, AccessModule],
  controllers: [MediaController],
  providers: [
    MediaPostgresRepository,
    SpacesMediaStorage,
    ClamAvMediaScanner,
    SharpMediaImageProcessor,
    { provide: MEDIA_STORAGE, useExisting: SpacesMediaStorage },
    { provide: MEDIA_SCANNER, useExisting: ClamAvMediaScanner },
    { provide: MEDIA_IMAGE_PROCESSOR, useExisting: SharpMediaImageProcessor },
    {
      provide: MediaService,
      useFactory: (repository: MediaPostgresRepository, storage: SpacesMediaStorage,
        scanner: ClamAvMediaScanner, processor: SharpMediaImageProcessor) =>
        new MediaService(repository, storage, scanner, processor),
      inject: [MediaPostgresRepository, MEDIA_STORAGE, MEDIA_SCANNER, MEDIA_IMAGE_PROCESSOR],
    },
  ],
})
export class MediaModule {}
