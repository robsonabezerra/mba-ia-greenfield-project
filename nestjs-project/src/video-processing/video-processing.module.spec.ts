import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import storageConfig from '../config/storage.config';
import videosConfig from '../config/videos.config';
import { createTestDataSource } from '../test/create-test-data-source';
import { ALL_TEST_ENTITIES } from '../test/videos-test-module';
import { VideoProcessingModule } from './video-processing.module';
import { VideoProcessingService } from './video-processing.service';

describe('VideoProcessingModule', () => {
  it('should compile and resolve VideoProcessingService', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, videosConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_TEST_ENTITIES).options),
        VideoProcessingModule,
      ],
    }).compile();

    expect(module.get(VideoProcessingService)).toBeInstanceOf(
      VideoProcessingService,
    );
    await module.close();
  }, 30000);
});
