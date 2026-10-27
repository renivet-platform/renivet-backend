import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthRateLimiter, RedisEvalClient } from './rate-limiter';
import { IdentityInfrastructure } from './identity-infrastructure';
import { IdentityRepository } from './identity.repository';
import { PasswordHashService } from './passwords';

@Module({
  controllers: [AuthController],
  providers: [
    IdentityInfrastructure,
    IdentityRepository,
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
        sessionTtlSeconds: configuration.get<number>('AUTH_SESSION_TTL_SECONDS') ?? 1_800,
      }),
      inject: [IdentityRepository, PasswordHashService, AuthRateLimiter, ConfigService],
    },
  ],
})
export class IdentityModule {}
