import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Job, UnrecoverableError } from 'bullmq';
import videosConfig from '../config/videos.config';
import type { ProcessVideoJobData } from '../videos/video-jobs.types';
import { VIDEO_JOBS, VIDEO_PROCESSING_QUEUE } from '../videos/videos.constants';
import { VideoProcessingService } from './video-processing.service';

@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessor
  extends WorkerHost
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(
    private readonly processingService: VideoProcessingService,
    @Inject(videosConfig.KEY)
    private readonly config: ConfigType<typeof videosConfig>,
  ) {
    super();
  }

  onApplicationBootstrap(): void {
    // Decorator options are evaluated at import time, before .env is loaded.
    this.worker.concurrency = this.config.workerConcurrency;
  }

  async process(job: Job): Promise<void> {
    switch (job.name) {
      case VIDEO_JOBS.PROCESS:
        await this.processingService.process(
          (job.data as ProcessVideoJobData).videoId,
        );
        return;
      default:
        throw new UnrecoverableError(`Unknown job name: ${job.name}`);
    }
  }

  /** Background context: failures are recorded and logged, never rethrown. */
  @OnWorkerEvent('failed')
  async onFailed(job: Job | undefined, error: Error): Promise<void> {
    if (!job || job.name !== VIDEO_JOBS.PROCESS) return;
    const isFinal =
      error instanceof UnrecoverableError ||
      error.name === 'UnrecoverableError' ||
      job.attemptsMade >= (job.opts.attempts ?? 1);
    const { videoId } = job.data as ProcessVideoJobData;
    if (!isFinal) {
      this.logger.warn(
        `Processing ${videoId} failed (attempt ${job.attemptsMade}); will retry: ${error.message}`,
      );
      return;
    }
    try {
      await this.processingService.markFailed(videoId, error.message);
      this.logger.error(
        `Processing ${videoId} failed permanently: ${error.message}`,
      );
    } catch (markError) {
      this.logger.error(
        `Could not mark ${videoId} as failed: ${(markError as Error).message}`,
      );
    }
  }
}
