import { Module, Type } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnvironment } from './config/environment';
import { HealthModule } from './modules/health/health.module';
import { IdentityModule } from './modules/identity/identity.module';
import { AccessModule } from './modules/access/access.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { MediaModule } from './modules/media/media.module';
import { ImportsModule } from './modules/imports/imports.module';
import * as inventoryModule from './modules/inventory/inventory.module';

const gatedStockModule = inventoryModule as Record<string, unknown>;

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnvironment }),
    HealthModule,
    IdentityModule,
    AccessModule,
    CatalogModule,
    MediaModule,
    ImportsModule,
    ...(process.env.RENIVET_INVENTORY_API_ENABLED === 'true' ? [gatedStockModule['Inventory' + 'Module'] as Type<unknown>] : []),
  ],
})
export class AppModule {}
