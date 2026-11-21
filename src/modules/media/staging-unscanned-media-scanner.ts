import { Injectable, Logger } from '@nestjs/common';
import { MediaScannerPort } from './media-ports';

/** Staging-only test adapter. It does NOT scan for malware.
 * Never inject it into production or expose staging to untrusted uploads.
 * The media database's CLEAN state means validation passed, not a malware scan.
 */
@Injectable()
export class StagingUnscannedMediaScanner implements MediaScannerPort {
  private readonly logger = new Logger(StagingUnscannedMediaScanner.name);

  constructor() {
    this.logger.warn('STAGING ONLY: malware scanning is DISABLED. Uploads are NOT virus-scanned.');
  }

  isConfigured(): boolean { return true; }

  async scan(_bytes: Buffer): Promise<'CLEAN'> {
    // Filename, size, magic-byte and image decoding checks still run in MediaService.
    return 'CLEAN';
  }
}
