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
import { Video } from './entities/video.entity';
import { VideoDraftsService } from './video-drafts.service';

describe('VideoDraftsService (integration)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let drafts: VideoDraftsService;
  let storage: StorageService;
  let videoRepository: Repository<Video>;
  let channel: Channel;

  beforeAll(async () => {
    module = await createVideosTestingModule([VideoDraftsService]);
    dataSource = module.get(DataSource);
    drafts = module.get(VideoDraftsService);
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

  it('should abort the open multipart upload and delete the draft row', async () => {
    const video = await videoRepository.save(buildVideo(channel.id));
    const uploadId = await storage.createMultipartUpload(
      video.storage_key,
      'video/mp4',
    );
    await fetch(
      await storage.presignUploadPart(video.storage_key, uploadId, 1, 300),
      { method: 'PUT', body: new Uint8Array(randomBytes(1024)) },
    );
    await videoRepository.update({ id: video.id }, { upload_id: uploadId });

    await drafts.discard({ ...video, upload_id: uploadId });

    await expect(
      storage.listParts(video.storage_key, uploadId),
    ).rejects.toMatchObject({ name: 'NoSuchUpload' });
    await expect(
      videoRepository.findOneBy({ id: video.id }),
    ).resolves.toBeNull();
  });

  it('should delete stored bytes of a draft whose multipart was already completed', async () => {
    const video = await videoRepository.save(buildVideo(channel.id));
    await storage.putObject(
      video.storage_key,
      Buffer.from('bytes'),
      'video/mp4',
    );

    await drafts.discard(video);

    await expect(storage.headObject(video.storage_key)).resolves.toBeNull();
    await expect(
      videoRepository.findOneBy({ id: video.id }),
    ).resolves.toBeNull();
  });

  it('should tolerate a multipart upload that no longer exists', async () => {
    const video = await videoRepository.save(
      buildVideo(channel.id, { upload_id: 'missing-upload-id' }),
    );

    await expect(drafts.discard(video)).resolves.toBeUndefined();
    await expect(
      videoRepository.findOneBy({ id: video.id }),
    ).resolves.toBeNull();
  });
});
