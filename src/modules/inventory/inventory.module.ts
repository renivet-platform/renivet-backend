import { Module } from '@nestjs/common';

// PROPOSED ONLY: PostgreSQL authoritative for stock. No reservations, mutations, sync or lock policy until approved.
// Do not register this empty module in AppModule until approved services/routes exist.
@Module({})
export class InventoryModule {}
