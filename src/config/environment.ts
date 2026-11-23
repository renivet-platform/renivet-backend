/**
 * Validate runtime configuration without logging values that may contain secrets.
 * Development and test may start with no infrastructure; staging and production
 * must explicitly supply their external-service settings.
 */
const environments = ['development', 'test', 'staging', 'production'] as const;
type Environment = (typeof environments)[number];

function error(name: string, expectation: string): never {
  throw new Error(`Invalid ${name}: ${expectation}`);
}

function optionalString(input: Record<string, unknown>, name: string): string | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    error(name, 'must be a non-empty string');
  }
  return value.trim();
}

function optionalConfigString(input: Record<string, unknown>, name: string): string | undefined {
  const value = input[name];
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string') error(name, 'must be a string');
  return value.trim() || undefined;
}

function parseUrl(
  input: Record<string, unknown>,
  name: string,
  protocols: readonly string[],
  required: boolean,
): string | undefined {
  const value = optionalString(input, name);
  if (value === undefined) {
    if (required) error(name, 'is required in staging and production');
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return error(name, 'must be a valid connection URL');
  }
  if (!protocols.includes(url.protocol) || !url.hostname) {
    error(name, `must use ${protocols.join(' or ')} and include a hostname`);
  }
  if (name !== 'DATABASE_URL' && name !== 'REDIS_URL' && (url.username || url.password)) {
    error(name, 'credentials must not be embedded in the URL');
  }
  return value;
}

function positiveInteger(
  input: Record<string, unknown>,
  name: string,
  fallback: number,
  maximum: number,
): number {
  const value = optionalString(input, name);
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > maximum) {
    error(name, `must be an integer between 1 and ${maximum}`);
  }
  return Number(value);
}

function optionalBoolean(input: Record<string, unknown>, name: string): boolean | undefined {
  const value = optionalConfigString(input, name);
  if (value === undefined) return undefined;
  if (value.toLowerCase() === 'true') return true;
  if (value.toLowerCase() === 'false') return false;
  return error(name, 'must be true or false');
}

export function validateEnvironment(input: Record<string, unknown>): Record<string, unknown> {
  const envName = optionalString(input, 'NODE_ENV') ?? 'development';
  if (!environments.includes(envName as Environment)) {
    error('NODE_ENV', 'must be development, test, staging, or production');
  }
  const protectedEnvironment = envName === 'staging' || envName === 'production';
  const mediaMalwareScanMode = optionalString(input, 'MEDIA_MALWARE_SCAN_MODE') ?? 'required';
  if (mediaMalwareScanMode !== 'required' && mediaMalwareScanMode !== 'skip-staging') {
    error('MEDIA_MALWARE_SCAN_MODE', 'must be required or skip-staging');
  }
  if (mediaMalwareScanMode === 'skip-staging' && envName !== 'staging') {
    error('MEDIA_MALWARE_SCAN_MODE', 'skip-staging is permitted only when NODE_ENV=staging');
  }
  const requestedMfaEnforcementMode = optionalString(input, 'MFA_ENFORCEMENT_MODE') ?? 'deferred';
  if (requestedMfaEnforcementMode !== 'enforced' && requestedMfaEnforcementMode !== 'deferred') {
    error('MFA_ENFORCEMENT_MODE', 'must be enforced or deferred');
  }

  const rawPort = optionalString(input, 'PORT') ?? '4000';
  if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) {
    error('PORT', 'must be an integer between 1 and 65535');
  }
  const rawHost = optionalString(input, 'HOST') ?? '127.0.0.1';
  if (!/^[a-zA-Z0-9.:-]+$/.test(rawHost)) {
    error('HOST', 'must be a hostname or IP address, not a URL');
  }

  const db = parseUrl(input, 'DATABASE_URL', ['postgres:', 'postgresql:'], protectedEnvironment);
  const redis = parseUrl(input, 'REDIS_URL', ['redis:', 'rediss:'], protectedEnvironment);
  const search = parseUrl(input, 'TYPESENSE_URL', ['http:', 'https:'], protectedEnvironment);
  const python = parseUrl(input, 'PYTHON_SERVICE_URL', ['http:', 'https:'], protectedEnvironment);
  const searchKey = optionalString(input, 'TYPESENSE_API_KEY');
  const authRateLimitKey = optionalString(input, 'AUTH_RATE_LIMIT_HMAC_KEY');
  const authChallengeKey = optionalString(input, 'AUTH_CHALLENGE_HMAC_KEY');
  const authCsrfKey = optionalString(input, 'AUTH_CSRF_HMAC_KEY');
  const authMfaEncryptionKey = optionalString(input, 'AUTH_MFA_ENCRYPTION_KEY');
  const authImportUploadHmacKey = optionalString(input, 'AUTH_IMPORT_UPLOAD_HMAC_KEY');
  const inventoryApiEnabled = optionalBoolean(input, 'RENIVET_INVENTORY_API_ENABLED') ?? false;
  const requestedLocalImportStorageEnabled = optionalBoolean(input, 'RENIVET_LOCAL_IMPORT_STORAGE_ENABLED') ?? false;
  const localImportStorageDir = optionalConfigString(input, 'RENIVET_LOCAL_IMPORT_STORAGE_DIR');
  const requestedLocalMediaStorageEnabled = optionalBoolean(input, 'RENIVET_LOCAL_MEDIA_STORAGE_ENABLED') ?? false;
  const localMediaStorageDir = optionalConfigString(input, 'RENIVET_LOCAL_MEDIA_STORAGE_DIR');
  // A development .env is often loaded by test/staging harnesses as well. Keep the
  // local adapter strictly development-only without making those harnesses fail
  // startup: the flag is ignored outside development and can never activate there.
  const localImportStorageEnabled = requestedLocalImportStorageEnabled && envName === 'development';
  const localMediaStorageEnabled = requestedLocalMediaStorageEnabled && envName === 'development';
  if (authImportUploadHmacKey && authImportUploadHmacKey.length < 32) {
    error('AUTH_IMPORT_UPLOAD_HMAC_KEY', 'must contain at least 32 characters');
  }
  if (authImportUploadHmacKey && [authRateLimitKey, authChallengeKey, authCsrfKey, authMfaEncryptionKey].includes(authImportUploadHmacKey)) {
    error('AUTH_IMPORT_UPLOAD_HMAC_KEY', 'must be distinct from authentication keys');
  }
  if (localImportStorageEnabled && !authImportUploadHmacKey) {
    error('AUTH_IMPORT_UPLOAD_HMAC_KEY', 'is required when development local import storage is enabled');
  }
  const smtpHost = optionalConfigString(input, 'SMTP_HOST');
  if (smtpHost && (smtpHost.length > 253 || !/^[A-Za-z0-9.-]+$/.test(smtpHost) || smtpHost.startsWith('.') || smtpHost.endsWith('.'))) {
    error('SMTP_HOST', 'must be a DNS hostname or IPv4 address');
  }
  const smtpUsername = optionalConfigString(input, 'SMTP_USERNAME');
  const smtpPassword = optionalConfigString(input, 'SMTP_PASSWORD');
  const smtpFrom = optionalConfigString(input, 'SMTP_FROM');
  const emailOtpProvider = optionalConfigString(input, 'EMAIL_OTP_PROVIDER') ?? 'smtp';
  if (emailOtpProvider !== 'smtp' && emailOtpProvider !== 'resend' && emailOtpProvider !== 'resend_direct') {
    error('EMAIL_OTP_PROVIDER', 'must be smtp, resend or resend_direct');
  }
  const resendApiKey = optionalConfigString(input, 'RESEND_API_KEY');
  const resendFrom = optionalConfigString(input, 'RESEND_FROM');
  const resendEmailVerificationTemplateId = optionalConfigString(input, 'RESEND_EMAIL_VERIFICATION_TEMPLATE_ID');
  const resendPasswordRecoveryTemplateId = optionalConfigString(input, 'RESEND_PASSWORD_RECOVERY_TEMPLATE_ID');
  const smtpPortValue = optionalConfigString(input, 'SMTP_PORT');
  const smtpPort = smtpPortValue === undefined ? 587 : Number(smtpPortValue);
  if (smtpPortValue !== undefined && (!/^\d+$/.test(smtpPortValue) || smtpPort < 1 || smtpPort > 65_535)) {
    error('SMTP_PORT', 'must be an integer between 1 and 65535');
  }
  const allowedOriginsRaw = optionalString(input, 'AUTH_ALLOWED_ORIGINS');
  const allowedOrigins = (allowedOriginsRaw ?? '').split(',').map((origin) => origin.trim()).filter(Boolean);
  for (const origin of allowedOrigins) {
    let parsed: URL;
    try { parsed = new URL(origin); } catch { return error('AUTH_ALLOWED_ORIGINS', 'must be a comma-separated list of exact origins'); }
    if (parsed.origin !== origin || parsed.username || parsed.password || (protectedEnvironment && parsed.protocol !== 'https:')) {
      error('AUTH_ALLOWED_ORIGINS', protectedEnvironment ? 'must contain exact HTTPS origins without paths or credentials' : 'must contain exact origins without paths or credentials');
    }
  }
  if (authRateLimitKey && authRateLimitKey.length < 32) {
    error('AUTH_RATE_LIMIT_HMAC_KEY', 'must contain at least 32 characters');
  }
  if (protectedEnvironment && authRateLimitKey === 'local-only-set-a-random-32-byte-value') {
    error('AUTH_RATE_LIMIT_HMAC_KEY', 'must not use the local example value');
  }
  if (protectedEnvironment && authCsrfKey === 'local-only-set-a-random-32-byte-value') error('AUTH_CSRF_HMAC_KEY', 'must not use the local example value');
  if (authCsrfKey && (authCsrfKey === authRateLimitKey || authCsrfKey === authChallengeKey)) {
    error('AUTH_CSRF_HMAC_KEY', 'must be distinct from the rate-limit and challenge HMAC keys');
  }
  if (protectedEnvironment && !authRateLimitKey) {
    error('AUTH_RATE_LIMIT_HMAC_KEY', 'is required in staging and production');
  }
  if (authChallengeKey && authChallengeKey.length < 32) {
    error('AUTH_CHALLENGE_HMAC_KEY', 'must contain at least 32 characters');
  }
  if (authCsrfKey && authCsrfKey.length < 32) error('AUTH_CSRF_HMAC_KEY', 'must contain at least 32 characters');
  if (protectedEnvironment && authChallengeKey === 'local-only-set-a-random-32-byte-value') {
    error('AUTH_CHALLENGE_HMAC_KEY', 'must not use the local example value');
  }
  if (protectedEnvironment && !authChallengeKey) {
    error('AUTH_CHALLENGE_HMAC_KEY', 'is required in staging and production');
  }
  if (protectedEnvironment && !authCsrfKey) error('AUTH_CSRF_HMAC_KEY', 'is required in staging and production');
  if (authMfaEncryptionKey !== undefined) {
    const validBase64Shape = /^[A-Za-z0-9+/]{43}=$/.test(authMfaEncryptionKey);
    const decoded = validBase64Shape ? Buffer.from(authMfaEncryptionKey, 'base64') : Buffer.alloc(0);
    if (!validBase64Shape || decoded.length !== 32 || decoded.toString('base64') !== authMfaEncryptionKey) {
      error('AUTH_MFA_ENCRYPTION_KEY', 'must be canonical base64 encoding of exactly 32 bytes');
    }
    if ([authRateLimitKey, authChallengeKey, authCsrfKey].includes(authMfaEncryptionKey)) {
      error('AUTH_MFA_ENCRYPTION_KEY', 'must be distinct from other authentication keys');
    }
  } else if (protectedEnvironment) {
    error('AUTH_MFA_ENCRYPTION_KEY', 'is required in staging and production');
  }
  if (protectedEnvironment && allowedOrigins.length === 0) error('AUTH_ALLOWED_ORIGINS', 'is required in staging and production');
  if (protectedEnvironment) {
    if (!searchKey) error('TYPESENSE_API_KEY', 'is required in staging and production');
    if (searchKey === 'local-typesense-do-not-deploy') {
      error('TYPESENSE_API_KEY', 'must not use the local development key');
    }
    if (db && new URL(db).password === 'renivet_local_only') {
      error('DATABASE_URL', 'must not use the local development password');
    }
  }

  return {
    ...input,
    NODE_ENV: envName,
    PORT: Number(rawPort),
    HOST: rawHost,
    DATABASE_URL: db,
    REDIS_URL: redis,
    TYPESENSE_URL: search,
    PYTHON_SERVICE_URL: python,
    TYPESENSE_API_KEY: searchKey,
    AUTH_RATE_LIMIT_HMAC_KEY: authRateLimitKey,
    AUTH_CHALLENGE_HMAC_KEY: authChallengeKey,
    AUTH_CSRF_HMAC_KEY: authCsrfKey,
    AUTH_MFA_ENCRYPTION_KEY: authMfaEncryptionKey,
    AUTH_IMPORT_UPLOAD_HMAC_KEY: authImportUploadHmacKey,
    MEDIA_MALWARE_SCAN_MODE: mediaMalwareScanMode,
    MFA_ENFORCEMENT_MODE: requestedMfaEnforcementMode,
    RENIVET_INVENTORY_API_ENABLED: inventoryApiEnabled,
    RENIVET_LOCAL_IMPORT_STORAGE_ENABLED: localImportStorageEnabled,
    RENIVET_LOCAL_IMPORT_STORAGE_DIR: localImportStorageDir,
    RENIVET_LOCAL_MEDIA_STORAGE_ENABLED: localMediaStorageEnabled,
    RENIVET_LOCAL_MEDIA_STORAGE_DIR: localMediaStorageDir,
    SMTP_HOST: smtpHost,
    SMTP_PORT: smtpPort,
    SMTP_SECURE: optionalBoolean(input, 'SMTP_SECURE'),
    SMTP_USERNAME: smtpUsername,
    SMTP_PASSWORD: smtpPassword,
    SMTP_FROM: smtpFrom,
    EMAIL_OTP_PROVIDER: emailOtpProvider,
    RESEND_API_KEY: resendApiKey,
    RESEND_FROM: resendFrom,
    RESEND_EMAIL_VERIFICATION_TEMPLATE_ID: resendEmailVerificationTemplateId,
    RESEND_PASSWORD_RECOVERY_TEMPLATE_ID: resendPasswordRecoveryTemplateId,
    AUTH_ALLOWED_ORIGINS: allowedOrigins,
    AUTH_RATE_LIMIT_WINDOW_SECONDS: positiveInteger(input, 'AUTH_RATE_LIMIT_WINDOW_SECONDS', 900, 86_400),
    AUTH_REGISTER_ACCOUNT_LIMIT: positiveInteger(input, 'AUTH_REGISTER_ACCOUNT_LIMIT', 5, 10_000),
    AUTH_REGISTER_IP_LIMIT: positiveInteger(input, 'AUTH_REGISTER_IP_LIMIT', 30, 100_000),
    AUTH_LOGIN_ACCOUNT_LIMIT: positiveInteger(input, 'AUTH_LOGIN_ACCOUNT_LIMIT', 5, 10_000),
    AUTH_LOGIN_IP_LIMIT: positiveInteger(input, 'AUTH_LOGIN_IP_LIMIT', 60, 100_000),
    AUTH_SESSION_TTL_SECONDS: positiveInteger(input, 'AUTH_SESSION_TTL_SECONDS', 1_800, 604_800),
    AUTH_SESSION_IDLE_TTL_SECONDS: positiveInteger(input, 'AUTH_SESSION_IDLE_TTL_SECONDS', 1_800, 1_800),
    AUTH_SESSION_ABSOLUTE_TTL_SECONDS: positiveInteger(input, 'AUTH_SESSION_ABSOLUTE_TTL_SECONDS', 604_800, 604_800),
    AUTH_CHALLENGE_TTL_SECONDS: positiveInteger(input, 'AUTH_CHALLENGE_TTL_SECONDS', 300, 3_600),
    AUTH_CHALLENGE_MAX_ATTEMPTS: positiveInteger(input, 'AUTH_CHALLENGE_MAX_ATTEMPTS', 5, 20),
    AUTH_CHALLENGE_RESEND_COOLDOWN_SECONDS: positiveInteger(input, 'AUTH_CHALLENGE_RESEND_COOLDOWN_SECONDS', 60, 3_600),
    AUTH_CHALLENGE_RESEND_WINDOW_SECONDS: positiveInteger(input, 'AUTH_CHALLENGE_RESEND_WINDOW_SECONDS', 900, 86_400),
    AUTH_CHALLENGE_RESEND_MAX: positiveInteger(input, 'AUTH_CHALLENGE_RESEND_MAX', 3, 20),
    AUTH_CHALLENGE_IP_LIMIT: positiveInteger(input, 'AUTH_CHALLENGE_IP_LIMIT', 30, 100_000),
    AUTH_CHALLENGE_IDENTITY_LIMIT: positiveInteger(input, 'AUTH_CHALLENGE_IDENTITY_LIMIT', 5, 10_000),
    AUTH_CHALLENGE_VERIFY_IP_LIMIT: positiveInteger(input, 'AUTH_CHALLENGE_VERIFY_IP_LIMIT', 60, 100_000),
  };
}
