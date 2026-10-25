# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 7/16 completed

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
- **Status:** completed
- **Tests:** 11/11 passing (video-processing.producer.integration-spec.ts: 3, queue.module.spec.ts: 1, + videos.module.spec.ts e specs de vídeo existentes)
- **Observations:** 
  - `@nestjs/bullmq@12.0.0` é ESM-only (`"type": "module"`) — o Jest/CommonJS do projeto falha com `SyntaxError: Unexpected token 'export'`. Fixado `@nestjs/bullmq@^11.0.5` (CJS, peers Nest ^10
  - ^11 e bullmq ^3–^6). Registrado como `**Revisions:**` em `phase-03-videos/TD-01`, com `library-refs.md`, `context.md`, `validation.md` e o plano reestampados e nota de amendment no SI-03.1.
  - `bullmq@6` tornou `ioredis` peer opcional (changelog v6, via context7): sem ele a conexão nunca abre e `Queue.close()` lança `Cannot read properties of undefined (reading 'off')`. Instalado `ioredis@^5.11.1` (versão usada nos testes do próprio bullmq 6.4.2).
  - `Queue#client` foi removido no bullmq 6; o teste de prefixo verifica `job.queueQualifiedName` em vez de chaves Redis cruas.

### SI-03.5 — Pré-cadastro do vídeo como rascunho (POST /videos)
- **Status:** completed
- **Tests:** slug.util.spec: 2, videos.service.spec: 6, videos.service.integration-spec: 2, channels.service.integration-spec: +2 (findByUserId), videos.e2e-spec: 6 — passing; e2e completo 58/58, unit+integração completo verde
- **Observations:** 
  - O script `test:e2e` não tinha `--runInBand` (o CLAUDE.md do backend afirma que já estava configurado): com uma 4ª suíte e2e os arquivos passaram a rodar em paralelo no mesmo banco e o login de uma suíte quebrava com 500 enquanto a outra limpava as tabelas. Adicionado `--runInBand` ao script.
  - Helper `isPgUniqueViolationOnColumn` criado em `src/common/database/pg-errors.ts` para o retry de slug; o `ChannelsService` mantém a cópia privada dele (refatorar fica fora do escopo).
  - Helpers de teste novos: `src/test/videos-test-module.ts` (módulo com DB+MinIO+Redis reais e limpeza de storage), `test/helpers/create-test-app.ts` (globais do `main.ts`) e `test/helpers/auth-user.ts` (registro→confirmação→login, limpando o throttler).

### SI-03.6 — Assinatura de partes e estado do upload (retomada)
- **Status:** completed
- **Tests:** videos.service.spec: +7, videos.service.integration-spec: +1, videos.e2e-spec: +10 — passing (src/videos 28/28, videos.e2e 16/16)
- **Observations:** 
  - `findOwnedDraft` exige também `upload_id` não nulo (rascunho com multipart aberto) — o mesmo guard é reutilizado por conclusão e cancelamento nas próximas SIs.
  - A expiração das URLs é limitada pela expiração do rascunho (`created_at + UPLOAD_EXPIRATION_HOURS`), coberto por teste unitário com rascunho a 15 minutos de expirar.

### SI-03.7 — Conclusão do upload e enfileiramento do processamento
- **Status:** completed
- **Tests:** videos.service.spec: +7, videos.service.integration-spec: +1, videos.e2e-spec: +5 — passing (src/videos 36/36, videos.e2e 21/21)
- **Observations:** 
  - O AC da fila indisponível (503 + reversão para `draft`) é coberto por teste unitário com o produtor lançando erro; derrubar o Redis dentro do e2e afetaria as demais suítes que compartilham o serviço.
  - A lista do `CompleteMultipartUpload` é montada pelo servidor a partir do `ListParts` (o cliente não precisa ler o header `ETag`, o que evita depender de CORS `ExposeHeaders` no storage).
  - Corrida entre duas conclusões simultâneas: a transição guardada garante um único vencedor; o perdedor relê o vídeo e devolve o estado atual (202) ou 409.

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
