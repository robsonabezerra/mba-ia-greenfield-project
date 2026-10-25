import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import type { Channel } from '../channels/entities/channel.entity';
import {
  ChannelNotFoundException,
  InvalidUploadPartException,
  ProcessingQueueUnavailableException,
  UploadIncompleteException,
  UploadSizeMismatchException,
  VideoFileTooLargeException,
  VideoNotFoundException,
  VideoNotOwnedException,
  VideoNotUploadableException,
} from '../common/exceptions/domain.exception';
import videosConfig from '../config/videos.config';
import { StorageService } from '../storage/storage.service';
import { Video } from './entities/video.entity';
import { VideoProcessingProducer } from './video-processing.producer';
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
  let producer: jest.Mocked<VideoProcessingProducer>;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        {
          provide: getRepositoryToken(Video),
          useValue: {
            create: jest.fn((data: Partial<Video>) => ({ ...data }) as Video),
            findOne: jest.fn(),
            findOneByOrFail: jest.fn(),
            update: jest.fn().mockResolvedValue({ affected: 1 }),
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
            presignUploadPart: jest.fn(
              (_key: string, _upload: string, part: number) =>
                Promise.resolve(`https://storage/part-${part}`),
            ),
            listParts: jest.fn().mockResolvedValue([]),
            completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
            headObject: jest.fn(),
            deleteObject: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: VideoProcessingProducer,
          useValue: {
            enqueueProcessing: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: videosConfig.KEY, useValue: config },
      ],
    }).compile();

    service = module.get(VideosService);
    videoRepository = module.get(getRepositoryToken(Video));
    channelsService = module.get(ChannelsService);
    storageService = module.get(StorageService);
    producer = module.get(VideoProcessingProducer);
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

  function draftVideo(overrides: Partial<Video> = {}): Video {
    return {
      id: 'video-1',
      slug: 'abcdefghijk',
      status: VideoStatus.DRAFT,
      storage_key: 'videos/video-1/source',
      upload_id: 'upload-1',
      upload_part_size: 67108864,
      upload_part_count: 3,
      created_at: new Date(),
      channel: { user_id: 'user-1' } as Channel,
      ...overrides,
    } as Video;
  }

  describe('signUploadParts', () => {
    it('should sign the requested parts in ascending order', async () => {
      videoRepository.findOne.mockResolvedValue(draftVideo());

      const result = await service.signUploadParts('user-1', 'abcdefghijk', {
        part_numbers: [3, 1],
      });

      expect(result.parts).toEqual([
        { part_number: 1, url: 'https://storage/part-1' },
        { part_number: 3, url: 'https://storage/part-3' },
      ]);
    });

    it('should cap URL expiration at the draft expiration', async () => {
      const createdAt = new Date(Date.now() - 23.75 * 60 * 60 * 1000);
      videoRepository.findOne.mockResolvedValue(
        draftVideo({ created_at: createdAt }),
      );

      const result = await service.signUploadParts('user-1', 'abcdefghijk', {
        part_numbers: [1],
      });

      const draftExpiry = createdAt.getTime() + 24 * 60 * 60 * 1000;
      expect(new Date(result.expires_at).getTime()).toBe(draftExpiry);
      const expiresIn = storageService.presignUploadPart.mock.calls[0][3];
      expect(expiresIn).toBeLessThanOrEqual(15 * 60);
    });

    it('should reject a part number above the part count', async () => {
      videoRepository.findOne.mockResolvedValue(draftVideo());

      await expect(
        service.signUploadParts('user-1', 'abcdefghijk', { part_numbers: [4] }),
      ).rejects.toThrow(InvalidUploadPartException);
    });

    it('should reject an unknown slug', async () => {
      videoRepository.findOne.mockResolvedValue(null);

      await expect(
        service.signUploadParts('user-1', 'missing', { part_numbers: [1] }),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it("should reject another channel's video", async () => {
      videoRepository.findOne.mockResolvedValue(draftVideo());

      await expect(
        service.signUploadParts('user-2', 'abcdefghijk', { part_numbers: [1] }),
      ).rejects.toThrow(VideoNotOwnedException);
    });

    it('should reject a video that is no longer a draft', async () => {
      videoRepository.findOne.mockResolvedValue(
        draftVideo({ status: VideoStatus.PROCESSING, upload_id: null }),
      );

      await expect(
        service.signUploadParts('user-1', 'abcdefghijk', { part_numbers: [1] }),
      ).rejects.toThrow(VideoNotUploadableException);
    });
  });

  describe('getUploadState', () => {
    it('should map stored parts to the upload state', async () => {
      videoRepository.findOne.mockResolvedValue(draftVideo());
      storageService.listParts.mockResolvedValue([
        { partNumber: 1, size: 67108864, etag: '"a"' },
      ]);

      const result = await service.getUploadState('user-1', 'abcdefghijk');

      expect(result).toMatchObject({
        part_size: 67108864,
        part_count: 3,
        uploaded_parts: [{ part_number: 1, size: 67108864 }],
      });
    });
  });

  describe('completeUpload', () => {
    const FILE_SIZE = 2 * 1024;
    const uploading = (overrides: Partial<Video> = {}) =>
      draftVideo({
        file_size_bytes: FILE_SIZE,
        upload_part_count: 2,
        ...overrides,
      });
    const parts = [
      { partNumber: 1, size: 1024, etag: '"1"' },
      { partNumber: 2, size: 1024, etag: '"2"' },
    ];

    it('should complete the multipart, mark processing and enqueue the job', async () => {
      videoRepository.findOne.mockResolvedValue(uploading());
      storageService.listParts.mockResolvedValue(parts);
      storageService.headObject.mockResolvedValue({
        contentLength: FILE_SIZE,
        contentType: 'video/mp4',
      });

      const result = await service.completeUpload('user-1', 'abcdefghijk');

      expect(result.status).toBe(VideoStatus.PROCESSING);
      expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
        'videos/video-1/source',
        'upload-1',
        parts,
      );
      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: 'video-1', status: VideoStatus.DRAFT },
        { status: VideoStatus.PROCESSING },
      );
      expect(producer.enqueueProcessing).toHaveBeenCalledWith('video-1');
    });

    it('should reject when a part is missing and keep the upload open', async () => {
      videoRepository.findOne.mockResolvedValue(uploading());
      storageService.listParts.mockResolvedValue([parts[0]]);

      await expect(
        service.completeUpload('user-1', 'abcdefghijk'),
      ).rejects.toThrow(UploadIncompleteException);
      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
      expect(videoRepository.update).not.toHaveBeenCalled();
    });

    it('should reject when the uploaded parts do not add up to the declared size', async () => {
      videoRepository.findOne.mockResolvedValue(uploading());
      storageService.listParts.mockResolvedValue([
        parts[0],
        { ...parts[1], size: 10 },
      ]);

      await expect(
        service.completeUpload('user-1', 'abcdefghijk'),
      ).rejects.toThrow(UploadSizeMismatchException);
      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
    });

    it('should delete the object and fail the video when the final object size differs', async () => {
      videoRepository.findOne.mockResolvedValue(uploading({ upload_id: null }));
      storageService.headObject.mockResolvedValue({
        contentLength: 1,
        contentType: 'video/mp4',
      });

      await expect(
        service.completeUpload('user-1', 'abcdefghijk'),
      ).rejects.toThrow(UploadSizeMismatchException);
      expect(storageService.deleteObject).toHaveBeenCalledWith(
        'videos/video-1/source',
      );
      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: 'video-1', status: VideoStatus.DRAFT },
        {
          status: VideoStatus.FAILED,
          processing_error: 'UPLOAD_SIZE_MISMATCH',
        },
      );
    });

    it('should be idempotent while the video is already processing', async () => {
      videoRepository.findOne.mockResolvedValue(
        uploading({ status: VideoStatus.PROCESSING, upload_id: null }),
      );

      const result = await service.completeUpload('user-1', 'abcdefghijk');

      expect(result.status).toBe(VideoStatus.PROCESSING);
      expect(producer.enqueueProcessing).not.toHaveBeenCalled();
    });

    it('should revert to draft and report 503 when the queue is unavailable', async () => {
      videoRepository.findOne.mockResolvedValue(uploading({ upload_id: null }));
      storageService.headObject.mockResolvedValue({
        contentLength: FILE_SIZE,
        contentType: 'video/mp4',
      });
      producer.enqueueProcessing.mockRejectedValue(new Error('redis down'));

      await expect(
        service.completeUpload('user-1', 'abcdefghijk'),
      ).rejects.toThrow(ProcessingQueueUnavailableException);
      expect(videoRepository.update).toHaveBeenLastCalledWith(
        { id: 'video-1', status: VideoStatus.PROCESSING },
        { status: VideoStatus.DRAFT },
      );
    });

    it('should reject a video that is already ready', async () => {
      videoRepository.findOne.mockResolvedValue(
        uploading({ status: VideoStatus.READY, upload_id: null }),
      );

      await expect(
        service.completeUpload('user-1', 'abcdefghijk'),
      ).rejects.toThrow(VideoNotUploadableException);
    });
  });
});
