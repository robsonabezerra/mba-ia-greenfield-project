import { randomBytes } from 'crypto';
import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication } from '@nestjs/common';
import { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { cleanVideoStorage } from '../src/test/videos-test-module';
import { Video } from '../src/videos/entities/video.entity';
import { VideoStatus } from '../src/videos/video-status.enum';
import { VIDEO_PROCESSING_QUEUE } from '../src/videos/videos.constants';
import { createAuthenticatedUser } from './helpers/auth-user';
import { createTestApp } from './helpers/create-test-app';
import { bodyOf, type ErrorBody } from './helpers/response-body';

interface CreatedVideoBody {
  id: string;
  slug: string;
  title: string;
  status: string;
  upload: { part_size: number; part_count: number; expires_at: string };
}

interface SignedPartsBody {
  parts: { part_number: number; url: string }[];
  expires_at: string;
}

interface VideoBody {
  id: string;
  slug: string;
  status: string;
  channel: { id: string; nickname: string; name: string };
  stream_url: string | null;
  download_url: string | null;
  thumbnail_url: string | null;
}

interface UploadStateBody {
  part_size: number;
  part_count: number;
  expires_at: string;
  uploaded_parts: { part_number: number; size: number }[];
}

const MAX_SIZE = 10737418240;

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storage: StorageService;
  let ownerToken: string;
  let queue: Queue;

  beforeAll(async () => {
    app = await createTestApp();
    dataSource = app.get(DataSource);
    storage = app.get(StorageService);
    queue = app.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    await cleanVideoStorage(dataSource, storage);
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
    await app.close();
  });

  beforeEach(async () => {
    await cleanVideoStorage(dataSource, storage);
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
    ({ accessToken: ownerToken } = await createAuthenticatedUser(
      app,
      'owner@example.com',
    ));
  });

  const createVideo = (token: string, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  describe('POST /videos', () => {
    it('returns 201 with the draft and its upload plan', async () => {
      const res = await createVideo(ownerToken, {
        file_name: 'aula.mp4',
        file_size: 104857600,
        content_type: 'video/mp4',
      }).expect(201);

      const body = bodyOf<CreatedVideoBody>(res);
      expect(body).toMatchObject({
        title: 'aula',
        status: 'draft',
        upload: {
          part_size: body.upload.part_size,
          part_count: Math.ceil(104857600 / body.upload.part_size),
        },
      });
      expect(body.slug).toMatch(/^[A-Za-z0-9_-]{11}$/);
      const video = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ id: body.id });
      expect(video.status).toBe('draft');
      expect(video.upload_id).toEqual(expect.any(String));
      expect(video.storage_key).toBe(`videos/${body.id}/source`);
    });

    it('gives consecutive videos different slugs', async () => {
      const body = {
        file_name: 'a.mp4',
        file_size: 1024,
        content_type: 'video/mp4',
      };
      const first = await createVideo(ownerToken, body).expect(201);
      const second = await createVideo(ownerToken, body).expect(201);

      expect(bodyOf<CreatedVideoBody>(first).slug).not.toBe(
        bodyOf<CreatedVideoBody>(second).slug,
      );
    });

    it('returns 413 VIDEO_FILE_TOO_LARGE above the limit and creates nothing', async () => {
      const res = await createVideo(ownerToken, {
        file_name: 'huge.mp4',
        file_size: MAX_SIZE + 1,
        content_type: 'video/mp4',
      }).expect(413);

      expect(bodyOf<ErrorBody>(res).error).toBe('VIDEO_FILE_TOO_LARGE');
      await expect(dataSource.getRepository(Video).count()).resolves.toBe(0);
    });

    it('accepts exactly the 10 GiB limit', async () => {
      await createVideo(ownerToken, {
        file_name: 'big.mp4',
        file_size: MAX_SIZE,
        content_type: 'video/mp4',
      }).expect(201);
    });

    it('returns 400 VALIDATION_ERROR for a non-video content type', async () => {
      const res = await createVideo(ownerToken, {
        file_name: 'image.png',
        file_size: 1024,
        content_type: 'image/png',
      }).expect(400);

      expect(bodyOf<ErrorBody>(res).error).toBe('VALIDATION_ERROR');
    });

    it('returns 401 without a token', async () => {
      await request(app.getHttpServer())
        .post('/videos')
        .send({ file_name: 'a.mp4', file_size: 1, content_type: 'video/mp4' })
        .expect(401);
    });
  });

  async function createDraft(
    fileSize = 6 * 1024 * 1024,
  ): Promise<CreatedVideoBody> {
    const res = await createVideo(ownerToken, {
      file_name: 'clip.mp4',
      file_size: fileSize,
      content_type: 'video/mp4',
    }).expect(201);
    return bodyOf<CreatedVideoBody>(res);
  }

  const signParts = (token: string, slug: string, partNumbers: unknown) =>
    request(app.getHttpServer())
      .post(`/videos/${slug}/upload/parts`)
      .set('Authorization', `Bearer ${token}`)
      .send({ part_numbers: partNumbers });

  const uploadState = (token: string, slug: string) =>
    request(app.getHttpServer())
      .get(`/videos/${slug}/upload`)
      .set('Authorization', `Bearer ${token}`);

  describe('POST /videos/:slug/upload/parts', () => {
    it('returns 200 with URLs in ascending order bounded by the draft expiration', async () => {
      const draft = await createDraft();

      const res = await signParts(ownerToken, draft.slug, [2, 1]).expect(200);

      const body = bodyOf<SignedPartsBody>(res);
      expect(body.parts.map((p) => p.part_number)).toEqual([1, 2]);
      expect(new Date(body.expires_at).getTime()).toBeLessThanOrEqual(
        new Date(draft.upload.expires_at).getTime(),
      );
    });

    it('returns a URL the storage accepts for the part bytes', async () => {
      const draft = await createDraft();
      const res = await signParts(ownerToken, draft.slug, [1]).expect(200);

      const put = await fetch(bodyOf<SignedPartsBody>(res).parts[0].url, {
        method: 'PUT',
        body: new Uint8Array(randomBytes(1024)),
      });

      expect(put.status).toBe(200);
    });

    it('returns 400 INVALID_UPLOAD_PART above the part count', async () => {
      const draft = await createDraft();

      const res = await signParts(ownerToken, draft.slug, [
        draft.upload.part_count + 1,
      ]).expect(400);

      expect(bodyOf<ErrorBody>(res).error).toBe('INVALID_UPLOAD_PART');
    });

    it('returns 400 VALIDATION_ERROR for an empty list', async () => {
      const draft = await createDraft();

      const res = await signParts(ownerToken, draft.slug, []).expect(400);

      expect(bodyOf<ErrorBody>(res).error).toBe('VALIDATION_ERROR');
    });

    it('returns 403 VIDEO_NOT_OWNED for another user', async () => {
      const draft = await createDraft();
      const { accessToken: otherToken } = await createAuthenticatedUser(
        app,
        'other@example.com',
      );

      const res = await signParts(otherToken, draft.slug, [1]).expect(403);

      expect(bodyOf<ErrorBody>(res).error).toBe('VIDEO_NOT_OWNED');
    });

    it('returns 404 VIDEO_NOT_FOUND for an unknown slug', async () => {
      const res = await signParts(ownerToken, 'AAAAAAAAAAA', [1]).expect(404);

      expect(bodyOf<ErrorBody>(res).error).toBe('VIDEO_NOT_FOUND');
    });

    it('returns 401 without a token', async () => {
      const draft = await createDraft();

      await request(app.getHttpServer())
        .post(`/videos/${draft.slug}/upload/parts`)
        .send({ part_numbers: [1] })
        .expect(401);
    });
  });

  describe('GET /videos/:slug/upload', () => {
    it('lists the part already uploaded with its size', async () => {
      const draft = await createDraft();
      const signed = await signParts(ownerToken, draft.slug, [1]).expect(200);
      const bytes = randomBytes(5 * 1024 * 1024);
      await fetch(bodyOf<SignedPartsBody>(signed).parts[0].url, {
        method: 'PUT',
        body: new Uint8Array(bytes),
      });

      const res = await uploadState(ownerToken, draft.slug).expect(200);

      expect(bodyOf<UploadStateBody>(res)).toMatchObject({
        part_count: 2,
        uploaded_parts: [{ part_number: 1, size: bytes.length }],
      });
    });

    it('returns 403 VIDEO_NOT_OWNED for another user', async () => {
      const draft = await createDraft();
      const { accessToken: otherToken } = await createAuthenticatedUser(
        app,
        'other@example.com',
      );

      const res = await uploadState(otherToken, draft.slug).expect(403);

      expect(bodyOf<ErrorBody>(res).error).toBe('VIDEO_NOT_OWNED');
    });

    it('returns 404 VIDEO_NOT_FOUND for an unknown slug', async () => {
      const res = await uploadState(ownerToken, 'AAAAAAAAAAA').expect(404);

      expect(bodyOf<ErrorBody>(res).error).toBe('VIDEO_NOT_FOUND');
    });
  });

  /** Sends every slice of `bytes` to its presigned part URL. */
  async function uploadParts(
    slug: string,
    bytes: Buffer,
    partSize: number,
    only?: number[],
  ): Promise<void> {
    const partCount = Math.ceil(bytes.length / partSize);
    const numbers = only ?? Array.from({ length: partCount }, (_, i) => i + 1);
    const signed = await signParts(ownerToken, slug, numbers).expect(200);
    for (const part of bodyOf<SignedPartsBody>(signed).parts) {
      const start = (part.part_number - 1) * partSize;
      const res = await fetch(part.url, {
        method: 'PUT',
        body: new Uint8Array(bytes.subarray(start, start + partSize)),
      });
      expect(res.status).toBe(200);
    }
  }

  const complete = (token: string, slug: string) =>
    request(app.getHttpServer())
      .post(`/videos/${slug}/upload/complete`)
      .set('Authorization', `Bearer ${token}`);

  describe('POST /videos/:slug/upload/complete', () => {
    const bytes = randomBytes(6 * 1024 * 1024);

    it('returns 202 processing after all parts were sent directly to storage', async () => {
      const draft = await createDraft(bytes.length);
      await uploadParts(draft.slug, bytes, draft.upload.part_size);

      const res = await complete(ownerToken, draft.slug).expect(202);

      expect(bodyOf<{ status: string }>(res).status).toBe('processing');
      const video = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ id: draft.id });
      expect(video.status).toBe('processing');
      await expect(queue.getJob(draft.id)).resolves.toMatchObject({
        data: { videoId: draft.id },
      });
    });

    it('is idempotent: a second call returns 202 and keeps a single job', async () => {
      const draft = await createDraft(bytes.length);
      await uploadParts(draft.slug, bytes, draft.upload.part_size);
      await complete(ownerToken, draft.slug).expect(202);

      const res = await complete(ownerToken, draft.slug).expect(202);

      expect(bodyOf<{ status: string }>(res).status).toBe('processing');
      const counts = await queue.getJobCounts('waiting', 'delayed', 'active');
      expect(counts.waiting + counts.delayed + counts.active).toBe(1);
    });

    it('returns 409 UPLOAD_INCOMPLETE when a part is missing and keeps the draft', async () => {
      const draft = await createDraft(bytes.length);
      await uploadParts(draft.slug, bytes, draft.upload.part_size, [1]);

      const res = await complete(ownerToken, draft.slug).expect(409);

      expect(bodyOf<ErrorBody>(res).error).toBe('UPLOAD_INCOMPLETE');
      const state = await uploadState(ownerToken, draft.slug).expect(200);
      expect(bodyOf<UploadStateBody>(state).uploaded_parts).toHaveLength(1);
    });

    it('returns 409 UPLOAD_SIZE_MISMATCH when the sent bytes differ from the declared size', async () => {
      const draft = await createDraft(bytes.length + 10);
      await uploadParts(draft.slug, bytes, draft.upload.part_size);

      const res = await complete(ownerToken, draft.slug).expect(409);

      expect(bodyOf<ErrorBody>(res).error).toBe('UPLOAD_SIZE_MISMATCH');
    });

    it('returns 403 VIDEO_NOT_OWNED for another user', async () => {
      const draft = await createDraft(bytes.length);
      const { accessToken: otherToken } = await createAuthenticatedUser(
        app,
        'other@example.com',
      );

      const res = await complete(otherToken, draft.slug).expect(403);

      expect(bodyOf<ErrorBody>(res).error).toBe('VIDEO_NOT_OWNED');
    });
  });

  const cancel = (token: string, slug: string) =>
    request(app.getHttpServer())
      .delete(`/videos/${slug}/upload`)
      .set('Authorization', `Bearer ${token}`);

  describe('DELETE /videos/:slug/upload', () => {
    it('returns 204, releases the multipart upload and removes the draft', async () => {
      const draft = await createDraft();
      await uploadParts(
        draft.slug,
        randomBytes(5 * 1024 * 1024),
        draft.upload.part_size,
        [1],
      );
      const video = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ id: draft.id });

      await cancel(ownerToken, draft.slug).expect(204);

      const res = await uploadState(ownerToken, draft.slug).expect(404);
      expect(bodyOf<ErrorBody>(res).error).toBe('VIDEO_NOT_FOUND');
      await expect(
        storage.listParts(video.storage_key, video.upload_id!),
      ).rejects.toMatchObject({ name: 'NoSuchUpload' });
    });

    it('returns 409 VIDEO_NOT_UPLOADABLE for a video in processing and keeps it', async () => {
      const bytes = randomBytes(1024);
      const draft = await createDraft(bytes.length);
      await uploadParts(draft.slug, bytes, draft.upload.part_size);
      await complete(ownerToken, draft.slug).expect(202);

      const res = await cancel(ownerToken, draft.slug).expect(409);

      expect(bodyOf<ErrorBody>(res).error).toBe('VIDEO_NOT_UPLOADABLE');
      await expect(
        dataSource.getRepository(Video).findOneBy({ id: draft.id }),
      ).resolves.not.toBeNull();
    });

    it('returns 403 VIDEO_NOT_OWNED for another user', async () => {
      const draft = await createDraft();
      const { accessToken: otherToken } = await createAuthenticatedUser(
        app,
        'other@example.com',
      );

      const res = await cancel(otherToken, draft.slug).expect(403);

      expect(bodyOf<ErrorBody>(res).error).toBe('VIDEO_NOT_OWNED');
    });

    it('returns 401 without a token', async () => {
      const draft = await createDraft();

      await request(app.getHttpServer())
        .delete(`/videos/${draft.slug}/upload`)
        .expect(401);
    });
  });

  describe('GET /videos/:slug', () => {
    const getVideo = (slug: string, token?: string) => {
      const req = request(app.getHttpServer()).get(`/videos/${slug}`);
      return token ? req.set('Authorization', `Bearer ${token}`) : req;
    };

    async function readyVideo(): Promise<CreatedVideoBody> {
      const draft = await createDraft(1024);
      await dataSource
        .getRepository(Video)
        .update(
          { id: draft.id },
          { status: VideoStatus.READY, upload_id: null },
        );
      return draft;
    }

    it('returns 200 to anonymous callers for a ready video, with delivery URLs', async () => {
      const video = await readyVideo();

      const res = await getVideo(video.slug).expect(200);

      const body = bodyOf<VideoBody>(res);
      expect(body).toMatchObject({
        status: 'ready',
        stream_url: `/videos/${video.slug}/stream`,
        download_url: `/videos/${video.slug}/download`,
        thumbnail_url: `/videos/${video.slug}/thumbnail`,
      });
      expect(body.channel.nickname).toEqual(expect.any(String));
    });

    it('treats an invalid Bearer token as anonymous', async () => {
      const video = await readyVideo();

      await getVideo(video.slug, 'not-a-valid-jwt').expect(200);
    });

    it('returns 404 VIDEO_NOT_FOUND to anonymous callers for a draft', async () => {
      const draft = await createDraft();

      const res = await getVideo(draft.slug).expect(404);

      expect(bodyOf<ErrorBody>(res).error).toBe('VIDEO_NOT_FOUND');
    });

    it('returns the draft to its owner without delivery URLs', async () => {
      const draft = await createDraft();

      const res = await getVideo(draft.slug, ownerToken).expect(200);

      expect(bodyOf<VideoBody>(res)).toMatchObject({
        status: 'draft',
        stream_url: null,
        download_url: null,
        thumbnail_url: null,
      });
    });

    it('returns 404 VIDEO_NOT_FOUND for an unknown slug', async () => {
      const res = await getVideo('AAAAAAAAAAA').expect(404);

      expect(bodyOf<ErrorBody>(res).error).toBe('VIDEO_NOT_FOUND');
    });

    it('keeps protected routes protected (GET /auth/me without token is 401)', async () => {
      await request(app.getHttpServer()).get('/auth/me').expect(401);
    });
  });
});
