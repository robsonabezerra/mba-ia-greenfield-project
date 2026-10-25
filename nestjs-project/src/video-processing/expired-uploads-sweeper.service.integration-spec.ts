import { randomBytes } from 'crypto';
import { TestingModule } from '@nestjs/testing';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import { buildVideo, createTestChannel } from '../test/video-factory';
import {
  cleanVideoStorage,
  createVideosTestingModule,
} from '../test/videos-test-module';
import { Video } from '../videos/entities/video.entity';
import { VideoDraftsService } from '../videos/video-drafts.service';
import { VideoStatus } from '../videos/video-status.enum';
import { ExpiredUploadsSweeperService } from './expired-uploads-sweeper.service';

const HOUR_MS = 60 * 60 * 1000;

describe('ExpiredUploadsSweeperService (integration)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let sweeper: ExpiredUploadsSweeperService;
  let storage: StorageService;
  let videoRepository: Repository<Video>;
  let channel: Channel;

  beforeAll(async () => {
    module = await createVideosTestingModule([
      VideoDraftsService,
      ExpiredUploadsSweeperService,
    ]);
    dataSource = module.get(DataSource);
    sweeper = module.get(ExpiredUploadsSweeperService);
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

  async function videoCreatedAgo(
    hours: number,
    status: VideoStatus,
  ): Promise<Video> {
    const video = await videoRepository.save(
      buildVideo(channel.id, { status }),
    );
    await videoRepository.update(
      { id: video.id },
      { created_at: new Date(Date.now() - hours * HOUR_MS) },
    );
    return video;
  }

  it('should discard an expired draft and abort its multipart upload', async () => {
    const video = await videoCreatedAgo(25, VideoStatus.DRAFT);
    const uploadId = await storage.createMultipartUpload(
      video.storage_key,
      'video/mp4',
    );
    await fetch(
      await storage.presignUploadPart(video.storage_key, uploadId, 1, 300),
      { method: 'PUT', body: new Uint8Array(randomBytes(1024)) },
    );
    await videoRepository.update({ id: video.id }, { upload_id: uploadId });

    const discarded = await sweeper.sweep();

    expect(discarded).toBe(1);
    await expect(
      videoRepository.findOneBy({ id: video.id }),
    ).resolves.toBeNull();
    await expect(
      storage.listParts(video.storage_key, uploadId),
    ).rejects.toMatchObject({ name: 'NoSuchUpload' });
  });

  it('should keep recent drafts and never touch videos past the draft state', async () => {
    const recent = await videoCreatedAgo(1, VideoStatus.DRAFT);
    const kept = await Promise.all(
      [VideoStatus.PROCESSING, VideoStatus.READY, VideoStatus.FAILED].map(
        (status) => videoCreatedAgo(48, status),
      ),
    );

    const discarded = await sweeper.sweep();

    expect(discarded).toBe(0);
    for (const video of [recent, ...kept]) {
      await expect(
        videoRepository.findOneBy({ id: video.id }),
      ).resolves.not.toBeNull();
    }
  });
});
