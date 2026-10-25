import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import videosConfig from '../config/videos.config';
import { QueueModule } from '../queue/queue.module';
import { VIDEO_JOBS, VIDEO_PROCESSING_QUEUE } from '../videos/videos.constants';
import { ExpiredUploadsSchedulerService } from './expired-uploads-scheduler.service';
import { EXPIRED_UPLOADS_SCHEDULER_ID } from './video-processing.constants';

describe('ExpiredUploadsSchedulerService (integration)', () => {
  let module: TestingModule;
  let queue: Queue;
  let scheduler: ExpiredUploadsSchedulerService;

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
      providers: [ExpiredUploadsSchedulerService],
    }).compile();
    queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    scheduler = module.get(ExpiredUploadsSchedulerService);
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await module.close();
  });

  it('should register a single sweeper scheduler on bootstrap, even when bootstrapped twice', async () => {
    await module.init();
    await scheduler.onApplicationBootstrap();

    const schedulers = await queue.getJobSchedulers();
    expect(schedulers).toHaveLength(1);
    expect(schedulers[0]).toMatchObject({
      key: EXPIRED_UPLOADS_SCHEDULER_ID,
      name: VIDEO_JOBS.SWEEP_EXPIRED_UPLOADS,
      every: 60 * 60 * 1000,
    });
  });
});
