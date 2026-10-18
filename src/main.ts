import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { shouldExposeSwagger } from './config/swagger';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { bufferLogs: true });
  const configuration = app.get(ConfigService);
  app.setGlobalPrefix('api/v1');
  if (shouldExposeSwagger(configuration.get<string>('NODE_ENV'))) {
    const config = new DocumentBuilder().setTitle('Renivet API').setVersion('0.1.0').build();
    SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));
  }
  await app.listen(
    configuration.get<number>('PORT') ?? 4000,
    configuration.get<string>('HOST') ?? '127.0.0.1',
  );
}
void bootstrap();
