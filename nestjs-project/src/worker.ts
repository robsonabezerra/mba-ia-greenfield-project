import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  // SIGTERM/SIGINT close the BullMQ worker gracefully (active jobs finish).
  app.enableShutdownHooks();
  Logger.log('Video worker started', 'VideoWorker');
  process.once('SIGTERM', () =>
    Logger.log('SIGTERM received, closing the worker', 'VideoWorker'),
  );
}
void bootstrap();
