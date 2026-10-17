import { Module } from '@nestjs/common';

// PROPOSED ONLY: Delhivery, Shopify/Uniware, Twilio, SMTP are optional adapters behind approved contracts.
// Do not register this empty module in AppModule until approved services/routes exist.
@Module({})
export class IntegrationsModule {}
