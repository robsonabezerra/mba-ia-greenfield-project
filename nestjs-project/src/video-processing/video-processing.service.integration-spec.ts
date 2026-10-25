import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TestingModule } from '@nestjs/testing';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import { buildVideo, createTestChannel } from '../test/video-factory';
import { generateTestVideo } from '../test/video-fixtures';
import {
  cleanVideoStorage,
  createVideosTestingModule,
} from '../test/videos-test-module';
import { Video } from '../videos/entities/video.entity';
import { VideoStatus } from '../videos/video-status.enum';
import { FfmpegService } from './ffmpeg.service';
import { VideoProcessingService } from './video-processing.service';

describe('VideoProcessingService (integration)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let service: VideoProcessingService;
  let storage: StorageService;
  let videoRepository: Repository<Video>;
  let channel: Channel;
  let dir: string;
  let sample: Buffer;

  beforeAll(async () => {
    module = await createVideosTestingModule([
      FfmpegService,
      VideoProcessingService,
    ]);
    dataSource = module.get(DataSource);
    service = module.get(VideoProcessingService);
    storage = module.get(StorageService);
    videoRepository = dataSource.getRepository(Video);
    dir = mkdtempSync(join(tmpdir(), 'processing-spec-'));
    const path = join(dir, 'sample.mp4');
    await generateTestVideo(path, { durationSeconds: 3 });
    sample = readFileSync(path);
  });

  afterAll(async () => {
    await cleanVideoStorage(dataSource, storage);
    await cleanAllTables(dataSource);
    await module.close();
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await cleanVideoStorage(dataSource, storage);
    await cleanAllTables(dataSource);
    channel = await createTestChannel(dataSource);
  });

  async function processingVideo(body: Buffer): Promise<Video> {
    const video = await videoRepository.save(
      buildVideo(channel.id, {
        status: VideoStatus.PROCESSING,
        file_size_bytes: body.length,
      }),
    );
    await storage.putObject(video.storage_key, body, 'video/mp4');
    return video;
  }

  it('should mark the video ready with duration, metadata and a stored thumbnail', async () => {
    const video = await processingVideo(sample);

    await service.process(video.id);

    const processed = await videoRepository.findOneByOrFail({ id: video.id });
    expect(processed.status).toBe(VideoStatus.READY);
    expect(processed.duration_seconds).toBeGreaterThanOrEqual(2.9);
    expect(processed.duration_seconds).toBeLessThanOrEqual(3.1);
    expect(processed.metadata).toMatchObject({
      width: 320,
      height: 240,
      video_codec: 'h264',
      audio_codec: 'aac',
    });
    expect(processed.processed_at).toBeInstanceOf(Date);
    expect(processed.processing_error).toBeNull();
    expect(processed.thumbnail_key).toBe(`videos/${video.id}/thumbnail.jpg`);
    await expect(
      storage.headObject(processed.thumbnail_key!),
    ).resolves.toMatchObject({ contentType: 'image/jpeg' });
  });

  it('should leave an already ready video untouched when processed again', async () => {
    const video = await processingVideo(sample);
    await service.process(video.id);
    const first = await videoRepository.findOneByOrFail({ id: video.id });

    await service.process(video.id);

    const second = await videoRepository.findOneByOrFail({ id: video.id });
    expect(second.updated_at).toEqual(first.updated_at);
    expect(second.processed_at).toEqual(first.processed_at);
  });

  it('should reject bytes that are not a video', async () => {
    const video = await processingVideo(Buffer.from('this is not a video'));

    await expect(service.process(video.id)).rejects.toThrow(
      'Source file is not a decodable video',
    );
  });
});
