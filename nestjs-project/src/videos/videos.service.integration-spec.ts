import { TestingModule } from '@nestjs/testing';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import { createTestChannel } from '../test/video-factory';
import {
  cleanVideoStorage,
  createVideosTestingModule,
} from '../test/videos-test-module';
import { Video } from './entities/video.entity';
import { VideoStatus } from './video-status.enum';
import { VideosService } from './videos.service';

describe('VideosService (integration)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let service: VideosService;
  let storage: StorageService;
  let videoRepository: Repository<Video>;
  let channel: Channel;

  beforeAll(async () => {
    module = await createVideosTestingModule([VideosService]);
    dataSource = module.get(DataSource);
    service = module.get(VideosService);
    storage = module.get(StorageService);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await cleanVideoStorage(dataSource, storage);
    await cleanAllTables(dataSource);
    await module.close();
  });

  beforeEach(async () => {
    await cleanVideoStorage(dataSource, storage);
    await cleanAllTables(dataSource);
    channel = await createTestChannel(dataSource);
  });

  describe('initiateUpload', () => {
    it('should persist a draft and open the multipart upload in storage', async () => {
      const result = await service.initiateUpload(channel.user_id, {
        file_name: 'aula.mp4',
        file_size: 12 * 1024 * 1024,
        content_type: 'video/mp4',
      });

      const video = await videoRepository.findOneByOrFail({ id: result.id });
      expect(video).toMatchObject({
        channel_id: channel.id,
        slug: result.slug,
        title: 'aula',
        status: VideoStatus.DRAFT,
        storage_key: `videos/${result.id}/source`,
        upload_part_size: 5242880,
        upload_part_count: 3,
      });
      expect(video.upload_id).toEqual(expect.any(String));
      await expect(
        storage.listParts(video.storage_key, video.upload_id!),
      ).resolves.toEqual([]);
    });

    it('should give different slugs to consecutive drafts', async () => {
      const dto = {
        file_name: 'a.mp4',
        file_size: 1024,
        content_type: 'video/mp4',
      };

      const first = await service.initiateUpload(channel.user_id, dto);
      const second = await service.initiateUpload(channel.user_id, dto);

      expect(first.slug).not.toBe(second.slug);
    });
  });
});
