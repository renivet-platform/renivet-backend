import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { BrandAccessGuard } from './brand-access.guard';
import { BrandAccessRepository } from './brand-access.repository';

@Module({
  imports: [IdentityModule],
  providers: [BrandAccessRepository, BrandAccessGuard],
  exports: [BrandAccessGuard, BrandAccessRepository],
})
export class AccessModule {}
