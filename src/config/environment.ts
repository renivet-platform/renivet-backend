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

export function validateEnvironment(input: Record<string, unknown>): Record<string, unknown> {
  const envName = optionalString(input, 'NODE_ENV') ?? 'development';
  if (!environments.includes(envName as Environment)) {
    error('NODE_ENV', 'must be development, test, staging, or production');
  }
  const protectedEnvironment = envName === 'staging' || envName === 'production';

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
  };
}
