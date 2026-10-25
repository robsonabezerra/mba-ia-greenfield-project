# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 1/16 completed

### SI-03.1 — Infra: dependências, configuração e serviços de storage e fila no Compose
- **Status:** completed
- **Tests:** 7/7 passing (env.validation.integration-spec.ts) + app.e2e-spec.ts 1/1
- **Observations:** 
  - Imagem oficial `minio/minio` não existe mais no Docker Hub e `quay.io/minio/minio` exige autenticação; usado o fork comunitário `pgsty/minio:RELEASE.2026-08-04T00-00-00Z` (mesma API S3, já traz `mc`), conforme registrado no research.
  - `rootDir` do `test/jest-e2e.json` é `test/` (relativo ao arquivo), então o setupFile aponta para `<rootDir>/../src/test/setup-test-env.ts`.
  - ffmpeg do Debian 12 (5.1.9) inclui `libx264` e `aac`, usados pelos fixtures de teste.
  - Verificado manualmente: `minio`/`redis` healthy, `minio-init` Exited (0), bucket `streamtube` privado, boot sem `S3_ACCESS_KEY_ID` falha com 'Config validation error'.

### SI-03.2 — StorageModule e StorageService (S3/MinIO)
- **Status:** pending
- **Tests:** —
- **Observations:** none

### SI-03.3 — Entidade Video, relação com Channel e migration CreateVideos
- **Status:** pending
- **Tests:** —
- **Observations:** none

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
