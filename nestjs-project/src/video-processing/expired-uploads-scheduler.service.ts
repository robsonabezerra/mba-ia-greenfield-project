import { InjectQueue } from '@nestjs/bullmq';
import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Queue } from 'bullmq';
import videosConfig from '../config/videos.config';
import { VIDEO_JOBS, VIDEO_PROCESSING_QUEUE } from '../videos/videos.constants';
import { EXPIRED_UPLOADS_SCHEDULER_ID } from './video-processing.constants';

/** Registers (idempotently) the recurring sweep job when the worker boots. */
@Injectable()
export class ExpiredUploadsSchedulerService implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE) private readonly queue: Queue,
    @Inject(videosConfig.KEY)
    private readonly config: ConfigType<typeof videosConfig>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      EXPIRED_UPLOADS_SCHEDULER_ID,
      { every: this.config.uploadSweepIntervalMinutes * 60 * 1000 },
      {
        name: VIDEO_JOBS.SWEEP_EXPIRED_UPLOADS,
        data: {},
        opts: { removeOnComplete: true, removeOnFail: 100 },
      },
    );
  }
}
