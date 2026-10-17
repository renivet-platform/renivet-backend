import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { bufferLogs: true });
  app.setGlobalPrefix('api/v1');
  const config = new DocumentBuilder().setTitle('Renivet API').setVersion('0.1.0').build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));
  await app.listen(Number(process.env.PORT || '4000'), process.env.HOST || '127.0.0.1');
}
void bootstrap();
