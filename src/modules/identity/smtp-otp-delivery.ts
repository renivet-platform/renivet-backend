import nodemailer from 'nodemailer';
import { OtpDeliveryMessage, OtpDeliveryPort } from './otp-delivery';

const DEFAULT_TIMEOUT_MILLISECONDS = 5_000;

export interface SmtpOtpConfiguration {
  host?: string;
  port?: number;
  secure?: boolean;
  username?: string;
  password?: string;
  from?: string;
}

export interface SmtpTransportOptions {
  host: string;
  port: number;
  secure: boolean;
  requireTLS: boolean;
  connectionTimeout: number;
  greetingTimeout: number;
  socketTimeout: number;
  tls: { minVersion: 'TLSv1.2' };
  auth?: { user: string; pass: string };
}

export interface SmtpMailTransport {
  sendMail(message: { from: string; to: string; subject: string; text: string; html: string }): Promise<unknown>;
  close?(): void;
}

export type SmtpTransportFactory = (options: SmtpTransportOptions) => SmtpMailTransport;

function clean(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result || undefined;
}

function validMailbox(value: string | undefined): value is string {
  return Boolean(value && value.length <= 254 && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(value));
}

function validHost(value: string | undefined): value is string {
  return Boolean(value && value.length <= 253 && /^[A-Za-z0-9.-]+$/.test(value) && !value.startsWith('.') && !value.endsWith('.'));
}

function minutes(expiresInSeconds: number): string {
  const value = Math.ceil(expiresInSeconds / 60);
  return `${value} ${value === 1 ? 'minute' : 'minutes'}`;
}

function messageContent(message: OtpDeliveryMessage): { subject: string; text: string; html: string } {
  const duration = minutes(message.expiresInSeconds);
  const verification = message.purpose === 'email_verification';
  const action = verification ? 'verify your email address' : 'reset your Renivet password';
  const subject = verification ? 'Your Renivet verification code' : 'Your Renivet password reset code';
  const text = `Use ${message.code} to ${action}. This code expires in ${duration}. If you did not request this, you can ignore this email.`;
  const html = `<!doctype html><html lang="en"><body style="margin:0;background:#f4f4ee;color:#14251f;font-family:Arial,Helvetica,sans-serif;padding:32px 16px"><main style="box-sizing:border-box;margin:0 auto;max-width:520px;background:#fff;border:1px solid #dce3dc;border-radius:16px;padding:32px"><p style="margin:0 0 20px;color:#17483b;font-weight:700;letter-spacing:.12em;text-transform:uppercase">Renivet</p><h1 style="font-size:24px;line-height:1.3;margin:0 0 12px">${verification ? 'Verify your email' : 'Reset your password'}</h1><p style="font-size:16px;line-height:1.6;margin:0 0 24px">Use this one-time code to ${action}.</p><p style="background:#f4f6f1;border-radius:10px;color:#17483b;font-size:30px;font-weight:700;letter-spacing:.24em;margin:0 0 18px;padding:18px;text-align:center">${message.code}</p><p style="color:#58675f;font-size:14px;line-height:1.6;margin:0">This code expires in ${duration}. If you did not request this, you can ignore this email.</p></main></body></html>`;
  return { subject, text, html };
}

/** Sends Renivet-generated email OTPs through an explicitly configured SMTP relay. */
export class SmtpOtpDelivery implements OtpDeliveryPort {
  private readonly host?: string;
  private readonly from?: string;
  private readonly username?: string;
  private readonly password?: string;
  private readonly port: number;
  private readonly secure?: boolean;
  private readonly isConfigured: boolean;

  constructor(
    configuration: SmtpOtpConfiguration,
    private readonly transportFactory: SmtpTransportFactory = (options) => nodemailer.createTransport(options),
    private readonly timeoutMilliseconds = DEFAULT_TIMEOUT_MILLISECONDS,
  ) {
    this.host = clean(configuration.host);
    this.from = clean(configuration.from);
    this.username = clean(configuration.username);
    this.password = clean(configuration.password);
    this.port = configuration.port ?? 587;
    this.secure = configuration.secure;
    const validAuth = Boolean(this.username) && Boolean(this.password);
    this.isConfigured = validHost(this.host)
      && validMailbox(this.from)
      && Number.isInteger(this.port) && this.port >= 1 && this.port <= 65_535
      && this.timeoutMilliseconds >= 100 && this.timeoutMilliseconds <= 15_000
      && validAuth;
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
      || !Number.isInteger(message.expiresInSeconds) || message.expiresInSeconds < 1 || message.expiresInSeconds > 3_600
      || signal?.aborted) {
      throw new Error('Email delivery failed.');
    }

    const secure = this.secure ?? this.port === 465;
    const options: SmtpTransportOptions = {
      host: this.host!,
      port: this.port,
      secure,
      requireTLS: !secure,
      connectionTimeout: this.timeoutMilliseconds,
      greetingTimeout: this.timeoutMilliseconds,
      socketTimeout: this.timeoutMilliseconds,
      tls: { minVersion: 'TLSv1.2' },
      ...(this.username && this.password ? { auth: { user: this.username, pass: this.password } } : {}),
    };

    let transport: SmtpMailTransport | undefined;
    let timer: NodeJS.Timeout | undefined;
    let abortListener: (() => void) | undefined;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      try { transport?.close?.(); } catch { /* Keep provider details private. */ }
    };

    try {
      transport = this.transportFactory(options);
      const content = messageContent(message);
      const delivery = transport.sendMail({ from: this.from!, to: message.destination, ...content });
      const bounded = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          close();
          reject(new Error('timeout'));
        }, this.timeoutMilliseconds);
        if (signal) {
          abortListener = () => {
            close();
            reject(new Error('aborted'));
          };
          signal.addEventListener('abort', abortListener, { once: true });
        }
      });
      await Promise.race([delivery, bounded]);
    } catch {
      throw new Error('Email delivery failed.');
    } finally {
      if (timer) clearTimeout(timer);
      if (signal && abortListener) signal.removeEventListener('abort', abortListener);
      close();
    }
  }
}
