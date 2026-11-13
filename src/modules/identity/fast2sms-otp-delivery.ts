import { OtpDeliveryMessage, OtpDeliveryPort } from './otp-delivery';

const FAST2SMS_DLT_ENDPOINT = 'https://www.fast2sms.com/dev/bulkV2';
const DEFAULT_TIMEOUT_MILLISECONDS = 4_000;

export interface Fast2SmsOtpConfiguration {
  apiKey?: string;
  messageId?: string;
  senderId?: string;
  entityId?: string;
}

type Fast2SmsFetch = (url: string, options: RequestInit) => Promise<Response>;

function configuredValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function validConfiguration(config: Fast2SmsOtpConfiguration): boolean {
  return Boolean(
    configuredValue(config.apiKey)
    && config.messageId && /^[0-9]{1,32}$/.test(config.messageId.trim())
    && config.senderId && /^[A-Za-z]{3,6}$/.test(config.senderId.trim())
    && config.entityId && /^[0-9]{5,32}$/.test(config.entityId.trim()),
  );
}

/** Sends Renivet-generated, purpose-bound phone OTPs through Fast2SMS DLT SMS. */
export class Fast2SmsOtpDelivery implements OtpDeliveryPort {
  private readonly apiKey?: string;
  private readonly messageId?: string;
  private readonly senderId?: string;
  private readonly isConfigured: boolean;

  constructor(
    configuration: Fast2SmsOtpConfiguration,
    private readonly fetcher: Fast2SmsFetch = fetch,
    private readonly timeoutMilliseconds = DEFAULT_TIMEOUT_MILLISECONDS,
  ) {
    this.apiKey = configuredValue(configuration.apiKey);
    this.messageId = configuredValue(configuration.messageId);
    this.senderId = configuredValue(configuration.senderId);
    this.isConfigured = validConfiguration(configuration);
  }

  get available(): boolean {
    return this.isConfigured;
  }

  availableFor(channel: OtpDeliveryMessage['channel'], purpose: OtpDeliveryMessage['purpose']): boolean {
    return this.isConfigured && channel === 'phone' && (purpose === 'phone_verification' || purpose === 'phone_login');
  }

  async send(message: OtpDeliveryMessage, signal?: AbortSignal): Promise<void> {
    if (!this.availableFor(message.channel, message.purpose)) throw new Error('Fast2SMS delivery failed.');
    if (!/^\+91[6-9][0-9]{9}$/.test(message.destination)
      || !/^[0-9]{6}$/.test(message.code)
      || !Number.isInteger(message.expiresInSeconds)
      || message.expiresInSeconds < 1) {
      throw new Error('Fast2SMS delivery failed.');
    }

    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), this.timeoutMilliseconds);
    const requestSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;

    try {
      if (requestSignal.aborted) throw new Error('request aborted');
      const response = await this.fetcher(FAST2SMS_DLT_ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: this.apiKey!,
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          sender_id: this.senderId,
          message: this.messageId,
          variables_values: `${message.code}|${Math.ceil(message.expiresInSeconds / 60)}`,
          route: 'dlt',
          numbers: message.destination.slice(3),
        }),
        signal: requestSignal,
      });
      if (!response.ok) throw new Error('provider rejected request');
      const result: unknown = await response.json();
      if (!result || typeof result !== 'object' || !('return' in result) || result.return !== true) {
        throw new Error('provider rejected request');
      }
    } catch {
      // Never expose provider responses, OTPs, destinations, request bodies, or credentials.
      throw new Error('Fast2SMS delivery failed.');
    } finally {
      clearTimeout(timeout);
    }
  }
}
