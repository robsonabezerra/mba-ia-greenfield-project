import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { UnrecoverableError } from 'bullmq';
import { Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { Video } from '../videos/entities/video.entity';
import { VideoStatus } from '../videos/video-status.enum';
import { videoThumbnailKey } from '../videos/video-storage-keys';
import { FfmpegExecutionError, FfmpegService } from './ffmpeg.service';
import { parseProbeOutput, type ParsedProbe } from './probe-parser';
import {
  PROCESSING_ERROR_MAX_LENGTH,
  SOURCE_URL_EXPIRES_IN_SECONDS,
  THUMBNAIL_CONTENT_TYPE,
  THUMBNAIL_POSITION_RATIO,
} from './video-processing.constants';

/** ffprobe messages meaning the bytes are not decodable media — retrying cannot help. */
const NOT_MEDIA_PATTERN =
  /Invalid data found when processing input|could not find codec parameters|moov atom not found/i;

/** Frame position for the thumbnail: 10% of the duration, 0 for short or unknown durations. */
export function thumbnailTimestamp(durationSeconds: number | null): number {
  if (durationSeconds === null || durationSeconds <= 1) return 0;
  return Number((durationSeconds * THUMBNAIL_POSITION_RATIO).toFixed(3));
}

@Injectable()
export class VideoProcessingService {
  private readonly logger = new Logger(VideoProcessingService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly ffmpegService: FfmpegService,
  ) {}

  /** Extracts metadata + thumbnail and marks the video ready. Idempotent. */
  async process(videoId: string): Promise<void> {
    const video = await this.videoRepository.findOneBy({ id: videoId });
    if (!video || video.status !== VideoStatus.PROCESSING) {
      this.logger.log(`Skipping ${videoId}: not in processing state`);
      return;
    }

    const sourceUrl = await this.storageService.presignInternalGetObject(
      video.storage_key,
      SOURCE_URL_EXPIRES_IN_SECONDS,
    );
    const probe = await this.probe(sourceUrl);
    if (!probe.hasVideoStream) {
      throw new UnrecoverableError('Source file has no video stream');
    }

    const thumbnailKey = videoThumbnailKey(video.id);
    await this.generateThumbnail(
      sourceUrl,
      probe.durationSeconds,
      thumbnailKey,
    );

    await this.videoRepository.update(
      { id: video.id, status: VideoStatus.PROCESSING },
      {
        status: VideoStatus.READY,
        duration_seconds: probe.durationSeconds,
        metadata: probe.metadata,
        thumbnail_key: thumbnailKey,
        processed_at: new Date(),
        processing_error: null,
      },
    );
  }

  /** Terminal failure: only a video still in processing is moved to failed. */
  async markFailed(videoId: string, message: string): Promise<void> {
    await this.videoRepository.update(
      { id: videoId, status: VideoStatus.PROCESSING },
      {
        status: VideoStatus.FAILED,
        processing_error: message.slice(0, PROCESSING_ERROR_MAX_LENGTH),
      },
    );
  }

  private async probe(sourceUrl: string): Promise<ParsedProbe> {
    try {
      return parseProbeOutput(await this.ffmpegService.probe(sourceUrl));
    } catch (err) {
      if (
        err instanceof FfmpegExecutionError &&
        NOT_MEDIA_PATTERN.test(err.stderr)
      ) {
        throw new UnrecoverableError('Source file is not a decodable video');
      }
      throw err;
    }
  }

  private async generateThumbnail(
    sourceUrl: string,
    durationSeconds: number | null,
    thumbnailKey: string,
  ): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'video-thumbnail-'));
    try {
      const output = join(dir, 'thumbnail.jpg');
      await this.ffmpegService.extractFrame(
        sourceUrl,
        thumbnailTimestamp(durationSeconds),
        output,
      );
      await this.storageService.putObject(
        thumbnailKey,
        await readFile(output),
        THUMBNAIL_CONTENT_TYPE,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
