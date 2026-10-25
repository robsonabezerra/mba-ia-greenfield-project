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
  InvalidUploadPartException,
  VideoFileTooLargeException,
  VideoNotFoundException,
  VideoNotOwnedException,
  VideoNotUploadableException,
} from '../common/exceptions/domain.exception';
import videosConfig from '../config/videos.config';
import { StorageService } from '../storage/storage.service';
import type { CreateVideoDto } from './dto/create-video.dto';
import type { CreatedVideoResponseDto } from './dto/created-video-response.dto';
import type { SignUploadPartsDto } from './dto/sign-upload-parts.dto';
import type {
  SignedUploadPartsResponseDto,
  UploadStateResponseDto,
} from './dto/upload-parts-response.dto';
import { Video } from './entities/video.entity';
import { generateVideoSlug } from './slug.util';
import { VideoStatus } from './video-status.enum';
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

  /** Presigned PUT URLs for the requested parts of the owner's draft. */
  async signUploadParts(
    userId: string,
    slug: string,
    dto: SignUploadPartsDto,
  ): Promise<SignedUploadPartsResponseDto> {
    const video = await this.findOwnedDraft(userId, slug);
    const partNumbers = [...dto.part_numbers].sort((a, b) => a - b);
    if (partNumbers[partNumbers.length - 1] > video.upload_part_count) {
      throw new InvalidUploadPartException(video.upload_part_count);
    }

    // URLs never outlive the draft: the sweeper removes expired uploads.
    const now = Date.now();
    const expiresAt = Math.min(
      now + this.config.presignedUrlExpiresInSeconds * 1000,
      this.uploadExpiresAt(video).getTime(),
    );
    const expiresIn = Math.max(1, Math.floor((expiresAt - now) / 1000));

    const parts = await Promise.all(
      partNumbers.map(async (partNumber) => ({
        part_number: partNumber,
        url: await this.storageService.presignUploadPart(
          video.storage_key,
          video.upload_id!,
          partNumber,
          expiresIn,
        ),
      })),
    );
    return { parts, expires_at: new Date(expiresAt).toISOString() };
  }

  /** Parts already stored for the owner's draft — what a client resumes from. */
  async getUploadState(
    userId: string,
    slug: string,
  ): Promise<UploadStateResponseDto> {
    const video = await this.findOwnedDraft(userId, slug);
    const parts = await this.storageService.listParts(
      video.storage_key,
      video.upload_id!,
    );
    return {
      part_size: video.upload_part_size,
      part_count: video.upload_part_count,
      expires_at: this.uploadExpiresAt(video).toISOString(),
      uploaded_parts: parts.map((p) => ({
        part_number: p.partNumber,
        size: p.size,
      })),
    };
  }

  private async findOwnedVideo(userId: string, slug: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { slug },
      relations: ['channel'],
    });
    if (!video) throw new VideoNotFoundException();
    if (video.channel.user_id !== userId) throw new VideoNotOwnedException();
    return video;
  }

  /** Owner's video that still accepts upload operations (open multipart). */
  private async findOwnedDraft(userId: string, slug: string): Promise<Video> {
    const video = await this.findOwnedVideo(userId, slug);
    if (video.status !== VideoStatus.DRAFT || !video.upload_id) {
      throw new VideoNotUploadableException(video.status);
    }
    return video;
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
