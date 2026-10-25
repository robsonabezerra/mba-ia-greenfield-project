# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 3/16 completed

### SI-03.1 — Infra: dependências, configuração e serviços de storage e fila no Compose
- **Status:** completed
- **Tests:** 7/7 passing (env.validation.integration-spec.ts) + app.e2e-spec.ts 1/1
- **Observations:** 
  - Imagem oficial `minio/minio` não existe mais no Docker Hub e `quay.io/minio/minio` exige autenticação; usado o fork comunitário `pgsty/minio:RELEASE.2026-08-04T00-00-00Z` (mesma API S3, já traz `mc`), conforme registrado no research.
  - `rootDir` do `test/jest-e2e.json` é `test/` (relativo ao arquivo), então o setupFile aponta para `<rootDir>/../src/test/setup-test-env.ts`.
  - ffmpeg do Debian 12 (5.1.9) inclui `libx264` e `aac`, usados pelos fixtures de teste.
  - Verificado manualmente: `minio`/`redis` healthy, `minio-init` Exited (0), bucket `streamtube` privado, boot sem `S3_ACCESS_KEY_ID` falha com 'Config validation error'.

### SI-03.2 — StorageModule e StorageService (S3/MinIO)
- **Status:** completed
- **Tests:** 8/8 passing (storage.service.integration-spec.ts: 7, storage.module.spec.ts: 1)
- **Observations:** 
  - Nos testes o endpoint público é igual ao interno (setup-test-env), então as URLs assinadas são resolvíveis de dentro do container; a assinatura com `localhost:9000` para o navegador é exercitada só fora dos testes.
  - `StorageService` implementa `onModuleDestroy` para destruir os dois `S3Client` (sockets keep-alive não seguram o Jest).

### SI-03.3 — Entidade Video, relação com Channel e migration CreateVideos
- **Status:** completed
- **Tests:** 9/9 passing (video.entity.integration-spec.ts: 6, migrations.integration-spec.ts: 2, videos.module.spec.ts: 1); suíte unit+integração completa 162/162
- **Observations:** 
  - Migration gerada pelo CLI (`1792945993822-CreateVideos.ts`) e formatada pelo Prettier via `eslint --fix`.
  - Como `Channel` ganhou `@OneToMany` para `Video`, as 10 specs existentes com `ALL_ENTITIES` precisaram incluir `Video` (senão o TypeORM não resolve a metadata da relação).
  - O teste de migrations fazia `DROP TABLE ... CASCADE` em paralelo (`Promise.all`) — com a FK `videos→channels` isso passou a dar deadlock; trocado por um único `DROP TABLE a, b, ... CASCADE`.
  - Criado `src/test/video-factory.ts` (`createTestChannel`, `buildVideo`) para reuso nas SIs seguintes.
  - Correção na SI-03.2: `fetch` tipado não aceita `Buffer` como body (o ts-jest não acusou, o `tsc` sim) — passado como `Uint8Array`.

### SI-03.4 — Fila: QueueModule (BullMQ) e VideoProcessingProducer
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.5 — Pré-cadastro do vídeo como rascunho (POST /videos)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.6 — Assinatura de partes e estado do upload (retomada)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.7 — Conclusão do upload e enfileiramento do processamento
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.8 — Cancelamento do upload (DELETE /videos/:slug/upload)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.9 — FfmpegService (ffprobe/ffmpeg via spawn) e fixtures de vídeo
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.10 — VideoProcessingService (metadados + thumbnail)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.11 — Worker: entrypoint, VideoProcessor e serviço video-worker no Compose
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.12 — Sweeper de uploads abandonados no worker
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.13 — Detalhes do vídeo pela URL única com autenticação opcional (GET /videos/:slug)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.14 — Streaming, download e thumbnail por redirecionamento a URLs assinadas
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.15 — Pipeline completo de ingestão (E2E com worker real)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.16 — Documentação: guia de testes, CLAUDE.md, diagrama e OpenAPI
- **Status:** pending
- **Tests:** —
- **Observations:** none
