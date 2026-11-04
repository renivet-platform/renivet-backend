import { DocumentBuilder } from '@nestjs/swagger';

export function createOpenApiConfig(): ReturnType<DocumentBuilder['build']> {
  return new DocumentBuilder()
    .setTitle('Renivet API')
    .setVersion('0.1.0')
    .addCookieAuth('__Host-renivet_session', { type: 'apiKey', in: 'cookie' }, 'renivetSession')
    .addCookieAuth('__Host-renivet_session', { type: 'apiKey', in: 'cookie' }, 'sessionCookie')
    .build();
}
