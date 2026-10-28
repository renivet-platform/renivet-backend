import * as argon2 from 'argon2';

export const PASSWORD_MIN_LENGTH = 15;
export const PASSWORD_MAX_LENGTH = 128;

const ARGON2ID_OPTIONS: argon2.HashOptions = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32,
};

// Synthetic random input was used to generate this static value. It is only a
// constant-work verification target for unknown accounts, never a user credential.
const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$ogRF+l1VzO3n4j12q9jF2A$hJVaQyUX+SREGXlc8D219gV2SjsFEPAHt9HtPcrUGms';

export function isPasswordAllowed(password: unknown): password is string {
  if (typeof password !== 'string') return false;
  const length = [...password].length;
  return length >= PASSWORD_MIN_LENGTH && length <= PASSWORD_MAX_LENGTH;
}

export class PasswordHashService {
  async hash(password: string): Promise<string> {
    const encoded: string = await argon2.hash(password, ARGON2ID_OPTIONS);

    // Keep the PHC parameter order consistent with REN2-20's database check.
    // Argon2 PHC permits reordered parameters and node-argon2 verifies this form.
    return encoded.replace(/m=(\d+),p=(\d+),t=(\d+)/, 'm=$1,t=$3,p=$2');
  }

  async verify(encodedHash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(encodedHash, password);
    } catch {
      return false;
    }
  }

  async verifyOrDummy(encodedHash: string | null | undefined, password: string): Promise<boolean> {
    if (encodedHash) return this.verify(encodedHash, password);
    await this.verify(DUMMY_PASSWORD_HASH, password);
    return false;
  }
}
