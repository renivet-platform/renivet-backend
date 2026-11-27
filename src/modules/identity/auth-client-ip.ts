import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

type Headers = Record<string, string | string[] | undefined>;
function validIp(value: unknown): value is string {
  return typeof value === 'string' && !value.includes('%') && isIP(value) !== 0;
}

/** Never trust unsigned browser forwarding headers. Enable DO ingress trust only after spoof testing. */
export function resolveAuthClientIp(headers: Headers, socketIp: string, path: string, key: string | undefined, trustDigitalOcean: boolean, now = Date.now()): string {
  const proof = headers['x-renivet-client-ip-proof'];
  if (typeof proof === 'string' && key && key.length >= 32 && proof.length <= 180) {
    const parts = proof.split(';');
    const [version, timestamp, ip, signature] = parts;
    if (parts.length === 4 && version === 'v1' && /^\d{10}$/.test(timestamp) && validIp(ip)
      && /^[a-f0-9]{64}$/.test(signature) && Math.abs(Math.floor(now / 1000) - Number(timestamp)) <= 30) {
      const expected = createHmac('sha256', key).update(`v1\n${path}\n${timestamp}\n${ip}`).digest();
      if (timingSafeEqual(expected, Buffer.from(signature, 'hex'))) return ip;
    }
  }
  const ingressIp = headers['do-connecting-ip'];
  return trustDigitalOcean && validIp(ingressIp) ? ingressIp : socketIp;
}
