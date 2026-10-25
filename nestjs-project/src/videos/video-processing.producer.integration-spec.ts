import { randomUUID } from 'crypto';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import videosConfig from '../config/videos.config';
import { QueueModule } from '../queue/queue.module';
import { VideoProcessingProducer } from './video-processing.producer';
import { VIDEO_JOBS, VIDEO_PROCESSING_QUEUE } from './videos.constants';

describe('VideoProcessingProducer (integration)', () => {
  let module: TestingModule;
  let producer: VideoProcessingProducer;
  let queue: Queue;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [queueConfig, videosConfig],
        }),
        QueueModule,
        BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
      ],
      providers: [VideoProcessingProducer],
    }).compile();
    producer = module.get(VideoProcessingProducer);
    queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await module.close();
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
  });

  it('should enqueue process-video with jobId = videoId, retries and backoff', async () => {
    const videoId = randomUUID();

    await producer.enqueueProcessing(videoId);

    const job = await queue.getJob(videoId);
    expect(job).toBeDefined();
    expect(job!.name).toBe(VIDEO_JOBS.PROCESS);
    expect(job!.data).toEqual({ videoId });
    expect(job!.opts.attempts).toBe(3);
    expect(job!.opts.backoff).toEqual({ type: 'exponential', delay: 5000 });
  });

  it('should keep a single job when the same video is enqueued twice', async () => {
    const videoId = randomUUID();

    await producer.enqueueProcessing(videoId);
    await producer.enqueueProcessing(videoId);

    const counts = await queue.getJobCounts('waiting', 'delayed', 'active');
    expect(counts.waiting + counts.delayed + counts.active).toBe(1);
  });

  it('should namespace jobs under the configured QUEUE_PREFIX', async () => {
    const videoId = randomUUID();

    await producer.enqueueProcessing(videoId);

    const job = await queue.getJob(videoId);
    expect(job!.queueQualifiedName).toBe(
      `streamtube-test:${VIDEO_PROCESSING_QUEUE}`,
    );
  });
});
