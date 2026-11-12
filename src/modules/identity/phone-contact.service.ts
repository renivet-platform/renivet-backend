import { AuthHttpError } from './auth.service';
import { AuthRateLimiter } from './rate-limiter';
export interface PhoneContactRepositoryPort {
  setPhoneForVerification(userId: string, phone: string): Promise<boolean | null>;
}

const phoneChangeRule = { limit: 3, windowSeconds: 900 };
const phoneChangeIpRule = { limit: 15, windowSeconds: 900 };

export class PhoneContactService {
  constructor(
    private readonly repository: PhoneContactRepositoryPort,
    private readonly limiter: AuthRateLimiter,
  ) {}

  async setPhoneForVerification(userId: string, phone: string, ip: string): Promise<{ status: 'accepted'; verificationRequired: boolean }> {
    if (!/^\+91[6-9][0-9]{9}$/.test(phone)) {
      throw new AuthHttpError(400, 'AUTH_INPUT_INVALID', 'The request could not be processed.');
    }

    await this.limiter.consume('phone-change-user', userId, phoneChangeRule);
    await this.limiter.consume('phone-change-ip', ip, phoneChangeIpRule);

    let verificationRequired: boolean | null;
    try {
      verificationRequired = await this.repository.setPhoneForVerification(userId, phone);
    } catch {
      throw new AuthHttpError(503, 'AUTH_SERVICE_UNAVAILABLE', 'Authentication is temporarily unavailable.');
    }
    if (verificationRequired === null) throw new AuthHttpError(400, 'AUTH_INPUT_INVALID', 'The request could not be processed.');
    return { status: 'accepted', verificationRequired };
  }
}
