import { createHmac, randomBytes } from 'node:crypto';

const FIXED_WINDOW_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return {current, redis.call('TTL', KEYS[1])}
`;

const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;


export interface RedisEvalClient {
  status?: string;
  connect?: () => Promise<unknown>;
  eval(script: string, keyCount: number, ...arguments_: Array<string | number>): Promise<unknown>;
}


export interface RateLimitRule {
  limit: number;
  windowSeconds: number;
}

export class AuthRateLimitExceededError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('Authentication request rate limit exceeded.');
    this.name = 'AuthRateLimitExceededError';
  }
}

export class AuthRateLimitUnavailableError extends Error {
  constructor() {
    super('Authentication rate limiting is temporarily unavailable.');
    this.name = 'AuthRateLimitUnavailableError';
  }
}

export class AuthLockContentionError extends Error {
  constructor() {
    super('Authentication operation is already in progress.');
    this.name = 'AuthLockContentionError';
  }
}

export class AuthRateLimiter {
  private redisConnection: Promise<unknown> | undefined;

  constructor(
    private readonly redis: RedisEvalClient | null,
    private readonly hmacKey: string | undefined,
  ) {}

  async consume(scope: string, identity: string, rule: RateLimitRule): Promise<void> {
    if (!this.redis || !this.hmacKey || this.hmacKey.length < 32) {
      throw new AuthRateLimitUnavailableError();
    }

    const identityDigest = createHmac('sha256', this.hmacKey).update(identity).digest('hex');
    const key = `renivet:auth:v1:${scope}:${identityDigest}`;
    let count: number;
    let retryAfterSeconds = rule.windowSeconds;
    try {
      if (this.redis.status !== 'ready' && this.redis.connect) {
        this.redisConnection ??= this.redis.connect().finally(() => { this.redisConnection = undefined; });
        await this.redisConnection;
      }
      const result = await this.redis.eval(FIXED_WINDOW_SCRIPT, 1, key, rule.windowSeconds);
      if (Array.isArray(result)) {
        count = Number(result[0]);
        const ttl = Number(result[1]);
        if (Number.isSafeInteger(ttl) && ttl > 0) retryAfterSeconds = ttl;
      } else {
        count = Number(result);
      }
    } catch {
      throw new AuthRateLimitUnavailableError();
    }

    if (!Number.isSafeInteger(count) || count < 1) {
      throw new AuthRateLimitUnavailableError();
    }
    if (count > rule.limit) throw new AuthRateLimitExceededError(retryAfterSeconds);
  }

  async withLock<T>(scope: string, identity: string, ttlMilliseconds: number, task: () => Promise<T>): Promise<T> {
    if (!this.redis || !this.hmacKey || this.hmacKey.length < 32 || !Number.isSafeInteger(ttlMilliseconds) || ttlMilliseconds < 1) {
      throw new AuthRateLimitUnavailableError();
    }
    const identityDigest = createHmac('sha256', this.hmacKey).update(identity).digest('hex');
    const key = `renivet:auth:lock:v1:${scope}:${identityDigest}`;
    const token = randomBytes(24).toString('hex');
    try {
      if (this.redis.status !== 'ready' && this.redis.connect) {
        this.redisConnection ??= this.redis.connect().finally(() => { this.redisConnection = undefined; });
        await this.redisConnection;
      }
      const acquired = await this.redis.eval(
        "return redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX') and 1 or 0",
        1,
        key,
        token,
        ttlMilliseconds,
      );
      if (Number(acquired) !== 1) throw new AuthLockContentionError();
    } catch (error) {
      if (error instanceof AuthLockContentionError) throw error;
      throw new AuthRateLimitUnavailableError();
    }

    try {
      return await task();
    } finally {
      try {
        await this.redis.eval(RELEASE_LOCK_SCRIPT, 1, key, token);
      } catch {
        // TTL releases the lock if Redis is temporarily unavailable during cleanup.
      }
    }
  }

}
