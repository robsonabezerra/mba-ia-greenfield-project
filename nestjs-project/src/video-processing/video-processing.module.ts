import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StorageModule } from '../storage/storage.module';
import { Video } from '../videos/entities/video.entity';
import { VideoDraftsService } from '../videos/video-drafts.service';
import { ExpiredUploadsSweeperService } from './expired-uploads-sweeper.service';
import { FfmpegService } from './ffmpeg.service';
import { VideoProcessingService } from './video-processing.service';

@Module({
  imports: [TypeOrmModule.forFeature([Video]), StorageModule],
  providers: [
    FfmpegService,
    VideoProcessingService,
    VideoDraftsService,
    ExpiredUploadsSweeperService,
  ],
  exports: [VideoProcessingService, ExpiredUploadsSweeperService],
})
export class VideoProcessingModule {}
