import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { shouldExposeSwagger } from './config/swagger';
import { createOpenApiConfig } from './config/openapi';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { bufferLogs: true });
  const configuration = app.get(ConfigService);
  app.setGlobalPrefix('api/v1');
  if (shouldExposeSwagger(configuration.get<string>('NODE_ENV'))) {
    SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, createOpenApiConfig()));
  }
  await app.listen(
    configuration.get<number>('PORT') ?? 4000,
    configuration.get<string>('HOST') ?? '127.0.0.1',
  );
}
void bootstrap();
