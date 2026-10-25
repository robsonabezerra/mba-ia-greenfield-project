import { randomBytes } from 'crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { buildVideo, createTestChannel } from '../src/test/video-factory';
import { cleanVideoStorage } from '../src/test/videos-test-module';
import { Video } from '../src/videos/entities/video.entity';
import { VideoStatus } from '../src/videos/video-status.enum';
import { createTestApp } from './helpers/create-test-app';
import { bodyOf, type ErrorBody } from './helpers/response-body';

describe('Video delivery (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storage: StorageService;
  let videoRepository: Repository<Video>;
  const source = randomBytes(4096);

  beforeAll(async () => {
    app = await createTestApp();
    dataSource = app.get(DataSource);
    storage = app.get(StorageService);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await cleanVideoStorage(dataSource, storage);
    await cleanAllTables(dataSource);
    await app.close();
  });

  beforeEach(async () => {
    await cleanVideoStorage(dataSource, storage);
    await cleanAllTables(dataSource);
  });

  /** A processed video: source + thumbnail in storage, status ready. */
  async function seedVideo(status: VideoStatus): Promise<Video> {
    const channel = await createTestChannel(dataSource);
    const video = await videoRepository.save(
      buildVideo(channel.id, {
        status,
        title: 'Minha aula',
        original_file_name: 'aula.mp4',
        file_size_bytes: source.length,
      }),
    );
    await storage.putObject(video.storage_key, source, 'video/mp4');
    const thumbnailKey = `videos/${video.id}/thumbnail.jpg`;
    await storage.putObject(thumbnailKey, randomBytes(512), 'image/jpeg');
    await videoRepository.update(
      { id: video.id },
      { thumbnail_key: thumbnailKey },
    );
    return { ...video, thumbnail_key: thumbnailKey };
  }

  const get = (path: string) => request(app.getHttpServer()).get(path);

  describe('GET /videos/:slug/stream', () => {
    it('redirects (302) to storage, which serves Range requests with 206', async () => {
      const video = await seedVideo(VideoStatus.READY);

      const res = await get(`/videos/${video.slug}/stream`).expect(302);

      expect(res.headers['cache-control']).toBe('no-store');
      const ranged = await fetch(res.headers.location, {
        headers: { Range: 'bytes=0-99' },
      });
      expect(ranged.status).toBe(206);
      expect(ranged.headers.get('content-range')).toBe(
        `bytes 0-99/${source.length}`,
      );
      expect(ranged.headers.get('content-type')).toBe('video/mp4');
      expect(Buffer.from(await ranged.arrayBuffer())).toEqual(
        source.subarray(0, 100),
      );
    });

    it('returns 409 VIDEO_NOT_READY for a video still processing', async () => {
      const video = await seedVideo(VideoStatus.PROCESSING);

      const res = await get(`/videos/${video.slug}/stream`).expect(409);

      expect(bodyOf<ErrorBody>(res).error).toBe('VIDEO_NOT_READY');
    });

    it('returns 404 VIDEO_NOT_FOUND for an unknown slug', async () => {
      const res = await get('/videos/AAAAAAAAAAA/stream').expect(404);

      expect(bodyOf<ErrorBody>(res).error).toBe('VIDEO_NOT_FOUND');
    });
  });

  describe('GET /videos/:slug/download', () => {
    it('redirects (302) to the file served as an attachment', async () => {
      const video = await seedVideo(VideoStatus.READY);

      const res = await get(`/videos/${video.slug}/download`).expect(302);
      const file = await fetch(res.headers.location);

      expect(res.headers['cache-control']).toBe('no-store');
      expect(file.status).toBe(200);
      expect(file.headers.get('content-disposition')).toBe(
        'attachment; filename="Minha aula.mp4"',
      );
      expect(Buffer.from(await file.arrayBuffer())).toEqual(source);
    });

    it('returns 409 VIDEO_NOT_READY for a video still processing', async () => {
      const video = await seedVideo(VideoStatus.PROCESSING);

      const res = await get(`/videos/${video.slug}/download`).expect(409);

      expect(bodyOf<ErrorBody>(res).error).toBe('VIDEO_NOT_READY');
    });
  });

  describe('GET /videos/:slug/thumbnail', () => {
    it('redirects (302) to the JPEG thumbnail', async () => {
      const video = await seedVideo(VideoStatus.READY);

      const res = await get(`/videos/${video.slug}/thumbnail`).expect(302);
      const image = await fetch(res.headers.location);

      expect(res.headers['cache-control']).toBe('no-store');
      expect(image.status).toBe(200);
      expect(image.headers.get('content-type')).toBe('image/jpeg');
    });

    it('returns 409 VIDEO_NOT_READY for a video still processing', async () => {
      const video = await seedVideo(VideoStatus.PROCESSING);

      const res = await get(`/videos/${video.slug}/thumbnail`).expect(409);

      expect(bodyOf<ErrorBody>(res).error).toBe('VIDEO_NOT_READY');
    });
  });
});
