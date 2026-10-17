import { Module } from '@nestjs/common';

// PROPOSED ONLY: Brand-owned products only; no universal SKU or catalog mutation implemented.
// Do not register this empty module in AppModule until approved services/routes exist.
@Module({})
export class CatalogModule {}
