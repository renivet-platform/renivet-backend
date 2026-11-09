import type { EventHandler, DurableEvent } from '../../workers/durable-worker';
import type { WorkerAuthorizationContext } from '../../workers/worker-authorization';
import type { PoolClient } from 'pg';
import { Injectable } from '@nestjs/common';
import { ImportRecoveryService } from './import-recovery.service';

export const IMPORT_RETRY_CONSUMER = 'imports.retry';

@Injectable()
export class ImportRetryEventHandler implements EventHandler {
  readonly consumerId = IMPORT_RETRY_CONSUMER;
  readonly eventTypes = ['imports.retry_requested'];
  readonly authorization = { scope: 'brand' as const, purpose: 'imports.retry', effects: ['imports.retry'] };

  constructor(private readonly recovery: ImportRecoveryService) {}

  async handle(event: DurableEvent, transaction: PoolClient, authorization?: WorkerAuthorizationContext): Promise<void> {
    if (!authorization) throw Object.assign(new Error('worker authorization is required'), { code: 'IMPORT_WORKER_UNAUTHORIZED' });
    await this.recovery.processRetryEvent(event, transaction, authorization);
  }
}
