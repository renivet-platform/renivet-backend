import {
  createCipheriv,
  createHash,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const base32Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const totpStepSeconds = 30;
const totpDigits = 6;

export interface EncryptedTotpSecret {
  iv: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

function requireKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('MFA key must be exactly 32 bytes.');
}

export function generateTotpSecret(): Buffer {
  return randomBytes(20);
}

export function base32Encode(value: Buffer): string {
  let accumulator = 0;
  let bits = 0;
  let result = '';
  for (const byte of value) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += base32Alphabet[(accumulator >>> bits) & 31];
    }
  }
  if (bits > 0) result += base32Alphabet[(accumulator << (5 - bits)) & 31];
  return result;
}

export function totpCode(secret: Buffer, timeMs: number): string {
  if (!Buffer.isBuffer(secret) || secret.length < 16 || !Number.isSafeInteger(timeMs) || timeMs < 0) {
    throw new Error('Invalid TOTP input.');
  }
  const counter = Math.floor(timeMs / (totpStepSeconds * 1_000));
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', secret).update(counterBuffer).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = ((digest[offset]! & 0x7f) << 24)
    | ((digest[offset + 1]! & 0xff) << 16)
    | ((digest[offset + 2]! & 0xff) << 8)
    | (digest[offset + 3]! & 0xff);
  return String(binary % (10 ** totpDigits)).padStart(totpDigits, '0');
}

export function verifyTotp(secret: Buffer, code: string, timeMs: number, lastAcceptedStep?: number | null): number | null {
  if (!/^\d{6}$/.test(code) || !Number.isSafeInteger(timeMs) || timeMs < 0) return null;
  const currentStep = Math.floor(timeMs / (totpStepSeconds * 1_000));
  const supplied = Buffer.from(code, 'ascii');
  for (const candidateStep of [currentStep, currentStep - 1, currentStep + 1]) {
    if (candidateStep < 0 || (lastAcceptedStep !== null && lastAcceptedStep !== undefined && candidateStep <= lastAcceptedStep)) continue;
    const expected = Buffer.from(totpCode(secret, candidateStep * totpStepSeconds * 1_000), 'ascii');
    if (timingSafeEqual(expected, supplied)) return candidateStep;
  }
  return null;
}

export function encryptTotpSecret(secret: Buffer, key: Buffer, factorId: string, userId: string): EncryptedTotpSecret {
  requireKey(key);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`renivet-mfa-totp-v1\0${factorId}\0${userId}`, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
  return { iv, ciphertext, tag: cipher.getAuthTag() };
}

export function decryptTotpSecret(encrypted: EncryptedTotpSecret, key: Buffer, factorId: string, userId: string): Buffer {
  requireKey(key);
  if (encrypted.iv.length !== 12 || encrypted.tag.length !== 16 || encrypted.ciphertext.length < 16) {
    throw new Error('Invalid encrypted MFA factor.');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, encrypted.iv);
  decipher.setAAD(Buffer.from(`renivet-mfa-totp-v1\0${factorId}\0${userId}`, 'utf8'));
  decipher.setAuthTag(encrypted.tag);
  return Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]);
}

export function generateRecoveryCodes(count = 10): string[] {
  if (!Number.isSafeInteger(count) || count < 1 || count > 20) throw new Error('Invalid recovery code count.');
  return Array.from({ length: count }, () => base32Encode(randomBytes(16)));
}

export function hashRecoveryCode(code: string): string {
  const normalized = code.replace(/-/g, '').toUpperCase();
  return createHash('sha256').update(normalized).digest('hex');
}
