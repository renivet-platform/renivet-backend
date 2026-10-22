import { Module } from '@nestjs/common';

// PROPOSED ONLY: Manual external bank transfer only; record proof, amount, date, reference after admin approval. No automated seller payout endpoints or jobs.
// Do not register this empty module in AppModule until approved services/routes exist.
@Module({})
export class SettlementsModule {}
