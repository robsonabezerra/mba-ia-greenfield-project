import { randomBytes, randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';

let sequence = 0;

/** Persists a user + channel pair for tests that need a video owner. */
export async function createTestChannel(
  dataSource: DataSource,
): Promise<Channel> {
  const n = ++sequence;
  const user = await dataSource.getRepository(User).save({
    email: `video_owner_${n}_${Date.now()}@example.com`,
    password: 'hashed',
  });
  return dataSource.getRepository(Channel).save({
    name: `owner${n}`,
    nickname: `owner_${n}_${randomBytes(3).toString('hex')}`,
    user_id: user.id,
  });
}

/** Video row defaults matching a freshly pre-registered draft. */
export function buildVideo(
  channelId: string,
  overrides: Partial<Video> = {},
): Partial<Video> {
  const id = overrides.id ?? randomUUID();
  return {
    id,
    channel_id: channelId,
    slug: randomBytes(8).toString('base64url'),
    title: 'Test video',
    original_file_name: 'test-video.mp4',
    content_type: 'video/mp4',
    file_size_bytes: 1024,
    storage_key: `videos/${id}/source`,
    upload_id: null,
    upload_part_size: 5242880,
    upload_part_count: 1,
    ...overrides,
  };
}
