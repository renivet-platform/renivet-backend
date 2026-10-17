import { Module } from '@nestjs/common';

// PROPOSED ONLY: Razorpay customer collection only after approved contract; no seller-disbursement API.
// Do not register this empty module in AppModule until approved services/routes exist.
@Module({})
export class PaymentsModule {}
