import { Injectable } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { IdentityInfrastructure } from './identity-infrastructure';
import { IdentityRepositoryPort, PasswordCredentialRecord } from './auth.service';
import { OtpChallengeRepositoryPort, OtpChannel, OtpPurpose } from './otp-challenge.service';

@Injectable()
export class IdentityRepository implements IdentityRepositoryPort, OtpChallengeRepositoryPort {
  constructor(private readonly infrastructure: IdentityInfrastructure) {}

  async createPendingAccount(email: string, passwordHash: string): Promise<boolean> {
    const pool = this.requirePool();
    let client: PoolClient | undefined;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO identity.users (email, state)
         VALUES ($1, 'pending_verification')
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [email],
      );
      if (inserted.rowCount !== 1) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query(
        `INSERT INTO identity.user_credentials (user_id, password_hash, credential_version)
         VALUES ($1, $2, 1)`,
        [inserted.rows[0].id, passwordHash],
      );
      await client.query('COMMIT');
      return true;
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => undefined);
      const code = (error as { code?: string }).code;
      if (code === '23505') return false;
      throw error;
    } finally {
      client?.release();
    }
  }

  async findPasswordCredential(email: string): Promise<PasswordCredentialRecord | null> {
    const result = await this.requirePool().query<{
      user_id: string;
      credential_id: string | null;
      state: string;
      email_verified_at: Date | null;
      password_hash: string | null;
    }>(
      `SELECT u.id AS user_id,
              c.id AS credential_id,
              u.state,
              u.email_verified_at,
              c.password_hash
         FROM identity.users AS u
         LEFT JOIN identity.user_credentials AS c
           ON c.user_id = u.id AND c.disabled_at IS NULL
        WHERE lower(btrim(u.email)) = $1
        LIMIT 1`,
      [email],
    );
    const record = result.rows[0];
    if (!record) return null;
    return {
      userId: record.user_id,
      credentialId: record.credential_id,
      state: record.state,
      emailVerifiedAt: record.email_verified_at,
      passwordHash: record.password_hash,
    };
  }

  async createSession(session: {
    userId: string;
    credentialId: string;
    tokenHash: string;
    expiresAt: Date;
    ipHash: string;
  }): Promise<boolean> {
    const pool = this.requirePool();
    let client: PoolClient | undefined;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO identity.user_sessions (user_id, token_hash, expires_at, ip_hash)
         SELECT u.id, $3, $4, $5
           FROM identity.users AS u
          WHERE u.id = $1
            AND u.state = 'active'
            AND u.email_verified_at IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM identity.user_credentials AS c
               WHERE c.id = $2 AND c.user_id = u.id AND c.disabled_at IS NULL
            )
         RETURNING id`,
        [session.userId, session.credentialId, session.tokenHash, session.expiresAt, session.ipHash],
      );
      if (inserted.rowCount !== 1) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query(
        `UPDATE identity.users
            SET last_login_at = now(), updated_at = now(), row_version = row_version + 1
          WHERE id = $1`,
        [session.userId],
      );
      await client.query('COMMIT');
      return true;
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client?.release();
    }
  }

  async findUnverified(channel: OtpChannel, destination: string): Promise<{ userId: string; destination: string } | null> {
    const column = channel === 'email' ? 'email' : 'phone';
    const verifiedColumn = channel === 'email' ? 'email_verified_at' : 'phone_verified_at';
    const result = await this.requirePool().query<{ id: string; destination: string }>(
      `SELECT id, ${column} AS destination
         FROM identity.users
        WHERE ${channel === 'email' ? 'lower(btrim(email))' : 'phone'} = $1
          AND ${verifiedColumn} IS NULL
        LIMIT 1`,
      [destination],
    );
    return result.rows[0] ? { userId: result.rows[0].id, destination: result.rows[0].destination } : null;
  }

  async issue(input: { id: string; userId: string; kind: string; codeHash: string; expiresAt: Date; destination: string }): Promise<boolean> {
    const pool = this.requirePool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${input.userId}:${input.kind}`]);
      await client.query(
        `SELECT id FROM identity.auth_challenges
          WHERE user_id = $1 AND kind = $2 AND consumed_at IS NULL AND expires_at > now()
          ORDER BY id FOR UPDATE`,
        [input.userId, input.kind],
      );
      const channel = input.kind.startsWith('email:') ? 'email' : 'phone';
      const contactColumn = channel === 'email' ? 'email' : 'phone';
      const verifiedColumn = channel === 'email' ? 'email_verified_at' : 'phone_verified_at';
      const current = await client.query(
        `SELECT id FROM identity.users WHERE id = $1 AND ${contactColumn} = $2 AND ${verifiedColumn} IS NULL FOR UPDATE`,
        [input.userId, input.destination],
      );
      if (!current.rowCount) { await client.query('ROLLBACK'); return false; }
      await client.query(
        `UPDATE identity.auth_challenges
            SET consumed_at = clock_timestamp(), updated_at = clock_timestamp(), row_version = row_version + 1
          WHERE user_id = $1 AND kind = $2 AND consumed_at IS NULL AND expires_at > now()`,
        [input.userId, input.kind],
      );
      await client.query(
        `INSERT INTO identity.auth_challenges (id, user_id, kind, code_hash, expires_at, attempt_count)
         VALUES ($1, $2, $3, $4, $5, 0)`,
        [input.id, input.userId, input.kind, input.codeHash, input.expiresAt],
      );
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async invalidate(id: string): Promise<void> {
    await this.requirePool().query(
      `UPDATE identity.auth_challenges
          SET consumed_at = clock_timestamp(), updated_at = clock_timestamp(), row_version = row_version + 1
        WHERE id = $1 AND consumed_at IS NULL`,
      [id],
    );
  }

  async verify(input: { id: string; purpose: OtpPurpose; code: string; hmacKey: string; maxAttempts: number }): Promise<'verified' | 'denied'> {
    const client = await this.requirePool().connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{
        id: string; user_id: string | null; kind: string; code_hash: string; expires_at: Date;
        attempt_count: number; consumed_at: Date | null;
      }>(
        `SELECT id, user_id, kind, code_hash, expires_at, attempt_count, consumed_at
           FROM identity.auth_challenges
          WHERE id = $1
          FOR UPDATE`,
        [input.id],
      );
      const challenge = result.rows[0];
      if (!challenge?.user_id || challenge.consumed_at || challenge.expires_at.getTime() <= Date.now() || challenge.attempt_count >= input.maxAttempts) {
        await client.query('ROLLBACK'); return 'denied';
      }
      const ownerResult = await client.query<{
        email: string | null; phone: string | null;
        email_verified_at: Date | null; phone_verified_at: Date | null;
      }>(
        `SELECT email, phone, email_verified_at, phone_verified_at
           FROM identity.users WHERE id=$1 FOR UPDATE`,
        [challenge.user_id],
      );
      const owner = ownerResult.rows[0];
      if (!owner) { await client.query('ROLLBACK'); return 'denied'; }
      const channel: OtpChannel = input.purpose === 'email_verification' ? 'email' : 'phone';
      const expectedKind = `${channel}:${input.purpose}`;
      const destination = channel === 'email' ? owner.email : owner.phone;
      if (challenge.kind !== expectedKind || !destination || (channel === 'email' ? owner.email_verified_at : owner.phone_verified_at)) {
        await client.query('ROLLBACK'); return 'denied';
      }
      const proof = createHmac('sha256', input.hmacKey)
        .update([challenge.id, challenge.user_id, channel, input.purpose, destination, input.code].join('\0'))
        .digest('hex');
      const expected = Buffer.from(challenge.code_hash, 'hex');
      const supplied = Buffer.from(proof, 'hex');
      const matches = expected.length === supplied.length && timingSafeEqual(expected, supplied);
      if (!matches) {
        const attempts = challenge.attempt_count + 1;
        await client.query(
          `UPDATE identity.auth_challenges
              SET attempt_count = $2::integer,
                  consumed_at = CASE WHEN $2::integer >= $3::integer THEN clock_timestamp() ELSE consumed_at END,
                  updated_at = clock_timestamp(), row_version = row_version + 1
            WHERE id = $1::uuid`,
          [input.id, attempts, input.maxAttempts],
        );
        await client.query('COMMIT'); return 'denied';
      }
      const verifiedColumn = channel === 'email' ? 'email_verified_at' : 'phone_verified_at';
      await client.query(
        `UPDATE identity.users
            SET ${verifiedColumn} = now(),
                state = CASE WHEN $2 = 'email' AND state = 'pending_verification' THEN 'active' ELSE state END,
                updated_at = clock_timestamp(), row_version = row_version + 1
          WHERE id = $1`,
        [challenge.user_id, channel],
      );
      await client.query(
        `UPDATE identity.auth_challenges
            SET consumed_at = clock_timestamp(), updated_at = clock_timestamp(), row_version = row_version + 1
          WHERE id = $1 AND consumed_at IS NULL`,
        [input.id],
      );
      await client.query('COMMIT');
      return 'verified';
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  private requirePool(): Pool {
    const pool = this.infrastructure.pool;
    if (!pool) throw new Error('Database unavailable');
    return pool;
  }
}
