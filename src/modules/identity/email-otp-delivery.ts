import { OtpDeliveryPort } from './otp-delivery';
import { ResendOtpDeliveryFailure, ResendTemplateOtpDelivery } from './resend-template-otp-delivery';
import { SmtpOtpDelivery } from './smtp-otp-delivery';

export interface EmailOtpProviderConfiguration {
  provider?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUsername?: string;
  smtpPassword?: string;
  smtpFrom?: string;
  resendApiKey?: string;
  resendFrom?: string;
  resendEmailVerificationTemplateId?: string;
  resendPasswordRecoveryTemplateId?: string;
  onResendDeliveryFailure?: (failure: ResendOtpDeliveryFailure) => void;
}

/** Builds exactly one email adapter, retaining SMTP as the backwards-compatible default. */
export function createEmailOtpDelivery(configuration: EmailOtpProviderConfiguration): OtpDeliveryPort {
  if (configuration.provider === 'resend') {
    const apiKey = configuration.resendApiKey
      ?? (configuration.smtpHost?.toLowerCase() === 'smtp.resend.com' ? configuration.smtpPassword : undefined);
    return new ResendTemplateOtpDelivery({
      apiKey,
      from: configuration.resendFrom ?? configuration.smtpFrom,
      emailVerificationTemplateId: configuration.resendEmailVerificationTemplateId,
      passwordRecoveryTemplateId: configuration.resendPasswordRecoveryTemplateId,
      onDeliveryFailure: configuration.onResendDeliveryFailure,
    });
  }

  return new SmtpOtpDelivery({
    host: configuration.smtpHost,
    port: configuration.smtpPort,
    secure: configuration.smtpSecure,
    username: configuration.smtpUsername,
    password: configuration.smtpPassword,
    from: configuration.smtpFrom,
  });
}
