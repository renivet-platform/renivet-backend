import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { Pool } from 'pg';

@Injectable()
export class IdentityInfrastructure implements OnModuleDestroy {
  readonly pool: Pool | null;
  readonly redis: Redis | null;

  constructor(configuration: ConfigService) {
    const databaseUrl = configuration.get<string>('DATABASE_URL');
    const redisUrl = configuration.get<string>('REDIS_URL');
    this.pool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 1_500 }) : null;
    this.redis = redisUrl
      ? new Redis(redisUrl, {
          lazyConnect: true,
          connectTimeout: 1_500,
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
          retryStrategy: () => null,
        })
      : null;
    this.redis?.on('error', () => undefined);
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([
      this.pool?.end(),
      this.redis
        ? this.redis.status === 'wait'
          ? Promise.resolve(this.redis.disconnect())
          : this.redis.quit().catch(() => this.redis?.disconnect())
        : undefined,
    ]);
  }
}
