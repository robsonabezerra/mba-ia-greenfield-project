import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import type { Channel } from '../channels/entities/channel.entity';
import {
  ChannelNotFoundException,
  VideoFileTooLargeException,
} from '../common/exceptions/domain.exception';
import videosConfig from '../config/videos.config';
import { StorageService } from '../storage/storage.service';
import { Video } from './entities/video.entity';
import { VideoStatus } from './video-status.enum';
import { VideosService } from './videos.service';

const config = {
  maxSizeBytes: 10737418240,
  uploadPartSizeBytes: 67108864,
  uploadExpirationHours: 24,
  presignedUrlExpiresInSeconds: 3600,
  processingAttempts: 3,
  uploadSweepIntervalMinutes: 60,
  workerConcurrency: 1,
};

const channel = { id: 'channel-1', user_id: 'user-1' } as Channel;

function slugViolation(): QueryFailedError {
  return new QueryFailedError(
    'INSERT',
    [],
    Object.assign(new Error(), {
      code: '23505',
      detail: 'Key (slug)=(abc) already exists.',
    }),
  );
}

describe('VideosService', () => {
  let service: VideosService;
  let videoRepository: jest.Mocked<Repository<Video>>;
  let channelsService: jest.Mocked<ChannelsService>;
  let storageService: jest.Mocked<StorageService>;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        {
          provide: getRepositoryToken(Video),
          useValue: {
            create: jest.fn((data: Partial<Video>) => ({ ...data }) as Video),
            save: jest.fn((video: Video) =>
              Promise.resolve({
                ...video,
                status: VideoStatus.DRAFT,
                created_at: new Date('2026-01-01T00:00:00.000Z'),
              } as Video),
            ),
          },
        },
        {
          provide: ChannelsService,
          useValue: { findByUserId: jest.fn().mockResolvedValue(channel) },
        },
        {
          provide: StorageService,
          useValue: {
            createMultipartUpload: jest.fn().mockResolvedValue('upload-1'),
            abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: videosConfig.KEY, useValue: config },
      ],
    }).compile();

    service = module.get(VideosService);
    videoRepository = module.get(getRepositoryToken(Video));
    channelsService = module.get(ChannelsService);
    storageService = module.get(StorageService);
  });

  describe('initiateUpload', () => {
    const dto = {
      file_name: 'aula.mp4',
      file_size: 104857600,
      content_type: 'video/mp4',
    };

    it('should create a draft with the file name as default title and the part plan', async () => {
      const result = await service.initiateUpload('user-1', dto);

      expect(result).toMatchObject({
        title: 'aula',
        status: VideoStatus.DRAFT,
        upload: {
          part_size: 67108864,
          part_count: 2,
          expires_at: '2026-01-02T00:00:00.000Z',
        },
      });
      expect(result.slug).toMatch(/^[A-Za-z0-9_-]{11}$/);
      expect(storageService.createMultipartUpload).toHaveBeenCalledWith(
        `videos/${result.id}/source`,
        'video/mp4',
      );
    });

    it('should keep an explicit title', async () => {
      const result = await service.initiateUpload('user-1', {
        ...dto,
        title: 'Minha aula',
      });

      expect(result.title).toBe('Minha aula');
    });

    it('should reject files above VIDEO_MAX_SIZE_BYTES without touching storage', async () => {
      await expect(
        service.initiateUpload('user-1', {
          ...dto,
          file_size: config.maxSizeBytes + 1,
        }),
      ).rejects.toThrow(VideoFileTooLargeException);
      expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('should reject a user without channel', async () => {
      channelsService.findByUserId.mockResolvedValue(null);

      await expect(service.initiateUpload('user-1', dto)).rejects.toThrow(
        ChannelNotFoundException,
      );
    });

    it('should retry with a new slug on a slug unique violation', async () => {
      const save = videoRepository.save.getMockImplementation()!;
      videoRepository.save
        .mockRejectedValueOnce(slugViolation())
        .mockImplementationOnce(save);

      await service.initiateUpload('user-1', dto);

      expect(videoRepository.save).toHaveBeenCalledTimes(2);
    });

    it('should abort the multipart upload when the draft cannot be saved', async () => {
      videoRepository.save.mockRejectedValue(new Error('db down'));

      await expect(service.initiateUpload('user-1', dto)).rejects.toThrow(
        'db down',
      );
      expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
        expect.stringMatching(/^videos\/.+\/source$/),
        'upload-1',
      );
    });
  });
});
