import { OtpDeliveryMessage, OtpDeliveryPort } from './otp-delivery';

const RESEND_EMAIL_ENDPOINT = 'https://api.resend.com/emails';
const DEFAULT_TIMEOUT_MILLISECONDS = 5_000;
const DEFAULT_EMAIL_VERIFICATION_TEMPLATE_ID = 'email-verification';
const DEFAULT_PASSWORD_RECOVERY_TEMPLATE_ID = 'reset_password';

export interface ResendTemplateOtpConfiguration {
  apiKey?: string;
  from?: string;
  emailVerificationTemplateId?: string;
  passwordRecoveryTemplateId?: string;
}

export type ResendFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function clean(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result || undefined;
}

function validMailbox(value: string | undefined): value is string {
  return Boolean(value && value.length <= 254
    && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(value));
}

function validSender(value: string | undefined): value is string {
  if (!value || value.length > 320 || /[\r\n]/.test(value)) return false;
  const match = /^(?:[^<>\r\n]{1,120}\s)?<([^<>\s]+)>$/.exec(value);
  return validMailbox(match?.[1] ?? value);
}

function validTemplateId(value: string | undefined): value is string {
  return Boolean(value && value.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value));
}

/** Sends purpose-bound email OTPs through Resend's published hosted templates. */
export class ResendTemplateOtpDelivery implements OtpDeliveryPort {
  private readonly apiKey?: string;
  private readonly from?: string;
  private readonly emailVerificationTemplateId?: string;
  private readonly passwordRecoveryTemplateId?: string;
  private readonly isConfigured: boolean;

  constructor(
    configuration: ResendTemplateOtpConfiguration,
    private readonly fetcher: ResendFetch = fetch,
    private readonly timeoutMilliseconds = DEFAULT_TIMEOUT_MILLISECONDS,
  ) {
    this.apiKey = clean(configuration.apiKey);
    this.from = clean(configuration.from);
    this.emailVerificationTemplateId = clean(configuration.emailVerificationTemplateId)
      ?? DEFAULT_EMAIL_VERIFICATION_TEMPLATE_ID;
    this.passwordRecoveryTemplateId = clean(configuration.passwordRecoveryTemplateId)
      ?? DEFAULT_PASSWORD_RECOVERY_TEMPLATE_ID;
    this.isConfigured = Boolean(this.apiKey)
      && validSender(this.from)
      && validTemplateId(this.emailVerificationTemplateId)
      && validTemplateId(this.passwordRecoveryTemplateId)
      && Number.isInteger(this.timeoutMilliseconds)
      && this.timeoutMilliseconds >= 100
      && this.timeoutMilliseconds <= 15_000;
  }

  get available(): boolean {
    return this.isConfigured;
  }

  availableFor(channel: OtpDeliveryMessage['channel'], purpose: OtpDeliveryMessage['purpose']): boolean {
    return this.isConfigured && channel === 'email'
      && (purpose === 'email_verification' || purpose === 'password_recovery');
  }

  async send(message: OtpDeliveryMessage, signal?: AbortSignal): Promise<void> {
    if (!this.availableFor(message.channel, message.purpose)
      || !validMailbox(message.destination)
      || !/^[0-9]{6}$/.test(message.code)
      || !Number.isInteger(message.expiresInSeconds)
      || message.expiresInSeconds < 1
      || message.expiresInSeconds > 3_600
      || signal?.aborted) {
      throw new Error('Email delivery failed.');
    }

    const templateId = message.purpose === 'email_verification'
      ? this.emailVerificationTemplateId!
      : this.passwordRecoveryTemplateId!;
    const controller = new AbortController();
    let abortListener: (() => void) | undefined;
    const timer = setTimeout(() => controller.abort(), this.timeoutMilliseconds);
    if (signal) {
      abortListener = () => controller.abort();
      signal.addEventListener('abort', abortListener, { once: true });
    }

    try {
      const response = await this.fetcher(RESEND_EMAIL_ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: this.from,
          to: [message.destination],
          subject: message.purpose === 'email_verification'
            ? 'Verify your Renivet email'
            : 'Reset your Renivet password',
          template: {
            id: templateId,
            variables: {
              OTP_CODE: message.code,
              // Resend hosted-template variables must all be strings.
              EXPIRY_MINUTES: String(Math.ceil(message.expiresInSeconds / 60)),
            },
          },
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('provider failure');
      const result: unknown = await response.json();
      if (!result || typeof result !== 'object' || !('id' in result)
        || typeof result.id !== 'string' || result.id.length === 0 || result.id.length > 200) {
        throw new Error('invalid provider response');
      }
    } catch {
      throw new Error('Email delivery failed.');
    } finally {
      clearTimeout(timer);
      if (signal && abortListener) signal.removeEventListener('abort', abortListener);
    }
  }
}
