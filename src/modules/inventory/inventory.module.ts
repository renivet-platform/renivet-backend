import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { MfaGuard } from '../../common/guards/require-mfa';
import { AccessModule } from '../access/access.module';
import { IdentityModule } from '../identity/identity.module';
import { MfaService } from '../identity/mfa.service';
import { SessionService } from '../identity/session.service';
import { InventoryController } from './inventory.controller';
import { InventoryAdminController } from './inventory-admin.controller';
import { InventoryPostgresRepository } from './inventory.repository';

@Module({
  imports: [ConfigModule, IdentityModule, AccessModule],
  controllers: [InventoryController, InventoryAdminController],
  providers: [InventoryPostgresRepository, {
    provide: MfaGuard,
    useFactory: (reflector: Reflector, sessions: SessionService, mfa: MfaService, configuration: ConfigService) =>
      new MfaGuard(reflector, sessions, mfa, Date.now, configuration.get<'enforced' | 'deferred'>('MFA_ENFORCEMENT_MODE') ?? 'enforced'),
    inject: [Reflector, SessionService, MfaService, ConfigService],
  }],
})
export class InventoryModule {}
