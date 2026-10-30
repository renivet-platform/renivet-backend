import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { AuthHttpError } from './auth.service';
import { AuthRateLimitExceededError, AuthRateLimitUnavailableError, AuthRateLimiter } from './rate-limiter';
import {
  base32Encode,
  decryptTotpSecret,
  encryptTotpSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  verifyTotp,
} from './mfa-crypto';
import { MfaRepositoryPort } from './mfa.repository';
import { hashSessionToken } from './session.service';

export interface MfaServiceOptions {
  encryptionKey: Buffer | undefined;
  rateLimitHmacKey: string | undefined;
  idleTtlSeconds: number;
  enrollmentUserLimit?: number;
  enrollmentIpLimit?: number;
  stepUpUserLimit?: number;
  stepUpIpLimit?: number;
  now?: () => number;
}

export class MfaService {
  private readonly now: () => number;

  constructor(
    private readonly repository: MfaRepositoryPort,
    private readonly limiter: AuthRateLimiter,
    private readonly options: MfaServiceOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  async status(userId: string): Promise<{ state: 'not_enrolled' | 'enrollment_pending' | 'enabled'; recoveryCodesRemaining: number }> {
    try { return await this.repository.getStatus(userId); }
    catch { throw this.unavailable(); }
  }

  async beginEnrollment(input: { userId: string; sessionId: string; ipAddress: string }): Promise<{ state: 'enrollment_pending'; provisioningUri: string; expiresInSeconds: number }> {
    await this.consumeLimits('enrollment', input.userId, input.ipAddress, this.options.enrollmentUserLimit ?? 5, this.options.enrollmentIpLimit ?? 30);
    const key = this.requireEncryptionKey();
    const factorId = randomUUID();
    const secret = randomBytes(20);
    const encrypted = encryptTotpSecret(secret, key, factorId, input.userId);
    const ipHash = this.hashIp(input.ipAddress);
    let started: boolean;
    try {
      started = await this.repository.beginEnrollment({
        factorId, userId: input.userId,
        encryptedSecret: encrypted.ciphertext.toString('base64'),
        secretIv: encrypted.iv.toString('base64'), secretTag: encrypted.tag.toString('base64'),
        pendingExpiresAt: new Date(this.now() + 600_000), ipHash, sessionId: input.sessionId,
      });
    } catch { throw this.unavailable(); }
    if (!started) {
      await this.deny({ userId: input.userId, sessionId: input.sessionId, eventName: 'enrollment_denied', reason: 'factor_already_pending_or_active', ipHash });
      throw new AuthHttpError(409, 'AUTH_MFA_ENROLLMENT_UNAVAILABLE', 'MFA enrollment cannot be started for this account.');
    }
    const label = encodeURIComponent(`Renivet:${input.userId}`);
    const params = new URLSearchParams({
      secret: base32Encode(secret), issuer: 'Renivet', algorithm: 'SHA1', digits: '6', period: '30',
    });
    return { state: 'enrollment_pending', provisioningUri: `otpauth://totp/${label}?${params.toString()}`, expiresInSeconds: 600 };
  }

  async confirmEnrollment(input: { userId: string; sessionId: string; sessionToken: string; code: string; ipAddress: string }): Promise<{ state: 'enabled'; sessionId: string; sessionToken: string; expiresAt: Date; expiresInSeconds: number; recoveryCodes: string[] }> {
    await this.consumeLimits('enrollment', input.userId, input.ipAddress, this.options.enrollmentUserLimit ?? 5, this.options.enrollmentIpLimit ?? 30);
    const ipHash = this.hashIp(input.ipAddress);
    const factor = await this.getFactor(input.userId, 'pending');
    if (!factor) {
      await this.deny({ userId: input.userId, sessionId: input.sessionId, eventName: 'enrollment_denied', reason: 'pending_factor_missing_or_expired', ipHash });
      throw this.invalidProof();
    }
    const secret = this.decrypt(factor, input.userId);
    const acceptedStep = verifyTotp(secret, input.code, this.now(), factor.lastTotpStep);
    if (acceptedStep === null) {
      await this.deny({ userId: input.userId, sessionId: input.sessionId, factorId: factor.id, eventName: 'enrollment_denied', reason: 'invalid_or_replayed_totp', ipHash });
      throw this.invalidProof();
    }
    const recoveryCodes = generateRecoveryCodes(10);
    const sessionToken = randomBytes(32).toString('base64url');
    let activated: { sessionId: string; expiresAt: Date } | null;
    try {
      activated = await this.repository.activateFactor({
        userId: input.userId, factorId: factor.id, lastTotpStep: acceptedStep,
        recoveryCodeHashes: recoveryCodes.map(hashRecoveryCode), ipHash, sessionId: input.sessionId,
        currentTokenHash: hashSessionToken(input.sessionToken), newTokenHash: hashSessionToken(sessionToken),
        idleTtlSeconds: this.options.idleTtlSeconds,
      });
    } catch { throw this.unavailable(); }
    if (!activated) {
      await this.deny({ userId: input.userId, sessionId: input.sessionId, factorId: factor.id, eventName: 'enrollment_denied', reason: 'factor_expired_or_already_activated', ipHash });
      throw this.invalidProof();
    }
    return {
      state: 'enabled', sessionId: activated.sessionId, sessionToken, expiresAt: activated.expiresAt,
      expiresInSeconds: Math.max(0, Math.ceil((activated.expiresAt.getTime() - this.now()) / 1_000)),
      recoveryCodes,
    };
  }

  async stepUp(input: { userId: string; sessionId: string; sessionToken: string; code: string; ipAddress: string }): Promise<{ sessionId: string; sessionToken: string; expiresAt: Date; expiresInSeconds: number }> {
    await this.consumeLimits('step-up', input.userId, input.ipAddress, this.options.stepUpUserLimit ?? 5, this.options.stepUpIpLimit ?? 60);
    const ipHash = this.hashIp(input.ipAddress);
    const factor = await this.getFactor(input.userId, 'active');
    if (!factor) {
      await this.deny({ userId: input.userId, sessionId: input.sessionId, eventName: 'step_up_denied', reason: 'active_factor_missing', ipHash });
      throw this.invalidProof();
    }

    const normalized = input.code.replace(/-/g, '').trim().toUpperCase();
    let method: 'totp' | 'recovery_code';
    let totpStep: number | undefined;
    let recoveryCodeHash: string | undefined;
    if (/^\d{6}$/.test(normalized)) {
      method = 'totp';
      totpStep = verifyTotp(this.decrypt(factor, input.userId), normalized, this.now(), factor.lastTotpStep) ?? undefined;
      if (totpStep === undefined) {
        await this.deny({ userId: input.userId, sessionId: input.sessionId, factorId: factor.id, eventName: 'step_up_denied', reason: 'invalid_or_replayed_totp', ipHash });
        throw this.invalidProof();
      }
    } else if (/^[A-Z2-7]{26}$/.test(normalized)) {
      method = 'recovery_code';
      recoveryCodeHash = hashRecoveryCode(normalized);
    } else {
      await this.deny({ userId: input.userId, sessionId: input.sessionId, factorId: factor.id, eventName: 'step_up_denied', reason: 'invalid_factor_proof', ipHash });
      throw this.invalidProof();
    }

    const sessionToken = randomBytes(32).toString('base64url');
    let elevated: { sessionId: string; expiresAt: Date } | null;
    try {
      elevated = await this.repository.elevateSession({
        userId: input.userId, currentTokenHash: hashSessionToken(input.sessionToken),
        newTokenHash: hashSessionToken(sessionToken), factorId: factor.id, ipHash, method,
        totpStep, recoveryCodeHash, idleTtlSeconds: this.options.idleTtlSeconds,
      });
    } catch { throw this.unavailable(); }
    if (!elevated) {
      await this.deny({ userId: input.userId, sessionId: input.sessionId, factorId: factor.id, eventName: 'step_up_denied', reason: 'factor_or_session_no_longer_valid', ipHash });
      throw this.invalidProof();
    }
    return {
      sessionId: elevated.sessionId,
      sessionToken,
      expiresAt: elevated.expiresAt,
      expiresInSeconds: Math.max(0, Math.ceil((elevated.expiresAt.getTime() - this.now()) / 1_000)),
    };
  }

  async revokeFactor(input: { userId: string; sessionId: string; sessionToken: string; ipAddress: string }): Promise<void> {
    const ipHash = this.hashIp(input.ipAddress);
    let revoked: boolean;
    try {
      revoked = await this.repository.revokeFactor({
        userId: input.userId, currentTokenHash: hashSessionToken(input.sessionToken), ipHash,
        maxMfaAgeSeconds: 300,
      });
    } catch { throw this.unavailable(); }
    if (!revoked) {
      await this.deny({ userId: input.userId, sessionId: input.sessionId, eventName: 'step_up_denied', reason: 'fresh_step_up_or_active_factor_required', ipHash });
      throw new AuthHttpError(403, 'AUTH_MFA_STEP_UP_REQUIRED', 'A recent MFA step-up is required.');
    }
  }

  async auditPrivilegedDecision(input: { userId: string | null; sessionId: string | null; action: string; allowed: boolean; ipAddress: string }): Promise<void> {
    try {
      await this.repository.recordPrivilegedDecision({
        userId: input.userId, sessionId: input.sessionId, action: input.action,
        allowed: input.allowed, ipHash: this.hashIp(input.ipAddress),
      });
    } catch { throw this.unavailable(); }
  }

  private async getFactor(userId: string, state: 'pending' | 'active') {
    try {
      return state === 'pending'
        ? await this.repository.getPendingFactor(userId)
        : await this.repository.getActiveFactor(userId);
    } catch { throw this.unavailable(); }
  }

  private async consumeLimits(name: string, userId: string, ipAddress: string, userLimit: number, ipLimit: number): Promise<void> {
    try {
      await this.limiter.consume(`mfa-${name}-user`, userId, { limit: userLimit, windowSeconds: 900 });
      await this.limiter.consume(`mfa-${name}-ip`, ipAddress, { limit: ipLimit, windowSeconds: 900 });
    } catch (error) {
      if (error instanceof AuthRateLimitExceededError) {
        throw new AuthHttpError(429, 'AUTH_RATE_LIMITED', 'Authentication is temporarily unavailable.', error.retryAfterSeconds);
      }
      if (error instanceof AuthRateLimitUnavailableError) throw this.unavailable();
      throw this.unavailable();
    }
  }

  private async deny(input: Parameters<MfaRepositoryPort['recordDenied']>[0]): Promise<void> {
    try { await this.repository.recordDenied(input); }
    catch { throw this.unavailable(); }
  }

  private decrypt(factor: { id: string; encryptedSecret: string; secretIv: string; secretTag: string }, userId: string): Buffer {
    return decryptTotpSecret({
      ciphertext: Buffer.from(factor.encryptedSecret, 'base64'),
      iv: Buffer.from(factor.secretIv, 'base64'),
      tag: Buffer.from(factor.secretTag, 'base64'),
    }, this.requireEncryptionKey(), factor.id, userId);
  }

  private requireEncryptionKey(): Buffer {
    const key = this.options.encryptionKey;
    if (!key || key.length !== 32) throw this.unavailable();
    return key;
  }

  private hashIp(ipAddress: string): string {
    const key = this.options.rateLimitHmacKey;
    if (!key || key.length < 32) throw this.unavailable();
    return createHmac('sha256', key).update(`renivet-mfa-audit-ip-v1\0${ipAddress}`).digest('hex');
  }

  private invalidProof(): AuthHttpError {
    return new AuthHttpError(401, 'AUTH_MFA_PROOF_INVALID', 'The authentication factor could not be verified.');
  }

  private unavailable(): AuthHttpError {
    return new AuthHttpError(503, 'AUTH_SERVICE_UNAVAILABLE', 'Authentication is temporarily unavailable.');
  }
}
