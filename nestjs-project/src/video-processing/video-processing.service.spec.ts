import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { UnrecoverableError } from 'bullmq';
import { Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { Video } from '../videos/entities/video.entity';
import { VideoStatus } from '../videos/video-status.enum';
import { FfmpegExecutionError, FfmpegService } from './ffmpeg.service';
import {
  thumbnailTimestamp,
  VideoProcessingService,
} from './video-processing.service';

describe('VideoProcessingService', () => {
  let service: VideoProcessingService;
  let videoRepository: jest.Mocked<Repository<Video>>;
  let ffmpeg: jest.Mocked<FfmpegService>;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        VideoProcessingService,
        {
          provide: getRepositoryToken(Video),
          useValue: {
            findOneBy: jest.fn(),
            update: jest.fn().mockResolvedValue({ affected: 1 }),
          },
        },
        {
          provide: StorageService,
          useValue: {
            presignInternalGetObject: jest
              .fn()
              .mockResolvedValue('http://minio:9000/source'),
            putObject: jest.fn(),
          },
        },
        {
          provide: FfmpegService,
          useValue: { probe: jest.fn(), extractFrame: jest.fn() },
        },
      ],
    }).compile();

    service = module.get(VideoProcessingService);
    videoRepository = module.get(getRepositoryToken(Video));
    ffmpeg = module.get(FfmpegService);
  });

  describe('process', () => {
    it('should skip a video that is not processing', async () => {
      videoRepository.findOneBy.mockResolvedValue({
        id: 'v1',
        status: VideoStatus.READY,
      } as Video);

      await service.process('v1');

      expect(ffmpeg.probe).not.toHaveBeenCalled();
      expect(videoRepository.update).not.toHaveBeenCalled();
    });

    it('should skip a video that no longer exists', async () => {
      videoRepository.findOneBy.mockResolvedValue(null);

      await expect(service.process('gone')).resolves.toBeUndefined();
    });

    it('should fail without retry when the source has no video stream', async () => {
      videoRepository.findOneBy.mockResolvedValue({
        id: 'v1',
        status: VideoStatus.PROCESSING,
        storage_key: 'videos/v1/source',
      } as Video);
      ffmpeg.probe.mockResolvedValue({
        streams: [{ codec_type: 'audio', codec_name: 'aac' }],
      });

      await expect(service.process('v1')).rejects.toThrow(UnrecoverableError);
      expect(ffmpeg.extractFrame).not.toHaveBeenCalled();
    });

    it('should fail without retry when ffprobe reports invalid data', async () => {
      videoRepository.findOneBy.mockResolvedValue({
        id: 'v1',
        status: VideoStatus.PROCESSING,
        storage_key: 'videos/v1/source',
      } as Video);
      ffmpeg.probe.mockRejectedValue(
        new FfmpegExecutionError(
          'ffprobe',
          'http://minio:9000/source: Invalid data found when processing input',
          'exited with code 1',
        ),
      );

      await expect(service.process('v1')).rejects.toThrow(UnrecoverableError);
    });

    it('should let transient ffprobe errors propagate for a retry', async () => {
      videoRepository.findOneBy.mockResolvedValue({
        id: 'v1',
        status: VideoStatus.PROCESSING,
        storage_key: 'videos/v1/source',
      } as Video);
      const transient = new FfmpegExecutionError(
        'ffprobe',
        'Connection refused',
        'exited with code 1',
      );
      ffmpeg.probe.mockRejectedValue(transient);

      await expect(service.process('v1')).rejects.toBe(transient);
    });
  });

  describe('thumbnailTimestamp', () => {
    it('should pick 10% of the duration', () => {
      expect(thumbnailTimestamp(120)).toBe(12);
    });

    it('should pick the first frame for short or unknown durations', () => {
      expect(thumbnailTimestamp(1)).toBe(0);
      expect(thumbnailTimestamp(0.4)).toBe(0);
      expect(thumbnailTimestamp(null)).toBe(0);
    });
  });

  describe('markFailed', () => {
    it('should store a failure reason truncated to 500 characters', async () => {
      await service.markFailed('v1', 'x'.repeat(800));

      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: 'v1', status: VideoStatus.PROCESSING },
        { status: VideoStatus.FAILED, processing_error: 'x'.repeat(500) },
      );
    });
  });
});
