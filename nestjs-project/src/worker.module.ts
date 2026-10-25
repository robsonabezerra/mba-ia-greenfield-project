import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from './channels/channels.module';
import { configModuleOptions } from './config/config-module.options';
import databaseConfig from './config/database.config';
import { buildTypeOrmOptions } from './database/typeorm-options';
import { QueueModule } from './queue/queue.module';
import { UsersModule } from './users/users.module';
import { VideoProcessingModule } from './video-processing/video-processing.module';
import { VideoProcessor } from './video-processing/video.processor';
import { VIDEO_PROCESSING_QUEUE } from './videos/videos.constants';

/** Root module of the video worker process — no HTTP modules (per TD-06). */
@Module({
  imports: [
    ConfigModule.forRoot(configModuleOptions),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: (dbConfig: ConfigType<typeof databaseConfig>) =>
        buildTypeOrmOptions(dbConfig),
    }),
    QueueModule,
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
    VideoProcessingModule,
    // Entity owners of the Video → Channel → User relation graph.
    ChannelsModule,
    UsersModule,
  ],
  providers: [VideoProcessor],
})
export class WorkerModule {}
