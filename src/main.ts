import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { shouldExposeSwagger } from './config/swagger';
import { createOpenApiConfig } from './config/openapi';
import { FASTIFY_BODY_LIMIT_BYTES } from './config/http-limits';
import { MAX_MEDIA_UPLOAD_BYTES } from './modules/media/media-validation';
import { MAX_IMPORT_FILE_BYTES } from './modules/imports/import-workbook-reader';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ bodyLimit: FASTIFY_BODY_LIMIT_BYTES }), { bufferLogs: true });
  app.getHttpAdapter().getInstance().addContentTypeParser(/^image\/(?:jpeg|png|webp)$/, {
    parseAs: 'buffer', bodyLimit: MAX_MEDIA_UPLOAD_BYTES,
  }, (_request, body, done) => done(null, body));
  app.getHttpAdapter().getInstance().addContentTypeParser(/^(?:text\/csv|application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet)$/, {
    parseAs: 'buffer', bodyLimit: MAX_IMPORT_FILE_BYTES,
  }, (_request, body, done) => done(null, body));
  const configuration = app.get(ConfigService);
  app.setGlobalPrefix('api/v1');
  const allowedOrigins = configuration.get<string[]>('AUTH_ALLOWED_ORIGINS') ?? [];
  app.enableCors({ origin: allowedOrigins, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], allowedHeaders: ['Accept', 'Content-Type', 'Origin', 'X-Renivet-Local-Upload-Token'], credentials: false });
  if (shouldExposeSwagger(configuration.get<string>('NODE_ENV'))) {
    SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, createOpenApiConfig()));
  }
  await app.listen(
    configuration.get<number>('PORT') ?? 4000,
    configuration.get<string>('HOST') ?? '127.0.0.1',
  );
}
void bootstrap();
