import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { buildVideo, createTestChannel } from '../../test/video-factory';
import { User } from '../../users/entities/user.entity';
import { VideoStatus } from '../video-status.enum';
import type { VideoMetadata } from '../video-metadata.types';
import { Video } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channel: Channel;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    channel = await createTestChannel(dataSource);
  });

  it('should default status to draft', async () => {
    const saved = await videoRepository.save(buildVideo(channel.id));

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.status).toBe(VideoStatus.DRAFT);
  });

  it('should enforce a unique slug', async () => {
    await videoRepository.save(buildVideo(channel.id, { slug: 'AAAAAAAAAAA' }));

    await expect(
      videoRepository.save(buildVideo(channel.id, { slug: 'AAAAAAAAAAA' })),
    ).rejects.toThrow(QueryFailedError);
  });

  it('should reject a status outside the enum', async () => {
    const video = buildVideo(channel.id);

    await expect(
      dataSource.query(
        `INSERT INTO videos (id, channel_id, slug, title, status, original_file_name, content_type,
           file_size_bytes, storage_key, upload_part_size, upload_part_count)
         VALUES ($1, $2, $3, 't', 'published', 'f.mp4', 'video/mp4', 1, 'k', 5242880, 1)`,
        [video.id, channel.id, video.slug],
      ),
    ).rejects.toThrow(QueryFailedError);
  });

  it('should delete videos when their channel is deleted', async () => {
    const saved = await videoRepository.save(buildVideo(channel.id));

    await dataSource.getRepository(Channel).delete({ id: channel.id });

    await expect(
      videoRepository.findOneBy({ id: saved.id }),
    ).resolves.toBeNull();
  });

  it('should map bigint and numeric columns to numbers and round-trip jsonb metadata', async () => {
    const metadata: VideoMetadata = {
      width: 1920,
      height: 1080,
      video_codec: 'h264',
      audio_codec: null,
      bitrate: 5_000_000,
      format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
      size_bytes: 10737418240,
    };
    const saved = await videoRepository.save(
      buildVideo(channel.id, {
        file_size_bytes: 10737418240,
        duration_seconds: 123.456,
        metadata,
      }),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.file_size_bytes).toBe(10737418240);
    expect(found.duration_seconds).toBe(123.456);
    expect(found.metadata).toEqual(metadata);
  });

  it('should load the owning channel through the relation', async () => {
    const saved = await videoRepository.save(buildVideo(channel.id));

    const found = await videoRepository.findOneOrFail({
      where: { id: saved.id },
      relations: ['channel'],
    });
    expect(found.channel.id).toBe(channel.id);
  });
});
