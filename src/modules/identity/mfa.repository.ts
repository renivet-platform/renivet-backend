import { Injectable } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { IdentityInfrastructure } from './identity-infrastructure';

export interface MfaFactorRecord {
  id: string;
  encryptedSecret: string;
  secretIv: string;
  secretTag: string;
  lastTotpStep: number | null;
}

export interface MfaRepositoryPort {
  beginEnrollment(input: { factorId: string; userId: string; encryptedSecret: string; secretIv: string; secretTag: string; pendingExpiresAt: Date; ipHash: string; sessionId: string }): Promise<boolean>;
  getStatus(userId: string): Promise<{ state: 'not_enrolled' | 'enrollment_pending' | 'enabled'; recoveryCodesRemaining: number }>;
  getPendingFactor(userId: string): Promise<MfaFactorRecord | null>;
  getActiveFactor(userId: string): Promise<MfaFactorRecord | null>;
  activateFactor(input: { userId: string; factorId: string; lastTotpStep: number; recoveryCodeHashes: string[]; ipHash: string; sessionId: string; currentTokenHash: string; newTokenHash: string; idleTtlSeconds: number }): Promise<{ sessionId: string; expiresAt: Date } | null>;
  recordDenied(input: { userId: string | null; sessionId: string | null; factorId?: string | null; eventName: 'enrollment_denied' | 'step_up_denied' | 'privileged_access_denied'; reason: string; ipHash: string; action?: string }): Promise<void>;
  elevateSession(input: { userId: string; currentTokenHash: string; newTokenHash: string; factorId: string; ipHash: string; method: 'totp' | 'recovery_code'; totpStep?: number; recoveryCodeHash?: string; idleTtlSeconds: number }): Promise<{ sessionId: string; expiresAt: Date } | null>;
  revokeFactor(input: { userId: string; currentTokenHash: string; ipHash: string; maxMfaAgeSeconds: number }): Promise<boolean>;
  recordPrivilegedDecision(input: { userId: string | null; sessionId: string | null; ipHash: string; action: string; allowed: boolean }): Promise<void>;
}

@Injectable()
export class MfaRepository implements MfaRepositoryPort {
  constructor(private readonly infrastructure: IdentityInfrastructure) {}

  async beginEnrollment(input: Parameters<MfaRepositoryPort['beginEnrollment']>[0]): Promise<boolean> {
    const client = await this.requirePool().connect();
    try {
      await client.query('BEGIN');
      const owner = await client.query(
        `SELECT id FROM identity.users
          WHERE id = $1 AND state = 'active' AND email_verified_at IS NOT NULL
          FOR UPDATE`,
        [input.userId],
      );
      if (!owner.rowCount) { await client.query('ROLLBACK'); return false; }
      const current = await client.query<{ id: string; state: string; pending_live: boolean }>(
        `SELECT id, state, (pending_expires_at > clock_timestamp()) AS pending_live
           FROM identity.mfa_factors
          WHERE user_id = $1 AND state IN ('pending', 'active')
          ORDER BY created_at DESC FOR UPDATE`,
        [input.userId],
      );
      if (current.rows.some((factor) => factor.state === 'active' || (factor.state === 'pending' && factor.pending_live))) {
        await client.query('ROLLBACK'); return false;
      }
      if (current.rows.length) {
        await client.query(
          `UPDATE identity.mfa_factors
              SET state = 'revoked', encrypted_secret = '', secret_iv = '', secret_tag = '',
                  revoked_at = clock_timestamp(), updated_at = clock_timestamp(), row_version = row_version + 1
            WHERE user_id = $1 AND state = 'pending'`,
          [input.userId],
        );
      }
      await client.query(
        `INSERT INTO identity.mfa_factors
          (id, user_id, encrypted_secret, secret_iv, secret_tag, state, pending_expires_at)
         VALUES ($1, $2, $3, $4, $5, 'pending', $6)`,
        [input.factorId, input.userId, input.encryptedSecret, input.secretIv, input.secretTag, input.pendingExpiresAt],
      );
      await this.insertAudit(client, {
        actorUserId: input.userId, sessionId: input.sessionId, factorId: input.factorId,
        eventName: 'enrollment_started', outcome: 'allowed', ipHash: input.ipHash,
        metadata: { expiresInSeconds: 600 },
      });
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async getStatus(userId: string): Promise<{ state: 'not_enrolled' | 'enrollment_pending' | 'enabled'; recoveryCodesRemaining: number }> {
    const result = await this.requirePool().query<{ state: string; recovery_codes_remaining: string }>(
      `SELECT factor.state,
              (SELECT count(*) FROM identity.mfa_recovery_codes AS recovery
                WHERE recovery.factor_id = factor.id AND recovery.consumed_at IS NULL)::text AS recovery_codes_remaining
         FROM identity.mfa_factors AS factor
        WHERE factor.user_id = $1
          AND (factor.state = 'active' OR (factor.state = 'pending' AND factor.pending_expires_at > clock_timestamp()))
        ORDER BY factor.created_at DESC LIMIT 1`,
      [userId],
    );
    const factor = result.rows[0];
    if (!factor) return { state: 'not_enrolled', recoveryCodesRemaining: 0 };
    return {
      state: factor.state === 'active' ? 'enabled' : 'enrollment_pending',
      recoveryCodesRemaining: Number(factor.recovery_codes_remaining),
    };
  }

  async getPendingFactor(userId: string): Promise<MfaFactorRecord | null> {
    return this.findFactor(
      `WHERE user_id = $1 AND state = 'pending' AND pending_expires_at > clock_timestamp()
       ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
  }

  async getActiveFactor(userId: string): Promise<MfaFactorRecord | null> {
    return this.findFactor(`WHERE user_id = $1 AND state = 'active' LIMIT 1`, [userId]);
  }

  async activateFactor(input: Parameters<MfaRepositoryPort['activateFactor']>[0]): Promise<{ sessionId: string; expiresAt: Date } | null> {
    const client = await this.requirePool().connect();
    try {
      await client.query('BEGIN');
      const currentSession = await client.query<{ id: string; absolute_expires_at: Date }>(
        `SELECT id, absolute_expires_at FROM identity.user_sessions
          WHERE token_hash = $1 AND user_id = $2 AND revoked_at IS NULL
            AND expires_at > clock_timestamp() AND absolute_expires_at > clock_timestamp()
          FOR UPDATE`,
        [input.currentTokenHash, input.userId],
      );
      if (!currentSession.rows[0]) { await client.query('ROLLBACK'); return null; }
      const factor = await client.query(
        `UPDATE identity.mfa_factors
            SET state = 'active', activated_at = clock_timestamp(), last_totp_step = $3,
                updated_at = clock_timestamp(), row_version = row_version + 1
          WHERE id = $1 AND user_id = $2 AND state = 'pending' AND pending_expires_at > clock_timestamp()
          RETURNING id`,
        [input.factorId, input.userId, input.lastTotpStep],
      );
      if (!factor.rowCount) { await client.query('ROLLBACK'); return null; }
      for (const codeHash of input.recoveryCodeHashes) {
        await client.query('INSERT INTO identity.mfa_recovery_codes (factor_id, code_hash) VALUES ($1, $2)', [input.factorId, codeHash]);
      }
      const inserted = await client.query<{ id: string; expires_at: Date }>(
        `INSERT INTO identity.user_sessions
          (user_id, token_hash, expires_at, absolute_expires_at, ip_hash, mfa_verified_at)
         VALUES ($1, $2, LEAST(clock_timestamp() + ($3::integer * interval '1 second'), $4), $4, $5, clock_timestamp())
         RETURNING id, expires_at`,
        [input.userId, input.newTokenHash, input.idleTtlSeconds, currentSession.rows[0].absolute_expires_at, input.ipHash],
      );
      await client.query(
        `UPDATE identity.user_sessions SET revoked_at = clock_timestamp(), updated_at = clock_timestamp(), row_version = row_version + 1 WHERE id = $1 AND revoked_at IS NULL`,
        [currentSession.rows[0].id],
      );
      await this.insertAudit(client, {
        actorUserId: input.userId, sessionId: inserted.rows[0].id, factorId: input.factorId,
        eventName: 'enrollment_activated', outcome: 'allowed', ipHash: input.ipHash,
        metadata: { recoveryCodeCount: input.recoveryCodeHashes.length },
      });
      await client.query('COMMIT');
      return { sessionId: inserted.rows[0].id, expiresAt: inserted.rows[0].expires_at };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async recordDenied(input: Parameters<MfaRepositoryPort['recordDenied']>[0]): Promise<void> {
    const client = await this.requirePool().connect();
    try {
      await client.query('BEGIN');
      await this.insertAudit(client, {
        actorUserId: input.userId, sessionId: input.sessionId, factorId: input.factorId ?? null,
        eventName: input.eventName, outcome: 'denied', ipHash: input.ipHash,
        metadata: input.action ? { reason: input.reason, action: input.action } : { reason: input.reason },
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async elevateSession(input: Parameters<MfaRepositoryPort['elevateSession']>[0]): Promise<{ sessionId: string; expiresAt: Date } | null> {
    const client = await this.requirePool().connect();
    try {
      await client.query('BEGIN');
      const session = await client.query<{ id: string; absolute_expires_at: Date }>(
        `SELECT id, absolute_expires_at FROM identity.user_sessions
          WHERE token_hash = $1 AND user_id = $2 AND revoked_at IS NULL
            AND expires_at > clock_timestamp() AND absolute_expires_at > clock_timestamp()
          FOR UPDATE`,
        [input.currentTokenHash, input.userId],
      );
      const factor = await client.query<{ last_totp_step: string | null }>(
        `SELECT last_totp_step FROM identity.mfa_factors
          WHERE id = $1 AND user_id = $2 AND state = 'active' FOR UPDATE`,
        [input.factorId, input.userId],
      );
      if (!session.rows[0] || !factor.rows[0]) { await client.query('ROLLBACK'); return null; }
      if (input.method === 'totp') {
        const lastStep = factor.rows[0].last_totp_step === null ? null : Number(factor.rows[0].last_totp_step);
        if (input.totpStep === undefined || (lastStep !== null && input.totpStep <= lastStep)) {
          await client.query('ROLLBACK'); return null;
        }
        await client.query(
          `UPDATE identity.mfa_factors SET last_totp_step = $2, updated_at = clock_timestamp(), row_version = row_version + 1 WHERE id = $1`,
          [input.factorId, input.totpStep],
        );
      } else {
        const consumed = await client.query(
          `UPDATE identity.mfa_recovery_codes SET consumed_at = clock_timestamp()
            WHERE factor_id = $1 AND code_hash = $2 AND consumed_at IS NULL RETURNING id`,
          [input.factorId, input.recoveryCodeHash],
        );
        if (consumed.rowCount !== 1) { await client.query('ROLLBACK'); return null; }
      }
      const inserted = await client.query<{ id: string; expires_at: Date }>(
        `INSERT INTO identity.user_sessions
          (user_id, token_hash, expires_at, absolute_expires_at, ip_hash, mfa_verified_at)
         VALUES ($1, $2, LEAST(clock_timestamp() + ($3::integer * interval '1 second'), $4), $4, $5, clock_timestamp())
         RETURNING id, expires_at`,
        [input.userId, input.newTokenHash, input.idleTtlSeconds, session.rows[0].absolute_expires_at, input.ipHash],
      );
      await client.query(
        `UPDATE identity.user_sessions SET revoked_at = clock_timestamp(), updated_at = clock_timestamp(), row_version = row_version + 1 WHERE id = $1 AND revoked_at IS NULL`,
        [session.rows[0].id],
      );
      await this.insertAudit(client, {
        actorUserId: input.userId, sessionId: inserted.rows[0].id, factorId: input.factorId,
        eventName: 'step_up_succeeded', outcome: 'allowed', ipHash: input.ipHash,
        metadata: { method: input.method },
      });
      await client.query('COMMIT');
      return { sessionId: inserted.rows[0].id, expiresAt: inserted.rows[0].expires_at };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async revokeFactor(input: Parameters<MfaRepositoryPort['revokeFactor']>[0]): Promise<boolean> {
    const client = await this.requirePool().connect();
    try {
      await client.query('BEGIN');
      const session = await client.query<{ id: string }>(
        `SELECT id FROM identity.user_sessions
          WHERE token_hash = $1 AND user_id = $2 AND revoked_at IS NULL
            AND expires_at > clock_timestamp() AND absolute_expires_at > clock_timestamp()
            AND mfa_verified_at >= clock_timestamp() - ($3::integer * interval '1 second')
          FOR UPDATE`,
        [input.currentTokenHash, input.userId, input.maxMfaAgeSeconds],
      );
      const factor = await client.query<{ id: string }>(
        `SELECT id FROM identity.mfa_factors WHERE user_id = $1 AND state = 'active' FOR UPDATE`,
        [input.userId],
      );
      if (!session.rows[0] || !factor.rows[0]) { await client.query('ROLLBACK'); return false; }
      await client.query(
        `UPDATE identity.mfa_factors
            SET state = 'revoked', encrypted_secret = '', secret_iv = '', secret_tag = '',
                revoked_at = clock_timestamp(), updated_at = clock_timestamp(), row_version = row_version + 1
          WHERE id = $1`,
        [factor.rows[0].id],
      );
      await client.query(
        `UPDATE identity.mfa_recovery_codes SET consumed_at = COALESCE(consumed_at, clock_timestamp()) WHERE factor_id = $1`,
        [factor.rows[0].id],
      );
      await client.query(
        `UPDATE identity.user_sessions SET revoked_at = clock_timestamp(), updated_at = clock_timestamp(), row_version = row_version + 1 WHERE user_id = $1 AND revoked_at IS NULL`,
        [input.userId],
      );
      await this.insertAudit(client, {
        actorUserId: input.userId, sessionId: session.rows[0].id, factorId: factor.rows[0].id,
        eventName: 'factor_revoked', outcome: 'allowed', ipHash: input.ipHash, metadata: {},
      });
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async recordPrivilegedDecision(input: Parameters<MfaRepositoryPort['recordPrivilegedDecision']>[0]): Promise<void> {
    const client = await this.requirePool().connect();
    try {
      await client.query('BEGIN');
      await this.insertAudit(client, {
        actorUserId: input.userId, sessionId: input.sessionId, factorId: null,
        eventName: input.allowed ? 'privileged_access_allowed' : 'privileged_access_denied',
        outcome: input.allowed ? 'allowed' : 'denied', ipHash: input.ipHash,
        metadata: { action: input.action },
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  private async findFactor(where: string, parameters: string[]): Promise<MfaFactorRecord | null> {
    const result = await this.requirePool().query<MfaFactorRecord & { last_totp_step: string | null }>(
      `SELECT id, encrypted_secret AS "encryptedSecret", secret_iv AS "secretIv", secret_tag AS "secretTag", last_totp_step
         FROM identity.mfa_factors ${where}`,
      parameters,
    );
    const factor = result.rows[0];
    return factor ? { ...factor, lastTotpStep: factor.last_totp_step === null ? null : Number(factor.last_totp_step) } : null;
  }

  private async insertAudit(client: PoolClient, input: {
    actorUserId: string | null; sessionId: string | null; factorId: string | null;
    eventName: string; outcome: 'allowed' | 'denied'; ipHash: string; metadata: Record<string, string | number>;
  }): Promise<void> {
    await client.query(
      `INSERT INTO identity.security_audit_events
        (actor_user_id, session_id, factor_id, event_name, outcome, ip_hash, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [input.actorUserId, input.sessionId, input.factorId, input.eventName, input.outcome, input.ipHash, JSON.stringify(input.metadata)],
    );
  }

  private requirePool(): Pool {
    const pool = this.infrastructure.pool;
    if (!pool) throw new Error('Database unavailable');
    return pool;
  }
}
