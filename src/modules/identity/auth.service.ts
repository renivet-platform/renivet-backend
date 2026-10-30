import { createHmac, createHash, randomBytes } from 'node:crypto';
import { isPasswordAllowed, PasswordHashService } from './passwords';
import { AuthRateLimitExceededError, AuthRateLimitUnavailableError, AuthRateLimiter } from './rate-limiter';

export interface PasswordCredentialRecord {
  userId: string;
  credentialId: string | null;
  state: string;
  emailVerifiedAt: Date | null;
  passwordHash: string | null;
}

export interface IdentityRepositoryPort {
  createPendingAccount(email: string, passwordHash: string): Promise<boolean>;
  findPasswordCredential(email: string): Promise<PasswordCredentialRecord | null>;
  createSession(session: {
    userId: string;
    credentialId: string;
    expectedPasswordHash: string;
    tokenHash: string;
    expiresAt: Date;
    absoluteExpiresAt?: Date;
    ipHash: string;
    previousTokenHash?: string;
  }): Promise<boolean>;
  revokeSession(tokenHash: string): Promise<boolean>;
  revokeUserSessions(userId: string): Promise<void>;
}

export interface AuthServiceOptions {
  hmacKey: string | undefined;
  windowSeconds: number;
  registerAccountLimit: number;
  registerIpLimit: number;
  loginAccountLimit: number;
  loginIpLimit: number;
  sessionTtlSeconds: number;
  absoluteSessionTtlSeconds?: number;
}

export interface RegisterRequest {
  email: string;
  password: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResult {
  userId: string;
  sessionToken: string;
  expiresInSeconds: number;
}

export class AuthHttpError extends Error {
  readonly publicResponse: { code: string; message: string };

  constructor(readonly status: number, code: string, message: string, readonly retryAfterSeconds?: number) {
    super(message);
    this.name = 'AuthHttpError';
    this.publicResponse = { code, message };
  }
}

const GENERIC_AUTH_FAILURE = new AuthHttpError(
  401,
  'AUTHENTICATION_FAILED',
  'The credentials could not be verified.',
);
const GENERIC_INFRASTRUCTURE_FAILURE = new AuthHttpError(
  503,
  'AUTH_SERVICE_UNAVAILABLE',
  'Authentication is temporarily unavailable.',
);

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class AuthService {
  constructor(
    private readonly repository: IdentityRepositoryPort,
    private readonly passwords: PasswordHashService,
    private readonly limiter: AuthRateLimiter,
    private readonly options: AuthServiceOptions,
  ) {}

  async register(request: RegisterRequest, ip: string): Promise<{ status: 'accepted' }> {
    const email = normalizeEmail(request.email);
    if (!email || !isPasswordAllowed(request.password)) {
      throw new AuthHttpError(400, 'AUTH_INPUT_INVALID', 'The request could not be processed.');
    }

    await this.consumeLimit('register-account', email, this.options.registerAccountLimit);
    await this.consumeLimit('register-ip', ip, this.options.registerIpLimit);

    try {
      const passwordHash = await this.passwords.hash(request.password);
      await this.repository.createPendingAccount(email, passwordHash);
    } catch {
      throw GENERIC_INFRASTRUCTURE_FAILURE;
    }
    return { status: 'accepted' };
  }

  async login(request: LoginRequest, ip: string, previousSessionToken?: string): Promise<LoginResult> {
    const email = normalizeEmail(request.email);
    if (!email || !isPasswordAllowed(request.password)) {
      throw new AuthHttpError(400, 'AUTH_INPUT_INVALID', 'The request could not be processed.');
    }

    await this.consumeLimit('login-account', email, this.options.loginAccountLimit);
    await this.consumeLimit('login-ip', ip, this.options.loginIpLimit);

    let credential: PasswordCredentialRecord | null;
    try {
      credential = await this.repository.findPasswordCredential(email);
    } catch {
      throw GENERIC_INFRASTRUCTURE_FAILURE;
    }

    let passwordMatches: boolean;
    try {
      passwordMatches = await this.passwords.verifyOrDummy(credential?.passwordHash, request.password);
    } catch {
      throw GENERIC_INFRASTRUCTURE_FAILURE;
    }
    if (
      !credential ||
      !credential.credentialId ||
      !passwordMatches ||
      credential.state !== 'active' ||
      !credential.emailVerifiedAt
    ) {
      throw GENERIC_AUTH_FAILURE;
    }

    const sessionToken = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(sessionToken).digest('hex');
    const now = Date.now();
    const absoluteSessionTtlSeconds = this.options.absoluteSessionTtlSeconds ?? 604_800;
    const expiresInSeconds = Math.min(this.options.sessionTtlSeconds, absoluteSessionTtlSeconds);
    const expiresAt = new Date(now + expiresInSeconds * 1_000);
    const absoluteExpiresAt = new Date(now + absoluteSessionTtlSeconds * 1_000);
    const ipHash = this.options.hmacKey
      ? createHmac('sha256', this.options.hmacKey).update(ip).digest('hex')
      : '';

    let created: boolean;
    try {
      created = await this.repository.createSession({
        userId: credential.userId,
        credentialId: credential.credentialId,
        expectedPasswordHash: credential.passwordHash!,
        tokenHash,
        expiresAt,
        absoluteExpiresAt,
        ipHash,
        previousTokenHash: previousSessionToken && /^[A-Za-z0-9_-]{43}$/.test(previousSessionToken)
          ? createHash('sha256').update(previousSessionToken).digest('hex')
          : undefined,
      });
    } catch {
      throw GENERIC_INFRASTRUCTURE_FAILURE;
    }
    if (!created) throw GENERIC_AUTH_FAILURE;

    return {
      userId: credential.userId,
      sessionToken,
      expiresInSeconds,
    };
  }

  private async consumeLimit(scope: string, identity: string, limit: number): Promise<void> {
    try {
      await this.limiter.consume(scope, identity, {
        limit,
        windowSeconds: this.options.windowSeconds,
      });
    } catch (error) {
      if (error instanceof AuthRateLimitExceededError) {
        throw new AuthHttpError(429, 'AUTH_RATE_LIMITED', 'Authentication is temporarily unavailable.', error.retryAfterSeconds);
      }
      if (error instanceof AuthRateLimitUnavailableError) throw GENERIC_INFRASTRUCTURE_FAILURE;
      throw GENERIC_INFRASTRUCTURE_FAILURE;
    }
  }
}
