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
  /** Optional channel- and purpose-specific capability for multi-channel providers. */
  availableFor?(channel: OtpDeliveryMessage['channel'], purpose: OtpDeliveryMessage['purpose']): boolean;
  /** Implementations must stop pending delivery when the supplied abort signal fires. */
  send(message: OtpDeliveryMessage, signal?: AbortSignal): Promise<void>;
}

/** Routes a message to exactly one channel/purpose-specific delivery adapter. */
export class CompositeOtpDelivery implements OtpDeliveryPort {
  constructor(private readonly providers: readonly OtpDeliveryPort[]) {}

  get available(): boolean {
    return this.providers.some((provider) => provider.available);
  }

  availableFor(channel: OtpDeliveryMessage['channel'], purpose: OtpDeliveryMessage['purpose']): boolean {
    return this.providers.some((provider) => provider.availableFor?.(channel, purpose) ?? provider.available);
  }

  async send(message: OtpDeliveryMessage, signal?: AbortSignal): Promise<void> {
    const provider = this.providers.find((candidate) => candidate.availableFor?.(message.channel, message.purpose) ?? candidate.available);
    if (!provider) throw new Error('OTP delivery is not configured.');
    await provider.send(message, signal);
  }
}

/** Production-safe placeholder. It performs no network I/O until a reviewed provider is configured. */
export class UnavailableOtpDelivery implements OtpDeliveryPort {
  readonly available = false;
  async send(): Promise<void> {
    throw new Error('OTP delivery is not configured.');
  }
}
