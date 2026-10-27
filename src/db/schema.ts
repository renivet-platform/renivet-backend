import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  index,
  integer,
  jsonb,
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
export const platform = pgSchema('platform');

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

const platformRow = () => ({
  id: uuid('id').defaultRandom().primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  rowVersion: bigint('row_version', { mode: 'number' }).default(1).notNull(),
});

export const platformOutboxEvents = platform.table(
  'outbox_events',
  {
    ...platformRow(),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: uuid('aggregate_id').notNull(),
    eventType: text('event_type').notNull(),
    eventVersion: integer('event_version').notNull(),
    eventPayload: jsonb('event_payload').notNull(),
    eventKey: text('event_key').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('platform_outbox_events_scoped_key_uq').on(table.aggregateType, table.aggregateId, table.eventKey),
    index('platform_outbox_events_pending_idx').on(table.occurredAt, table.id).where(sql`${table.deliveredAt} is null`),
    check('platform_outbox_events_version_positive', sql`${table.eventVersion} > 0`),
    check('platform_outbox_events_row_version_positive', sql`${table.rowVersion} > 0`),
    check('platform_outbox_events_timestamps_ordered', sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
);

export const platformWebhookInbox = platform.table(
  'webhook_inbox',
  {
    ...platformRow(),
    provider: text('provider').notNull(),
    providerEventId: text('provider_event_id').notNull(),
    signatureVerified: boolean('signature_verified').notNull(),
    payloadHash: char('payload_hash', { length: 64 }).notNull(),
    payloadKey: text('payload_key'),
    state: text('state').notNull().default('received'),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('platform_webhook_inbox_provider_event_uq').on(table.provider, table.providerEventId),
    index('platform_webhook_inbox_state_idx').on(table.state, table.createdAt),
    check('platform_webhook_inbox_payload_hash_sha256', sql`${table.payloadHash} ~ '^[0-9a-f]{64}$'`),
    check('platform_webhook_inbox_state_valid', sql`${table.state} in ('received', 'processing', 'processed', 'failed')`),
    check('platform_webhook_inbox_processed_verified', sql`${table.processedAt} is null or (${table.signatureVerified} and ${table.state} = 'processed')`),
    check('platform_webhook_inbox_row_version_positive', sql`${table.rowVersion} > 0`),
    check('platform_webhook_inbox_timestamps_ordered', sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
);

export const platformInboxReceipts = platform.table(
  'inbox_receipts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    consumerId: text('consumer_id').notNull(),
    messageId: uuid('message_id').notNull().references(() => platformOutboxEvents.id),
    eventVersion: integer('event_version').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('platform_inbox_receipts_consumer_message_uq').on(table.consumerId, table.messageId),
    check('platform_inbox_receipts_event_version_positive', sql`${table.eventVersion} > 0`),
  ],
);

export const platformDurableJobs = platform.table(
  'durable_jobs',
  {
    ...platformRow(),
    jobKind: text('job_kind').notNull(),
    businessKey: text('business_key').notNull(),
    state: text('state').notNull().default('pending'),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }).defaultNow().notNull(),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    attemptCount: integer('attempt_count').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    leaseOwner: text('lease_owner'),
    leaseStartedAt: timestamp('lease_started_at', { withTimezone: true }),
    lastErrorCode: text('last_error_code'),
  },
  (table) => [
    uniqueIndex('platform_durable_jobs_business_key_uq').on(table.jobKind, table.businessKey),
    index('platform_durable_jobs_pending_claim_idx').on(table.scheduledFor, table.id).where(sql`${table.state} = 'pending'`),
    index('platform_durable_jobs_expired_lease_idx').on(table.leaseUntil, table.id).where(sql`${table.state} = 'leased'`),
    check('platform_durable_jobs_state_valid', sql`${table.state} in ('pending', 'leased', 'succeeded', 'dead_letter')`),
    check('platform_durable_jobs_attempts_bounded', sql`${table.attemptCount} >= 0 and ${table.maxAttempts} between 1 and 5 and ${table.attemptCount} <= ${table.maxAttempts}`),
    check('platform_durable_jobs_lease_consistent', sql`(${table.state} = 'leased' and ${table.leaseUntil} is not null and ${table.leaseStartedAt} is not null and ${table.leaseOwner} is not null) or (${table.state} <> 'leased' and ${table.leaseUntil} is null and ${table.leaseStartedAt} is null and ${table.leaseOwner} is null)`),
    check('platform_durable_jobs_lease_bounded', sql`${table.leaseUntil} is null or (${table.leaseStartedAt} <= ${table.leaseUntil} and ${table.leaseUntil} <= ${table.leaseStartedAt} + interval '5 minutes')`),
    check('platform_durable_jobs_safe_error_code', sql`${table.lastErrorCode} is null or ${table.lastErrorCode} ~ '^[A-Z][A-Z0-9_]{0,63}$'`),
    check('platform_durable_jobs_row_version_positive', sql`${table.rowVersion} > 0`),
    check('platform_durable_jobs_timestamps_ordered', sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
);

export const platformDeadLetterCases = platform.table(
  'dead_letter_cases',
  {
    ...platformRow(),
    jobId: uuid('job_id').references(() => platformDurableJobs.id),
    eventId: uuid('event_id').references(() => platformOutboxEvents.id),
    reasonCode: text('reason_code').notNull(),
    state: text('state').notNull().default('open'),
    assignedToId: uuid('assigned_to_id').references(() => identityUsers.id),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (table) => [
    index('platform_dead_letter_cases_open_idx').on(table.createdAt, table.id).where(sql`${table.state} = 'open'`),
    check('platform_dead_letter_cases_target_required', sql`${table.jobId} is not null or ${table.eventId} is not null`),
    check('platform_dead_letter_cases_reason_code_safe', sql`${table.reasonCode} ~ '^[A-Z][A-Z0-9_]{0,63}$'`),
    check('platform_dead_letter_cases_state_valid', sql`${table.state} in ('open', 'requeued', 'resolved')`),
    check('platform_dead_letter_cases_resolution_consistent', sql`(${table.state} = 'resolved') = (${table.resolvedAt} is not null)`),
    check('platform_dead_letter_cases_row_version_positive', sql`${table.rowVersion} > 0`),
    check('platform_dead_letter_cases_timestamps_ordered', sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
);
