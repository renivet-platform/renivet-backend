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

  async preparePhoneRegistration(destination: string): Promise<{ userId: string; destination: string } | null> {
    const client = await this.requirePool().connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`phone-registration:${destination}`]);
      const existing = await client.query<{ id: string; state: string; email: string | null; phone_verified_at: Date | null; has_active_credential: boolean }>(
        `SELECT u.id, u.state, u.email, u.phone_verified_at,
                EXISTS (SELECT 1 FROM identity.user_credentials c WHERE c.user_id = u.id AND c.disabled_at IS NULL) AS has_active_credential
           FROM identity.users u
          WHERE u.phone = $1
          FOR UPDATE`,
        [destination],
      );
      if (existing.rowCount) {
        const account = existing.rows[0];
        await client.query('COMMIT');
        return account.state === 'pending_verification' && account.email === null && account.phone_verified_at === null && !account.has_active_credential
          ? { userId: account.id, destination }
          : null;
      }
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO identity.users (phone, state)
         VALUES ($1, 'pending_verification')
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [destination],
      );
      if (inserted.rowCount !== 1) {
        await client.query('ROLLBACK');
        return null;
      }
      await client.query('COMMIT');
      return { userId: inserted.rows[0].id, destination };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
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
    expectedPasswordHash: string;
    tokenHash: string;
    expiresAt: Date;
    absoluteExpiresAt?: Date;
    ipHash: string;
    previousTokenHash?: string;
  }): Promise<boolean> {
    const pool = this.requirePool();
    let client: PoolClient | undefined;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const owner = await client.query(
        `SELECT u.id
           FROM identity.users AS u
           JOIN identity.user_credentials AS c ON c.user_id = u.id
          WHERE u.id = $1 AND u.state = 'active' AND u.email_verified_at IS NOT NULL
            AND c.id = $2 AND c.password_hash = $3 AND c.disabled_at IS NULL
          FOR UPDATE OF u, c`,
        [session.userId, session.credentialId, session.expectedPasswordHash],
      );
      if (owner.rowCount !== 1) {
        await client.query('ROLLBACK');
        return false;
      }
      if (session.previousTokenHash) {
        await client.query(
          `UPDATE identity.user_sessions
              SET revoked_at = clock_timestamp(), updated_at = clock_timestamp(), row_version = row_version + 1
            WHERE token_hash = $1 AND user_id = $2 AND revoked_at IS NULL`,
          [session.previousTokenHash, session.userId],
        );
      }
      const inserted = await client.query(
        `INSERT INTO identity.user_sessions (user_id, token_hash, expires_at, ip_hash, absolute_expires_at)
         SELECT u.id, $3, $4, $5, COALESCE($7::timestamptz, clock_timestamp() + interval '7 days')
           FROM identity.users AS u
          WHERE u.id = $1
            AND u.state = 'active'
            AND u.email_verified_at IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM identity.user_credentials AS c
               WHERE c.id = $2 AND c.user_id = u.id AND c.password_hash = $6 AND c.disabled_at IS NULL
            )
         RETURNING id`,
        [session.userId, session.credentialId, session.tokenHash, session.expiresAt, session.ipHash, session.expectedPasswordHash, session.absoluteExpiresAt ?? null],
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

  async findAndTouchSession(tokenHash: string, idleTtlSeconds: number): Promise<{
    sessionId: string; userId: string; expiresAt: Date; mfaVerifiedAt: Date | null;
    signInMethod: 'phone' | 'email_password'; phoneVerified: boolean;
    destination: { kind: 'storefront' } | { kind: 'operations' } | { kind: 'brands'; brands: Array<{ id: string; name: string }> };
  } | null> {
    const result = await this.requirePool().query<{
      id: string; user_id: string; expires_at: Date; mfa_verified_at: Date | null;
      is_phone_only: boolean; phone_verified: boolean; is_admin: boolean; eligible_brands: Array<{ id: string; name: string }>;
    }>(
      `WITH refreshed AS (
         UPDATE identity.user_sessions AS session
            SET expires_at = LEAST(clock_timestamp() + ($2::integer * interval '1 second'), absolute_expires_at),
                updated_at = clock_timestamp(), row_version = row_version + 1
          WHERE token_hash = $1 AND revoked_at IS NULL
            AND expires_at > clock_timestamp()
            AND absolute_expires_at > clock_timestamp()
            AND EXISTS (SELECT 1 FROM identity.users AS active_account WHERE active_account.id = session.user_id AND active_account.state = 'active')
          RETURNING id, user_id, expires_at, mfa_verified_at
       )
       SELECT refreshed.id, refreshed.user_id, refreshed.expires_at, refreshed.mfa_verified_at,
              (account.email IS NULL AND account.phone_verified_at IS NOT NULL AND NOT EXISTS (
                SELECT 1 FROM identity.user_credentials AS credential
                 WHERE credential.user_id = account.id AND credential.disabled_at IS NULL
              )) AS is_phone_only,
              (account.phone_verified_at IS NOT NULL) AS phone_verified,
              EXISTS (
                SELECT 1 FROM access.role_assignments AS assignment
                JOIN access.roles AS role ON role.id = assignment.role_id AND role.scope_kind = 'global'
                 WHERE assignment.user_id = refreshed.user_id AND assignment.scope_type = 'global'
                   AND role.role_code = 'renivet_admin' AND assignment.active_from <= clock_timestamp()
                   AND (assignment.active_until IS NULL OR assignment.active_until > clock_timestamp())
              ) AS is_admin,
              COALESCE((
                SELECT json_agg(json_build_object('id', brand.id, 'name', brand.display_name)
                                ORDER BY lower(brand.display_name), brand.id)
                  FROM access.role_assignments AS assignment
                  JOIN access.roles AS role ON role.id = assignment.role_id AND role.scope_kind = 'brand'
                  JOIN brands.brand_memberships AS membership
                    ON membership.user_id = assignment.user_id AND membership.brand_id = assignment.brand_id
                  JOIN brands.brands AS brand ON brand.id = membership.brand_id
                 WHERE assignment.user_id = refreshed.user_id AND assignment.scope_type = 'brand'
                   AND role.role_code IN ('brand_owner', 'brand_staff')
                   AND assignment.active_from <= clock_timestamp()
                   AND (assignment.active_until IS NULL OR assignment.active_until > clock_timestamp())
                   AND membership.membership_state = 'active' AND membership.joined_at IS NOT NULL
                   AND membership.valid_from <= clock_timestamp()
                   AND (membership.valid_until IS NULL OR membership.valid_until > clock_timestamp())
                   AND brand.onboarding_state = 'approved'
              ), '[]'::json) AS eligible_brands
         FROM refreshed
         JOIN identity.users AS account ON account.id = refreshed.user_id`,
      [tokenHash, idleTtlSeconds],
    );
    return result.rows[0] ? {
      sessionId: result.rows[0].id,
      userId: result.rows[0].user_id,
      expiresAt: result.rows[0].expires_at,
      mfaVerifiedAt: result.rows[0].mfa_verified_at,
      signInMethod: result.rows[0].is_phone_only ? 'phone' : 'email_password',
      phoneVerified: result.rows[0].phone_verified,
      destination: result.rows[0].is_admin
        ? { kind: 'operations' }
        : result.rows[0].eligible_brands.length
          ? { kind: 'brands', brands: result.rows[0].eligible_brands }
          : { kind: 'storefront' },
    } : null;
  }

  async revokeSession(tokenHash: string): Promise<boolean> {
    const result = await this.requirePool().query(
      `UPDATE identity.user_sessions
          SET revoked_at = clock_timestamp(), updated_at = clock_timestamp(), row_version = row_version + 1
        WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > clock_timestamp()
          AND absolute_expires_at > clock_timestamp()`,
      [tokenHash],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async revokeUserSessions(userId: string, exceptTokenHash?: string): Promise<void> {
    await this.requirePool().query(
      `UPDATE identity.user_sessions
          SET revoked_at = clock_timestamp(), updated_at = clock_timestamp(), row_version = row_version + 1
        WHERE user_id = $1 AND revoked_at IS NULL AND ($2::text IS NULL OR token_hash <> $2)`,
      [userId, exceptTokenHash ?? null],
    );
  }

  /** Attach a phone to an active account without treating it as verified. */
  async setPhoneForVerification(userId: string, phone: string): Promise<boolean | null> {
    try {
      const result = await this.requirePool().query<{ verification_required: boolean }>(
        `UPDATE identity.users
            SET phone = $2,
                phone_verified_at = CASE WHEN phone IS DISTINCT FROM $2 THEN NULL ELSE phone_verified_at END,
                updated_at = clock_timestamp(),
                row_version = row_version + 1
          WHERE id = $1 AND state = 'active' AND email_verified_at IS NOT NULL
          RETURNING phone_verified_at IS NULL AS verification_required`,
        [userId, phone],
      );
      return result.rows[0]?.verification_required ?? null;
    } catch (error) {
      if ((error as { code?: string }).code === '23505') return null;
      throw error;
    }
  }

  async findChallengeTarget(channel: OtpChannel, purpose: OtpPurpose, destination: string): Promise<{ userId: string; destination: string } | null> {
    const column = channel === 'email' ? 'email' : 'phone';
    const verifiedColumn = channel === 'email' ? 'email_verified_at' : 'phone_verified_at';
    const recovery = purpose === 'password_recovery';
    const login = purpose === 'phone_login';
    const result = await this.requirePool().query<{ id: string; destination: string }>(
      `SELECT id, ${column} AS destination
         FROM identity.users
        WHERE ${channel === 'email' ? 'lower(btrim(email))' : 'phone'} = $1
          AND ${verifiedColumn} IS ${(recovery || login) ? 'NOT ' : ''}NULL
          AND ($2::boolean = false OR state = 'active')
          AND ($3::boolean = false OR EXISTS (SELECT 1 FROM identity.user_credentials c WHERE c.user_id = identity.users.id AND c.disabled_at IS NULL))
        LIMIT 1`,
      [destination, recovery || login, recovery],
    );
    return result.rows[0] ? { userId: result.rows[0].id, destination: result.rows[0].destination } : null;
  }

  async issue(input: { id: string; userId: string; kind: string; codeHash: string; expiresAt: Date; destination: string; purpose?: OtpPurpose }): Promise<boolean> {
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
      const recovery = input.kind === 'email:password_recovery';
      const login = input.kind === 'phone:phone_login';
      const current = await client.query(
        `SELECT id FROM identity.users
          WHERE id = $1 AND ${contactColumn} = $2 AND ${verifiedColumn} IS ${(recovery || login) ? 'NOT ' : ''}NULL
            AND ($3::boolean = false OR state = 'active')
            AND ($4::boolean = false OR EXISTS (SELECT 1 FROM identity.user_credentials c WHERE c.user_id = identity.users.id AND c.disabled_at IS NULL))
          FOR UPDATE`,
        [input.userId, input.destination, recovery || login, recovery],
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

  async verify(input: { id: string; purpose: OtpPurpose; code: string; hmacKey: string; maxAttempts: number; passwordHash?: string; sessionTokenHash?: string; sessionExpiresAt?: Date; absoluteExpiresAt?: Date; ipHash?: string }): Promise<'verified' | { status: 'authenticated'; userId: string } | 'denied'> {
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
        state: string; has_active_credential: boolean;
      }>(
        `SELECT u.email, u.phone, u.email_verified_at, u.phone_verified_at, u.state,
                EXISTS (SELECT 1 FROM identity.user_credentials c WHERE c.user_id = u.id AND c.disabled_at IS NULL) AS has_active_credential
           FROM identity.users u WHERE u.id=$1 FOR UPDATE OF u`,
        [challenge.user_id],
      );
      const owner = ownerResult.rows[0];
      if (!owner) { await client.query('ROLLBACK'); return 'denied'; }
      const channel: OtpChannel = input.purpose === 'phone_verification' || input.purpose === 'phone_login' || input.purpose === 'phone_registration' ? 'phone' : 'email';
      const expectedKind = `${channel}:${input.purpose}`;
      const destination = channel === 'email' ? owner.email : owner.phone;
      const eligible = input.purpose === 'phone_login'
        ? owner.phone_verified_at !== null && owner.state === 'active'
        : input.purpose === 'phone_registration'
        ? owner.phone_verified_at === null && owner.state === 'pending_verification' && owner.email === null && !owner.has_active_credential
        : input.purpose === 'password_recovery'
        ? owner.email_verified_at !== null && owner.state === 'active' && Boolean(input.passwordHash)
        : !(channel === 'email' ? owner.email_verified_at : owner.phone_verified_at);
      if (challenge.kind !== expectedKind || !destination || !eligible) {
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
      if (input.purpose === 'phone_login' || input.purpose === 'phone_registration') {
        if (!input.sessionTokenHash || !input.sessionExpiresAt || !input.absoluteExpiresAt || !input.ipHash) { await client.query('ROLLBACK'); return 'denied'; }
        if (input.purpose === 'phone_registration') {
          const activated = await client.query(
            `UPDATE identity.users
                SET phone_verified_at = clock_timestamp(), state = 'active', updated_at = clock_timestamp(), row_version = row_version + 1
              WHERE id = $1 AND state = 'pending_verification' AND phone = $2
                AND phone_verified_at IS NULL AND email IS NULL
                AND NOT EXISTS (SELECT 1 FROM identity.user_credentials c WHERE c.user_id = identity.users.id AND c.disabled_at IS NULL)
              RETURNING id`,
            [challenge.user_id, destination],
          );
          if (activated.rowCount !== 1) { await client.query('ROLLBACK'); return 'denied'; }
        }
        const session = await client.query(
          `INSERT INTO identity.user_sessions (user_id, token_hash, expires_at, ip_hash, absolute_expires_at)
           SELECT id, $2, $3, $4, $5 FROM identity.users
            WHERE id = $1 AND state = 'active' AND phone_verified_at IS NOT NULL
           RETURNING id`,
          [challenge.user_id, input.sessionTokenHash, input.sessionExpiresAt, input.ipHash, input.absoluteExpiresAt],
        );
        if (session.rowCount !== 1) { await client.query('ROLLBACK'); return 'denied'; }
        await client.query(`UPDATE identity.users SET last_login_at=clock_timestamp(), updated_at=clock_timestamp(), row_version=row_version+1 WHERE id=$1`, [challenge.user_id]);
      } else if (input.purpose === 'password_recovery') {
        const credentialUpdate = await client.query(
          `UPDATE identity.user_credentials
              SET password_hash = $2,
                  credential_version = (SELECT COALESCE(MAX(versioned.credential_version), 0) + 1 FROM identity.user_credentials versioned WHERE versioned.user_id = $1),
                  updated_at = clock_timestamp(), row_version = row_version + 1
            WHERE user_id = $1 AND disabled_at IS NULL`,
          [challenge.user_id, input.passwordHash],
        );
        if (credentialUpdate.rowCount !== 1) { await client.query('ROLLBACK'); return 'denied'; }
        await client.query(
          `UPDATE identity.user_sessions
              SET revoked_at = clock_timestamp(), updated_at = clock_timestamp(), row_version = row_version + 1
            WHERE user_id = $1 AND revoked_at IS NULL`,
          [challenge.user_id],
        );
      } else {
        const verifiedColumn = channel === 'email' ? 'email_verified_at' : 'phone_verified_at';
        await client.query(
          `UPDATE identity.users
              SET ${verifiedColumn} = now(),
                  state = CASE WHEN $2 = 'email' AND state = 'pending_verification' THEN 'active' ELSE state END,
                  updated_at = clock_timestamp(), row_version = row_version + 1
            WHERE id = $1`,
          [challenge.user_id, channel],
        );
      }
      await client.query(
        `UPDATE identity.auth_challenges
            SET consumed_at = clock_timestamp(), updated_at = clock_timestamp(), row_version = row_version + 1
          WHERE id = $1 AND consumed_at IS NULL`,
        [input.id],
      );
      await client.query('COMMIT');
      return input.purpose === 'phone_login' || input.purpose === 'phone_registration' ? { status: 'authenticated', userId: challenge.user_id } : 'verified';
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
