import { randomBytes } from 'crypto';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { generateTestVideo } from '../src/test/video-fixtures';
import { cleanVideoStorage } from '../src/test/videos-test-module';
import { VIDEO_PROCESSING_QUEUE } from '../src/videos/videos.constants';
import { WorkerModule } from '../src/worker.module';
import { createAuthenticatedUser } from './helpers/auth-user';
import { createTestApp } from './helpers/create-test-app';
import { bodyOf, type ErrorBody } from './helpers/response-body';

interface CreatedVideoBody {
  slug: string;
  upload: { part_size: number; part_count: number };
}

interface VideoBody {
  status: string;
  duration_seconds: number | null;
  metadata: { width: number; height: number; video_codec: string } | null;
  processing_error: string | null;
  stream_url: string | null;
  download_url: string | null;
  thumbnail_url: string | null;
}

const GENERATED_DURATION_SECONDS = 6;

describe('Video pipeline (e2e: API + worker in-process)', () => {
  let app: INestApplication<App>;
  let worker: TestingModule;
  let dataSource: DataSource;
  let storage: StorageService;
  let queue: Queue;
  let token: string;
  let dir: string;
  let video: Buffer;
  let partsUsed = 0;

  beforeAll(async () => {
    app = await createTestApp();
    worker = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    await worker.init();
    dataSource = app.get(DataSource);
    storage = app.get(StorageService);
    queue = app.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    await queue.obliterate({ force: true });

    dir = mkdtempSync(join(tmpdir(), 'pipeline-e2e-'));
    const path = join(dir, 'upload.mp4');
    // High bitrate so the file spans more than one 5 MiB test part.
    await generateTestVideo(path, {
      durationSeconds: GENERATED_DURATION_SECONDS,
      width: 1280,
      height: 720,
      videoBitrate: '12M',
    });
    video = readFileSync(path);
  }, 120000);

  afterAll(async () => {
    await cleanVideoStorage(dataSource, storage);
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
    await worker.close();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await cleanVideoStorage(dataSource, storage);
    await cleanAllTables(dataSource);
    ({ accessToken: token } = await createAuthenticatedUser(
      app,
      'creator@example.com',
    ));
  });

  const auth = (req: request.Test) =>
    req.set('Authorization', `Bearer ${token}`);

  /** Initiates, uploads every part straight to storage and completes. */
  async function upload(bytes: Buffer): Promise<string> {
    const created = await auth(request(app.getHttpServer()).post('/videos'))
      .send({
        file_name: 'aula.mp4',
        file_size: bytes.length,
        content_type: 'video/mp4',
      })
      .expect(201);
    const { slug, upload: plan } = bodyOf<CreatedVideoBody>(created);
    partsUsed = plan.part_count;

    const partNumbers = Array.from(
      { length: plan.part_count },
      (_, i) => i + 1,
    );
    const signed = await auth(
      request(app.getHttpServer()).post(`/videos/${slug}/upload/parts`),
    )
      .send({ part_numbers: partNumbers })
      .expect(200);
    for (const part of bodyOf<{
      parts: { part_number: number; url: string }[];
    }>(signed).parts) {
      const start = (part.part_number - 1) * plan.part_size;
      const res = await fetch(part.url, {
        method: 'PUT',
        body: new Uint8Array(bytes.subarray(start, start + plan.part_size)),
      });
      expect(res.status).toBe(200);
    }

    await auth(
      request(app.getHttpServer()).post(`/videos/${slug}/upload/complete`),
    ).expect(202);
    return slug;
  }

  async function waitUntilSettled(slug: string): Promise<VideoBody> {
    const deadline = Date.now() + 60000;
    for (;;) {
      const res = await auth(
        request(app.getHttpServer()).get(`/videos/${slug}`),
      ).expect(200);
      const body = bodyOf<VideoBody>(res);
      if (body.status === 'ready' || body.status === 'failed') return body;
      if (Date.now() > deadline) throw new Error(`still ${body.status}`);
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  it('takes a multipart upload to ready and serves it by streaming and download', async () => {
    const slug = await upload(video);

    const ready = await waitUntilSettled(slug);

    expect(partsUsed).toBeGreaterThanOrEqual(2);
    expect(ready.status).toBe('ready');
    expect(ready.duration_seconds).toBeGreaterThan(
      GENERATED_DURATION_SECONDS - 0.2,
    );
    expect(ready.duration_seconds).toBeLessThan(
      GENERATED_DURATION_SECONDS + 0.2,
    );
    expect(ready.metadata).toMatchObject({
      width: 1280,
      height: 720,
      video_codec: 'h264',
    });
    expect(ready.thumbnail_url).toBe(`/videos/${slug}/thumbnail`);

    const stream = await request(app.getHttpServer())
      .get(`/videos/${slug}/stream`)
      .expect(302);
    const ranged = await fetch(stream.headers.location, {
      headers: { Range: 'bytes=0-1023' },
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toBe(
      `bytes 0-1023/${video.length}`,
    );

    const download = await request(app.getHttpServer())
      .get(`/videos/${slug}/download`)
      .expect(302);
    // Presigned URLs are signed for GET (SigV4 covers the method); fetch 1 byte.
    const file = await fetch(download.headers.location, {
      headers: { Range: 'bytes=0-0' },
    });
    expect(file.headers.get('content-disposition')).toBe(
      'attachment; filename="aula.mp4"',
    );

    const thumbnail = await request(app.getHttpServer())
      .get(`/videos/${slug}/thumbnail`)
      .expect(302);
    const image = await fetch(thumbnail.headers.location, {
      headers: { Range: 'bytes=0-0' },
    });
    expect(image.headers.get('content-type')).toBe('image/jpeg');
  }, 90000);

  it('takes bytes that are not a video to failed with a reason', async () => {
    const slug = await upload(randomBytes(64 * 1024));

    const failed = await waitUntilSettled(slug);

    expect(failed.status).toBe('failed');
    expect(failed.processing_error).toEqual(expect.any(String));
    const stream = await request(app.getHttpServer())
      .get(`/videos/${slug}/stream`)
      .expect(409);
    expect(bodyOf<ErrorBody>(stream).error).toBe('VIDEO_NOT_READY');
  }, 90000);
});
