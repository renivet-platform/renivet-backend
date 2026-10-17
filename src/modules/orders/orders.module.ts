import { Module } from '@nestjs/common';

// PROPOSED ONLY: Per-brand seller order ownership. No state transitions, ledger integration or fulfillment logic.
// Do not register this empty module in AppModule until approved services/routes exist.
@Module({})
export class OrdersModule {}
