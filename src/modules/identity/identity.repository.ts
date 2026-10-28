import { Injectable } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { IdentityInfrastructure } from './identity-infrastructure';
import { IdentityRepositoryPort, PasswordCredentialRecord } from './auth.service';

@Injectable()
export class IdentityRepository implements IdentityRepositoryPort {
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

  private requirePool(): Pool {
    const pool = this.infrastructure.pool;
    if (!pool) throw new Error('Database unavailable');
    return pool;
  }
}
