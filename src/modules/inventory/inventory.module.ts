import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MfaGuard } from '../../common/guards/require-mfa';
import { AccessModule } from '../access/access.module';
import { IdentityModule } from '../identity/identity.module';
import { InventoryController } from './inventory.controller';
import { InventoryAdminController } from './inventory-admin.controller';
import { InventoryPostgresRepository } from './inventory.repository';

@Module({
  imports: [ConfigModule, IdentityModule, AccessModule],
  controllers: [InventoryController, InventoryAdminController],
  providers: [InventoryPostgresRepository, MfaGuard],
})
export class InventoryModule {}
