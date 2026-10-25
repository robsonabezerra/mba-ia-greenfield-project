import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { S3ServiceException } from '@aws-sdk/client-s3';
import { Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { Video } from './entities/video.entity';

const NO_SUCH_UPLOAD = 'NoSuchUpload';

/** Releases everything a draft holds: open multipart, stored bytes and the row. */
@Injectable()
export class VideoDraftsService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
  ) {}

  async discard(video: Video): Promise<void> {
    if (video.upload_id) {
      try {
        await this.storageService.abortMultipartUpload(
          video.storage_key,
          video.upload_id,
        );
      } catch (err) {
        // Already aborted (or completed): nothing left to release.
        if (
          !(err instanceof S3ServiceException && err.name === NO_SUCH_UPLOAD)
        ) {
          throw err;
        }
      }
    }
    if (await this.storageService.headObject(video.storage_key)) {
      await this.storageService.deleteObject(video.storage_key);
    }
    await this.videoRepository.delete({ id: video.id });
  }
}
