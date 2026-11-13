import { createHash, createHmac, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { AuthHttpError, normalizeEmail } from './auth.service';
import { AuthLockContentionError, AuthRateLimitExceededError, AuthRateLimiter } from './rate-limiter';
import { OtpDeliveryPort } from './otp-delivery';
import { PasswordHashService, isPasswordAllowed } from './passwords';

export type OtpChannel = 'email' | 'phone';
export type OtpPurpose = 'email_verification' | 'phone_verification' | 'phone_login' | 'phone_registration' | 'password_recovery';

export interface OtpChallengeRepositoryPort {
  findChallengeTarget(channel: OtpChannel, purpose: OtpPurpose, destination: string): Promise<{ userId: string; destination: string } | null>;
  preparePhoneRegistration(destination: string): Promise<{ userId: string; destination: string } | null>;
  issue(input: { id: string; userId: string; kind: string; codeHash: string; expiresAt: Date; destination: string; purpose: OtpPurpose }): Promise<boolean>;
  invalidate(id: string): Promise<void>;
  verify(input: { id: string; purpose: OtpPurpose; code: string; hmacKey: string; maxAttempts: number; passwordHash?: string; sessionTokenHash?: string; sessionExpiresAt?: Date; absoluteExpiresAt?: Date; ipHash?: string }): Promise<'verified' | { status: 'authenticated'; userId: string } | 'denied'>;
}

export interface OtpChallengeOptions {
  hmacKey: string | undefined;
  ttlSeconds: number;
  maxAttempts: number;
  resendCooldownSeconds: number;
  resendWindowSeconds: number;
  resendMax: number;
  issueIpLimit?: number;
  identityLimit?: number;
  verifyIpLimit?: number;
  codeGenerator?: () => string;
  deliveryTimeoutMilliseconds?: number;
  sessionTtlSeconds?: number;
  absoluteSessionTtlSeconds?: number;
}

export class OtpChallengeError extends AuthHttpError {
  constructor(status: number, code: string, message: string, retryAfterSeconds?: number) {
    super(status, code, message, retryAfterSeconds);
    this.name = 'OtpChallengeError';
  }
}

const genericUnavailable = () => new OtpChallengeError(503, 'AUTH_SERVICE_UNAVAILABLE', 'Authentication is temporarily unavailable.');
const genericDenied = () => new OtpChallengeError(401, 'AUTHENTICATION_FAILED', 'The challenge could not be verified.');
const validPurpose = (channel: OtpChannel, purpose: OtpPurpose): boolean =>
  (channel === 'email' && ['email_verification', 'password_recovery'].includes(purpose)) || (channel === 'phone' && ['phone_verification', 'phone_login', 'phone_registration'].includes(purpose));

export function makeOtpProof(key: string, input: {
  challengeId: string; userId: string; channel: OtpChannel; purpose: OtpPurpose; destination: string; code: string;
}): string {
  return createHmac('sha256', key)
    .update([input.challengeId, input.userId, input.channel, input.purpose, input.destination, input.code].join('\0'))
    .digest('hex');
}

function normalizeDestination(channel: OtpChannel, destination: string): string | null {
  if (channel === 'email') {
    const value = normalizeEmail(destination);
    return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : null;
  }
  const value = destination.trim();
  return /^\+[1-9][0-9]{0,14}$/.test(value) ? value : null;
}

export class OtpChallengeService {
  constructor(
    private readonly repository: OtpChallengeRepositoryPort,
    private readonly limiter: AuthRateLimiter,
    private readonly delivery: OtpDeliveryPort,
    private readonly options: OtpChallengeOptions,
    private readonly passwords?: PasswordHashService,
  ) {}

  async issue(request: { channel: OtpChannel; purpose: OtpPurpose; destination: string }, ip: string): Promise<{ status: 'accepted'; challengeId: string }> {
    const destination = normalizeDestination(request.channel, request.destination);
    if (!destination || !validPurpose(request.channel, request.purpose)) {
      throw new OtpChallengeError(400, 'AUTH_INPUT_INVALID', 'The request could not be processed.');
    }
    const deliveryAvailable = this.delivery.availableFor?.(request.channel, request.purpose) ?? this.delivery.available;
    if (!this.options.hmacKey || this.options.hmacKey.length < 32 || !deliveryAvailable) throw genericUnavailable();
    await this.applyLimits('issue', request.channel, request.purpose, destination, ip);
    const issueKey = `${request.channel}:${request.purpose}:${destination}`;
    try {
      return await this.limiter.withLock('otp-issue', issueKey, 15_000, async () => {
        let identity: { userId: string; destination: string } | null;
        try {
          identity = request.purpose === 'phone_registration'
            ? await this.repository.preparePhoneRegistration(destination)
            : await this.repository.findChallengeTarget(request.channel, request.purpose, destination);
        }
        catch { throw genericUnavailable(); }
        if (!identity) return { status: 'accepted', challengeId: randomUUID() };
        const challengeId = randomUUID();
        const code = this.options.codeGenerator?.() ?? randomInt(0, 1_000_000).toString().padStart(6, '0');
        if (!/^[0-9]{6}$/.test(code)) throw genericUnavailable();
        const codeHash = makeOtpProof(this.options.hmacKey!, {
          challengeId, userId: identity.userId, channel: request.channel,
          purpose: request.purpose, destination: identity.destination, code,
        });
        const expiresAt = new Date(Date.now() + this.options.ttlSeconds * 1000);
        let issued: boolean;
        try { issued = await this.repository.issue({ id: challengeId, userId: identity.userId, kind: `${request.channel}:${request.purpose}`, codeHash, expiresAt, destination: identity.destination, purpose: request.purpose }); }
        catch { throw genericUnavailable(); }
        if (!issued) return { status: 'accepted', challengeId: randomUUID() };
        try {
          await this.sendBounded({ channel: request.channel, destination: identity.destination, purpose: request.purpose, code, expiresInSeconds: this.options.ttlSeconds });
        } catch {
          await this.repository.invalidate(challengeId).catch(() => undefined);
          // Preserve the same public acceptance shape as the unknown-contact path.
          return { status: 'accepted', challengeId: randomUUID() };
        }
        return { status: 'accepted', challengeId };
      });
    } catch (error) {
      this.mapInfrastructureError(error);
    }
  }

  async verify(request: { challengeId: string; purpose: OtpPurpose; code: string; newPassword?: string }, ip: string): Promise<{ status: 'verified' } | { status: 'authenticated'; userId: string; sessionToken: string; expiresInSeconds: number }> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.challengeId) || !/^[0-9]{6}$/.test(request.code)) {
      throw genericDenied();
    }
    if (!this.options.hmacKey || this.options.hmacKey.length < 32) throw genericUnavailable();
    if (request.purpose === 'password_recovery') {
      if (!request.newPassword || !isPasswordAllowed(request.newPassword) || !this.passwords) {
        throw new OtpChallengeError(400, 'AUTH_INPUT_INVALID', 'The request could not be processed.');
      }
    } else if (request.newPassword !== undefined) {
      throw new OtpChallengeError(400, 'AUTH_INPUT_INVALID', 'The request could not be processed.');
    }
    try {
      await this.limiter.consume('otp-verify-ip', ip, { limit: this.options.verifyIpLimit ?? 60, windowSeconds: 900 });
      let passwordHash: string | undefined;
      if (request.purpose === 'password_recovery') {
        try { passwordHash = await this.passwords!.hash(request.newPassword!); } catch { throw genericUnavailable(); }
      }
      const createsSession = request.purpose === 'phone_login' || request.purpose === 'phone_registration';
      const sessionToken = createsSession ? randomBytes(32).toString('base64url') : undefined;
      const absoluteTtl = this.options.absoluteSessionTtlSeconds ?? 604_800;
      const expiresInSeconds = Math.min(this.options.sessionTtlSeconds ?? 1_800, absoluteTtl);
      const now = Date.now();
      const result = await this.limiter.withLock('otp-verify', request.challengeId, 10_000, async () => {
        // Repository computes the proof only after loading its canonical user/contact binding.
        return this.repository.verify({ id: request.challengeId, purpose: request.purpose, code: request.code, hmacKey: this.options.hmacKey!, maxAttempts: this.options.maxAttempts, passwordHash,
          sessionTokenHash: sessionToken ? createHash('sha256').update(sessionToken).digest('hex') : undefined,
          sessionExpiresAt: sessionToken ? new Date(now + expiresInSeconds * 1000) : undefined,
          absoluteExpiresAt: sessionToken ? new Date(now + absoluteTtl * 1000) : undefined,
          ipHash: sessionToken ? createHmac('sha256', this.options.hmacKey!).update(ip).digest('hex') : undefined });
      });
      if (createsSession) {
        if (typeof result !== 'object' || !sessionToken) throw genericDenied();
        return { status: 'authenticated', userId: result.userId, sessionToken, expiresInSeconds };
      }
      if (result !== 'verified') throw genericDenied();
      return { status: 'verified' };
    } catch (error) {
      if (error instanceof OtpChallengeError) throw error;
      if (error instanceof AuthHttpError) throw error;
      this.mapInfrastructureError(error);
    }
  }

  private async applyLimits(operation: string, channel: OtpChannel, purpose: OtpPurpose, destination: string, ip: string): Promise<void> {
    const identityKey = `${channel}:${purpose}:${destination}`;
    try {
      await this.limiter.consume(`otp-${operation}-ip`, ip, { limit: this.options.issueIpLimit ?? 30, windowSeconds: 900 });
      await this.limiter.consume(`otp-${operation}-identity`, identityKey, { limit: this.options.identityLimit ?? 5, windowSeconds: 900 });
      await this.limiter.consume('otp-resend-window', identityKey, { limit: this.options.resendMax + 1, windowSeconds: this.options.resendWindowSeconds });
      await this.limiter.consume('otp-resend-cooldown', identityKey, { limit: 1, windowSeconds: this.options.resendCooldownSeconds });
    } catch (error) {
      this.mapInfrastructureError(error);
    }
  }

  private async sendBounded(message: Parameters<OtpDeliveryPort['send']>[0]): Promise<void> {
    const abort = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        reject(new Error('OTP delivery timed out.'));
      }, this.options.deliveryTimeoutMilliseconds ?? 5_000);
    });
    try {
      await Promise.race([this.delivery.send(message, abort.signal), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private mapInfrastructureError(error: unknown): never {
    if (error instanceof AuthHttpError) throw error;
    if (error instanceof AuthRateLimitExceededError) throw new OtpChallengeError(429, 'AUTH_RATE_LIMITED', 'Authentication is temporarily unavailable.', error.retryAfterSeconds);
    if (error instanceof AuthLockContentionError) throw new OtpChallengeError(429, 'AUTH_RATE_LIMITED', 'Authentication is temporarily unavailable.', 1);
    throw genericUnavailable();
  }
}
