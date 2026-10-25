---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-10-25T13:42:43-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-10-25T13:42:53-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-25T13:42:43-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-10-25T12:22:15-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar a ingestão de vídeos de ponta a ponta no backend — serviço de armazenamento (S3/MinIO) para vídeos e thumbnails, fila de processamento em segundo plano (BullMQ/Redis) consumida por um worker FFmpeg, upload de até 10GB direto ao storage com pré-cadastro do vídeo como rascunho, extração automática de duração/metadados e thumbnail, URL única por vídeo, reprodução via streaming e download — de forma que upload, processamento, streaming e URLs únicas funcionem sem impacto na performance da API.

---

## Step Implementations

### SI-03.1 — Infra: dependências, configuração e serviços de storage e fila no Compose

**Description:** Instalar as libs da fase, adicionar FFmpeg à imagem de dev, subir MinIO (+ bootstrap do bucket) e Redis no Compose e criar os namespaces de configuração `storage`, `queue` e `videos` — fundação de infraestrutura de todas as SIs seguintes.

**Technical actions:**

1. Instalar em `nestjs-project`: `@nestjs/bullmq@^12.0.0`, `bullmq@^6.4.2` (per `phase-03-videos/TD-01`), `@aws-sdk/client-s3@^3.1156.0`, `@aws-sdk/s3-request-presigner@^3.1156.0` (per `phase-03-videos/TD-02`)
2. Atualizar `nestjs-project/Dockerfile.dev` — incluir `ffmpeg` no `apt install` (fornece `ffmpeg`/`ffprobe` do Debian à API e ao worker) (per `phase-03-videos/TD-07`)
3. Atualizar `nestjs-project/compose.yaml` — serviços `minio` (`pgsty/minio:RELEASE.2026-08-04T00-00-00Z`, `server /data --console-address ":9001"`, portas 9000/9001, credenciais `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` = `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`, volume nomeado, healthcheck `curl -f http://localhost:9000/minio/health/live`), `minio-init` (mesma imagem, `mc alias set` + `mc mb --ignore-existing` do `S3_BUCKET`, `depends_on: minio: service_healthy`), `redis` (`redis:8.8-alpine`, `--appendonly yes`, volume nomeado, healthcheck `redis-cli ping`); `nestjs-api` passa a depender de `redis` (healthy) e `minio-init` (`service_completed_successfully`) (per `phase-03-videos/TD-01`, `phase-03-videos/TD-03`)
4. Criar `src/config/storage.config.ts`, `src/config/queue.config.ts`, `src/config/videos.config.ts` (`registerAs`, chaves e defaults da tabela "Configuração nova" do Data Model), registrá-los no `load` do `ConfigModule.forRoot` em `AppModule`, estender `src/config/env.validation.ts` (`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` obrigatórias, `UPLOAD_PART_SIZE_BYTES` ≥ 5242880, demais com default) e documentar tudo em `.env.example` (per `phase-03-videos/TD-03`, `phase-03-videos/TD-05`, `phase-03-videos/TD-17`)
5. Criar `src/test/setup-test-env.ts` (carregado após `dotenv/config` em `setupFiles` do jest unit e do `test/jest-e2e.json`) — força `S3_PUBLIC_ENDPOINT = S3_ENDPOINT` (URLs assinadas resolvíveis de dentro do container), `QUEUE_PREFIX = 'streamtube-test'` e `UPLOAD_PART_SIZE_BYTES = '5242880'` nos testes (per `phase-03-videos/TD-16`)

> _Amendment (registrado na execução da SI-03.4):_ `@nestjs/bullmq` fixado em `^11.0.5` (o `12.0.0` é ESM-only) e `ioredis@^5.11.1` adicionado como peer exigido pelo `bullmq@6` — per `phase-03-videos/TD-01` Revisions.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `envValidationSchema` (chaves de storage/fila/vídeos) | Integration: obrigatoriedade de `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`, defaults aplicados, `UPLOAD_PART_SIZE_BYTES` < 5242880 rejeitado | `src/config/env.validation.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` deixa `minio` e `redis` com status `healthy` e `minio-init` termina com exit code 0
- Após o bootstrap, o bucket `streamtube` existe no MinIO (`mc ls` lista o bucket) e não é público
- `docker compose exec nestjs-api ffprobe -version` e `ffmpeg -version` retornam exit code 0
- Subir a aplicação sem `S3_ACCESS_KEY_ID` falha na validação Joi do bootstrap
- `GET /` continua retornando 200 (suíte e2e existente verde)

---

### SI-03.2 — StorageModule e StorageService (S3/MinIO)

**Description:** Encapsular todo acesso ao object storage num `StorageService` reutilizável pela API e pelo worker — multipart upload, URLs assinadas e operações de objeto — com os dois clientes S3 (interno e público) exigidos pelo layout decidido.

**Technical actions:**

1. Criar `src/storage/storage.constants.ts` (tokens `S3_INTERNAL_CLIENT`, `S3_PUBLIC_CLIENT`) e `src/storage/storage.module.ts` — providers de `S3Client` a partir de `storageConfig` (`endpoint` = `S3_ENDPOINT` / `S3_PUBLIC_ENDPOINT`, `forcePathStyle: true`, `region`, `credentials`, `requestChecksumCalculation: 'WHEN_REQUIRED'`, `responseChecksumValidation: 'WHEN_REQUIRED'`); exporta `StorageService` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-03`)
2. Implementar em `src/storage/storage.service.ts` o multipart: `createMultipartUpload(key, contentType): Promise<string>`, `presignUploadPart(key, uploadId, partNumber, expiresIn): Promise<string>` (cliente público), `listParts(key, uploadId): Promise<{ partNumber; size; etag }[]>` (paginando enquanto `IsTruncated`), `completeMultipartUpload(key, uploadId, parts)`, `abortMultipartUpload(key, uploadId)` (per `phase-03-videos/TD-04`)
3. Implementar operações de objeto: `headObject(key): Promise<{ contentLength; contentType } | null>` (erro `NotFound` → `null`, demais erros propagam), `putObject(key, body, contentType)`, `deleteObject(key)` (per `phase-03-videos/TD-03`)
4. Implementar URLs de leitura: `presignGetObject(key, { expiresIn, responseContentType?, responseContentDisposition? })` com o cliente público (entrega, per `phase-03-videos/TD-12`) e `presignInternalGetObject(key, expiresIn)` com o cliente interno (entrada do FFmpeg no worker, per `phase-03-videos/TD-08`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration (MinIO real): multipart completo com `PUT` via `fetch` nas URLs assinadas, `listParts` com tamanhos, `complete` + `headObject`, `GET` assinado com `Range: bytes=0-99` → 206, `response-content-disposition` aplicado, `abortMultipartUpload`, `headObject` de chave inexistente → `null`, `deleteObject` | `src/storage/storage.service.integration-spec.ts` |
| `StorageModule` | Unit: compilação do módulo com `storageConfig` | `src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.1 — MinIO no Compose, config `storage` e libs AWS instaladas

**Acceptance criteria:**

- Um objeto enviado em 2 partes por URLs assinadas de `UploadPart` fica disponível após `completeMultipartUpload`, com `ContentLength` igual à soma das partes
- Uma URL de `GetObject` assinada com o endpoint público é aceita pelo MinIO e responde `206 Partial Content` com `Content-Range` para `Range: bytes=0-99`
- Uma URL assinada com `responseContentDisposition: attachment; filename="x.mp4"` faz o storage responder com esse `Content-Disposition`
- Após `abortMultipartUpload`, o `UploadId` deixa de ser aceito pelo storage
- `headObject` de uma chave inexistente retorna `null` sem lançar

---

### SI-03.3 — Entidade Video, relação com Channel e migration CreateVideos

**Description:** Criar a tabela `videos` ligada ao canal, com status, chaves de storage, duração, metadados e o `slug` da URL única, e manter o teste de migrations cobrindo o novo schema.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` (`@Entity('videos')`, colunas, índices e transformers do Data Model), `src/videos/video-status.enum.ts` (`VideoStatus` = `draft | processing | ready | failed`) e `src/videos/video-metadata.types.ts` (`VideoMetadata`) (per `phase-03-videos/TD-10`, `phase-03-videos/TD-11`, `phase-03-videos/TD-14`)
2. Adicionar `@OneToMany(() => Video, (video) => video.channel) videos: Video[]` em `src/channels/entities/channel.entity.ts` (relação nos dois lados, rule de entities)
3. Criar `src/videos/videos.module.ts` com `TypeOrmModule.forFeature([Video])` e registrar `VideosModule` em `AppModule`
4. Gerar `src/database/migrations/<timestamp>-CreateVideos.ts` com `npm run migration:generate -- src/database/migrations/CreateVideos` e revisar o SQL (enum `videos_status_enum`, FK `ON DELETE CASCADE`, unique `slug`, índices `channel_id` e `(status, created_at)`)
5. Atualizar `src/database/migrations.integration-spec.ts` (3 migrations, tabela `videos` em `MANAGED_TABLES`, remoção dos tipos enum antes de re-aplicar) e `cleanAllTables` em `src/test/create-test-data-source.ts` (apagar `videos` antes de `channels`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: `slug` único, `status` default `draft`, enum rejeita valor inválido, cascade ao apagar o canal, `file_size_bytes`/`duration_seconds` retornam `number`, `metadata` jsonb ida-e-volta | `src/videos/entities/video.entity.integration-spec.ts` |
| Migrations | Integration: aplica as 3 migrations do zero e cria as 5 tabelas; reverte a última e remove `videos` | `src/database/migrations.integration-spec.ts` |
| `VideosModule` | Unit: compilação com `TypeOrmModule.forFeature([Video])` | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.1 — dependências e config da fase (a migration roda no mesmo container)

**Acceptance criteria:**

- `npm run migration:run` cria a tabela `videos` com todas as colunas, o tipo `videos_status_enum`, a FK para `channels` e os índices do Data Model
- Inserir dois vídeos com o mesmo `slug` falha por violação de unicidade
- Um vídeo inserido sem `status` explícito fica `draft`
- Apagar um canal apaga os vídeos dele (cascade)
- `npm run migration:revert` remove a tabela `videos` e o tipo `videos_status_enum`

---

### SI-03.4 — Fila: QueueModule (BullMQ) e VideoProcessingProducer

**Description:** Conectar a aplicação ao Redis via BullMQ, registrar a fila `video-processing` e criar o produtor que enfileira `process-video` de forma idempotente — o lado "publica job" da arquitetura.

**Technical actions:**

1. Criar `src/queue/queue.module.ts` — `BullModule.forRootAsync({ inject: [queueConfig.KEY], useFactory: (cfg) => ({ connection: { host: cfg.host, port: cfg.port }, prefix: cfg.prefix }) })`; importar em `AppModule` (per `phase-03-videos/TD-01`)
2. Criar `src/videos/videos.constants.ts` (`VIDEO_PROCESSING_QUEUE`, `VIDEO_JOBS`), `src/videos/video-jobs.types.ts` (`ProcessVideoJobData = { videoId: string }`) e `src/videos/video-storage-keys.ts` (`videoSourceKey(id)`, `videoThumbnailKey(id)`) (per `phase-03-videos/TD-03`)
3. Registrar `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })` em `VideosModule`
4. Criar `src/videos/video-processing.producer.ts` — `enqueueProcessing(videoId): Promise<void>` → `queue.add(VIDEO_JOBS.PROCESS, { videoId }, { jobId: videoId, attempts: VIDEO_PROCESSING_ATTEMPTS, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: false, removeOnFail: false })` (per `phase-03-videos/TD-14`, `phase-03-videos/TD-15`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingProducer` | Integration (Redis real, prefixo de teste): job `process-video` enfileirado com `{ videoId }`, `jobId = videoId`, `attempts` e `backoff`; segundo enqueue do mesmo id não cria outro job | `src/videos/video-processing.producer.integration-spec.ts` |
| `QueueModule` | Unit: compilação de `BullModule.forRootAsync` com `queueConfig` | `src/queue/queue.module.spec.ts` |

**Dependencies:** SI-03.1 — Redis no Compose, config `queue` e libs BullMQ instaladas

**Acceptance criteria:**

- `enqueueProcessing(id)` cria na fila `video-processing` um job `process-video` com id igual ao `videoId` e payload `{ videoId }`
- Chamar `enqueueProcessing(id)` duas vezes resulta em um único job na fila
- As chaves do BullMQ ficam sob o prefixo configurado em `QUEUE_PREFIX` (testes não tocam no prefixo de dev)

---

### SI-03.5 — Pré-cadastro do vídeo como rascunho (POST /videos)

**Description:** Iniciar um upload: validar o tamanho declarado, abrir o multipart no storage e persistir o vídeo como `draft` com `slug` único — o pré-cadastro automático ao iniciar o upload.

**Technical actions:**

1. Adicionar `findByUserId(userId): Promise<Channel | null>` em `src/channels/channels.service.ts` (o domínio de canais é dono da consulta) e adicionar as exceções de domínio do Error Catalog em `src/common/exceptions/domain.exception.ts` (`ChannelNotFoundException`, `VideoFileTooLargeException`, `VideoNotFoundException`, `VideoNotOwnedException`, `VideoNotUploadableException`, `InvalidUploadPartException`, `UploadIncompleteException`, `UploadSizeMismatchException`, `VideoNotReadyException`, `ProcessingQueueUnavailableException`) (per `phase-02-auth/TD-07`)
2. Criar `src/videos/slug.util.ts` — `generateVideoSlug(): string` (`crypto.randomBytes(8).toString('base64url')`, 11 caracteres) (per `phase-03-videos/TD-11`)
3. Criar `src/videos/videos.service.ts` — `initiateUpload(userId, dto)`: canal do usuário (`CHANNEL_NOT_FOUND`), `file_size > VIDEO_MAX_SIZE_BYTES` → `VideoFileTooLargeException`, `part_count = ceil(file_size / UPLOAD_PART_SIZE_BYTES)`, `id = randomUUID()`, `storage_key = videoSourceKey(id)`, `createMultipartUpload`, `save` do `draft` (`title` = `dto.title` ou `file_name` sem extensão) com nova tentativa de `slug` em violação de unicidade (máx. 5); se a persistência falhar, abortar o multipart antes de propagar o erro (per `phase-03-videos/TD-04`, `phase-03-videos/TD-05`, `phase-03-videos/TD-11`)
4. Criar `src/videos/dto/create-video.dto.ts` (`CreateVideoDto`, Validation Rules) e `src/videos/dto/created-video-response.dto.ts`; criar `src/videos/videos.controller.ts` (`@ApiTags('videos')`, `@Controller('videos')`, `@SkipThrottle()`) com `POST /videos` → 201, `@ApiBearerAuth('access-token')` e um `@ApiResponse` por status do contrato (per `openapi-docs-nestjs/TD-01`)
5. Atualizar `VideosModule` — imports `ChannelsModule`, `StorageModule`; controller `VideosController`; provider `VideosService`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `generateVideoSlug` | Unit: 11 caracteres do alfabeto base64url, valores distintos em chamadas sucessivas | `src/videos/slug.util.spec.ts` |
| `VideosService.initiateUpload` | Unit (mocks): 413 acima do limite, canal ausente, `title` default, `part_count`, retry de `slug` em colisão, abort do multipart quando o `save` falha | `src/videos/videos.service.spec.ts` |
| `VideosService.initiateUpload` | Integration (DB + MinIO reais): `draft` persistido com `upload_id`, `storage_key` e `slug`; multipart aberto no storage (`listParts` vazio) | `src/videos/videos.service.integration-spec.ts` |
| `ChannelsService.findByUserId` | Integration: retorna o canal do usuário; `null` para usuário sem canal | `src/channels/channels.service.integration-spec.ts` |
| `POST /videos` | E2E: 201 com contrato; 400 validação; 401 sem token; 413 acima do limite | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.2 — `StorageService` para abrir o multipart; SI-03.3 — entidade `Video` e `VideosModule`

**Acceptance criteria:**

- `POST /videos` autenticado com `{ file_name: "aula.mp4", file_size: 104857600, content_type: "video/mp4" }` retorna `201` com `status: "draft"`, `title: "aula"`, `slug` de 11 caracteres e `upload.part_count = ceil(104857600 / part_size)`
- Após o `201`, existe um registro em `videos` com `status = 'draft'`, `upload_id` preenchido e `storage_key = videos/{id}/source`
- `POST /videos` com `file_size` = `VIDEO_MAX_SIZE_BYTES + 1` retorna `413` com `error: "VIDEO_FILE_TOO_LARGE"` e nenhum registro é criado
- `POST /videos` com `content_type: "image/png"` retorna `400` com `error: "VALIDATION_ERROR"`
- `POST /videos` sem token retorna `401`
- Dois vídeos criados em sequência recebem `slug`s diferentes

---

### SI-03.6 — Assinatura de partes e estado do upload (retomada)

**Description:** Permitir que o dono do rascunho obtenha URLs assinadas para enviar as partes direto ao storage e consulte quais partes já subiram — o que torna o upload de 10GB retomável sem passar bytes pela API.

**Technical actions:**

1. Implementar em `VideosService` o carregamento do rascunho do dono por `slug`: inexistente → `VideoNotFoundException`; canal ≠ canal do usuário → `VideoNotOwnedException`; `status` ≠ `draft` → `VideoNotUploadableException` (Authorization Matrix)
2. Implementar `signUploadParts(userId, slug, dto)` — `part_number > upload_part_count` → `InvalidUploadPartException`; `expiresIn = min(PRESIGNED_URL_EXPIRES_IN_SECONDS, segundos até created_at + UPLOAD_EXPIRATION_HOURS)`; `presignUploadPart` por parte, em ordem crescente (per `phase-03-videos/TD-04`, `phase-03-videos/TD-17`)
3. Implementar `getUploadState(userId, slug)` — `listParts` → `uploaded_parts` `{ part_number, size }` + `part_size`, `part_count`, `expires_at` (per `phase-03-videos/TD-04`)
4. Criar `src/videos/dto/sign-upload-parts.dto.ts` (`@IsArray`, `@ArrayMinSize(1)`, `@ArrayMaxSize(100)`, `@ArrayUnique`, `@IsInt({ each: true })`, `@Min(1, { each: true })`) e os response DTOs; adicionar ao `VideosController` `POST /videos/:slug/upload/parts` (200, `@HttpCode(HttpStatus.OK)`) e `GET /videos/:slug/upload` (200), documentados no OpenAPI

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.signUploadParts` / `getUploadState` | Unit (mocks): 404/403/409, parte fora do intervalo, expiração limitada pela expiração do upload | `src/videos/videos.service.spec.ts` |
| `VideosService.signUploadParts` / `getUploadState` | Integration (DB + MinIO reais): URL assinada aceita `PUT` da parte; estado passa a listar a parte enviada com seu tamanho | `src/videos/videos.service.integration-spec.ts` |
| `POST /videos/:slug/upload/parts`, `GET /videos/:slug/upload` | E2E: 200 com contrato; 400 validação e `INVALID_UPLOAD_PART`; 401; 403 outro usuário; 404 slug desconhecido | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.5 — rascunho criado por `POST /videos`

**Acceptance criteria:**

- `POST /videos/:slug/upload/parts` com `{ part_numbers: [1, 2] }` pelo dono retorna `200` com duas URLs em ordem crescente e `expires_at` ≤ expiração do upload
- Um `PUT` com os bytes da parte na URL retornada é aceito pelo storage (`200`)
- `GET /videos/:slug/upload` após enviar a parte 1 retorna `uploaded_parts: [{ part_number: 1, size: <bytes enviados> }]`
- `POST /videos/:slug/upload/parts` com `part_numbers: [part_count + 1]` retorna `400` com `error: "INVALID_UPLOAD_PART"`
- As duas rotas, chamadas por outro usuário autenticado, retornam `403` com `error: "VIDEO_NOT_OWNED"`; com slug inexistente, `404` com `error: "VIDEO_NOT_FOUND"`

---

### SI-03.7 — Conclusão do upload e enfileiramento do processamento

**Description:** Concluir o multipart validando partes e tamanho, mover o vídeo de `draft` para `processing` com transição guardada e publicar o job `process-video` — garantindo que chamadas repetidas e falhas da fila não corrompam o estado.

**Technical actions:**

1. Implementar `completeUpload(userId, slug)` em `VideosService`: dono + `status` (`processing` → retorno idempotente com o estado atual; `ready`/`failed` → `VideoNotUploadableException`); se `upload_id` ≠ null, `listParts` exige `1..upload_part_count` (senão `UploadIncompleteException`) e soma dos tamanhos = `file_size_bytes` (senão `UploadSizeMismatchException`), então `completeMultipartUpload` e persiste `upload_id = null` (per `phase-03-videos/TD-04`, `phase-03-videos/TD-05`)
2. Conferir o objeto final com `headObject`: `contentLength` ≠ `file_size_bytes` → `deleteObject`, vídeo `failed` com `processing_error = 'UPLOAD_SIZE_MISMATCH'` e `UploadSizeMismatchException` (per `phase-03-videos/TD-05`)
3. Transição guardada `repository.update({ id, status: draft }, { status: processing })`; `affected = 0` → recarrega e devolve o estado atual (idempotente) (per `phase-03-videos/TD-15`)
4. `VideoProcessingProducer.enqueueProcessing(id)`; se lançar, reverte com `update({ id, status: processing }, { status: draft })` e lança `ProcessingQueueUnavailableException` (per `phase-03-videos/TD-15`)
5. Adicionar `POST /videos/:slug/upload/complete` ao `VideosController` (`@HttpCode(HttpStatus.ACCEPTED)`, response `{ id, slug, status }`), documentado no OpenAPI

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit (mocks): parte faltando, soma divergente, `headObject` divergente (objeto removido + `failed`), chamada repetida em `processing`, falha do enqueue revertendo para `draft` | `src/videos/videos.service.spec.ts` |
| `VideosService.completeUpload` | Integration (DB + MinIO + Redis reais): após enviar as partes, `status = processing`, `upload_id = null`, objeto existe com o tamanho declarado e há job `process-video` com `jobId = videoId` | `src/videos/videos.service.integration-spec.ts` |
| `POST /videos/:slug/upload/complete` | E2E: partes enviadas por `fetch` às URLs assinadas → 202 `processing`; 409 `UPLOAD_INCOMPLETE`; segunda chamada → 202 idempotente; 403 outro usuário | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.6 — partes enviadas via URLs assinadas; SI-03.4 — `VideoProcessingProducer`

**Acceptance criteria:**

- `POST /videos/:slug/upload/complete` após enviar todas as partes retorna `202` com `status: "processing"`, e o banco reflete `status = 'processing'`
- A fila `video-processing` contém exatamente um job `process-video` com id = `videoId`, mesmo após duas chamadas de conclusão
- Concluir com uma parte faltando retorna `409` com `error: "UPLOAD_INCOMPLETE"` e o vídeo continua `draft`, com o multipart aberto (o cliente pode enviar a parte e tentar de novo)
- Concluir um upload cujo total enviado difere de `file_size_bytes` retorna `409` com `error: "UPLOAD_SIZE_MISMATCH"`
- Com a fila indisponível, a conclusão retorna `503` com `error: "PROCESSING_QUEUE_UNAVAILABLE"` e o vídeo volta a `draft`

---

### SI-03.8 — Cancelamento do upload (DELETE /videos/:slug/upload)

**Description:** Dar ao dono uma forma explícita de abandonar um upload, liberando as partes já enviadas e removendo o rascunho — e isolar essa limpeza num serviço reutilizado pelo sweeper do worker.

**Technical actions:**

1. Criar `src/videos/video-drafts.service.ts` — `discard(video): Promise<void>`: `abortMultipartUpload` se `upload_id` ≠ null, `deleteObject(storage_key)` se `headObject` encontrar o objeto, e remoção do registro (per `phase-03-videos/TD-17`)
2. Implementar `cancelUpload(userId, slug)` em `VideosService` — rascunho do dono (404/403/409 da SI-03.6) → `VideoDraftsService.discard` (per `phase-03-videos/TD-17`)
3. Registrar `VideoDraftsService` em `VideosModule` e adicionar `DELETE /videos/:slug/upload` ao `VideosController` (`@HttpCode(HttpStatus.NO_CONTENT)`), documentado no OpenAPI

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoDraftsService.discard` | Integration (DB + MinIO reais): multipart com parte enviada é abortado (o `UploadId` deixa de existir), objeto fonte removido quando existe, registro apagado | `src/videos/video-drafts.service.integration-spec.ts` |
| `VideosService.cancelUpload` | Unit (mocks): delega ao `discard` só para rascunho do dono; 404/403/409 | `src/videos/videos.service.spec.ts` |
| `DELETE /videos/:slug/upload` | E2E: 204 e vídeo some; 409 para vídeo em `processing`; 403 outro usuário; 401 sem token | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.6 — rascunho do dono e partes enviadas

**Acceptance criteria:**

- `DELETE /videos/:slug/upload` pelo dono de um rascunho retorna `204`; depois disso `GET /videos/:slug/upload` retorna `404` com `error: "VIDEO_NOT_FOUND"`
- Após o cancelamento, o storage não reconhece mais o `UploadId` do rascunho (partes liberadas)
- `DELETE /videos/:slug/upload` de um vídeo em `processing` retorna `409` com `error: "VIDEO_NOT_UPLOADABLE"` e nada é removido
- `DELETE /videos/:slug/upload` por outro usuário retorna `403` com `error: "VIDEO_NOT_OWNED"`

---

### SI-03.9 — FfmpegService (ffprobe/ffmpeg via spawn) e fixtures de vídeo

**Description:** Criar a integração com os binários do FFmpeg que o worker usa para extrair metadados e um frame, e um gerador de vídeos de teste (sem fixtures binárias no repositório).

**Technical actions:**

1. Criar `src/video-processing/ffmpeg.service.ts` — `probe(input): Promise<ProbeOutput>`: `spawn('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', input])`, timeout (`FFMPEG_TIMEOUT_MS`), exit code ≠ 0 → `FfmpegExecutionError` com o fim do stderr (per `phase-03-videos/TD-07`)
2. Implementar `extractFrame(input, atSeconds, outputPath): Promise<void>` — `spawn('ffmpeg', ['-v', 'error', '-ss', String(atSeconds), '-i', input, '-frames:v', '1', '-vf', 'scale=1280:-2', '-q:v', '3', '-y', outputPath])` (per `phase-03-videos/TD-07`, `phase-03-videos/TD-09`)
3. Criar `src/video-processing/probe-parser.ts` — `parseProbeOutput(output): { hasVideoStream; durationSeconds: number | null; metadata: VideoMetadata | null }` (mapeamento da tabela `VideoMetadata` do Data Model; puro, sem I/O) (per `phase-03-videos/TD-10`)
4. Criar `src/test/video-fixtures.ts` — `generateTestVideo(outputPath, { durationSeconds, width, height, withAudio })` usando `ffmpeg -f lavfi -i testsrc=...` (+ `sine` para áudio), `libx264`/`yuv420p`/`aac`, `-movflags +faststart` (per `phase-03-videos/TD-16`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `parseProbeOutput` | Unit: vídeo com áudio, vídeo sem áudio (`audio_codec: null`), sem stream de vídeo (`hasVideoStream: false`), duração ausente → `null` | `src/video-processing/probe-parser.spec.ts` |
| `FfmpegService` | Integration (binários reais): `probe` de um MP4 gerado retorna duração ≈ 3s e 320×240; `extractFrame` gera um JPEG de 1280px de largura; `probe` de um arquivo de texto rejeita com `FfmpegExecutionError` | `src/video-processing/ffmpeg.service.integration-spec.ts` |

**Dependencies:** SI-03.1 — FFmpeg instalado na imagem

**Acceptance criteria:**

- `probe` de um MP4 de 3s gerado pelo fixture retorna duração entre 2,9 e 3,1 segundos, `width: 320`, `height: 240`, `video_codec: "h264"` e `audio_codec: "aac"`
- `extractFrame(..., 0.3, out.jpg)` cria um arquivo JPEG cuja largura é 1280px
- `probe` de um arquivo que não é mídia rejeita com erro contendo a saída de stderr do ffprobe
- Um processo FFmpeg que excede `FFMPEG_TIMEOUT_MS` é encerrado e a chamada rejeita

---

### SI-03.10 — VideoProcessingService (metadados + thumbnail)

**Description:** Implementar a lógica do worker que transforma um vídeo `processing` em `ready` — duração e metadados via ffprobe, thumbnail de um frame no storage — ou o marca `failed`, de forma idempotente.

**Technical actions:**

1. Criar `src/video-processing/video-processing.service.ts` — `process(videoId)`: carrega o vídeo (ausente ou `status` ≠ `processing` → retorna sem efeito); `presignInternalGetObject(storage_key)`; `FfmpegService.probe(url)`; sem stream de vídeo → `UnrecoverableError` (per `phase-03-videos/TD-08`, `phase-03-videos/TD-14`, `phase-03-videos/TD-15`)
2. Thumbnail: `thumbnailTimestamp(duration)` = `duration × 0.1` (0 quando a duração é ≤ 1s ou ausente); `extractFrame(url, t, tmp)` em arquivo temporário; `putObject(videoThumbnailKey(id), jpeg, 'image/jpeg')`; arquivo temporário removido em `finally` (per `phase-03-videos/TD-09`)
3. Persistir com update condicionado: `update({ id, status: processing }, { status: ready, duration_seconds, metadata, thumbnail_key, processed_at: now, processing_error: null })` (per `phase-03-videos/TD-10`, `phase-03-videos/TD-15`)
4. Implementar `markFailed(videoId, message)` — `update({ id, status: processing }, { status: failed, processing_error: message truncada em 500 })` (per `phase-03-videos/TD-14`)
5. Criar `src/video-processing/video-processing.module.ts` — imports `TypeOrmModule.forFeature([Video])`, `StorageModule`; providers `FfmpegService`, `VideoProcessingService`; exports `VideoProcessingService`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingService` | Unit (mocks): ignora vídeo que não está `processing`; sem stream de vídeo lança `UnrecoverableError`; regra de timestamp (10%, 0 para ≤ 1s); `markFailed` trunca em 500 | `src/video-processing/video-processing.service.spec.ts` |
| `VideoProcessingService` | Integration (DB + MinIO + FFmpeg reais): MP4 gerado enviado ao storage → `ready` com `duration_seconds`, `metadata`, `thumbnail_key` e JPEG presente no storage; segunda execução não altera nada | `src/video-processing/video-processing.service.integration-spec.ts` |
| `VideoProcessingModule` | Unit: compilação do módulo | `src/video-processing/video-processing.module.spec.ts` |

**Dependencies:** SI-03.2 — `StorageService`; SI-03.3 — entidade `Video`; SI-03.9 — `FfmpegService`

**Acceptance criteria:**

- Processar um vídeo `processing` cujo objeto é um MP4 válido de 3s deixa o registro `ready`, com `duration_seconds` ≈ 3, `metadata.width`/`height`/`video_codec` preenchidos, `processed_at` definido e `processing_error` nulo
- O objeto `videos/{videoId}/thumbnail.jpg` existe no storage com `ContentType: image/jpeg`
- Processar de novo um vídeo já `ready` não muda o registro nem o storage
- Processar um vídeo cujo objeto não contém stream de vídeo lança `UnrecoverableError`
- `markFailed` em vídeo `processing` grava `status = 'failed'` e `processing_error` com no máximo 500 caracteres

---

### SI-03.11 — Worker: entrypoint, VideoProcessor e serviço video-worker no Compose

**Description:** Empacotar o processamento como um processo Nest separado (sem HTTP) que consome a fila `video-processing`, aplica a política de falha final e sobe como serviço próprio no Compose.

**Technical actions:**

1. Extrair `src/database/typeorm-options.ts` — `buildTypeOrmOptions(dbConfig)` com as opções hoje inline em `AppModule` (`autoLoadEntities: true`, `synchronize: false`), usado por `AppModule` e pelo worker (fonte única de parâmetros de conexão, convenção herdada da Fase 01)
2. Criar `src/worker.module.ts` — `ConfigModule.forRoot` (mesmo `load` e `envValidationSchema` da API), `TypeOrmModule.forRootAsync` com `buildTypeOrmOptions`, `QueueModule`, `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })`, `VideoProcessingModule` e `VideoProcessor`; nenhum módulo HTTP (Auth/Mail/controllers) (per `phase-03-videos/TD-06`)
3. Criar `src/video-processing/video.processor.ts` — `@Processor(VIDEO_PROCESSING_QUEUE, { concurrency: WORKER_CONCURRENCY })` + `WorkerHost`; `process(job)` despacha `process-video` → `VideoProcessingService.process(job.data.videoId)`; `@OnWorkerEvent('failed')` chama `markFailed` quando a falha é final (`UnrecoverableError` ou `job.attemptsMade ≥ job.opts.attempts`), com catch-and-log (contexto de background) (per `phase-03-videos/TD-01`, `phase-03-videos/TD-14`)
4. Criar `src/worker.ts` — `NestFactory.createApplicationContext(WorkerModule)` + `enableShutdownHooks()`; scripts npm `start:worker` (ts-node CommonJS, mesmo padrão do script `seed`) e `start:worker:prod` (`node dist/worker`) (per `phase-03-videos/TD-06`)
5. Adicionar o serviço `video-worker` ao `compose.yaml` — mesmo build (`Dockerfile.dev`) e volume da API, `command: npm run start:worker`, `depends_on` `db`/`redis` (healthy) e `minio-init` (completed), `restart: unless-stopped` (per `phase-03-videos/TD-06`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessor` | Integration (Redis + DB + MinIO + FFmpeg reais, prefixo de teste, contexto `WorkerModule` in-process): job de MP4 válido → `ready`; job de objeto não-vídeo → `failed` com `processing_error` sem novas tentativas | `src/video-processing/video.processor.integration-spec.ts` |
| `WorkerModule` | Unit: o contexto compila e resolve `VideoProcessor` sem registrar controllers HTTP | `src/worker.module.spec.ts` |

**Dependencies:** SI-03.4 — fila registrada e produtor; SI-03.10 — `VideoProcessingService`

**Acceptance criteria:**

- `docker compose up -d` sobe o serviço `video-worker` e ele permanece `running` consumindo a fila `video-processing`
- Um job `process-video` para um vídeo `processing` com MP4 válido resulta em `status = 'ready'` sem nenhuma chamada HTTP à API
- Um job para um objeto que não é vídeo resulta em `status = 'failed'` com `processing_error` preenchido e o job no conjunto `failed` com uma única tentativa
- Encerrar o worker (`SIGTERM`) fecha o `Worker` do BullMQ de forma graciosa (jobs ativos terminam ou voltam para a fila)
- `npm run build` gera `dist/worker.js` e `npm run start:worker:prod` inicia o consumidor

---

### SI-03.12 — Sweeper de uploads abandonados no worker

**Description:** Remover periodicamente rascunhos cujo upload expirou (partes órfãs no storage + registro `draft`), cobrindo o abandono silencioso que o cancelamento explícito não alcança.

**Technical actions:**

1. Criar `src/video-processing/expired-uploads-sweeper.service.ts` — `sweep(now = new Date()): Promise<number>`: vídeos `status = draft` com `created_at < now − UPLOAD_EXPIRATION_HOURS`; `VideoDraftsService.discard` em cada um; retorna a quantidade (per `phase-03-videos/TD-17`)
2. Criar `src/video-processing/expired-uploads-scheduler.service.ts` — `OnApplicationBootstrap` executa `queue.upsertJobScheduler('expired-uploads-sweeper', { every: UPLOAD_SWEEP_INTERVAL_MINUTES × 60000 }, { name: VIDEO_JOBS.SWEEP_EXPIRED_UPLOADS, data: {}, opts: { removeOnComplete: true, removeOnFail: 100 } })` (per `phase-03-videos/TD-17`)
3. Estender `VideoProcessor.process` para despachar `sweep-expired-uploads` → `ExpiredUploadsSweeperService.sweep()`
4. Registrar `VideoDraftsService`, `ExpiredUploadsSweeperService` e `ExpiredUploadsSchedulerService` no lado do worker (`VideoProcessingModule` / `WorkerModule`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `ExpiredUploadsSweeperService` | Integration (DB + MinIO reais): rascunho mais velho que a expiração é removido e seu multipart abortado; rascunho recente e vídeos `processing`/`ready` antigos permanecem; retorna a contagem | `src/video-processing/expired-uploads-sweeper.service.integration-spec.ts` |
| `ExpiredUploadsSchedulerService` | Integration (Redis real, prefixo de teste): após o bootstrap existe o job scheduler `expired-uploads-sweeper` com o intervalo configurado; bootstrap repetido não duplica | `src/video-processing/expired-uploads-scheduler.service.integration-spec.ts` |

**Dependencies:** SI-03.8 — `VideoDraftsService.discard`; SI-03.11 — worker e `VideoProcessor`

**Acceptance criteria:**

- `sweep()` remove do banco um `draft` criado há mais de `UPLOAD_EXPIRATION_HOURS` e o storage deixa de reconhecer o `UploadId` dele
- `sweep()` mantém `draft`s mais novos que a expiração e nunca toca vídeos `processing`, `ready` ou `failed`
- Ao subir o worker, a fila `video-processing` tem exatamente um job scheduler `expired-uploads-sweeper` com intervalo de `UPLOAD_SWEEP_INTERVAL_MINUTES`
- Um job `sweep-expired-uploads` processado pelo worker executa a varredura

---

### SI-03.13 — Detalhes do vídeo pela URL única com autenticação opcional (GET /videos/:slug)

**Description:** Expor o vídeo pela sua URL única: público quando `ready`, visível só ao dono enquanto não estiver pronto — o que exige que o guard JWT global saiba identificar o usuário em rotas públicas.

**Technical actions:**

1. Criar `src/auth/decorators/optional-auth.decorator.ts` (`OptionalAuth()` → metadata `IS_OPTIONAL_AUTH_KEY`) e estender `JwtAuthGuard`: em rota `@OptionalAuth()`, Bearer válido → `request.user` preenchido; ausente ou inválido → segue anônimo (nunca 401) (per `phase-03-videos/TD-13`)
2. Implementar `getVideo(slug, viewerUserId?)` em `VideosService` — carrega vídeo + canal; `ready` → qualquer chamador; não-`ready` → só o dono, demais → `VideoNotFoundException`; monta `stream_url`/`download_url`/`thumbnail_url` (`/videos/{slug}/...`) apenas quando `ready` (per `phase-03-videos/TD-12`, `phase-03-videos/TD-13`)
3. Criar `src/videos/dto/video-response.dto.ts` (`VideoResponseDto`, `VideoMetadataDto`, `VideoChannelDto` com `@ApiProperty`, nulos com `nullable: true`) e adicionar `GET /videos/:slug` com `@OptionalAuth()` ao `VideosController`, documentado no OpenAPI (sem `@ApiBearerAuth`, rota pública)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `JwtAuthGuard` | Unit: `@OptionalAuth()` com token válido popula `request.user`; com token inválido ou ausente libera sem usuário; rotas protegidas continuam exigindo token | `src/auth/guards/jwt-auth.guard.spec.ts` |
| `VideosService.getVideo` | Unit (mocks): `ready` visível a anônimo com URLs; não-`ready` visível ao dono sem URLs; não-`ready` para outro usuário/anônimo → `VideoNotFoundException` | `src/videos/videos.service.spec.ts` |
| `GET /videos/:slug` | E2E: 200 anônimo para `ready`; 404 anônimo para `draft`; 200 dono para `draft`; token inválido tratado como anônimo; 404 slug inexistente | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.5 — vídeos criados e `VideosController`

**Acceptance criteria:**

- `GET /videos/:slug` sem token, para vídeo `ready`, retorna `200` com `status: "ready"`, `channel.nickname`, `stream_url: "/videos/{slug}/stream"`, `download_url` e `thumbnail_url`
- `GET /videos/:slug` sem token, para vídeo `draft`, retorna `404` com `error: "VIDEO_NOT_FOUND"`
- `GET /videos/:slug` com o token do dono, para vídeo `draft`, retorna `200` com `status: "draft"` e as três URLs `null`
- `GET /videos/:slug` com Bearer inválido, para vídeo `ready`, retorna `200` (tratado como anônimo)
- `GET /auth/me` continua retornando `401` sem token (guard global inalterado para rotas protegidas)

---

### SI-03.14 — Streaming, download e thumbnail por redirecionamento a URLs assinadas

**Description:** Entregar a reprodução via streaming (Range/206 servido pelo storage), o download como anexo e o thumbnail, sem que nenhum byte de vídeo passe pela API.

**Technical actions:**

1. Implementar `getDeliveryUrl(slug, kind: 'stream' | 'download' | 'thumbnail')` em `VideosService` — inexistente → `VideoNotFoundException`; `status` ≠ `ready` → `VideoNotReadyException`; `presignGetObject` com `expiresIn = PRESIGNED_URL_EXPIRES_IN_SECONDS` e: `stream` → `responseContentType = content_type`; `download` → `responseContentDisposition = attachment; filename="..."`; `thumbnail` → chave `thumbnail_key` e `image/jpeg` (per `phase-03-videos/TD-12`)
2. Criar `src/videos/download-filename.util.ts` — `buildDownloadFileName(title, originalFileName)`: título sanitizado (ASCII seguro, sem aspas/barras/controles) + extensão do arquivo original; fallback `video` + extensão quando o título fica vazio
3. Adicionar ao `VideosController` `GET /videos/:slug/stream`, `/download` e `/thumbnail` — `@Public()`, resposta `302` com `Location` = URL assinada e `Cache-Control: no-store`, documentados no OpenAPI (per `phase-03-videos/TD-12`, `phase-03-videos/TD-13`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `buildDownloadFileName` | Unit: preserva extensão, remove aspas/barras/caracteres de controle, fallback quando o título sanitizado fica vazio | `src/videos/download-filename.util.spec.ts` |
| `VideosService.getDeliveryUrl` | Unit (mocks): 404 inexistente; 409 não-`ready`; parâmetros de assinatura por `kind` | `src/videos/videos.service.spec.ts` |
| Rotas de entrega | E2E (vídeo `ready` semeado no DB + objeto no MinIO): `302` com `Location`; `GET` no `Location` com `Range: bytes=0-99` → `206` + `Content-Range`; download com `Content-Disposition: attachment`; thumbnail `image/jpeg`; 409 não-`ready`; 404 inexistente | `test/videos-delivery.e2e-spec.ts` |

**Dependencies:** SI-03.13 — acesso por slug e vídeos `ready` expostos

**Acceptance criteria:**

- `GET /videos/:slug/stream` sem token, para vídeo `ready`, retorna `302` com `Location` apontando para o storage; um `GET` nesse `Location` com `Range: bytes=0-99` retorna `206 Partial Content` com `Content-Range: bytes 0-99/{tamanho}`
- `GET /videos/:slug/download` retorna `302`; seguir o `Location` responde `200` com `Content-Disposition: attachment; filename="{título}.mp4"`
- `GET /videos/:slug/thumbnail` retorna `302`; seguir o `Location` responde `200` com `Content-Type: image/jpeg`
- As três rotas, para vídeo em `processing`, retornam `409` com `error: "VIDEO_NOT_READY"`; para slug inexistente, `404` com `error: "VIDEO_NOT_FOUND"`
- As respostas `302` trazem `Cache-Control: no-store`

---

### SI-03.15 — Pipeline completo de ingestão (E2E com worker real)

**Description:** Provar o fluxo da fase de ponta a ponta com a infraestrutura real: cadastro → upload multipart direto ao storage → conclusão → worker processa → vídeo `ready` com thumbnail → streaming e download — e o caminho de falha até `failed`.

**Technical actions:**

1. Criar `test/video-pipeline.e2e-spec.ts` — `AppModule` (HTTP, globais de `main.ts` reproduzidos) + contexto `WorkerModule` in-process no mesmo processo de teste, ambos com o prefixo de fila de teste (per `phase-03-videos/TD-16`); helper para registrar, confirmar e logar um usuário
2. Caminho feliz: gerar com `generateTestVideo` um MP4 maior que uma parte (mais de 5 MiB, ≥ 2 partes com o `UPLOAD_PART_SIZE_BYTES` de teste), `POST /videos`, assinar todas as partes, `PUT` de cada fatia via `fetch`, `POST .../upload/complete`, aguardar (polling com timeout) `GET /videos/:slug` do dono ficar `ready`; validar `duration_seconds`, `metadata`, `thumbnail_url`; seguir `stream` com `Range` (206) e `download` (attachment)
3. Caminho de falha: enviar bytes aleatórios declarados como `video/mp4`, concluir e aguardar `status: "failed"` com `processing_error` preenchido; `stream` retorna `409 VIDEO_NOT_READY`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Fluxo upload → processamento → entrega | E2E (DB, MinIO, Redis, FFmpeg reais; worker in-process): caminho feliz até `ready` + streaming/download; caminho de falha até `failed` | `test/video-pipeline.e2e-spec.ts` |

**Dependencies:** SI-03.7 — conclusão + enqueue; SI-03.11 — worker; SI-03.14 — entrega

**Acceptance criteria:**

- Um MP4 enviado em ≥ 2 partes chega a `status: "ready"` sem intervenção manual, com `duration_seconds` ≈ duração gerada e `thumbnail_url` não nulo
- O `stream` desse vídeo responde `206 Partial Content` a `Range: bytes=0-1023` e o `download` responde com `Content-Disposition: attachment`
- Bytes que não são vídeo chegam a `status: "failed"` com `processing_error` preenchido, e `GET /videos/:slug/stream` retorna `409` com `error: "VIDEO_NOT_READY"`
- Nenhum byte do arquivo é enviado à API: a única carga útil grande trafega nos `PUT` às URLs assinadas do storage

---

### SI-03.16 — Documentação: guia de testes, CLAUDE.md, diagrama e OpenAPI

**Description:** Deixar a fundação de IA e os artefatos de contrato coerentes com o código entregue — guia de testes alinhado à infra real, `CLAUDE.md` com a seção de vídeos, diagrama sem fila "TBD" e `openapi.json` exportado com as rotas novas.

**Technical actions:**

1. Atualizar `.claude/skills/testing-guide-nestjs-project/references/external-systems.md` — Object Storage: MinIO real do Compose (URLs assinadas, multipart, Range), sem adapter de filesystem; Message Queue: BullMQ/Redis real com `QUEUE_PREFIX` de teste e worker in-process nos E2E (per `phase-03-videos/TD-16` Revisions)
2. Atualizar `nestjs-project/CLAUDE.md` (serviços `minio`, `minio-init`, `redis`, `video-worker`; comandos `start:worker`; `setup-test-env.ts`; módulos `videos`, `storage`, `queue`, `video-processing`) e o `CLAUDE.md` da raiz (Message Queue = Redis/BullMQ, seção de vídeos com endpoints, worker e storage)
3. Atualizar `docs/diagrams/software-arch.mermaid` — container da fila de "TBD" para "Redis (BullMQ)" (per `phase-03-videos/TD-01`)
4. Regenerar `nestjs-project/openapi.json` com `npm run openapi:export` (artefato versionado, per `openapi-docs-nestjs/TD-02`) e adicionar as requisições de vídeos em `nestjs-project/api.http`; estender o teste de export para verificar as rotas `/videos`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Export OpenAPI | Integration: o documento contém as rotas `/videos/...` com `summary`, e as rotas de upload exigem `access-token` | `src/openapi-export.integration-spec.ts` |

**Dependencies:** SI-03.15 — comportamento final verificado

**Acceptance criteria:**

- `openapi.json` versionado contém as 9 operações de `/videos` documentadas no API Contracts, com respostas de erro referenciando `ApiErrorEnvelope`
- `CLAUDE.md` (raiz e `nestjs-project/`) descreve apenas arquivos, serviços e comandos que existem no repositório
- `docs/diagrams/software-arch.mermaid` não contém mais "TBD"
- `references/external-systems.md` do guia de testes descreve MinIO e BullMQ reais, sem recomendar adapter de filesystem para storage

---

## Technical Specifications

### Data Model

#### Video

Tabela `videos` (entidade `Video`, módulo `VideosModule`). O `id` é gerado pela aplicação (`crypto.randomUUID()`) antes do insert, para que a chave de storage derive do id imutável (per `phase-03-videos/TD-03`).

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK (`@PrimaryColumn('uuid')`, gerado na aplicação) |
| channel_id | uuid | FK → `channels.id`, not null, `ON DELETE CASCADE` |
| slug | varchar(11) | unique, not null — 11 caracteres base64url de `crypto.randomBytes(8)` (per `phase-03-videos/TD-11`) |
| title | varchar(255) | not null — default: nome original do arquivo sem extensão (per `phase-03-videos/TD-04` Note) |
| status | enum `videos_status_enum` (`draft`, `processing`, `ready`, `failed`) | not null, default `draft` (per `phase-03-videos/TD-14`) |
| original_file_name | varchar(255) | not null |
| content_type | varchar(100) | not null — MIME declarado no início, `video/*` (per `phase-03-videos/TD-05`) |
| file_size_bytes | bigint | not null — tamanho declarado, ≤ `VIDEO_MAX_SIZE_BYTES`; transformer `bigint ↔ number` |
| storage_key | varchar(255) | not null — `videos/{videoId}/source` (per `phase-03-videos/TD-03`) |
| upload_id | varchar(255) | nullable — `UploadId` do multipart aberto; `null` após completar/cancelar (per `phase-03-videos/TD-04`) |
| upload_part_size | integer | not null — tamanho de parte fixado no início (per `phase-03-videos/TD-05`) |
| upload_part_count | integer | not null — `ceil(file_size_bytes / upload_part_size)` (per `phase-03-videos/TD-05`) |
| thumbnail_key | varchar(255) | nullable — `videos/{videoId}/thumbnail.jpg`, preenchido pelo worker (per `phase-03-videos/TD-03`, `phase-03-videos/TD-09`) |
| duration_seconds | numeric(12,3) | nullable — preenchido pelo worker; transformer `numeric ↔ number` (per `phase-03-videos/TD-10`) |
| metadata | jsonb | nullable — `VideoMetadata` (abaixo), preenchido pelo worker (per `phase-03-videos/TD-10`) |
| processing_error | varchar(500) | nullable — motivo da falha terminal (per `phase-03-videos/TD-14`) |
| processed_at | timestamptz | nullable — instante em que o vídeo ficou `ready` |
| created_at | timestamptz | `@CreateDateColumn` |
| updated_at | timestamptz | `@UpdateDateColumn` |

**Relations:** `Channel` has many `Video` (one-to-many; `@OneToMany(() => Video, (video) => video.channel)` em `Channel`, `@ManyToOne(() => Channel, (channel) => channel.videos, { onDelete: 'CASCADE' })` + `@JoinColumn({ name: 'channel_id' })` em `Video`). Nenhuma mudança de schema em `channels`.
**Indexes:** unique em `slug`; índice em `channel_id`; índice composto em `(status, created_at)` (consulta do sweeper de rascunhos expirados, per `phase-03-videos/TD-17`).
**Migration:** `src/database/migrations/<timestamp>-CreateVideos.ts`, gerada via `npm run migration:generate` (cria o tipo `videos_status_enum`, a tabela, a FK e os índices; `down` remove na ordem inversa).

**`VideoMetadata` (jsonb, per `phase-03-videos/TD-10`)** — resumo curado do `ffprobe -print_format json -show_format -show_streams`:

| Key | Type | Source (ffprobe) |
|-----|------|------------------|
| width | number | 1º stream `codec_type: video` → `width` |
| height | number | 1º stream de vídeo → `height` |
| video_codec | string | 1º stream de vídeo → `codec_name` |
| audio_codec | string \| null | 1º stream `codec_type: audio` → `codec_name` (`null` se não houver áudio) |
| bitrate | number \| null | `format.bit_rate` (bits/s) |
| format_name | string | `format.format_name` |
| size_bytes | number | `format.size` |

**Storage layout (per `phase-03-videos/TD-03`):** bucket privado único `S3_BUCKET` (default `streamtube`), criado pelo serviço Compose one-shot `minio-init` (`mc mb --ignore-existing`). Chaves por vídeo: `videos/{videoId}/source` (arquivo original, via multipart) e `videos/{videoId}/thumbnail.jpg` (JPEG gerado pelo worker). Dois clientes S3: interno (`S3_ENDPOINT`, chamadas servidor→storage) e público (`S3_PUBLIC_ENDPOINT`, usado **somente** para assinar URLs entregues ao cliente).

**Configuração nova (namespaces `registerAs`, validados no Joi `envValidationSchema`, documentados em `.env.example`):**

| Namespace / arquivo | Env var | Default |
|---------------------|---------|---------|
| `storage` — `src/config/storage.config.ts` | `S3_ENDPOINT` | `http://minio:9000` |
| | `S3_PUBLIC_ENDPOINT` | `http://localhost:9000` |
| | `S3_REGION` | `us-east-1` |
| | `S3_ACCESS_KEY_ID` | required |
| | `S3_SECRET_ACCESS_KEY` | required |
| | `S3_BUCKET` | `streamtube` |
| `queue` — `src/config/queue.config.ts` | `REDIS_HOST` | `redis` |
| | `REDIS_PORT` | `6379` |
| | `QUEUE_PREFIX` | `streamtube` (testes: `streamtube-test`, per `phase-03-videos/TD-16`) |
| `videos` — `src/config/videos.config.ts` | `VIDEO_MAX_SIZE_BYTES` | `10737418240` (10 GiB, per `phase-03-videos/TD-05`) |
| | `UPLOAD_PART_SIZE_BYTES` | `67108864` (64 MiB; mínimo `5242880`, per `phase-03-videos/TD-05`) |
| | `UPLOAD_EXPIRATION_HOURS` | `24` (per `phase-03-videos/TD-17`) |
| | `PRESIGNED_URL_EXPIRES_IN_SECONDS` | `3600` (per `phase-03-videos/TD-12`) |
| | `VIDEO_PROCESSING_ATTEMPTS` | `3` (per `phase-03-videos/TD-14`) |
| | `UPLOAD_SWEEP_INTERVAL_MINUTES` | `60` (per `phase-03-videos/TD-17`) |
| | `WORKER_CONCURRENCY` | `1` (per `phase-03-videos/TD-06`) |

### API Contracts

Controller `VideosController` — `@Controller('videos')`, `@ApiTags('videos')`, `@SkipThrottle()` (o rate limiting fica restrito aos endpoints de auth, per `phase-02-auth/TD-08`). O `slug` é o identificador público do vídeo em todas as rotas (per `phase-03-videos/TD-11`). Campos JSON em `snake_case` (convenção das respostas existentes, ex.: `access_token`). Erros usam o envelope `{ statusCode, error, message }` (per `phase-02-auth/TD-07`) e cada endpoint é documentado com `@ApiOperation` + um `@ApiResponse` por status (per `openapi-docs-nestjs/TD-01`).

#### POST /videos (SI-03.5)

Pré-cadastra o vídeo como `draft` e abre o multipart upload no storage (per `phase-03-videos/TD-04`, `phase-03-videos/TD-14`).

**Request headers:**
- Authorization: Bearer {access_token}
- Content-Type: application/json

**Request body (`CreateVideoDto`):**
- file_name: string, required — 1..255 caracteres
- file_size: integer, required — ≥ 1 (bytes); limite superior `VIDEO_MAX_SIZE_BYTES` validado no service (per `phase-03-videos/TD-05`)
- content_type: string, required — casa `^video\/[\w.+-]+$` (per `phase-03-videos/TD-05`)
- title: string, optional — 1..255 caracteres; ausente → `file_name` sem extensão (per `phase-03-videos/TD-04` Note)

**Response 201:**
- id: string (uuid)
- slug: string (11 chars)
- title: string
- status: `"draft"`
- upload: object
  - part_size: integer (bytes, = `UPLOAD_PART_SIZE_BYTES`)
  - part_count: integer (`ceil(file_size / part_size)`)
  - expires_at: string (ISO-8601, `created_at + UPLOAD_EXPIRATION_HOURS`)

**Error responses:**
- 400 VALIDATION_ERROR: corpo inválido (campo ausente, `content_type` fora de `video/*`, `file_size` < 1)
- 401: sem token / token inválido
- 404 CHANNEL_NOT_FOUND: usuário autenticado sem canal
- 413 VIDEO_FILE_TOO_LARGE: `file_size` > `VIDEO_MAX_SIZE_BYTES`

---

#### POST /videos/:slug/upload/parts (SI-03.6)

Assina URLs de `UploadPart` (endpoint público do storage) para as partes pedidas (per `phase-03-videos/TD-04`). O cliente faz `PUT` dos bytes de cada parte direto na URL.

**Request headers:**
- Authorization: Bearer {access_token}
- Content-Type: application/json

**Request body (`SignUploadPartsDto`):**
- part_numbers: integer[], required — 1..100 itens, únicos, cada um ≥ 1; limite superior `upload_part_count` validado no service

**Response 200:**
- parts: array of `{ part_number: integer, url: string }` (ordem crescente de `part_number`)
- expires_at: string (ISO-8601) — expiração das URLs = `min(now + PRESIGNED_URL_EXPIRES_IN_SECONDS, expires_at do upload)` (per `phase-03-videos/TD-17`)

**Error responses:**
- 400 VALIDATION_ERROR: corpo inválido
- 400 INVALID_UPLOAD_PART: algum `part_number` > `upload_part_count`
- 401: sem token / token inválido
- 403 VIDEO_NOT_OWNED: vídeo de outro canal
- 404 VIDEO_NOT_FOUND: slug inexistente
- 409 VIDEO_NOT_UPLOADABLE: `status` ≠ `draft`

---

#### GET /videos/:slug/upload (SI-03.6)

Estado do upload para retomada: quais partes já estão no storage (`ListParts`, paginado) (per `phase-03-videos/TD-04`).

**Request headers:**
- Authorization: Bearer {access_token}

**Response 200:**
- part_size: integer
- part_count: integer
- expires_at: string (ISO-8601)
- uploaded_parts: array of `{ part_number: integer, size: integer }` (ordem crescente)

**Error responses:**
- 401: sem token / token inválido
- 403 VIDEO_NOT_OWNED
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_UPLOADABLE: `status` ≠ `draft`

---

#### POST /videos/:slug/upload/complete (SI-03.7)

Conclui o multipart e dispara o processamento (per `phase-03-videos/TD-04`, `phase-03-videos/TD-05`, `phase-03-videos/TD-15`). Fluxo: (1) se `upload_id` ≠ null: `ListParts` → exige partes `1..upload_part_count` presentes e soma dos tamanhos = `file_size_bytes`, depois `CompleteMultipartUpload` (lista montada pelo servidor) e `upload_id = null`; (2) `HeadObject` confere `ContentLength` = `file_size_bytes` (divergência → objeto removido, vídeo `failed`, 409); (3) `UPDATE ... SET status='processing' WHERE id=:id AND status='draft'`; (4) enqueue `process-video` com `jobId = videoId`; falha no enqueue → reverte para `draft` e responde 503. Chamada repetida com o vídeo já em `processing` é idempotente (202 com o estado atual).

**Request headers:**
- Authorization: Bearer {access_token}

**Request body:** none.

**Response 202:**
- id: string (uuid)
- slug: string
- status: `"processing"`

**Error responses:**
- 401: sem token / token inválido
- 403 VIDEO_NOT_OWNED
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_UPLOADABLE: `status` é `ready` ou `failed`
- 409 UPLOAD_INCOMPLETE: falta alguma parte em `1..upload_part_count`
- 409 UPLOAD_SIZE_MISMATCH: tamanho enviado ≠ `file_size_bytes` declarado
- 503 PROCESSING_QUEUE_UNAVAILABLE: falha ao enfileirar (status revertido para `draft`; o cliente pode repetir a chamada)

---

#### DELETE /videos/:slug/upload (SI-03.8)

Cancela o upload do rascunho: `AbortMultipartUpload` (se houver `upload_id`), remove `videos/{videoId}/source` se existir e apaga o registro (per `phase-03-videos/TD-17`).

**Request headers:**
- Authorization: Bearer {access_token}

**Response 204:** No content.

**Error responses:**
- 401: sem token / token inválido
- 403 VIDEO_NOT_OWNED
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_UPLOADABLE: `status` ≠ `draft`

---

#### GET /videos/:slug (SI-03.13)

Detalhes do vídeo pela URL única. `@OptionalAuth()`: rota pública; se houver Bearer válido, o usuário é identificado. Vídeo `ready` → qualquer um; não-`ready` → só o dono (per `phase-03-videos/TD-13`).

**Request headers:**
- Authorization: Bearer {access_token} — optional

**Response 200 (`VideoResponseDto`):**
- id: string (uuid)
- slug: string
- title: string
- status: `"draft" | "processing" | "ready" | "failed"`
- duration_seconds: number | null
- metadata: `VideoMetadata` | null
- processing_error: string | null
- channel: object — `{ id: string (uuid), nickname: string, name: string }`
- stream_url: string | null — `/videos/{slug}/stream` quando `ready`, senão `null`
- download_url: string | null — `/videos/{slug}/download` quando `ready`, senão `null`
- thumbnail_url: string | null — `/videos/{slug}/thumbnail` quando `ready`, senão `null`
- created_at: string (ISO-8601)
- processed_at: string (ISO-8601) | null

**Error responses:**
- 404 VIDEO_NOT_FOUND: slug inexistente, ou vídeo não-`ready` e o chamador não é o dono

---

#### GET /videos/:slug/stream (SI-03.14)

`302` para uma URL `GetObject` assinada (endpoint público, `ResponseContentType = content_type`, expira em `PRESIGNED_URL_EXPIRES_IN_SECONDS`). O storage atende `Range` com `206 Partial Content` (per `phase-03-videos/TD-12`). Público (per `phase-03-videos/TD-13`).

**Response 302:**
- header `Location`: URL assinada do objeto `videos/{videoId}/source`
- header `Cache-Control: no-store`

**Error responses:**
- 404 VIDEO_NOT_FOUND: slug inexistente
- 409 VIDEO_NOT_READY: `status` ≠ `ready`

---

#### GET /videos/:slug/download (SI-03.14)

`302` para URL assinada com `ResponseContentDisposition: attachment; filename="{title sanitizado}{extensão do original_file_name}"` (per `phase-03-videos/TD-12`). Público (per `phase-03-videos/TD-13`).

**Response 302:**
- header `Location`: URL assinada do objeto `videos/{videoId}/source` com `response-content-disposition`
- header `Cache-Control: no-store`

**Error responses:**
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_READY

---

#### GET /videos/:slug/thumbnail (SI-03.14)

`302` para URL assinada do objeto `videos/{videoId}/thumbnail.jpg` (`ResponseContentType: image/jpeg`) (per `phase-03-videos/TD-12`). Público (per `phase-03-videos/TD-13`).

**Response 302:**
- header `Location`: URL assinada do thumbnail
- header `Cache-Control: no-store`

**Error responses:**
- 404 VIDEO_NOT_FOUND
- 409 VIDEO_NOT_READY: `status` ≠ `ready` (sem thumbnail ainda)

---

#### Validation Rules — videos

- `file_name`: required, string, 1..255
- `file_size`: required, integer, ≥ 1 (teto `VIDEO_MAX_SIZE_BYTES` → 413 no service)
- `content_type`: required, string, regex `^video\/[\w.+-]+$`
- `title`: optional, string, 1..255
- `part_numbers`: required, array 1..100, itens inteiros ≥ 1, únicos (teto `upload_part_count` → 400 INVALID_UPLOAD_PART no service)

### Authorization Matrix

"Owner" = usuário autenticado cujo canal (`channels.user_id = sub` do JWT) é o `channel_id` do vídeo. Guard JWT global (Fase 02); rotas públicas marcadas com `@Public()`; `GET /videos/:slug` usa `@OptionalAuth()` (pública, mas identifica o usuário se houver Bearer válido) (per `phase-03-videos/TD-13`).

| Endpoint | Anonymous | Authenticated (não dono) | Owner |
|----------|-----------|--------------------------|-------|
| POST /videos | ✗ 401 | ✓ (cria no próprio canal) | ✓ |
| POST /videos/:slug/upload/parts | ✗ 401 | ✗ 403 | ✓ |
| GET /videos/:slug/upload | ✗ 401 | ✗ 403 | ✓ |
| POST /videos/:slug/upload/complete | ✗ 401 | ✗ 403 | ✓ |
| DELETE /videos/:slug/upload | ✗ 401 | ✗ 403 | ✓ |
| GET /videos/:slug — vídeo `ready` | ✓ | ✓ | ✓ |
| GET /videos/:slug — vídeo não-`ready` | ✗ 404 | ✗ 404 | ✓ |
| GET /videos/:slug/stream | ✓ (409 se não-`ready`) | ✓ | ✓ |
| GET /videos/:slug/download | ✓ (409 se não-`ready`) | ✓ | ✓ |
| GET /videos/:slug/thumbnail | ✓ (409 se não-`ready`) | ✓ | ✓ |

### Error Catalog

Formato herdado: `{ statusCode, error, message }`; exceções de domínio estendem `DomainException` em `src/common/exceptions/domain.exception.ts` (per `phase-02-auth/TD-07`). Serviços lançam exceções de domínio, nunca exceções HTTP do Nest.

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VALIDATION_ERROR | 400 | DTO inválido (herdado da Fase 02) |
| INVALID_UPLOAD_PART | 400 | `part_numbers` contém número > `upload_part_count` |
| VIDEO_NOT_OWNED | 403 | Operação de upload em vídeo de outro canal |
| CHANNEL_NOT_FOUND | 404 | Usuário autenticado sem canal ao iniciar upload |
| VIDEO_NOT_FOUND | 404 | Slug inexistente; ou detalhes de vídeo não-`ready` pedidos por quem não é dono |
| VIDEO_NOT_UPLOADABLE | 409 | Operação de upload (assinar partes, estado, concluir, cancelar) com `status` fora do permitido |
| UPLOAD_INCOMPLETE | 409 | Concluir upload com parte faltando em `1..upload_part_count` |
| UPLOAD_SIZE_MISMATCH | 409 | Concluir upload cujo tamanho enviado ≠ `file_size_bytes` declarado |
| VIDEO_NOT_READY | 409 | Stream, download ou thumbnail de vídeo com `status` ≠ `ready` |
| VIDEO_FILE_TOO_LARGE | 413 | `file_size` > `VIDEO_MAX_SIZE_BYTES` (per `phase-03-videos/TD-05`) |
| PROCESSING_QUEUE_UNAVAILABLE | 503 | Falha ao enfileirar `process-video` na conclusão do upload (per `phase-03-videos/TD-15`) |

### Events/Messages

Broker: Redis (serviço Compose `redis`), via BullMQ (per `phase-03-videos/TD-01`). Fila única **`video-processing`**, chaves Redis sob `QUEUE_PREFIX` (dev `streamtube`, testes `streamtube-test` — o serviço `video-worker` de dev nunca consome jobs de teste, per `phase-03-videos/TD-16`). Constantes em `src/videos/videos.constants.ts`: `VIDEO_PROCESSING_QUEUE = 'video-processing'`, `VIDEO_JOBS = { PROCESS: 'process-video', SWEEP_EXPIRED_UPLOADS: 'sweep-expired-uploads' } as const`. O `VideoProcessor` despacha por `job.name`.

#### process-video

**Payload:**

```json
{ "videoId": "uuid" }
```

**Job options:** `jobId = videoId` (enqueue idempotente), `attempts = VIDEO_PROCESSING_ATTEMPTS` (3), `backoff: { type: 'exponential', delay: 5000 }`, `removeOnComplete: false`, `removeOnFail: false` (jobs mantidos para que o `jobId` continue deduplicando, conforme aviso da doc do BullMQ em `library-refs.md`).
**Producer:** `VideoProcessingProducer` (API, `VideosModule`), chamado por `POST /videos/:slug/upload/complete` após a transição guardada `draft → processing` (per `phase-03-videos/TD-15`).
**Consumer:** `VideoProcessor` (`@Processor('video-processing', { concurrency: WORKER_CONCURRENCY })`, `WorkerHost`) no processo `video-worker` (per `phase-03-videos/TD-06`), delegando a `VideoProcessingService.process(videoId)`:
1. Carrega o vídeo; se não existe ou `status` ≠ `processing` → retorna sem efeito (idempotência, per `phase-03-videos/TD-15`).
2. Assina um `GetObject` no endpoint **interno** e passa a URL ao `ffprobe -v error -print_format json -show_format -show_streams` (per `phase-03-videos/TD-07`, `phase-03-videos/TD-08`). Sem stream de vídeo → `UnrecoverableError` (sem retry).
3. Extrai um frame em `duration × 0.1` (0 se a duração for ≤ 1s ou ausente) com `ffmpeg -ss {t} -i {url} -frames:v 1 -vf scale=1280:-2` para um JPEG temporário e faz `PutObject` em `videos/{videoId}/thumbnail.jpg` (per `phase-03-videos/TD-09`).
4. `UPDATE videos SET status='ready', duration_seconds, metadata, thumbnail_key, processed_at=now(), processing_error=null WHERE id=:id AND status='processing'`.
**Trigger:** conclusão do upload (`POST /videos/:slug/upload/complete`).
**Failure handling:** `@OnWorkerEvent('failed')` — quando a falha é final (`UnrecoverableError` ou `job.attemptsMade ≥ job.opts.attempts`), `VideoProcessingService.markFailed(videoId, message)` faz `UPDATE ... SET status='failed', processing_error=:message (≤500 chars) WHERE id=:id AND status='processing'`. Falhas intermediárias apenas são registradas em log (contexto de background — catch-and-log permitido pela rule de services) (per `phase-03-videos/TD-14`).
**Delivery semantics:** at-least-once; processamento idempotente (chave de thumbnail determinística, update final condicionado a `status='processing'`) (per `phase-03-videos/TD-15`).

#### sweep-expired-uploads

**Payload:**

```json
{}
```

**Producer:** job scheduler `expired-uploads-sweeper`, registrado de forma idempotente pelo worker no bootstrap com `queue.upsertJobScheduler('expired-uploads-sweeper', { every: UPLOAD_SWEEP_INTERVAL_MINUTES × 60000 }, { name: 'sweep-expired-uploads', data: {}, opts: { removeOnComplete: true, removeOnFail: 100 } })` (per `phase-03-videos/TD-17`).
**Consumer:** `VideoProcessor` → `ExpiredUploadsSweeperService.sweep(now)`: busca vídeos `status='draft'` com `created_at < now − UPLOAD_EXPIRATION_HOURS` e, para cada um, `VideoDraftsService.discard(video)` (aborta o multipart se `upload_id` ≠ null, remove `videos/{videoId}/source` se existir, apaga o registro). Retorna a quantidade removida.
**Trigger:** intervalo fixo `UPLOAD_SWEEP_INTERVAL_MINUTES` (default 60).
**Delivery semantics:** at-least-once; idempotente (um rascunho já removido simplesmente não é mais encontrado) (per `phase-03-videos/TD-17`).

---

## Dependency Map

```
SI-03.1 (root — dependências, config, MinIO/Redis no Compose, FFmpeg na imagem)
├── SI-03.2 — depends on SI-03.1 (MinIO + config storage)
├── SI-03.3 — depends on SI-03.1 (config + migrations no container)
├── SI-03.4 — depends on SI-03.1 (Redis + config queue)
└── SI-03.9 — depends on SI-03.1 (FFmpeg instalado)

SI-03.5 — depends on SI-03.2 (abrir multipart) + SI-03.3 (entidade Video)
├── SI-03.6 — depends on SI-03.5 (rascunho existe)
│   ├── SI-03.7 — depends on SI-03.6 (partes enviadas) + SI-03.4 (produtor da fila)
│   └── SI-03.8 — depends on SI-03.6 (rascunho do dono)
└── SI-03.13 — depends on SI-03.5 (vídeos + controller)
    └── SI-03.14 — depends on SI-03.13 (acesso por slug)

SI-03.10 — depends on SI-03.2 (storage) + SI-03.3 (Video) + SI-03.9 (FfmpegService)
└── SI-03.11 — depends on SI-03.4 (fila) + SI-03.10 (lógica do worker)
    └── SI-03.12 — depends on SI-03.11 (worker) + SI-03.8 (VideoDraftsService)

SI-03.15 — depends on SI-03.7 (conclusão + enqueue) + SI-03.11 (worker) + SI-03.14 (entrega)
└── SI-03.16 — depends on SI-03.15 (comportamento final verificado)
```

Ordem de execução (topológica): SI-03.1 → SI-03.2 → SI-03.3 → SI-03.4 → SI-03.5 → SI-03.6 → SI-03.7 → SI-03.8 → SI-03.9 → SI-03.10 → SI-03.11 → SI-03.12 → SI-03.13 → SI-03.14 → SI-03.15 → SI-03.16.

---

## Deliverables

- [ ] SI-03.1 — Infra: dependências, configuração e serviços de storage e fila no Compose
- [ ] SI-03.2 — StorageModule e StorageService (S3/MinIO)
- [ ] SI-03.3 — Entidade Video, relação com Channel e migration CreateVideos
- [ ] SI-03.4 — Fila: QueueModule (BullMQ) e VideoProcessingProducer
- [ ] SI-03.5 — Pré-cadastro do vídeo como rascunho (POST /videos)
- [ ] SI-03.6 — Assinatura de partes e estado do upload (retomada)
- [ ] SI-03.7 — Conclusão do upload e enfileiramento do processamento
- [ ] SI-03.8 — Cancelamento do upload (DELETE /videos/:slug/upload)
- [ ] SI-03.9 — FfmpegService (ffprobe/ffmpeg via spawn) e fixtures de vídeo
- [ ] SI-03.10 — VideoProcessingService (metadados + thumbnail)
- [ ] SI-03.11 — Worker: entrypoint, VideoProcessor e serviço video-worker no Compose
- [ ] SI-03.12 — Sweeper de uploads abandonados no worker
- [ ] SI-03.13 — Detalhes do vídeo pela URL única com autenticação opcional (GET /videos/:slug)
- [ ] SI-03.14 — Streaming, download e thumbnail por redirecionamento a URLs assinadas
- [ ] SI-03.15 — Pipeline completo de ingestão (E2E com worker real)
- [ ] SI-03.16 — Documentação: guia de testes, CLAUDE.md, diagrama e OpenAPI

**Full test suites:**

- [ ] Infra up: `cd nestjs-project && docker compose up -d` — `db`, `redis`, `minio` healthy; `minio-init` exit 0; `video-worker` running
- [ ] Migrations aplicadas: `cd nestjs-project && docker compose exec nestjs-api npm run migration:run`
- [ ] Backend tests pass (`cd nestjs-project && docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`cd nestjs-project && docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation checks pass (`cd nestjs-project && docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`cd nestjs-project && docker compose exec nestjs-api npm run lint`)
- [ ] Project builds successfully, including the worker entrypoint (`cd nestjs-project && docker compose exec nestjs-api npm run build` → `dist/main.js` e `dist/worker.js`)
