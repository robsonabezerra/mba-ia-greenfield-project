import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import videosConfig from '../config/videos.config';
import { Video } from '../videos/entities/video.entity';
import { VideoDraftsService } from '../videos/video-drafts.service';
import { VideoStatus } from '../videos/video-status.enum';

const HOUR_MS = 60 * 60 * 1000;

/** Removes drafts whose upload expired (orphan parts + draft row), per TD-17. */
@Injectable()
export class ExpiredUploadsSweeperService {
  private readonly logger = new Logger(ExpiredUploadsSweeperService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly draftsService: VideoDraftsService,
    @Inject(videosConfig.KEY)
    private readonly config: ConfigType<typeof videosConfig>,
  ) {}

  /** Returns how many expired drafts were discarded. */
  async sweep(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(
      now.getTime() - this.config.uploadExpirationHours * HOUR_MS,
    );
    const expired = await this.videoRepository.find({
      where: { status: VideoStatus.DRAFT, created_at: LessThan(cutoff) },
    });

    let discarded = 0;
    for (const video of expired) {
      try {
        await this.draftsService.discard(video);
        discarded++;
      } catch (err) {
        // Background job: one broken draft must not stop the sweep; it is
        // retried on the next run.
        this.logger.error(
          `Could not discard expired draft ${video.id}: ${(err as Error).message}`,
        );
      }
    }
    if (discarded > 0) {
      this.logger.log(`Discarded ${discarded} expired draft(s)`);
    }
    return discarded;
  }
}
