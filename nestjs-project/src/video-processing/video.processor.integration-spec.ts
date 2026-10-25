import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { StorageService } from '../storage/storage.service';
import { cleanAllTables } from '../test/create-test-data-source';
import { buildVideo, createTestChannel } from '../test/video-factory';
import { generateTestVideo } from '../test/video-fixtures';
import { cleanVideoStorage } from '../test/videos-test-module';
import { Video } from '../videos/entities/video.entity';
import { VideoStatus } from '../videos/video-status.enum';
import { VIDEO_JOBS, VIDEO_PROCESSING_QUEUE } from '../videos/videos.constants';
import { WorkerModule } from '../worker.module';

async function waitForStatus(
  repo: Repository<Video>,
  id: string,
  statuses: VideoStatus[],
  timeoutMs = 30000,
): Promise<Video> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const video = await repo.findOneByOrFail({ id });
    if (statuses.includes(video.status)) return video;
    if (Date.now() > deadline) {
      throw new Error(`Video ${id} stayed ${video.status}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe('VideoProcessor (integration, worker in-process)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let storage: StorageService;
  let queue: Queue;
  let videoRepository: Repository<Video>;
  let channel: Channel;
  let dir: string;
  let sample: Buffer;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    await module.init();
    dataSource = module.get(DataSource);
    storage = module.get(StorageService);
    queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    videoRepository = dataSource.getRepository(Video);
    dir = mkdtempSync(join(tmpdir(), 'processor-spec-'));
    const path = join(dir, 'sample.mp4');
    await generateTestVideo(path, { durationSeconds: 2 });
    sample = readFileSync(path);
  }, 60000);

  afterAll(async () => {
    await cleanVideoStorage(dataSource, storage);
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
    await module.close();
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await cleanVideoStorage(dataSource, storage);
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
    channel = await createTestChannel(dataSource);
  });

  async function enqueue(body: Buffer): Promise<Video> {
    const video = await videoRepository.save(
      buildVideo(channel.id, {
        status: VideoStatus.PROCESSING,
        file_size_bytes: body.length,
      }),
    );
    await storage.putObject(video.storage_key, body, 'video/mp4');
    await queue.add(
      VIDEO_JOBS.PROCESS,
      { videoId: video.id },
      { jobId: video.id, attempts: 3, backoff: { type: 'fixed', delay: 200 } },
    );
    return video;
  }

  it('should consume process-video and mark the video ready', async () => {
    const video = await enqueue(sample);

    const processed = await waitForStatus(videoRepository, video.id, [
      VideoStatus.READY,
      VideoStatus.FAILED,
    ]);

    expect(processed.status).toBe(VideoStatus.READY);
    expect(processed.thumbnail_key).toBe(`videos/${video.id}/thumbnail.jpg`);
  }, 40000);

  it('should mark a non-video upload failed after a single attempt', async () => {
    const video = await enqueue(Buffer.from('not a video at all'));

    const failed = await waitForStatus(videoRepository, video.id, [
      VideoStatus.READY,
      VideoStatus.FAILED,
    ]);

    expect(failed.status).toBe(VideoStatus.FAILED);
    expect(failed.processing_error).toBe(
      'Source file is not a decodable video',
    );
    const job = await queue.getJob(video.id);
    expect(await job!.getState()).toBe('failed');
    expect(job!.attemptsMade).toBe(1);
  }, 40000);
});
