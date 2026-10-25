import { randomBytes } from 'crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
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
import { VideoProcessingProducer } from './video-processing.producer';
import { VIDEO_JOBS, VIDEO_PROCESSING_QUEUE } from './videos.constants';
import { VideosService } from './videos.service';

describe('VideosService (integration)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let service: VideosService;
  let storage: StorageService;
  let videoRepository: Repository<Video>;
  let channel: Channel;
  let queue: Queue;

  beforeAll(async () => {
    module = await createVideosTestingModule([
      VideosService,
      VideoProcessingProducer,
    ]);
    queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    dataSource = module.get(DataSource);
    service = module.get(VideosService);
    storage = module.get(StorageService);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await cleanVideoStorage(dataSource, storage);
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
    await module.close();
  });

  beforeEach(async () => {
    await cleanVideoStorage(dataSource, storage);
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
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

  describe('signUploadParts / getUploadState', () => {
    it('should sign a URL the storage accepts and report the stored part', async () => {
      const created = await service.initiateUpload(channel.user_id, {
        file_name: 'clip.mp4',
        file_size: 6 * 1024 * 1024,
        content_type: 'video/mp4',
      });
      const bytes = randomBytes(5 * 1024 * 1024);

      const signed = await service.signUploadParts(
        channel.user_id,
        created.slug,
        { part_numbers: [1] },
      );
      const put = await fetch(signed.parts[0].url, {
        method: 'PUT',
        body: new Uint8Array(bytes),
      });
      const state = await service.getUploadState(channel.user_id, created.slug);

      expect(put.status).toBe(200);
      expect(state.part_count).toBe(2);
      expect(state.uploaded_parts).toEqual([
        { part_number: 1, size: bytes.length },
      ]);
    });
  });

  describe('completeUpload', () => {
    it('should complete the object, mark processing and enqueue process-video', async () => {
      const part1 = randomBytes(5 * 1024 * 1024);
      const part2 = randomBytes(1024);
      const created = await service.initiateUpload(channel.user_id, {
        file_name: 'clip.mp4',
        file_size: part1.length + part2.length,
        content_type: 'video/mp4',
      });
      const signed = await service.signUploadParts(
        channel.user_id,
        created.slug,
        { part_numbers: [1, 2] },
      );
      for (const [i, body] of [part1, part2].entries()) {
        await fetch(signed.parts[i].url, {
          method: 'PUT',
          body: new Uint8Array(body),
        });
      }

      const result = await service.completeUpload(
        channel.user_id,
        created.slug,
      );

      expect(result.status).toBe(VideoStatus.PROCESSING);
      const video = await videoRepository.findOneByOrFail({ id: created.id });
      expect(video.status).toBe(VideoStatus.PROCESSING);
      expect(video.upload_id).toBeNull();
      await expect(
        storage.headObject(video.storage_key),
      ).resolves.toMatchObject({ contentLength: part1.length + part2.length });
      const job = await queue.getJob(created.id);
      expect(job?.name).toBe(VIDEO_JOBS.PROCESS);
      expect(job?.data).toEqual({ videoId: created.id });
    });
  });
});
