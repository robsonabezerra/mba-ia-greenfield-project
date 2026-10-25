import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsModule } from '../channels/channels.module';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import videosConfig from '../config/videos.config';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from '../videos/videos.constants';
import { createTestDataSource } from './create-test-data-source';

export const ALL_TEST_ENTITIES = [
  User,
  Channel,
  RefreshToken,
  VerificationToken,
  Video,
];

/**
 * Testing module with the real infrastructure used by video services:
 * PostgreSQL, MinIO (StorageModule) and Redis (video-processing queue).
 */
export async function createVideosTestingModule(
  providers: NonNullable<
    Parameters<typeof Test.createTestingModule>[0]
  >['providers'],
): Promise<TestingModule> {
  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        load: [storageConfig, queueConfig, videosConfig],
      }),
      TypeOrmModule.forRoot(createTestDataSource(ALL_TEST_ENTITIES).options),
      TypeOrmModule.forFeature([Video]),
      QueueModule,
      BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
      StorageModule,
      ChannelsModule,
    ],
    providers,
  }).compile();
}

/** Aborts open multipart uploads and removes stored objects of every video. */
export async function cleanVideoStorage(
  dataSource: DataSource,
  storage: StorageService,
): Promise<void> {
  const videos = await dataSource.getRepository(Video).find();
  for (const video of videos) {
    if (video.upload_id) {
      await storage
        .abortMultipartUpload(video.storage_key, video.upload_id)
        .catch(() => undefined);
    }
    await storage.deleteObject(video.storage_key);
    if (video.thumbnail_key) await storage.deleteObject(video.thumbnail_key);
  }
}
