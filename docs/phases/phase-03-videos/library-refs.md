---
libs:
  "@nestjs/bullmq":
    version: "^11.0.5"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-10-25T12:45:38-03:00"
  bullmq:
    version: "^6.4.2"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-10-25T12:45:38-03:00"
  ioredis:
    version: "^5.11.1"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-10-25T13:40:00-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1156.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-10-25T12:45:38-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1156.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-10-25T12:45:38-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-25T13:42:43-03:00"
---

# phase-03-videos — Library References

Distilled docs for the libraries decided in this phase, pulled via Context7 on 2026-10-25. Version compatibility checked against the npm registry the same day. **Revision (SI-03.4):** `@nestjs/bullmq@12.0.0` is ESM-only and cannot be loaded by this CommonJS project (Jest fails with `SyntaxError: Unexpected token 'export'`); the project pins `@nestjs/bullmq@^11.0.5` (CommonJS, peers `@nestjs/* ^10 || ^11` and `bullmq ^3–^6`) — see `phase-03-videos/TD-01` Revisions. Re-fetch when the TDs below change.

## @nestjs/bullmq

**Source:** `/nestjs/bull` (Context7, trust 9.7). Maps to `phase-03-videos/TD-01` (queue) and `phase-03-videos/TD-06` (worker as separate entrypoint).

### Root connection (once per process)

`BullModule.forRootAsync` registers a **global** shared configuration (all BullMQ `QueueOptions`: `connection`, `prefix`, `defaultJobOptions`, …). Use `inject` with a `registerAs` config key (inherited convention from Phase 01).

```ts
import { BullModule } from '@nestjs/bullmq';

BullModule.forRootAsync({
  inject: [queueConfig.KEY],
  useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
    connection: { host: cfg.host, port: cfg.port },
    prefix: cfg.prefix,            // BullMQ key prefix — tests use an isolated prefix (TD-16)
  }),
});
```

### Queue registration and producer

```ts
BullModule.registerQueue({ name: 'video-processing' });

@Injectable()
export class VideoProcessingProducer {
  constructor(@InjectQueue('video-processing') private readonly queue: Queue) {}
}
```

`getQueueToken(name)` returns the DI token `BullQueue_<name>` — use `moduleRef.get<Queue>(getQueueToken('video-processing'))` in tests to inspect enqueued jobs.

### Consumer (worker) — `@Processor` + `WorkerHost`

A class decorated with `@Processor(queueName, workerOptions?)` and extending `WorkerHost` is auto-registered as a BullMQ `Worker` **in every Nest context whose module graph contains it**. Keep processors only in the worker module so the API process never consumes jobs. The second argument carries raw BullMQ `WorkerOptions` (e.g., `concurrency`).

```ts
import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';

@Processor('video-processing', { concurrency: 1 })
export class VideoProcessor extends WorkerHost {
  async process(job: Job<{ videoId: string }>): Promise<void> { /* ... */ }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) { /* final-attempt handling */ }
}
```

`@OnWorkerEvent(eventName)` listens to BullMQ `WorkerListener` events (`active`, `completed`, `failed`, `error`, `stalled`, `drained`, …) on the worker created for that processor.

`extraOptions: { manualRegistration: true }` on `forRoot` disables automatic queue/worker registration (not needed when processors live only in the worker module).

## bullmq

**Source:** `/taskforcesh/bullmq` (Context7, trust 9.2; version `v6.3.11` indexed, npm latest `6.4.2`).

**v6 breaking changes that affect this project (Context7, `docs/gitbook/changelog.md`):** `ioredis` is no longer a direct dependency — it is an optional peer and must be installed explicitly; `Queue#client`/`Worker#blockingClient` were removed (raw Redis access only through `queue.getBackend()`), so tests assert on `job.queueQualifiedName` (`"{prefix}:{queue}"`) instead of raw keys.

Maps to `phase-03-videos/TD-01`, `phase-03-videos/TD-14`, `phase-03-videos/TD-15`, `phase-03-videos/TD-17`.

### Retries with exponential backoff (TD-14)

```ts
await queue.add('process-video', { videoId }, {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 }, // retries after 2^(attempt-1) * delay ms
});
```

### Idempotent enqueue with custom `jobId` (TD-15)

Jobs added with an identical `jobId` are considered duplicates and only the first is added. **Warning (docs):** if `removeOnComplete`/`removeOnFail` removes the job, a later `add` with the same id is accepted again — keep completed/failed jobs (or accept that a completed video may be re-enqueued only by an explicit retry path).

```ts
await queue.add('process-video', { videoId }, { jobId: videoId });
```

### Permanent failures — `UnrecoverableError`

Throwing `UnrecoverableError` moves the job straight to the failed set **without retries**, overriding `attempts`. Use it when ffprobe proves the object is not a decodable video (retrying cannot help).

```ts
import { UnrecoverableError } from 'bullmq';
throw new UnrecoverableError('Source is not a valid video');
```

In a `failed` listener, `job.attemptsMade` vs `job.opts.attempts` tells whether the failure is final.

### Job Schedulers — recurring jobs (TD-17)

`queue.upsertJobScheduler(schedulerId, repeatOpts, template)` creates (or updates, idempotently by id) a scheduler that produces jobs on a cron `pattern` or fixed `every` (ms) interval; produced jobs inherit the template's `name`, `data` and `opts`.

```ts
await queue.upsertJobScheduler(
  'expired-uploads-sweeper',
  { every: 60 * 60 * 1000 },                  // or { pattern: '0 0 * * * *' }
  { name: 'sweep-expired-uploads', data: {}, opts: { removeOnComplete: true, removeOnFail: 100 } },
);
```

The same worker processes scheduler-produced jobs; dispatch on `job.name` inside `process()` when a queue carries more than one job type.

### Worker defaults relevant to long jobs

`Worker` defaults: `concurrency: 1`, `lockDuration: 30000`, `stalledInterval: 30000`, `maxStalledCount: 1`. Workers force `maxRetriesPerRequest: null` on their blocking ioredis connection (required — do not override). The `prefix` option (Queue and Worker) namespaces every Redis key.

### Graceful shutdown

`await worker.close()` stops picking new jobs and waits for active ones; `await queue.close()` closes the connection. In Nest these run on application shutdown (`app.close()`), which tests must call in `afterAll`.

### Inspecting jobs (tests)

`queue.getJob(id)`, `queue.getJobs(['waiting'])`, `queue.getJobState(id)`, `queue.getJobCounts()`, `queue.obliterate({ force: true })` (clean the isolated test prefix).

## @aws-sdk/client-s3

**Source:** `/aws/aws-sdk-js-v3` (Context7, trust 9.6; versions indexed `v3.1153.0`/`v3.1145.0`, npm latest `3.1156.0`). Maps to `phase-03-videos/TD-02`, `phase-03-videos/TD-03`, `phase-03-videos/TD-04`.

### Client for MinIO and S3

```ts
import { S3Client } from '@aws-sdk/client-s3';

new S3Client({
  endpoint: 'http://minio:9000',   // custom endpoint overrides rule-based resolution
  forcePathStyle: true,            // host/bucket/key (required by MinIO)
  region: 'us-east-1',
  credentials: { accessKeyId, secretAccessKey },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});
```

**Checksum default (important):** `requestChecksumCalculation` defaults to `WHEN_SUPPORTED`, which makes `PutObject`/`UploadPart` add `x-amz-sdk-checksum-algorithm` + `x-amz-checksum-crc32` automatically. For presigned part URLs (the client cannot reproduce the checksum) and S3-compatible servers, set both options to `WHEN_REQUIRED` (aws-sdk-js-v3 issue #6810).

**Two clients (TD-03):** one client with the internal endpoint for server-side calls, and one with the public endpoint used **only** for `getSignedUrl` — SigV4 signs the host, so a URL signed for `minio:9000` is not valid at `localhost:9000` and vice versa.

### Multipart upload commands (TD-04)

| Command | Input (key fields) | Output used |
|---------|--------------------|-------------|
| `CreateMultipartUploadCommand` | `Bucket`, `Key`, `ContentType` | `UploadId` |
| `UploadPartCommand` (presigned) | `Bucket`, `Key`, `UploadId`, `PartNumber` | response header `ETag` (read by the uploader) |
| `ListPartsCommand` | `Bucket`, `Key`, `UploadId`, `PartNumberMarker`, `MaxParts` | `Parts[] { PartNumber, ETag, Size }`, `IsTruncated`, `NextPartNumberMarker` |
| `CompleteMultipartUploadCommand` | `Bucket`, `Key`, `UploadId`, `MultipartUpload: { Parts: [{ PartNumber, ETag }] }` (ascending) | — |
| `AbortMultipartUploadCommand` | `Bucket`, `Key`, `UploadId` | — |

Parts: 5 MiB minimum except the last part; part numbers 1..10000. The server can build the completion list itself from `ListParts` (paginate while `IsTruncated`), so clients do not need to read the `ETag` response header.

### Object commands

- `HeadObjectCommand({ Bucket, Key })` → `ContentLength`, `ContentType` (no body). A missing key surfaces as an error named `NotFound` (404 with empty body).
- `PutObjectCommand({ Bucket, Key, Body, ContentType })` — `Body` accepts Buffer or Node stream.
- `DeleteObjectCommand({ Bucket, Key })`.
- Errors: cast to `S3ServiceException` and switch on `error.name` or `error.$metadata.httpStatusCode`.

## @aws-sdk/s3-request-presigner

**Source:** `/aws/aws-sdk-js-v3` → `packages/s3-request-presigner`. Maps to `phase-03-videos/TD-04` (part URLs), `phase-03-videos/TD-08` (worker input URL), `phase-03-videos/TD-12` (delivery URLs).

```ts
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { GetObjectCommand, UploadPartCommand } from '@aws-sdk/client-s3';

// presigned part upload (client PUTs the raw bytes)
await getSignedUrl(publicClient, new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }), { expiresIn: 3600 });

// attachment download — response-header overrides must be signed
await getSignedUrl(publicClient, new GetObjectCommand({
  Bucket, Key,
  ResponseContentDisposition: 'attachment; filename="my-video.mp4"',
  ResponseContentType: 'video/mp4',
}), { expiresIn: 3600 });
```

- `expiresIn` defaults to **900** seconds when omitted; SigV4 caps it at 7 days.
- `ResponseContentDisposition` / `ResponseContentType` become `response-content-*` query parameters and are only honored on signed requests.
- `signableHeaders` / `unhoistableHeaders` force headers (e.g., `content-type`, `x-amz-checksum-sha256`) into the signature — not needed when checksums are `WHEN_REQUIRED`.

## ioredis

**Source:** `/taskforcesh/bullmq` → `docs/gitbook/guide/connections.md` + `package.json` (Context7). Maps to `phase-03-videos/TD-01` Revisions.

- BullMQ creates its connections with ioredis by default; the `connection` options passed to `BullModule.forRootAsync` (`{ host, port }`) go straight to the ioredis constructor.
- Peer range `ioredis >=5.0.0` (optional peer since bullmq 6); the project pins `^5.11.1`, the version bullmq 6.4.2 uses in its own test suite.
- Workers duplicate the connection for blocking commands and force `maxRetriesPerRequest: null` on it — do not pass a shared ioredis instance that overrides it.
