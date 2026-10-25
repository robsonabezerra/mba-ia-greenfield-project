---
scope_type: phase
related_phases: [3]
status: pending
date: 2026-10-25
scope_description: "Backend foundation for video ingestion: object storage usage, background job queue, direct-to-storage resumable upload of files up to 10GB, draft pre-registration, FFmpeg worker (metadata + thumbnail), unique video URLs, streaming and download delivery, and the video status lifecycle."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — receives the new `videos` module (draft pre-registration, upload orchestration, delivery endpoints), the storage and queue integrations, the video worker process and the new Compose services (object storage, queue broker, worker).
- `next-frontend/` — no open decision in this document: the phase scope defines no screen (no `Tela`/`Página` bullet) and the video UI is explicitly out of scope for this phase. The browser-side handshake implied by the upload protocol (TD-04) is described in that TD so a future frontend slice can consume it.

_Research notes (sources consulted on 2026-10-25):_ library docs via Context7 (`/nestjs/bull`, `/taskforcesh/bullmq`, `/aws/aws-sdk-js-v3`, `/minio/docs`, `/websites/ffmpeg_ffmpeg-all`); npm registry for current versions (`@nestjs/bullmq@12.0.0` peers `@nestjs/common ^10 || ^11 || ^12` and `bullmq ^3–^6`; `bullmq@6.4.2`; `@aws-sdk/client-s3@3.1156.0`; `minio@8.0.7`; `pg-boss@12.38.0`; `@golevelup/nestjs-rabbitmq@9.1.1`; `fluent-ffmpeg@2.1.3` is **deprecated** on npm); Docker Hub / quay.io for images (the official `minio/minio` Docker Hub repository no longer exists and `quay.io/minio/minio` requires authentication; the community fork `pgsty/minio` publishes S3-compatible MinIO builds that bundle `mc`). Installed backend stack: NestJS 11.1.16, TypeORM 0.3.28, `@nestjs/config` 4.0.3, Jest 30, Node 25 (dev image `node:25.6.0-slim`, Debian 12).

---

## TD-01: Background Job Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The architecture diagram (`docs/diagrams/software-arch.mermaid`) and `CLAUDE.md` list the Message Queue as **TBD**. Phase 03 needs a queue between the API (producer, after an upload completes) and the Video Worker (consumer running FFmpeg). Video jobs are long (seconds to minutes per file), must survive restarts, must be retried on transient failures, and must not be processed twice concurrently.

**Options:**

### Option A: BullMQ on Redis (`@nestjs/bullmq` + `bullmq`)
- Redis-backed job queue. `@nestjs/bullmq` provides `BullModule.forRootAsync`, `BullModule.registerQueue`, `@InjectQueue`, and `@Processor` classes extending `WorkerHost` (official NestJS integration, peers NestJS 11).
- **Pros:** First-class NestJS module (DI, lifecycle, `getQueueToken` for tests). Built-in retries with exponential backoff (`attempts`, `backoff`), custom `jobId` for idempotent enqueue, stalled-job recovery, per-worker `concurrency`, job progress. Redis is a small container. The project's testing guide already sketches the queue strategy with `BullModule.registerQueue({ name: 'video-processing' })`.
- **Cons:** Adds Redis as a new stateful service. Redis must be configured for persistence (AOF) if jobs must survive a Redis restart. Not a general-purpose message bus (no fan-out routing semantics).

### Option B: RabbitMQ (AMQP) via `@golevelup/nestjs-rabbitmq` or `@nestjs/microservices`
- AMQP broker with durable queues, manual acks and dead-letter exchanges; the worker consumes messages and acks after processing.
- **Pros:** Mature broker, strong delivery guarantees, routing/fan-out for future events (e.g., notifications). Management UI.
- **Cons:** Retries with delay require dead-letter + TTL topologies built by hand; no built-in job state (attempts, progress, failed set) — status tracking falls entirely to the DB. Heavier container (Erlang VM) for a 4GB dev VM. Less direct NestJS ergonomics for "job" semantics.

### Option C: PostgreSQL-backed queue (`pg-boss`)
- Jobs stored in PostgreSQL tables using `SKIP LOCKED`; no new infrastructure.
- **Pros:** Zero new services (PostgreSQL already in the stack). Enqueue can share the same DB transaction as the status update (atomic publish). Retries/backoff supported.
- **Cons:** No official NestJS module (manual provider wiring and lifecycle). Polling-based; adds write load to the primary DB. Smaller ecosystem than BullMQ.

**Recommendation:** **Option A (BullMQ on Redis)** — Official NestJS integration with job semantics this phase actually needs (attempts + exponential backoff, idempotent `jobId`, stalled recovery, concurrency control), at the cost of one lightweight Redis container. pg-boss's transactional enqueue is attractive but TD-15 covers consistency without it, and RabbitMQ would force hand-built retry topologies for a single job type.

**Decision:** A (BullMQ on Redis)
**Libraries:** @nestjs/bullmq@^12.0.0, bullmq@^6.4.2

---

## TD-02: Object Storage Client Library

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Storage is fixed as S3-compatible (MinIO locally, S3 in production). The API must create multipart uploads and presigned URLs; the worker must read source objects and write thumbnails. The client library determines how portable the code is between MinIO and S3.

**Options:**

### Option A: AWS SDK for JavaScript v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`)
- Modular SDK; `S3Client` configured with `endpoint` + `forcePathStyle: true` for MinIO and default resolution for AWS. `getSignedUrl(client, command, { expiresIn })` presigns any command (e.g., `UploadPartCommand`, `GetObjectCommand` with `ResponseContentDisposition`).
- **Pros:** Same code path for MinIO and AWS S3 (production target). Presigning works for every S3 operation, including multipart parts. Actively maintained, typed, tree-shakeable.
- **Cons:** Verbose command-object API. Two packages. Large dependency tree.

### Option B: MinIO JavaScript client (`minio`)
- MinIO's own S3-compatible SDK with `presignedUrl`, `presignedPutObject`, `fPutObject`, etc.
- **Pros:** Concise API, smaller footprint, good MinIO defaults.
- **Cons:** No public API to presign `UploadPart` for client-driven multipart (multipart is handled internally by `putObject`), which conflicts with TD-04. Less natural for an AWS S3 production target.

**Recommendation:** **Option A (AWS SDK v3)** — It is the only option that presigns individual multipart parts (required by TD-04) and keeps one code path for MinIO in development and S3 in production.

**Decision:** A (AWS SDK v3)
**Libraries:** @aws-sdk/client-s3@^3.1156.0, @aws-sdk/s3-request-presigner@^3.1156.0

---

## TD-03: Storage Organization, Keys and Endpoints

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Videos and thumbnails must be stored with predictable keys shared by the API (writes the source via presigned upload, reads for delivery) and the worker (reads the source, writes the thumbnail). The layout is a cross-component contract (API, worker, Compose bucket bootstrap). In Docker, the S3 endpoint the containers use (`http://minio:9000`) differs from the one a browser can reach (`http://localhost:9000`), and presigned URLs are signed for a specific host.

**Options:**

### Option A: Single private bucket, per-video key prefix
- One bucket (e.g., `streamtube`) with keys `videos/{videoId}/source` and `videos/{videoId}/thumbnail.jpg`; bucket is private and every client access goes through presigned URLs. Two S3 endpoints are configured: internal (`S3_ENDPOINT`, used for server-side calls) and public (`S3_PUBLIC_ENDPOINT`, used only to sign URLs handed to clients).
- **Pros:** One bucket to bootstrap and secure. Everything about a video lives under one prefix (easy deletion, lifecycle rules, cost accounting). Keys derive from the immutable `videoId`, never from user input. Separate public endpoint makes presigned URLs valid from the browser while containers keep using the service name (`CLAUDE.md` Docker networking rule).
- **Cons:** All objects share one bucket policy (no public-read thumbnails without presigning). Requires two endpoint settings.

### Option B: Separate buckets per asset type (`videos`, `thumbnails`)
- Source files in a private bucket; thumbnails in another bucket, optionally public-read.
- **Pros:** Thumbnails could be served without presigning (public bucket / CDN). Different lifecycle per bucket.
- **Cons:** Two buckets to bootstrap and configure; a video's assets are split across buckets. Public-read thumbnails leak assets of videos that are not yet ready/published (Phase 04 visibility).

**Recommendation:** **Option A (single private bucket, `videos/{videoId}/...` keys, internal + public endpoints)** — Minimal bootstrap, keys derived from the immutable id, and no accidental public exposure before Phase 04 defines visibility. The bucket is created by a one-shot Compose init service using the bundled `mc` CLI.

**Decision:** A (Single private bucket, per-video key prefix, internal + public endpoints)
**Libraries:** —

---

## TD-04: Upload Protocol for Files up to 10GB

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** A 10GB upload must not hold API resources (memory, sockets, event loop) and, per `docs/project-plan.md` § Pontos de Atenção, should be resumable after a connection failure. The protocol defines the handshake between the client (browser or any HTTP client) and the backend, and the moment the draft video is created. S3 limits: a single `PUT` is capped at 5GB; multipart uploads allow 5MB–5GB parts and up to 10,000 parts.

**Options:**

### Option A: S3 multipart upload with presigned part URLs (API orchestrates, bytes go straight to storage)
- `POST /videos` creates the draft video and calls `CreateMultipartUpload`; the client requests presigned `UploadPart` URLs, `PUT`s each part directly to storage, and calls a completion endpoint; the API lists the uploaded parts (`ListParts`) and calls `CompleteMultipartUpload`.
- **Pros:** Zero video bytes cross the API. Supports 10GB (and beyond) within S3 limits. Resumable: the client asks the API which parts already exist and re-sends only the missing ones; parts can be uploaded in parallel. Works identically on MinIO and S3. Backend side fully testable over HTTP.
- **Cons:** Multi-step handshake (initiate → sign parts → complete). Abandoned uploads leave orphan parts until aborted (needs an abort endpoint and/or storage cleanup). Browser uploads need CORS on the storage endpoint.

### Option B: Single presigned `PUT` URL
- The API creates the draft and returns one presigned `PutObject` URL; the client uploads the whole file in one request.
- **Pros:** Simplest handshake (one URL). No bytes through the API.
- **Cons:** S3 rejects single `PUT`s over 5GB — **cannot satisfy the 10GB requirement**. Not resumable: a failure at 9GB restarts from zero.

### Option C: tus resumable protocol (`@tus/server` mounted in the API, or a `tusd` container)
- Open resumable-upload protocol; the tus server receives chunks and writes them to S3.
- **Pros:** Standard resumable protocol with mature clients (Uppy, tus-js-client).
- **Cons:** When mounted in the API, every byte flows through the Node process (the thing this capability must avoid). A separate `tusd` service adds another container plus hook wiring to create the draft and enqueue processing. Duplicates what S3 multipart already provides natively.

### Option D: Streaming multipart/form-data through the API to S3
- The API pipes the request stream (e.g., busboy) into an S3 upload.
- **Pros:** Single request for the client; easy to validate during the stream.
- **Cons:** Holds an API connection for the whole 10GB transfer, consumes API bandwidth/CPU, not resumable, and a restart kills in-flight uploads. Directly contradicts "sem impacto na performance".

**Recommendation:** **Option A (S3 multipart with presigned part URLs)** — It is the only option that meets 10GB, keeps every video byte off the API, and is resumable, using storage-native primitives already chosen in TD-02. The draft video is created at `POST /videos` (initiation), which directly realizes "pré-cadastro como rascunho ao iniciar o upload". Depends on TD-02 and TD-03.

**Decision:** A (S3 multipart upload with presigned part URLs)
**Libraries:** @aws-sdk/client-s3@^3.1156.0, @aws-sdk/s3-request-presigner@^3.1156.0

**Note:** Resolved with phase-03-videos validation AMB-2 (2026-10-25): the draft's `title` defaults to the original file name without its extension; the client may send an optional `title` at initiation. Description/category stay empty until Phase 04.

---

## TD-05: Upload Size Limit and Part Sizing Policy

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** With TD-04 the client declares the file size at initiation and uploads parts. The backend must enforce the 10GB ceiling, decide the part size (S3: ≥5MB except the last part, ≤10,000 parts), and verify the final object. The policy is shared by the API validation, the client upload loop and the environment configuration.

**Options:**

### Option A: Server-defined fixed part size; declared size validated at initiation and verified at completion
- The API validates `file_size ≤ VIDEO_MAX_SIZE_BYTES` (10 GiB = 10737418240 bytes) at `POST /videos`, computes `part_count = ceil(file_size / UPLOAD_PART_SIZE_BYTES)` with a fixed part size (e.g., 64 MiB → 160 parts for 10 GiB), returns both to the client, and only signs part numbers in `1..part_count`. On completion it checks the object size (`HeadObject`) against the declared size and rejects mismatches.
- **Pros:** Client logic is trivial (slice by the returned `part_size`). Limits enforced server-side twice (declared + actual). Part numbers are bounded, so a client cannot inflate the object beyond the declared size. Tunable via env.
- **Cons:** One part size for every file (small files still get one part; very slow links re-send up to 64 MiB on failure).

### Option B: Client-chosen part size within server bounds
- The client picks the part size (between 5 MiB and a server maximum) and declares it; the server validates bounds and the 10,000-part cap.
- **Pros:** Clients on poor networks can choose smaller parts.
- **Cons:** More validation paths and client complexity for a benefit no consumer of this phase needs. Harder to reason about part-number bounds.

**Recommendation:** **Option A (fixed server-defined part size, double size check)** — Simplest contract for any client and the strongest server-side enforcement of the 10GB limit. Accepted content types are restricted at initiation to video MIME types (`video/*`); the authoritative format check is ffprobe in the worker (TD-07).

**Decision:** A (Server-defined fixed part size; declared size validated at initiation and verified at completion)
**Libraries:** —

---

## TD-06: Video Worker Runtime Model

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The architecture defines a separate **Video Worker (FFmpeg)** container that consumes jobs and updates DB and storage. The choice is how that worker is packaged relative to `nestjs-project/` and how it runs in Docker Compose.

**Options:**

### Option A: Same NestJS codebase, separate entrypoint and Compose service
- `nestjs-project/` gains a worker entrypoint (e.g., `src/worker.ts` bootstrapping a `WorkerModule` with `NestFactory.createApplicationContext`, no HTTP server). Compose runs a `video-worker` service from the same image (with FFmpeg installed) and a different command.
- **Pros:** Reuses entities, TypeORM config, storage service, Joi env schema and test tooling — no duplicated code. CPU-heavy FFmpeg work runs in its own container, isolated from the API event loop, and can be scaled independently (`docker compose up --scale video-worker=N`). One `package.json`, one lint/tsc/test pipeline.
- **Cons:** The API and worker images share dependencies (worker code ships with the API image and vice versa). The worker must not import HTTP-only modules (enforced by module boundaries).

### Option B: Separate standalone project (`video-worker/` subproject)
- A new subproject with its own `package.json`, consuming the queue and talking to DB/storage.
- **Pros:** Hard isolation; independent dependency set and release cycle.
- **Cons:** Duplicates entities/config/storage code or requires a shared package (monorepo tooling the repo does not have). New lint/test/CI surface. Overkill for one job type.

### Option C: Processor inside the API process
- `@Processor` registered in the API module; FFmpeg spawned from the API container.
- **Pros:** No new service; simplest wiring.
- **Cons:** FFmpeg CPU/IO load competes with HTTP traffic in the same container — contradicts the architecture's separate worker container and the "sem impacto na performance" goal. API restarts kill in-flight processing.

**Recommendation:** **Option A (same codebase, separate entrypoint + `video-worker` Compose service)** — Matches the architecture's separate worker container while reusing every existing building block; isolation is achieved at process/container level without monorepo tooling. Depends on TD-01.

**Decision:** A (Same NestJS codebase, separate entrypoint and Compose service)
**Libraries:** —

---

## TD-07: FFmpeg Integration

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The worker extracts duration/metadata (ffprobe) and renders one frame as a thumbnail (ffmpeg). The integration determines how binaries are installed and how the worker calls them.

**Options:**

### Option A: System `ffmpeg`/`ffprobe` from the OS package, invoked via `child_process.spawn`
- Install `ffmpeg` (Debian package) in the dev image; a thin `FfmpegService` spawns `ffprobe -v error -print_format json -show_format -show_streams <input>` and `ffmpeg ... -frames:v 1 <out.jpg>`, parsing JSON output and exit codes.
- **Pros:** No wrapper dependency; full control over arguments, timeouts and stderr capture. ffprobe's JSON output is a stable, documented contract. Same binaries available to tests running in the container.
- **Cons:** Thin wrapper code to maintain (argument building, process error handling). Image grows by the ffmpeg package.

### Option B: `fluent-ffmpeg` wrapper
- Fluent JS API over the ffmpeg binaries (`ffprobe()`, `screenshots()`).
- **Pros:** Convenient API, widely used historically.
- **Cons:** The package is **deprecated on npm** ("no longer supported"); still needs the system binaries. Adopting an unmaintained wrapper for a core path is a liability.

### Option C: npm-shipped static binaries (`ffmpeg-static` + `@ffprobe-installer/ffprobe`) with `child_process`
- Binaries downloaded at `npm install` time and resolved by path.
- **Pros:** No OS package step; pinned binary version per lockfile.
- **Cons:** Install-time binary downloads (fragile behind proxies/offline, architecture-specific on arm64/amd64 Macs and CI). `@ffprobe-installer/ffprobe` has not been updated since 2023.

**Recommendation:** **Option A (OS ffmpeg/ffprobe via `spawn`)** — Avoids a deprecated wrapper and install-time binary downloads; the Debian package is pinned by the image, and ffprobe JSON is a stable contract the worker can parse with typed code.

**Decision:** A (System ffmpeg/ffprobe via child_process.spawn)
**Libraries:** —

---

## TD-08: Worker Access to the Source Video

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The source object can be 10GB. ffprobe needs only the container header/index, and a single-frame thumbnail needs a seek to one position. How the worker feeds the file to FFmpeg drives disk usage and processing time. Depends on TD-02 and TD-07.

**Options:**

### Option A: Pass a short-lived presigned GET URL (internal endpoint) as FFmpeg input
- The worker presigns a `GetObject` URL on the internal endpoint and passes it to ffprobe/ffmpeg; FFmpeg's HTTP protocol issues range requests (`seekable` autodetect) and reads only what it needs.
- **Pros:** No local copy of a 10GB file; only header/index bytes and the frames around the seek point are transferred. Constant worker disk usage. Works for any object size.
- **Cons:** Containers with the moov atom at the end of the file require an extra seek (still range-based). Network hiccups mid-probe fail the attempt (covered by job retries, TD-14).

### Option B: Download the full object to a temp file, then run FFmpeg locally
- `GetObject` streamed to `/tmp`, then local ffprobe/ffmpeg.
- **Pros:** Local file access is fastest for repeated reads; no dependency on HTTP seek behavior.
- **Cons:** Up to 10GB of disk per concurrent job and a full transfer before any work starts; worker disk becomes a scaling limit.

**Recommendation:** **Option A (presigned URL as FFmpeg input)** — Metadata and a single frame need a tiny fraction of the file; streaming by range keeps worker disk constant regardless of upload size. Only the generated thumbnail is written to a temp file before upload.

**Decision:** A (Presigned GET URL as FFmpeg input)
**Libraries:** —

---

## TD-09: Thumbnail Frame Selection

**Scope:** Backend

**Capability:** Geração automática de thumbnail a partir de um frame do vídeo

**Context:** The thumbnail is extracted from one frame. The selection rule affects quality (avoiding black intro frames) and cost (how much of the file FFmpeg must decode).

**Options:**

### Option A: Fixed timestamp (e.g., 1s, clamped to duration)
- `-ss 1 -frames:v 1`.
- **Pros:** Cheapest; deterministic.
- **Cons:** Often captures fades/black frames at the start of videos.

### Option B: Relative position (10% of duration, clamped), single seek
- After ffprobe returns the duration, seek to `duration × 0.1` (fallback to 0 for very short videos) and grab one frame, scaled to a fixed width (e.g., 1280px, aspect preserved), JPEG.
- **Pros:** Avoids intros in most videos; still a single input seek (cheap with TD-08 range reads); deterministic.
- **Cons:** Still blind to content (may hit a transition frame). Depends on a valid duration.

### Option C: FFmpeg `thumbnail` filter (most representative frame in a batch)
- `-vf thumbnail` analyzes batches of frames (default 100) and picks the most representative.
- **Pros:** Better visual pick.
- **Cons:** Decodes many consecutive frames (CPU and range reads grow); memory grows with batch size; still needs a seek strategy to avoid analyzing only the intro.

**Recommendation:** **Option B (10% of duration, clamped, single seek, JPEG 1280px wide)** — Good-enough quality for an automatic thumbnail at the cost of one seek; custom thumbnails arrive in Phase 04 ("thumbnail customizada"). Depends on TD-07 and TD-08.

**Decision:** B (10% of duration, clamped, single seek, JPEG 1280px wide)
**Libraries:** —

---

## TD-10: Media Metadata Persistence Shape

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** ffprobe returns a large JSON document (format + per-stream data). The worker persists what it extracts; the API exposes it. The shape is shared by the worker (writer), the `videos` table and the API responses.

**Options:**

### Option A: Dedicated typed columns only
- Columns such as `duration_seconds`, `width`, `height`, `video_codec`, `audio_codec`, `bitrate`, `format_name`.
- **Pros:** Queryable and typed; simple API mapping.
- **Cons:** Every new attribute is a migration; loses the rest of ffprobe's output.

### Option B: Single `jsonb` column with the ffprobe summary
- `metadata jsonb` holding a curated subset of ffprobe output.
- **Pros:** Flexible, no migration per attribute.
- **Cons:** Duration (needed by listings in Phase 07 and by the player in Phase 05) is not a first-class typed column; harder to validate.

### Option C: Hybrid — typed `duration_seconds` + `jsonb metadata` for the curated technical summary
- Duration (the attribute the phase names explicitly) as a typed numeric column; width/height/codecs/bitrate/format/size in a typed-at-the-edge `jsonb` object.
- **Pros:** The explicitly required attribute is typed and queryable; the rest stays flexible without migrations.
- **Cons:** Two places to read metadata from; the `jsonb` shape must be documented in the Data Model.

**Recommendation:** **Option C (hybrid)** — The phase names duration explicitly ("extração de duração e metadados"), so it earns a typed column; the remaining technical attributes go to a documented `jsonb` object to avoid migrations for every new field.

**Decision:** C (Hybrid — typed duration_seconds + jsonb metadata)
**Libraries:** —

---

## TD-11: Unique Video URL Identifier

**Scope:** Cross-layer

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a short, unique, non-conflicting identifier for its URL (`docs/project-plan.md` § Pontos de Atenção: "URL curta e única que nunca conflite"). It becomes the public identifier the frontend routes on (Phase 05) and that unlisted links (Phase 04) rely on — so it must be unguessable, not just unique.

**Options:**

### Option A: Use the UUID primary key in the URL
- `/videos/{uuid}`.
- **Pros:** Already unique; no extra column.
- **Cons:** 36 characters — not "curta"; exposes the internal primary key.

### Option B: Random short ID (11 chars, base64url from `crypto.randomBytes(8)`) stored in a unique `slug` column, retry on collision
- 64 random bits encoded as 11 URL-safe characters (YouTube-like), generated with Node's `crypto`; a unique index guarantees no conflict and the service retries generation on the (astronomically rare) unique violation.
- **Pros:** Short, URL-safe, unguessable (64-bit entropy — suitable for future unlisted links). No dependency. Collision-proof by DB constraint, not by probability alone.
- **Cons:** Extra column + index; insert-retry path to handle.

### Option C: Encoded sequential number (Sqids/Hashids)
- Encode an auto-increment integer into a short string.
- **Pros:** Short, collision-free by construction.
- **Cons:** Reversible/enumerable (decoding reveals ordering and lets anyone walk all videos) — unacceptable for unlisted links; requires a sequence column and an extra dependency (`sqids@0.3.0`, last published 2023).

**Recommendation:** **Option B (11-char random base64url `slug` with unique index + retry)** — Short like the plan asks, unguessable for Phase 04's unlisted links, and conflict-free by constraint. The `slug` is the video's public identifier in every `/videos/:slug` route; the UUID stays internal.

**Decision:** B (11-char random base64url slug with unique index + retry)
**Libraries:** —

---

## TD-12: Playback (Streaming) and Download Delivery

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** The video must start playing without downloading the whole file (HTTP `Range` / `206 Partial Content`) and must be downloadable. The architecture diagram states "Frontend → Object Storage: Streams", i.e., playback bytes are expected to come from storage, not through the API. Depends on TD-02 and TD-03.

**Options:**

### Option A: API resolves the video and redirects (302) to a short-lived presigned storage URL
- `GET /videos/:slug/stream` → `302 Location: <presigned GetObject>`; the storage serves `Range` requests with `206 Partial Content` natively. `GET /videos/:slug/download` → `302` to a presigned URL signed with `ResponseContentDisposition: attachment; filename="..."`. The thumbnail uses the same pattern.
- **Pros:** Zero video bytes through the API (matches the diagram). Range/206, seeking and resumable downloads handled by S3/MinIO. A `<video src="/videos/{slug}/stream">` works directly because media elements follow redirects. Storage/CDN scale independently.
- **Cons:** Presigned URLs expire (players must re-request the API after expiry). Storage endpoint must be reachable by clients (TD-03 public endpoint).

### Option B: API proxies bytes with Range support
- The API parses the `Range` header, calls `GetObject` with the same range and pipes the body back as `206`.
- **Pros:** Single origin for clients; full control over headers and access checks per request.
- **Cons:** Every playback byte flows through the API process — bandwidth and connections scale with viewers, not with API logic. Duplicates what storage already does.

### Option C: Adaptive streaming (HLS/DASH) with transcoding in the worker
- The worker transcodes renditions and segments; clients play an `.m3u8`.
- **Pros:** Adaptive bitrate, industry standard for large platforms.
- **Cons:** Transcoding 10GB files is orders of magnitude heavier than metadata + thumbnail; multiplies storage. Not required by the phase ("sem necessidade de download completo" is satisfied by range requests).

**Recommendation:** **Option A (302 to presigned storage URLs for stream, download and thumbnail)** — Delivers range-based streaming and attachment downloads with no bytes through the API, exactly as the architecture diagram routes them; HLS remains a future option without changing the URL contract.

**Decision:** A (302 redirect to short-lived presigned storage URLs)
**Libraries:** @aws-sdk/s3-request-presigner@^3.1156.0

---

## TD-13: Access Policy for Video Delivery in Phase 03

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário", "URL única por vídeo, sem conflito com outros vídeos"

**Context:** Upload endpoints are clearly owner-only (authenticated, the video belongs to the user's channel). For streaming/download/metadata, Phase 03 has no visibility model yet (public/unlisted and draft → publish arrive in Phase 04; anonymous viewing is a Phase 05 bullet). The policy decides who can consume a video identified by its unique URL in this phase.

**Options:**

### Option A: Owner sees any status; everyone (anonymous included) can consume `ready` videos by slug
- `GET /videos/:slug`, `/stream`, `/download`, `/thumbnail` are `@Public()`; if the video is not `ready`, only the owner (valid bearer token for the owning channel) can see its details, and delivery endpoints answer "not ready". The unguessable slug (TD-11) acts as the access capability, like an unlisted link.
- **Pros:** Aligns with the product premise (anonymous watching) and with Phase 04's "unlisted = by link" semantics; `<video src>` works without auth headers. Phase 04 only narrows the policy (publication/visibility), it does not reverse it.
- **Cons:** Until Phase 04 lands, any holder of a ready video's slug can watch it even if the owner has not "published" it.

### Option B: Owner-only for every video endpoint in Phase 03
- All video endpoints require the owner's bearer token; anonymous access opens in Phase 05.
- **Pros:** No exposure before publication exists.
- **Cons:** Media elements cannot send bearer headers, so streaming needs an extra "get playback URL" JSON indirection now and a contract change later; contradicts the URL-as-identifier purpose of TD-11.

**Recommendation:** **Option A (public by slug for `ready` videos; owner-only details while not ready)** — Keeps the delivery contract stable across Phases 04/05 (they add visibility filters on top) and lets standard media elements consume the stream URL. Depends on TD-11 and TD-12.

**Decision:** A (Public by slug for ready videos; owner-only details while not ready)
**Libraries:** —

---

## TD-14: Video Status Lifecycle and Failure Handling

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The video moves from pre-registration to a playable state through steps owned by different components (API: initiation and upload completion; worker: processing). The lifecycle must be observable in the database and define what happens when processing fails. Phase 04 will add a separate publication dimension (draft → published); this TD covers the ingestion lifecycle only. Depends on TD-01 and TD-04.

**Options:**

### Option A: Single `status` enum `draft → processing → ready | failed`, worker retries with backoff, terminal `failed` with stored reason
- `draft`: created at upload initiation (multipart open). `processing`: set by the API when the upload is completed and the job is enqueued. `ready`: set by the worker after metadata + thumbnail succeed. `failed`: set by the worker when the last retry attempt fails (e.g., 3 attempts, exponential backoff), storing a short `processing_error`. Only `draft` accepts upload operations; only `ready` is deliverable.
- **Pros:** Literal mapping of the phase wording (rascunho → processando → pronto/erro); one column to query; transient failures (network, storage hiccups) are absorbed by retries; permanent failures (not a video) end in a visible terminal state.
- **Cons:** "draft" here means "ingestion not finished" — Phase 04 must name its publication state distinctly (documented now to avoid ambiguity). No automatic reprocessing of `failed` videos in this phase.

### Option B: Finer-grained statuses (`draft`, `uploading`, `uploaded`, `processing`, `ready`, `failed`)
- Separate states for "upload in progress" and "uploaded, waiting for worker".
- **Pros:** More detailed progress reporting.
- **Cons:** `uploading` cannot be observed reliably (parts go straight to storage, the API does not see them); `uploaded` vs `processing` differ only by queue latency. More transitions to test with no consumer in this phase.

**Recommendation:** **Option A (four-state enum with retries and terminal `failed` + reason)** — Matches the phase wording, keeps every transition owned by exactly one component, and makes failure explicit in the database.

**Decision:** A (draft → processing → ready/failed, retries with backoff, failed + reason)
**Libraries:** bullmq@^6.4.2

**Note:** Resolved with phase-03-videos validation AMB-1 (2026-10-25): `draft` is the ingestion state (pre-registered, upload not yet completed) of this lifecycle — it is NOT the publication draft of Phase 04. Publication (draft → published, visibility) is a separate dimension that Phase 04 introduces.

---

## TD-15: Job Publishing Consistency and Idempotency

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** On upload completion the API must both flip the video to `processing` (PostgreSQL) and enqueue a job (Redis) — two systems without a shared transaction. Duplicate completion calls (client retries) and redeliveries (worker crash, stalled jobs) must not corrupt state. Depends on TD-01 and TD-14.

**Options:**

### Option A: DB-guarded transition + enqueue with deterministic `jobId` = video id + idempotent worker
- The API performs a conditional update (`draft → processing` only if still `draft`) and then enqueues with `jobId = videoId`; BullMQ ignores a duplicate `jobId`. If enqueue fails, the API reverts the status to `draft` and returns an error so the client can retry completion. The worker treats the job as idempotent (deterministic thumbnail key, final update only when status is `processing`).
- **Pros:** No extra tables or relay process; duplicate completions and redeliveries are harmless; failure window is explicit and recoverable by the client.
- **Cons:** A crash between the DB update and the enqueue leaves a `processing` video without a job (narrow window; needs a manual or future reconciliation).

### Option B: Transactional outbox
- The status change and an `outbox` row are written in one DB transaction; a relay publishes outbox rows to the queue and marks them sent.
- **Pros:** Exactly-once intent; no lost jobs even on crashes.
- **Cons:** New table, a relay loop (polling) and its own failure modes — significant machinery for a single job type.

### Option C: Enqueue first, then update the DB
- Publish the job, then mark `processing`.
- **Pros:** Never loses the job.
- **Cons:** The worker may start before the status flips (race), and a DB failure after enqueue leaves a job for a `draft` video; requires the worker to tolerate inconsistent states.

**Recommendation:** **Option A (guarded transition + deterministic jobId + idempotent worker)** — Covers duplicates and redeliveries with mechanisms BullMQ already provides; the outbox's guarantees do not justify its machinery for one job type in this phase.

**Decision:** A (DB-guarded transition + deterministic jobId = video id + idempotent worker)
**Libraries:** bullmq@^6.4.2

---

## TD-16: Testing Strategy for Storage, Queue and FFmpeg

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The testing guide (`testing-guide-nestjs-project` → `references/external-systems.md`) suggests a local-filesystem storage adapter for tests and a real broker in Docker for the queue (technology then TBD). Phase 03's critical risks live at the boundaries: presigned multipart against a real S3 API, range requests, queue delivery and FFmpeg on real media. The strategy decides which of those are exercised for real.

**Options:**

### Option A: Real infrastructure from Compose (MinIO, Redis, FFmpeg) with generated media fixtures and isolated queue prefix
- Integration and E2E tests talk to the Compose `minio` and `redis` services and run the real ffmpeg binary; small test videos are generated at test time with ffmpeg's `lavfi` sources (`testsrc`/`sine`), so no binary fixtures are committed. Tests use a dedicated BullMQ key prefix so the long-running `video-worker` service never steals test jobs; full-flow E2E runs an in-process worker context.
- **Pros:** Exercises the actual contracts that can break (SigV4 presigning, multipart completion, 206 responses, ffprobe parsing, retries). Follows the existing project practice of real PostgreSQL and real Mailpit in tests.
- **Cons:** Slower tests; requires all Compose services up; ffmpeg needed in the test container image.

### Option B: Local filesystem storage adapter in tests (testing guide default) + real queue
- A `StorageService` abstraction with a filesystem driver for tests and S3 in runtime.
- **Pros:** Fast, no MinIO dependency in tests.
- **Cons:** Presigned URLs and multipart semantics do not exist on a filesystem — the core of TD-04/TD-12 would be untested; adds a production-unused driver.

### Option C: Mock storage/queue/FFmpeg clients in unit tests only
- **Pros:** Fastest.
- **Cons:** Proves nothing about the integrations that make this phase risky; violates the project's "real systems for boundaries" testing principle.

**Recommendation:** **Option A (real MinIO + Redis + FFmpeg, generated fixtures, isolated queue prefix)** — The risky contracts of this phase only exist against a real S3 API and real media; this deliberately replaces the guide's filesystem-adapter suggestion for storage, which cannot express presigned multipart or range delivery. Unit tests (mocked collaborators) remain for branching logic.

**Decision:** A (Real MinIO + Redis + FFmpeg from Compose, generated fixtures, isolated queue prefix)
**Libraries:** —

---

## TD-17: Abandoned Upload Cleanup

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** With TD-04 every upload opens an S3 multipart upload and a `draft` video row at initiation. If the client never completes (closed tab, lost connection, gave up), the already-uploaded parts — up to 10GB — stay in storage, invisible but billed, and the draft row lingers. `docs/project-plan.md` § Pontos de Atenção calls out storage growth and cost. Research finding (Context7 `/minio/docs`, S3 API compatibility page): MinIO does **not** support the `AbortIncompleteMultipartUpload` lifecycle action, so the S3-native cleanup rule is not available in the local stack. Depends on TD-01, TD-04 and TD-14.

**Options:**

### Option A: Explicit client cancellation only
- An owner-only endpoint cancels an upload: aborts the multipart upload (`AbortMultipartUpload`) and deletes the `draft` row.
- **Pros:** Smallest surface; immediate cleanup when the client cooperates.
- **Cons:** Does nothing for silent abandonment (the common case: crash, closed browser) — orphan parts accumulate indefinitely.

### Option B: Explicit cancellation + scheduled sweeper of expired drafts in the worker
- Same cancellation endpoint as A, plus a BullMQ job scheduler (`queue.upsertJobScheduler`, e.g., hourly) consumed by the worker that finds `draft` videos older than `UPLOAD_EXPIRATION_HOURS` (e.g., 24h), aborts their multipart uploads and deletes the rows. Presigned part URLs never outlive the upload expiration.
- **Pros:** Covers silent abandonment; identical behavior on MinIO and S3 (no dependency on storage lifecycle support); reuses the queue/worker already introduced; deterministic and testable (the sweep is a plain service method).
- **Cons:** One more scheduled job and a time-based policy to configure; a user resuming after the expiration finds the upload gone (must start over).

### Option C: Storage lifecycle rule only (`AbortIncompleteMultipartUpload` after N days)
- Configure the bucket lifecycle to abort incomplete multipart uploads automatically.
- **Pros:** Zero application code; storage-native on AWS S3.
- **Cons:** Not supported by MinIO (local stack and tests would behave differently from production); leaves `draft` rows orphaned in the database; no explicit cancellation for clients.

**Recommendation:** **Option B (cancellation endpoint + scheduled sweeper in the worker)** — The only option that behaves the same on MinIO and S3 and cleans both storage and database, reusing BullMQ (TD-01) and the worker (TD-06) instead of depending on lifecycle features MinIO lacks.

**Decision:** _[pending]_

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Background Job Queue Technology | BullMQ on Redis | A (BullMQ on Redis) |
| TD-02 | Backend | Object Storage Client Library | AWS SDK v3 | A (AWS SDK v3) |
| TD-03 | Backend | Storage Organization, Keys and Endpoints | Single private bucket, `videos/{videoId}/...`, internal + public endpoints | A (Single private bucket, per-video key prefix, internal + public endpoints) |
| TD-04 | Cross-layer | Upload Protocol for Files up to 10GB | S3 multipart with presigned part URLs | A (S3 multipart upload with presigned part URLs) |
| TD-05 | Cross-layer | Upload Size Limit and Part Sizing Policy | Fixed server part size + double size check | A (Server-defined fixed part size; declared size validated at initiation and verified at completion) |
| TD-06 | Backend | Video Worker Runtime Model | Same codebase, separate entrypoint + Compose service | A (Same NestJS codebase, separate entrypoint and Compose service) |
| TD-07 | Backend | FFmpeg Integration | OS ffmpeg/ffprobe via `spawn` | A (System ffmpeg/ffprobe via child_process.spawn) |
| TD-08 | Backend | Worker Access to the Source Video | Presigned URL as FFmpeg input | A (Presigned GET URL as FFmpeg input) |
| TD-09 | Backend | Thumbnail Frame Selection | 10% of duration, single seek, JPEG 1280px | B (10% of duration, clamped, single seek, JPEG 1280px wide) |
| TD-10 | Backend | Media Metadata Persistence Shape | Hybrid: typed duration + `jsonb` metadata | C (Hybrid — typed duration_seconds + jsonb metadata) |
| TD-11 | Cross-layer | Unique Video URL Identifier | 11-char random base64url `slug` + unique index | B (11-char random base64url slug with unique index + retry) |
| TD-12 | Cross-layer | Playback (Streaming) and Download Delivery | 302 to presigned storage URLs | A (302 redirect to short-lived presigned storage URLs) |
| TD-13 | Cross-layer | Access Policy for Video Delivery in Phase 03 | Public by slug when `ready`; owner-only while not ready | A (Public by slug for ready videos; owner-only details while not ready) |
| TD-14 | Cross-layer | Video Status Lifecycle and Failure Handling | `draft → processing → ready \| failed` + retries | A (draft → processing → ready/failed, retries with backoff, failed + reason) |
| TD-15 | Backend | Job Publishing Consistency and Idempotency | Guarded transition + `jobId` = video id + idempotent worker | A (DB-guarded transition + deterministic jobId = video id + idempotent worker) |
| TD-16 | Backend | Testing Strategy for Storage, Queue and FFmpeg | Real MinIO + Redis + FFmpeg, generated fixtures | A (Real MinIO + Redis + FFmpeg from Compose, generated fixtures, isolated queue prefix) |
| TD-17 | Backend | Abandoned Upload Cleanup | Cancellation endpoint + scheduled sweeper in the worker | _[pending]_ |
