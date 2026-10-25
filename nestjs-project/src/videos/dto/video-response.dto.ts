import { ApiProperty } from '@nestjs/swagger';
import { VideoStatus } from '../video-status.enum';

export class VideoMetadataDto {
  @ApiProperty({ example: 1920 })
  width: number;

  @ApiProperty({ example: 1080 })
  height: number;

  @ApiProperty({ example: 'h264' })
  video_codec: string;

  @ApiProperty({ example: 'aac', nullable: true, type: String })
  audio_codec: string | null;

  @ApiProperty({ example: 5000000, nullable: true, type: Number })
  bitrate: number | null;

  @ApiProperty({ example: 'mov,mp4,m4a,3gp,3g2,mj2' })
  format_name: string;

  @ApiProperty({ example: 104857600 })
  size_bytes: number;
}

export class VideoChannelDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'alice' })
  nickname: string;

  @ApiProperty({ example: 'alice' })
  name: string;
}

export class VideoResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'dQw4w9WgXcQ' })
  slug: string;

  @ApiProperty({ example: 'My video' })
  title: string;

  @ApiProperty({ enum: VideoStatus })
  status: VideoStatus;

  @ApiProperty({ example: 212.48, nullable: true, type: Number })
  duration_seconds: number | null;

  @ApiProperty({ type: VideoMetadataDto, nullable: true })
  metadata: VideoMetadataDto | null;

  @ApiProperty({ nullable: true, type: String })
  processing_error: string | null;

  @ApiProperty({ type: VideoChannelDto })
  channel: VideoChannelDto;

  @ApiProperty({
    example: '/videos/dQw4w9WgXcQ/stream',
    nullable: true,
    type: String,
  })
  stream_url: string | null;

  @ApiProperty({
    example: '/videos/dQw4w9WgXcQ/download',
    nullable: true,
    type: String,
  })
  download_url: string | null;

  @ApiProperty({
    example: '/videos/dQw4w9WgXcQ/thumbnail',
    nullable: true,
    type: String,
  })
  thumbnail_url: string | null;

  @ApiProperty({ format: 'date-time' })
  created_at: string;

  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  processed_at: string | null;
}
