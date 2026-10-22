import { Module } from '@nestjs/common';

// PROPOSED ONLY: Parent checkout and per-brand seller orders require approved reservation and payment policy.
// Do not register this empty module in AppModule until approved services/routes exist.
@Module({})
export class CheckoutModule {}
