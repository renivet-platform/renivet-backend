import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { MfaGuard } from '../../common/guards/require-mfa';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PhoneContactController } from './phone-contact.controller';
import { PhoneContactService } from './phone-contact.service';
import { AuthRateLimiter, RedisEvalClient } from './rate-limiter';
import { IdentityInfrastructure } from './identity-infrastructure';
import { IdentityRepository } from './identity.repository';
import { PasswordHashService } from './passwords';
import { OtpController } from './otp.controller';
import { OtpChallengeService } from './otp-challenge.service';
import { OTP_DELIVERY, OtpDeliveryPort } from './otp-delivery';
import { Fast2SmsOtpDelivery } from './fast2sms-otp-delivery';
import { SessionService } from './session.service';
import { MfaController } from './mfa.controller';
import { MfaRepository } from './mfa.repository';
import { MfaService } from './mfa.service';

@Module({
  controllers: [AuthController, PhoneContactController, OtpController, MfaController],
  providers: [
    IdentityInfrastructure,
    IdentityRepository,
    {
      provide: PhoneContactService,
      useFactory: (repository: IdentityRepository, limiter: AuthRateLimiter) => new PhoneContactService(repository, limiter),
      inject: [IdentityRepository, AuthRateLimiter],
    },
    MfaRepository,
    {
      provide: SessionService,
      useFactory: (repository: IdentityRepository, configuration: ConfigService) => new SessionService(
        repository,
        configuration.get<string>('AUTH_CSRF_HMAC_KEY'),
        configuration.get<number>('AUTH_SESSION_IDLE_TTL_SECONDS') ?? 1_800,
        configuration.get<number>('AUTH_SESSION_ABSOLUTE_TTL_SECONDS') ?? 604_800,
      ),
      inject: [IdentityRepository, ConfigService],
    },
    {
      provide: OTP_DELIVERY,
      useFactory: (configuration: ConfigService) => new Fast2SmsOtpDelivery({
        apiKey: configuration.get<string>('FAST2SMS_API_KEY'),
        messageId: configuration.get<string>('FAST2SMS_MESSAGE_ID'),
        senderId: configuration.get<string>('FAST2SMS_SENDER_ID'),
        entityId: configuration.get<string>('FAST2SMS_DLT_ENTITY_ID'),
      }),
      inject: [ConfigService],
    },
    PasswordHashService,
    {
      provide: AuthRateLimiter,
      useFactory: (infrastructure: IdentityInfrastructure, configuration: ConfigService) =>
        new AuthRateLimiter(
          infrastructure.redis as unknown as RedisEvalClient | null,
          configuration.get<string>('AUTH_RATE_LIMIT_HMAC_KEY'),
        ),
      inject: [IdentityInfrastructure, ConfigService],
    },
    {
      provide: AuthService,
      useFactory: (
        repository: IdentityRepository,
        passwords: PasswordHashService,
        limiter: AuthRateLimiter,
        configuration: ConfigService,
      ) => new AuthService(repository, passwords, limiter, {
        hmacKey: configuration.get<string>('AUTH_RATE_LIMIT_HMAC_KEY'),
        windowSeconds: configuration.get<number>('AUTH_RATE_LIMIT_WINDOW_SECONDS') ?? 900,
        registerAccountLimit: configuration.get<number>('AUTH_REGISTER_ACCOUNT_LIMIT') ?? 5,
        registerIpLimit: configuration.get<number>('AUTH_REGISTER_IP_LIMIT') ?? 30,
        loginAccountLimit: configuration.get<number>('AUTH_LOGIN_ACCOUNT_LIMIT') ?? 5,
        loginIpLimit: configuration.get<number>('AUTH_LOGIN_IP_LIMIT') ?? 60,
        sessionTtlSeconds: configuration.get<number>('AUTH_SESSION_IDLE_TTL_SECONDS') ?? configuration.get<number>('AUTH_SESSION_TTL_SECONDS') ?? 1_800,
        absoluteSessionTtlSeconds: configuration.get<number>('AUTH_SESSION_ABSOLUTE_TTL_SECONDS') ?? 604_800,
      }),
      inject: [IdentityRepository, PasswordHashService, AuthRateLimiter, ConfigService],
    },
    {
      provide: OtpChallengeService,
      useFactory: (repository: IdentityRepository, limiter: AuthRateLimiter, delivery: OtpDeliveryPort, configuration: ConfigService, passwords: PasswordHashService) =>
        new OtpChallengeService(repository, limiter, delivery, {
          hmacKey: configuration.get<string>('AUTH_CHALLENGE_HMAC_KEY'),
          ttlSeconds: configuration.get<number>('AUTH_CHALLENGE_TTL_SECONDS') ?? 300,
          maxAttempts: configuration.get<number>('AUTH_CHALLENGE_MAX_ATTEMPTS') ?? 5,
          resendCooldownSeconds: configuration.get<number>('AUTH_CHALLENGE_RESEND_COOLDOWN_SECONDS') ?? 60,
          resendWindowSeconds: configuration.get<number>('AUTH_CHALLENGE_RESEND_WINDOW_SECONDS') ?? 900,
          resendMax: configuration.get<number>('AUTH_CHALLENGE_RESEND_MAX') ?? 3,
          issueIpLimit: configuration.get<number>('AUTH_CHALLENGE_IP_LIMIT') ?? 30,
          identityLimit: configuration.get<number>('AUTH_CHALLENGE_IDENTITY_LIMIT') ?? 5,
          verifyIpLimit: configuration.get<number>('AUTH_CHALLENGE_VERIFY_IP_LIMIT') ?? 60,
        }, passwords),
      inject: [IdentityRepository, AuthRateLimiter, OTP_DELIVERY, ConfigService, PasswordHashService],
    },
    {
      provide: MfaService,
      useFactory: (
        repository: MfaRepository,
        limiter: AuthRateLimiter,
        configuration: ConfigService,
      ) => {
        const encryptionKey = configuration.get<string>('AUTH_MFA_ENCRYPTION_KEY');
        return new MfaService(repository, limiter, {
          encryptionKey: encryptionKey ? Buffer.from(encryptionKey, 'base64') : undefined,
          rateLimitHmacKey: configuration.get<string>('AUTH_RATE_LIMIT_HMAC_KEY'),
          idleTtlSeconds: configuration.get<number>('AUTH_SESSION_IDLE_TTL_SECONDS') ?? 1_800,
        });
      },
      inject: [MfaRepository, AuthRateLimiter, ConfigService],
    },
    {
      provide: MfaGuard,
      useFactory: (reflector: Reflector, sessions: SessionService, mfa: MfaService) => new MfaGuard(reflector, sessions, mfa),
      inject: [Reflector, SessionService, MfaService],
    },
  ],
  exports: [MfaGuard, MfaService, SessionService, IdentityInfrastructure],
})
export class IdentityModule {}
