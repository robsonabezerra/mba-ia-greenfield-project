# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 15/16 completed

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
- **Status:** completed
- **Tests:** video-drafts.service.integration-spec: 3, videos.service.spec: +3, videos.e2e-spec: +4 — passing (src/videos 42/42, videos.e2e 25/25)
- **Observations:** 
  - `VideoDraftsService.discard` trata `NoSuchUpload` do abort como resultado válido (multipart já liberado ou expirado) — único erro convertido; qualquer outro propaga, conforme a rule de services.
  - O cancelamento aceita rascunho sem `upload_id` (caso de uma conclusão que falhou no enqueue e reverteu para `draft` com o objeto já montado): o `discard` remove o objeto pelo `headObject`.

### SI-03.9 — FfmpegService (ffprobe/ffmpeg via spawn) e fixtures de vídeo
- **Status:** completed
- **Tests:** 8/8 passing (probe-parser.spec.ts: 4, ffmpeg.service.integration-spec.ts: 4)
- **Observations:** 
  - `parseProbeOutput` ignora streams de vídeo com `disposition.attached_pic = 1` (capa embutida em arquivos de áudio), para que um MP3 com capa não passe como vídeo.
  - O timeout é parâmetro opcional de `probe`/`extractFrame` (default `FFMPEG_TIMEOUT_MS` = 120s); o teste usa 1ms para provar o `SIGKILL`.
  - `generateTestVideo` aceita `videoBitrate` para gerar MP4s maiores que uma parte de 5 MiB no e2e do pipeline (SI-03.15).

### SI-03.10 — VideoProcessingService (metadados + thumbnail)
- **Status:** completed
- **Tests:** 20/20 passing em src/video-processing (video-processing.service.spec: 8, video-processing.service.integration-spec: 3, video-processing.module.spec: 1, + specs da SI-03.9)
- **Observations:** 
  - Além de 'sem stream de vídeo', erros do ffprobe que indicam bytes não decodificáveis (`Invalid data found when processing input`, `moov atom not found`, `could not find codec parameters`) viram `UnrecoverableError` — retentar não ajuda; os demais erros (rede, storage) propagam e seguem o retry do BullMQ.
  - O FFmpeg lê a fonte pela URL assinada do endpoint interno (`presignInternalGetObject`), sem baixar o arquivo; só o JPEG do thumbnail vai para um diretório temporário, removido em `finally`.

### SI-03.11 — Worker: entrypoint, VideoProcessor e serviço video-worker no Compose
- **Status:** completed
- **Tests:** video.processor.integration-spec: 2, worker.module.spec: 1 — passing; suítes completas: unit+integração 223/223, e2e 77/77
- **Observations:** 
  - O worker só registrava `Video` e o TypeORM não resolvia a relação `Video → Channel → User` (`autoLoadEntities` só carrega entidades de `forFeature`): o `WorkerModule` importa `ChannelsModule` e `UsersModule`, donos dessas entidades, sem nenhum módulo HTTP (verificado no teste: zero controllers).
  - `ConfigModule` e opções do TypeORM extraídos para `src/config/config-module.options.ts` e `src/database/typeorm-options.ts`, compartilhados por `AppModule` e `WorkerModule`.
  - A `concurrency` do worker é aplicada em `onApplicationBootstrap` (`this.worker.concurrency`), porque as opções do decorator `@Processor` são avaliadas no import, antes de o `.env` ser carregado.
  - No Compose, `npm run start:worker` como PID 1 engolia o SIGTERM (saída 1, `npm error signal SIGTERM`); o serviço passou a rodar `node -r ts-node/register src/worker.ts` com `init: true`. Verificado: o log mostra 'SIGTERM received, closing the worker' e o container sai em menos de 1s com 143 (o Nest re-emite o sinal após fechar o worker).
  - Verificado: `npm run build` gera `dist/worker.js` e `npm run start:worker:prod` inicia o consumidor.

### SI-03.12 — Sweeper de uploads abandonados no worker
- **Status:** completed
- **Tests:** expired-uploads-sweeper.service.integration-spec: 2, expired-uploads-scheduler.service.integration-spec: 1, video.processor.integration-spec: +1 (job de sweep pelo worker real) — passing (src/video-processing + worker 27/27)
- **Observations:** 
  - `VideoDraftsService` (domínio de vídeos) é provido também no `VideoProcessingModule`, que já tem o repositório `Video` e o `StorageModule` — o worker reaproveita a mesma limpeza do cancelamento sem importar o `VideosModule` (que traz controller HTTP).
  - O sweeper faz catch-and-log por rascunho (contexto de background permitido pela rule de services): um rascunho com erro não interrompe a varredura e volta a ser tentado na próxima execução.

### SI-03.13 — Detalhes do vídeo pela URL única com autenticação opcional (GET /videos/:slug)
- **Status:** completed
- **Tests:** jwt-auth.guard.spec: +3, videos.service.spec: +3, videos.e2e-spec: +6 — passing (guard+videos 53/53, videos.e2e 31/31, auth.e2e sem regressão)
- **Observations:** 
  - `@OptionalAuth()` é verificado antes de `@Public()` no guard global: token válido popula `request.user`, ausente ou inválido segue anônimo; rotas protegidas continuam exigindo token (coberto em unit e e2e).
  - Vídeo não-`ready` responde 404 também para outros usuários autenticados, não 403, para não revelar rascunhos de terceiros (Authorization Matrix).

### SI-03.14 — Streaming, download e thumbnail por redirecionamento a URLs assinadas
- **Status:** completed
- **Tests:** download-filename.util.spec: 4, videos.service.spec: +5, videos-delivery.e2e-spec: 7 — passing (src/videos 54/54)
- **Observations:** 
  - As rotas usam `@Redirect()` do Nest com `{ url }` dinâmico e `@Header('Cache-Control', 'no-store')` — a URL assinada expira, então a resposta 302 não pode ser cacheada.
  - O e2e segue o `Location` com `fetch` de dentro do container (o endpoint público é igual ao interno nos testes) e valida o 206 + `Content-Range` servido pelo próprio MinIO: nenhum byte de vídeo passa pela API.

### SI-03.15 — Pipeline completo de ingestão (E2E com worker real)
- **Status:** completed
- **Tests:** 2/2 passing (video-pipeline.e2e-spec.ts: caminho feliz multipart (≥2 partes) → ready → stream 206/download/thumbnail; caminho de falha → failed)
- **Observations:**
  - A API (`createTestApp`) e o `WorkerModule` sobem no mesmo processo de teste com o prefixo de fila de teste; o `video-worker` de dev (prefixo `streamtube`) não consome esses jobs.
  - A asserção `part_count ≥ 2` revelou que o fixture saía com ~0,5 MB (uma parte só) porque o x264 ignora `minrate` sem CBR estrito; `generateTestVideo` passou a usar `-x264-params nal-hrd=cbr` quando `videoBitrate` é informado (~9 MB, 2 partes de 5 MiB). O commit 50d6e25 entrou com esse teste vermelho (o exit code checado no encadeamento era o do grep, não o do Jest) e foi corrigido no commit seguinte; desde então o exit code do Jest é verificado explicitamente.
  - URLs presigned são assinadas para `GET` (o SigV4 inclui o método): verificar headers com `HEAD` dá 403; o teste usa `GET` com `Range: bytes=0-0`.

### SI-03.16 — Documentação: guia de testes, CLAUDE.md, diagrama e OpenAPI
- **Status:** pending
- **Tests:** —
- **Observations:** none
