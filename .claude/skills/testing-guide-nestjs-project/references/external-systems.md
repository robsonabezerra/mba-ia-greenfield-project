> Part of the `testing-guide-nestjs-project` skill (see `../SKILL.md`).

# External System Strategies

How each external system is handled in tests. These strategies were confirmed with the team.

---

## PostgreSQL — Real (Docker)

**Strategy:** Real database via the Docker `db` service (already in `compose.yaml`).

**Connection config for tests:**
```typescript
{
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USERNAME ?? 'streamtube',
  password: process.env.DB_PASSWORD ?? 'streamtube',
  database: process.env.DB_DATABASE ?? 'streamtube',
  synchronize: true, // auto-create tables in test setup
}
```

**Test isolation:**
- Use `dataSource.query('DELETE FROM "table_name"')` to clean tables between tests
- Do NOT use `repository.delete({})` — throws `Empty criteria(s) are not allowed`
- Alternative: `repository.clear()` (truncates the table)
- For complex foreign key chains, delete in reverse dependency order or use `TRUNCATE ... CASCADE`
- Use `beforeEach` for cleanup to ensure each test starts with a clean state

**Entity setup:**
- Use `synchronize: true` in test DataSource to auto-create tables from entities
- For integration tests, import only the entities needed by the test — not all entities
- For E2E tests, import `AppModule` which includes all entities via their domain modules

---

## Object Storage — Real MinIO (Docker)

**Strategy:** Real S3-compatible storage — the Compose `minio` service (bucket created by the one-shot `minio-init`). Decided in `phase-03-videos/TD-16`: presigned multipart uploads and Range delivery only exist against a real S3 API, so there is no filesystem adapter.

**How tests reach it:**
- `StorageModule` + `ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] })` — the same module the app uses (two `S3Client`s: internal `S3_ENDPOINT`, public `S3_PUBLIC_ENDPOINT`).
- `src/test/setup-test-env.ts` (Jest `setupFiles`) forces `S3_PUBLIC_ENDPOINT = S3_ENDPOINT`, so presigned URLs signed in tests are reachable from inside the container (SigV4 signs the host — a URL signed for `localhost:9000` would not work there).
- Client-side steps are exercised for real: `fetch(url, { method: 'PUT', body: new Uint8Array(part) })` on presigned part URLs, `fetch(url, { headers: { Range: 'bytes=0-99' } })` on delivery URLs (expect `206` + `Content-Range`).
- Presigned URLs are signed for `GET`/`PUT` — do not probe them with `HEAD` (signature mismatch → 403); use `GET` with `Range: bytes=0-0`.

**Test isolation:**
- Use unique keys (`test/storage/${randomUUID()}/...`) or the video's own `videos/{id}/...` keys.
- `cleanVideoStorage(dataSource, storage)` (`src/test/videos-test-module.ts`) aborts open multipart uploads and deletes the objects of every video row — call it before `cleanAllTables` in `beforeEach`/`afterAll`.
- Media fixtures are generated at test time with FFmpeg lavfi sources (`generateTestVideo` in `src/test/video-fixtures.ts`); no binary fixtures are committed. Pass `videoBitrate` (strict CBR) when a test needs a file larger than one 5 MiB part.

```typescript
const module = await createVideosTestingModule([VideosService, VideoProcessingProducer]);
const storage = module.get(StorageService);
const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
const url = await storage.presignUploadPart(key, uploadId, 1, 300);
expect((await fetch(url, { method: 'PUT', body: new Uint8Array(bytes) })).status).toBe(200);
```

---

## Message Queue — Real BullMQ on Redis (Docker)

**Strategy:** Real Redis (Compose `redis` service) through BullMQ (`phase-03-videos/TD-01`).

**Configuration in tests:**
- `QueueModule` (`BullModule.forRootAsync` with `queueConfig`) + `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })`.
- `setup-test-env.ts` sets `QUEUE_PREFIX = 'streamtube-test'`: tests never share keys with the long-running `video-worker` service (dev prefix `streamtube`), so that worker never steals test jobs.
- `ioredis` must be installed — it is an optional peer of `bullmq@6`.
- bullmq 6 removed `queue.client`; assert on jobs (`queue.getJob(id)`, `job.queueQualifiedName`, `queue.getJobCounts(...)`, `queue.getJobSchedulers()`), not raw Redis keys.

**Test isolation:** `await queue.obliterate({ force: true })` in `beforeEach` and `afterAll`.

**Publisher tests:** assert the job exists with the expected `name`, `data`, `jobId` and options.

**Consumer tests:** bootstrap the worker in-process — `Test.createTestingModule({ imports: [WorkerModule] })` + `await module.init()` — enqueue a job and poll the database until the video reaches a terminal status (`ready`/`failed`). Full-flow E2E (`test/video-pipeline.e2e-spec.ts`) runs the HTTP app and the worker context in the same Jest process.

```typescript
const worker = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
await worker.init();
await queue.add(VIDEO_JOBS.PROCESS, { videoId }, { jobId: videoId });
// poll videoRepository until status is ready/failed, then assert
```

---

## Email — Mailpit (Real SMTP Capture)

**Strategy:** Mailpit — a local SMTP server that captures all emails for inspection via its API. No emails are actually delivered.

**Setup:**
- Add Mailpit to `compose.yaml`:
```yaml
mailpit:
  image: axllent/mailpit
  ports:
    - "1025:1025"   # SMTP
    - "8025:8025"   # Web UI / API
```

**NestJS configuration:**
```typescript
// In mail module or config
{
  transport: {
    host: process.env.SMTP_HOST ?? 'localhost',
    port: Number(process.env.SMTP_PORT ?? 1025),
  },
}
```

**Integration test:**
```typescript
describe('MailService (integration)', () => {
  beforeEach(async () => {
    // Clear all captured emails via Mailpit API
    await fetch('http://localhost:8025/api/v1/messages', { method: 'DELETE' });
  });

  it('should send confirmation email', async () => {
    await mailService.sendConfirmation('user@test.com', 'token-123');

    // Query Mailpit API for captured emails
    const response = await fetch('http://localhost:8025/api/v1/messages');
    const data = await response.json();

    expect(data.messages).toHaveLength(1);
    expect(data.messages[0].To[0].Address).toBe('user@test.com');
    expect(data.messages[0].Subject).toContain('confirm');
  });
});
```

**Key points:**
- Mailpit captures ALL emails — no mocking, no side effects
- Use Mailpit's REST API (`http://localhost:8025/api/v1/messages`) to inspect sent emails
- Clear captured emails in `beforeEach` to ensure test isolation
- Web UI at `http://localhost:8025` for manual debugging
- Tests the full SMTP transport path — if the SMTP config is wrong, the test fails
