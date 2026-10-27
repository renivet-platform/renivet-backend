import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  pgSchema,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// Foundation-only example table retained independently from the W1 identity model.
export const systemEvents = pgTable('system_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  eventName: text('event_name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const identity = pgSchema('identity');

export const identityUsers = identity.table(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    rowVersion: bigint('row_version', { mode: 'number' }).default(1).notNull(),
    email: text('email'),
    phone: text('phone'),
    displayName: text('display_name'),
    state: text('state').notNull(),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    phoneVerifiedAt: timestamp('phone_verified_at', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('identity_users_email_normalized_uq').on(sql`lower(btrim(${table.email}))`),
    uniqueIndex('identity_users_phone_e164_uq').on(table.phone),
    check('identity_users_state_not_blank', sql`length(btrim(${table.state})) > 0`),
    check(
      'identity_users_email_not_blank',
      sql`${table.email} is null or length(btrim(${table.email})) > 0`,
    ),
    check(
      'identity_users_email_canonical',
      sql`${table.email} is null or ${table.email} = lower(btrim(${table.email}))`,
    ),
    check(
      'identity_users_phone_e164',
      sql`${table.phone} is null or ${table.phone} ~ '^\\+[1-9][0-9]{0,14}$'`,
    ),
    check(
      'identity_users_email_verified_requires_email',
      sql`${table.emailVerifiedAt} is null or ${table.email} is not null`,
    ),
    check(
      'identity_users_phone_verified_requires_phone',
      sql`${table.phoneVerifiedAt} is null or ${table.phone} is not null`,
    ),
    check('identity_users_row_version_positive', sql`${table.rowVersion} > 0`),
    check('identity_users_timestamps_ordered', sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
);

export const identityUserCredentials = identity.table(
  'user_credentials',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    rowVersion: bigint('row_version', { mode: 'number' }).default(1).notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => identityUsers.id),
    passwordHash: text('password_hash').notNull(),
    credentialVersion: integer('credential_version').notNull(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('identity_user_credentials_user_version_uq').on(table.userId, table.credentialVersion),
    uniqueIndex('identity_user_credentials_one_active_per_user_uq')
      .on(table.userId)
      .where(sql`${table.disabledAt} is null`),
    check(
      'identity_user_credentials_argon2id_hash',
      sql`${table.passwordHash} ~ '^\\$argon2id\\$v=[0-9]+\\$m=[1-9][0-9]*,t=[1-9][0-9]*,p=[1-9][0-9]*\\$[A-Za-z0-9+/]+={0,2}\\$[A-Za-z0-9+/]+={0,2}$'`,
    ),
    check('identity_user_credentials_version_positive', sql`${table.credentialVersion} > 0`),
    check('identity_user_credentials_row_version_positive', sql`${table.rowVersion} > 0`),
    check(
      'identity_user_credentials_timestamps_ordered',
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
    check(
      'identity_user_credentials_rotation_after_creation',
      sql`${table.rotatedAt} is null or ${table.rotatedAt} >= ${table.createdAt}`,
    ),
    check(
      'identity_user_credentials_disable_after_creation',
      sql`${table.disabledAt} is null or ${table.disabledAt} >= ${table.createdAt}`,
    ),
  ],
);

export const identityUserSessions = identity.table(
  'user_sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    rowVersion: bigint('row_version', { mode: 'number' }).default(1).notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => identityUsers.id),
    tokenHash: text('token_hash').notNull(),
    deviceHash: text('device_hash'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ipHash: text('ip_hash'),
  },
  (table) => [
    uniqueIndex('identity_user_sessions_token_hash_uq').on(table.tokenHash),
    index('identity_user_sessions_user_created_idx').on(table.userId, table.createdAt),
    index('identity_user_sessions_expires_idx').on(table.expiresAt),
    check(
      'identity_user_sessions_token_hash_sha256',
      sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check('identity_user_sessions_expiry_after_creation', sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      'identity_user_sessions_revocation_after_creation',
      sql`${table.revokedAt} is null or ${table.revokedAt} >= ${table.createdAt}`,
    ),
    check('identity_user_sessions_row_version_positive', sql`${table.rowVersion} > 0`),
    check(
      'identity_user_sessions_timestamps_ordered',
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const identityAuthChallenges = identity.table(
  'auth_challenges',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    rowVersion: bigint('row_version', { mode: 'number' }).default(1).notNull(),
    userId: uuid('user_id').references(() => identityUsers.id),
    kind: text('kind').notNull(),
    codeHash: text('code_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    attemptCount: integer('attempt_count').notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (table) => [
    index('identity_auth_challenges_user_created_idx').on(table.userId, table.createdAt),
    index('identity_auth_challenges_expires_idx').on(table.expiresAt),
    check('identity_auth_challenges_kind_not_blank', sql`length(btrim(${table.kind})) > 0`),
    check(
      'identity_auth_challenges_code_hash_hmac_sha256',
      sql`${table.codeHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check('identity_auth_challenges_attempt_count_nonnegative', sql`${table.attemptCount} >= 0`),
    check(
      'identity_auth_challenges_expiry_after_creation',
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    check(
      'identity_auth_challenges_consumed_after_creation',
      sql`${table.consumedAt} is null or ${table.consumedAt} >= ${table.createdAt}`,
    ),
    check('identity_auth_challenges_row_version_positive', sql`${table.rowVersion} > 0`),
    check(
      'identity_auth_challenges_timestamps_ordered',
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
);
