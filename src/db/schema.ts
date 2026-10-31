import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  pgTable,
  text,
  timestamp,
  unique,
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
export const brands = pgSchema('brands');
export const access = pgSchema('access');

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
    absoluteExpiresAt: timestamp('absolute_expires_at', { withTimezone: true }).default(sql`now() + interval '7 days'`).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ipHash: text('ip_hash'),
    mfaVerifiedAt: timestamp('mfa_verified_at', { withTimezone: true }),
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
    check('identity_user_sessions_absolute_expiry_after_creation', sql`${table.absoluteExpiresAt} > ${table.createdAt}`),
    check('identity_user_sessions_idle_expiry_within_absolute', sql`${table.expiresAt} <= ${table.absoluteExpiresAt}`),
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

export const identityMfaFactors = identity.table(
  'mfa_factors',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    rowVersion: bigint('row_version', { mode: 'number' }).default(1).notNull(),
    userId: uuid('user_id').notNull().references(() => identityUsers.id),
    encryptedSecret: text('encrypted_secret').notNull(),
    secretIv: text('secret_iv').notNull(),
    secretTag: text('secret_tag').notNull(),
    state: text('state').notNull(),
    pendingExpiresAt: timestamp('pending_expires_at', { withTimezone: true }),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastTotpStep: bigint('last_totp_step', { mode: 'number' }),
  },
  (table) => [
    uniqueIndex('identity_mfa_factors_one_pending_or_active_uq')
      .on(table.userId)
      .where(sql`${table.state} IN ('pending', 'active')`),
    index('identity_mfa_factors_user_created_idx').on(table.userId, table.createdAt),
    check('identity_mfa_factors_state_valid', sql`${table.state} IN ('pending', 'active', 'revoked')`),
    check(
      'identity_mfa_factors_secret_state_valid',
      sql`(${table.state} = 'revoked' AND ${table.encryptedSecret} = '' AND ${table.secretIv} = '' AND ${table.secretTag} = '') OR (${table.state} IN ('pending', 'active') AND ${table.encryptedSecret} ~ '^[A-Za-z0-9+/]{27}=$' AND ${table.secretIv} ~ '^[A-Za-z0-9+/]{16}$' AND ${table.secretTag} ~ '^[A-Za-z0-9+/]{22}==$')`,
    ),
    check(
      'identity_mfa_factors_lifecycle_valid',
      sql`(${table.state} = 'pending' AND ${table.pendingExpiresAt} > ${table.createdAt} AND ${table.activatedAt} IS NULL AND ${table.revokedAt} IS NULL) OR (${table.state} = 'active' AND ${table.activatedAt} IS NOT NULL AND ${table.revokedAt} IS NULL) OR (${table.state} = 'revoked' AND ${table.revokedAt} IS NOT NULL)`,
    ),
    check('identity_mfa_factors_totp_step_nonnegative', sql`${table.lastTotpStep} IS NULL OR ${table.lastTotpStep} >= 0`),
    check('identity_mfa_factors_row_version_positive', sql`${table.rowVersion} > 0`),
    check('identity_mfa_factors_timestamps_ordered', sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
);

export const identityMfaRecoveryCodes = identity.table(
  'mfa_recovery_codes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    factorId: uuid('factor_id').notNull().references(() => identityMfaFactors.id),
    codeHash: text('code_hash').notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('identity_mfa_recovery_codes_factor_hash_uq').on(table.factorId, table.codeHash),
    index('identity_mfa_recovery_codes_factor_consumed_idx').on(table.factorId, table.consumedAt),
    check('identity_mfa_recovery_codes_hash_sha256', sql`${table.codeHash} ~ '^[0-9a-f]{64}$'`),
    check('identity_mfa_recovery_codes_consumed_after_creation', sql`${table.consumedAt} IS NULL OR ${table.consumedAt} >= ${table.createdAt}`),
  ],
);

export const identitySecurityAuditEvents = identity.table(
  'security_audit_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    actorUserId: uuid('actor_user_id').references(() => identityUsers.id),
    sessionId: uuid('session_id').references(() => identityUserSessions.id),
    factorId: uuid('factor_id').references(() => identityMfaFactors.id),
    eventName: text('event_name').notNull(),
    outcome: text('outcome').notNull(),
    ipHash: text('ip_hash'),
    metadata: jsonb('metadata').default(sql`'{}'::jsonb`).notNull(),
  },
  (table) => [
    index('identity_security_audit_user_created_idx').on(table.actorUserId, table.createdAt),
    index('identity_security_audit_event_created_idx').on(table.eventName, table.createdAt),
    check(
      'identity_security_audit_event_valid',
      sql`${table.eventName} IN ('enrollment_started', 'enrollment_activated', 'enrollment_denied', 'step_up_succeeded', 'step_up_denied', 'factor_revoked', 'privileged_access_allowed', 'privileged_access_denied')`,
    ),
    check('identity_security_audit_outcome_valid', sql`${table.outcome} IN ('allowed', 'denied')`),
    check('identity_security_audit_metadata_object', sql`jsonb_typeof(${table.metadata}) = 'object'`),
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

export const platformDeadLetterRecoveryAudit = platform.table(
  'dead_letter_recovery_audit',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    caseId: uuid('case_id').notNull().references(() => platformDeadLetterCases.id),
    actorId: uuid('actor_id').notNull().references(() => identityUsers.id),
    reasonCode: text('reason_code').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      'platform_dead_letter_recovery_audit_reason_code_safe',
      sql`${table.reasonCode} in ('OPERATOR_RETRY', 'DATA_CORRECTED', 'DEPENDENCY_RESTORED')`,
    ),
    index('platform_dead_letter_recovery_audit_case_idx').on(table.caseId, table.createdAt),
  ],
);

const domainRow = () => ({
  id: uuid('id').defaultRandom().primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  rowVersion: bigint('row_version', { mode: 'number' }).default(1).notNull(),
});

// The canonical D02 brand root is included because it is the FK target for this first
// brand-membership slice and does not yet exist in the backend migration chain.
export const brandOrganizations = brands.table(
  'brands',
  {
    ...domainRow(),
    slug: text('slug').notNull(),
    legalName: text('legal_name').notNull(),
    displayName: text('display_name').notNull(),
    onboardingState: text('onboarding_state').notNull(),
    countryCode: char('country_code', { length: 2 }),
    taxIdRef: text('tax_id_ref'),
  },
  (table) => [
    uniqueIndex('ren2_26_brands_slug_uq').on(table.slug),
    check('ren2_26_brands_slug_canonical', sql`${table.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    check('ren2_26_brands_legal_name_nonblank', sql`length(btrim(${table.legalName})) > 0`),
    check('ren2_26_brands_display_name_nonblank', sql`length(btrim(${table.displayName})) > 0`),
    check('ren2_26_brands_onboarding_state_nonblank', sql`length(btrim(${table.onboardingState})) > 0`),
    check('ren2_26_brands_country_code_uppercase', sql`${table.countryCode} IS NULL OR ${table.countryCode} ~ '^[A-Z]{2}$'`),
    check('ren2_26_brands_row_version_positive', sql`${table.rowVersion} > 0`),
    check('ren2_26_brands_timestamps_ordered', sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
);

export const brandMemberships = brands.table(
  'brand_memberships',
  {
    ...domainRow(),
    brandId: uuid('brand_id').notNull().references(() => brandOrganizations.id),
    userId: uuid('user_id').notNull().references(() => identityUsers.id),
    membershipState: text('membership_state').notNull(),
    invitedById: uuid('invited_by_id').references(() => identityUsers.id, { onDelete: 'set null' }),
    joinedAt: timestamp('joined_at', { withTimezone: true }),
    validFrom: timestamp('valid_from', { withTimezone: true }).defaultNow().notNull(),
    validUntil: timestamp('valid_until', { withTimezone: true }),
  },
  (table) => [
    unique('ren2_26_brand_memberships_user_brand_uq').on(table.userId, table.brandId),
    index('ren2_26_brand_memberships_brand_state_idx').on(table.brandId, table.membershipState, table.userId),
    index('ren2_26_brand_memberships_user_state_idx').on(table.userId, table.membershipState, table.brandId),
    check(
      'ren2_26_brand_memberships_state_valid',
      sql`${table.membershipState} IN ('invited', 'pending', 'active', 'suspended', 'revoked')`,
    ),
    check(
      'ren2_26_brand_memberships_active_joined',
      sql`${table.membershipState} <> 'active' OR ${table.joinedAt} IS NOT NULL`,
    ),
    check(
      'ren2_26_brand_memberships_validity_ordered',
      sql`${table.validUntil} IS NULL OR ${table.validUntil} > ${table.validFrom}`,
    ),
    check('ren2_26_brand_memberships_row_version_positive', sql`${table.rowVersion} > 0`),
    check('ren2_26_brand_memberships_timestamps_ordered', sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
);

export const accessRoles = access.table(
  'roles',
  {
    ...domainRow(),
    roleCode: text('role_code').notNull(),
    scopeKind: text('scope_kind').notNull(),
    description: text('description'),
    isSystem: boolean('is_system').notNull().default(false),
  },
  (table) => [
    uniqueIndex('ren2_26_roles_code_uq').on(table.roleCode),
    unique('ren2_26_roles_id_scope_uq').on(table.id, table.scopeKind),
    check('ren2_26_roles_code_canonical', sql`${table.roleCode} ~ '^[a-z][a-z0-9_]{0,63}$'`),
    check('ren2_26_roles_scope_valid', sql`${table.scopeKind} IN ('global', 'brand')`),
    check('ren2_26_roles_row_version_positive', sql`${table.rowVersion} > 0`),
    check('ren2_26_roles_timestamps_ordered', sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
);

export const accessPermissions = access.table(
  'permissions',
  {
    ...domainRow(),
    permissionCode: text('permission_code').notNull(),
    resource: text('resource').notNull(),
    action: text('action').notNull(),
    description: text('description'),
  },
  (table) => [
    uniqueIndex('ren2_26_permissions_code_uq').on(table.permissionCode),
    check('ren2_26_permissions_code_canonical', sql`${table.permissionCode} ~ '^[a-z][a-z0-9_.]{0,127}$'`),
    check('ren2_26_permissions_resource_canonical', sql`${table.resource} ~ '^[a-z][a-z0-9_]{0,63}$'`),
    check('ren2_26_permissions_action_canonical', sql`${table.action} ~ '^[a-z][a-z0-9_]{0,63}$'`),
    check('ren2_26_permissions_row_version_positive', sql`${table.rowVersion} > 0`),
    check('ren2_26_permissions_timestamps_ordered', sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
);

export const accessRolePermissions = access.table(
  'role_permissions',
  {
    ...domainRow(),
    roleId: uuid('role_id').notNull().references(() => accessRoles.id),
    permissionId: uuid('permission_id').notNull().references(() => accessPermissions.id),
  },
  (table) => [
    uniqueIndex('ren2_26_role_permissions_role_permission_uq').on(table.roleId, table.permissionId),
    check('ren2_26_role_permissions_row_version_positive', sql`${table.rowVersion} > 0`),
    check('ren2_26_role_permissions_timestamps_ordered', sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
);

export const accessRoleAssignments = access.table(
  'role_assignments',
  {
    ...domainRow(),
    userId: uuid('user_id').notNull().references(() => identityUsers.id),
    roleId: uuid('role_id').notNull(),
    brandId: uuid('brand_id').references(() => brandOrganizations.id),
    scopeType: text('scope_type').notNull(),
    activeFrom: timestamp('active_from', { withTimezone: true }).defaultNow().notNull(),
    activeUntil: timestamp('active_until', { withTimezone: true }),
    grantedById: uuid('granted_by_id').notNull().references(() => identityUsers.id),
  },
  (table) => [
    foreignKey({
      name: 'ren2_26_role_assignments_role_scope_fk',
      columns: [table.roleId, table.scopeType],
      foreignColumns: [accessRoles.id, accessRoles.scopeKind],
    }),
    foreignKey({
      name: 'ren2_26_role_assignments_membership_fk',
      columns: [table.userId, table.brandId],
      foreignColumns: [brandMemberships.userId, brandMemberships.brandId],
    }),
    uniqueIndex('ren2_26_role_assignments_global_uq')
      .on(table.userId, table.roleId)
      .where(sql`${table.brandId} IS NULL`),
    uniqueIndex('ren2_26_role_assignments_brand_uq')
      .on(table.userId, table.roleId, table.brandId)
      .where(sql`${table.brandId} IS NOT NULL`),
    index('ren2_26_role_assignments_global_active_idx')
      .on(table.userId, table.activeFrom, table.activeUntil)
      .where(sql`${table.scopeType} = 'global'`),
    index('ren2_26_role_assignments_brand_active_idx')
      .on(table.brandId, table.userId, table.activeFrom, table.activeUntil)
      .where(sql`${table.scopeType} = 'brand'`),
    check(
      'ren2_26_role_assignments_scope_consistent',
      sql`(${table.scopeType} = 'global' AND ${table.brandId} IS NULL) OR (${table.scopeType} = 'brand' AND ${table.brandId} IS NOT NULL)`,
    ),
    check('ren2_26_role_assignments_scope_valid', sql`${table.scopeType} IN ('global', 'brand')`),
    check(
      'ren2_26_role_assignments_validity_ordered',
      sql`${table.activeUntil} IS NULL OR ${table.activeUntil} > ${table.activeFrom}`,
    ),
    check('ren2_26_role_assignments_row_version_positive', sql`${table.rowVersion} > 0`),
    check('ren2_26_role_assignments_timestamps_ordered', sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
);

export const accessSecurityAuditEvents = access.table(
  'security_audit_events',
  {
    ...domainRow(),
    actorUserId: uuid('actor_user_id').references(() => identityUsers.id),
    action: text('action').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: uuid('subject_id'),
    requestId: text('request_id').notNull(),
    ipHash: text('ip_hash'),
    payloadHash: char('payload_hash', { length: 64 }).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('ren2_26_security_audit_actor_created_idx').on(table.actorUserId, table.occurredAt),
    index('ren2_26_security_audit_subject_created_idx').on(table.subjectType, table.subjectId, table.occurredAt),
    index('ren2_26_security_audit_action_created_idx').on(table.action, table.occurredAt),
    check('ren2_26_security_audit_action_canonical', sql`${table.action} ~ '^[a-z][a-z0-9_.:-]{0,127}$'`),
    check('ren2_26_security_audit_subject_type_canonical', sql`${table.subjectType} ~ '^[a-z][a-z0-9_.:-]{0,63}$'`),
    check('ren2_26_security_audit_request_id_safe', sql`${table.requestId} ~ '^[A-Za-z0-9._:-]{1,128}$'`),
    check('ren2_26_security_audit_ip_hash_sha256', sql`${table.ipHash} IS NULL OR ${table.ipHash} ~ '^[0-9a-f]{64}$'`),
    check('ren2_26_security_audit_payload_hash_sha256', sql`${table.payloadHash} ~ '^[0-9a-f]{64}$'`),
    check('ren2_26_security_audit_row_version_positive', sql`${table.rowVersion} > 0`),
    check('ren2_26_security_audit_timestamps_ordered', sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
);

// This read-only resolver is a database-side deny-by-default boundary for authorization
// checks: global grants remain global, while brand grants require a live membership and
// an approved Brand. Business repositories still have to apply the authorized brand ID.
export const effectivePermissions = access.view('effective_permissions', {
  userId: uuid('user_id'),
  roleId: uuid('role_id'),
  roleCode: text('role_code'),
  scopeType: text('scope_type'),
  brandId: uuid('brand_id'),
  permissionCode: text('permission_code'),
}).existing();
