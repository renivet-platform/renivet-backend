export const OTP_DELIVERY = Symbol('OTP_DELIVERY');

export interface OtpDeliveryMessage {
  channel: 'email' | 'phone';
  destination: string;
  purpose: 'email_verification' | 'phone_verification' | 'password_recovery';
  code: string;
  expiresInSeconds: number;
}

export interface OtpDeliveryPort {
  readonly available: boolean;
  /** Implementations must stop pending delivery when the supplied abort signal fires. */
  send(message: OtpDeliveryMessage, signal?: AbortSignal): Promise<void>;
}

/** Production-safe placeholder. It performs no network I/O until a reviewed provider is configured. */
export class UnavailableOtpDelivery implements OtpDeliveryPort {
  readonly available = false;
  async send(): Promise<void> {
    throw new Error('OTP delivery is not configured.');
  }
}
