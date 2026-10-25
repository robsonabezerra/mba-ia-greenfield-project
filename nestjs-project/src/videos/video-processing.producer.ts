import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Queue } from 'bullmq';
import videosConfig from '../config/videos.config';
import {
  VIDEO_JOBS,
  VIDEO_PROCESSING_BACKOFF_DELAY_MS,
  VIDEO_PROCESSING_QUEUE,
} from './videos.constants';
import type { ProcessVideoJobData } from './video-jobs.types';

@Injectable()
export class VideoProcessingProducer {
  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE) private readonly queue: Queue,
    @Inject(videosConfig.KEY)
    private readonly config: ConfigType<typeof videosConfig>,
  ) {}

  /**
   * Enqueues the processing job. `jobId = videoId` makes repeated calls
   * idempotent; jobs are kept after completion/failure so the id keeps
   * deduplicating (a removed job would let the same id be added again).
   */
  async enqueueProcessing(videoId: string): Promise<void> {
    const data: ProcessVideoJobData = { videoId };
    await this.queue.add(VIDEO_JOBS.PROCESS, data, {
      jobId: videoId,
      attempts: this.config.processingAttempts,
      backoff: {
        type: 'exponential',
        delay: VIDEO_PROCESSING_BACKOFF_DELAY_MS,
      },
      removeOnComplete: false,
      removeOnFail: false,
    });
  }
}
