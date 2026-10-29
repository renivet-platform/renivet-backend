import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthRateLimiter, RedisEvalClient } from './rate-limiter';
import { IdentityInfrastructure } from './identity-infrastructure';
import { IdentityRepository } from './identity.repository';
import { PasswordHashService } from './passwords';
import { OtpController } from './otp.controller';
import { OtpChallengeService } from './otp-challenge.service';
import { OTP_DELIVERY, UnavailableOtpDelivery } from './otp-delivery';
import { SessionService } from './session.service';

@Module({
  controllers: [AuthController, OtpController],
  providers: [
    IdentityInfrastructure,
    IdentityRepository,
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
    { provide: OTP_DELIVERY, useClass: UnavailableOtpDelivery },
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
      }),
      inject: [IdentityRepository, PasswordHashService, AuthRateLimiter, ConfigService],
    },
    {
      provide: OtpChallengeService,
      useFactory: (repository: IdentityRepository, limiter: AuthRateLimiter, delivery: UnavailableOtpDelivery, configuration: ConfigService, passwords: PasswordHashService) =>
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
  ],
})
export class IdentityModule {}
