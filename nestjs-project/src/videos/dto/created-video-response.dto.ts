import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../video-status.enum';

export class UploadSessionDto {
  @ApiProperty({ example: 67108864, description: 'Part size in bytes' })
  part_size: number;

  @ApiProperty({ example: 160, description: 'Number of parts to upload' })
  part_count: number;

  @ApiProperty({ format: 'date-time', description: 'When the draft expires' })
  expires_at: string;
}

export class CreatedVideoResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'dQw4w9WgXcQ', description: 'Unique video slug' })
  slug: string;

  @ApiProperty({ example: 'my-video' })
  title: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.DRAFT })
  status: VideoStatus;

  @ApiProperty({ type: UploadSessionDto })
  upload: UploadSessionDto;
}
