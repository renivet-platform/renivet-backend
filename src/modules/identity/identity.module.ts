import { Module } from '@nestjs/common';

// PROPOSED ONLY: Identity/OIDC/password/OTP policies remain open; no endpoints, providers or guards yet.
// Do not register this empty module in AppModule until approved services/routes exist.
@Module({})
export class IdentityModule {}
