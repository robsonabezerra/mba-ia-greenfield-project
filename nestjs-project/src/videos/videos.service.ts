import { randomUUID } from 'crypto';
import { parse } from 'path';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { isPgUniqueViolationOnColumn } from '../common/database/pg-errors';
import {
  ChannelNotFoundException,
  VideoFileTooLargeException,
} from '../common/exceptions/domain.exception';
import videosConfig from '../config/videos.config';
import { StorageService } from '../storage/storage.service';
import type { CreateVideoDto } from './dto/create-video.dto';
import type { CreatedVideoResponseDto } from './dto/created-video-response.dto';
import { Video } from './entities/video.entity';
import { generateVideoSlug } from './slug.util';
import { videoSourceKey } from './video-storage-keys';

const MAX_SLUG_ATTEMPTS = 5;
const SLUG_COLUMN = 'slug';
const HOUR_MS = 60 * 60 * 1000;

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    @Inject(videosConfig.KEY)
    private readonly config: ConfigType<typeof videosConfig>,
  ) {}

  /** Pre-registers the video as `draft` and opens the multipart upload. */
  async initiateUpload(
    userId: string,
    dto: CreateVideoDto,
  ): Promise<CreatedVideoResponseDto> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) throw new ChannelNotFoundException();
    if (dto.file_size > this.config.maxSizeBytes) {
      throw new VideoFileTooLargeException(this.config.maxSizeBytes);
    }

    const partSize = this.config.uploadPartSizeBytes;
    const id = randomUUID();
    const storageKey = videoSourceKey(id);
    const uploadId = await this.storageService.createMultipartUpload(
      storageKey,
      dto.content_type,
    );

    let video: Video;
    try {
      video = await this.saveWithUniqueSlug(
        this.videoRepository.create({
          id,
          channel_id: channel.id,
          title: dto.title ?? this.defaultTitle(dto.file_name),
          original_file_name: dto.file_name,
          content_type: dto.content_type,
          file_size_bytes: dto.file_size,
          storage_key: storageKey,
          upload_id: uploadId,
          upload_part_size: partSize,
          upload_part_count: Math.ceil(dto.file_size / partSize),
        }),
      );
    } catch (err) {
      // Compensation: do not leave an orphan multipart upload behind.
      await this.storageService.abortMultipartUpload(storageKey, uploadId);
      throw err;
    }

    return {
      id: video.id,
      slug: video.slug,
      title: video.title,
      status: video.status,
      upload: {
        part_size: video.upload_part_size,
        part_count: video.upload_part_count,
        expires_at: this.uploadExpiresAt(video).toISOString(),
      },
    };
  }

  private async saveWithUniqueSlug(video: Video): Promise<Video> {
    for (let attempt = 1; ; attempt++) {
      video.slug = generateVideoSlug();
      try {
        return await this.videoRepository.save(video);
      } catch (err) {
        if (
          !isPgUniqueViolationOnColumn(err, SLUG_COLUMN) ||
          attempt >= MAX_SLUG_ATTEMPTS
        ) {
          throw err;
        }
      }
    }
  }

  private defaultTitle(fileName: string): string {
    return parse(fileName).name || fileName;
  }

  private uploadExpiresAt(video: Video): Date {
    return new Date(
      video.created_at.getTime() + this.config.uploadExpirationHours * HOUR_MS,
    );
  }
}
