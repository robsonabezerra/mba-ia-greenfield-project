---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 18
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-10-25T12:36:40-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-25T12:33:32-03:00"
issues:
  - id: AMB-1
    status: open
    summary: "'rascunho' (Fase 03) vs fluxo rascunho → publicação (Fase 04): fronteira ambígua"
  - id: AMB-2
    status: open
    summary: "Pré-cadastro automático: quais campos o rascunho recebe sem input do usuário"
  - id: OQ-1
    status: open
    summary: "TD-01 pending — Background Job Queue Technology"
  - id: OQ-2
    status: open
    summary: "TD-02 pending — Object Storage Client Library"
  - id: OQ-3
    status: open
    summary: "TD-03 pending — Storage Organization, Keys and Endpoints"
  - id: OQ-4
    status: open
    summary: "TD-04 pending — Upload Protocol for Files up to 10GB"
  - id: OQ-5
    status: open
    summary: "TD-05 pending — Upload Size Limit and Part Sizing Policy"
  - id: OQ-6
    status: open
    summary: "TD-06 pending — Video Worker Runtime Model"
  - id: OQ-7
    status: open
    summary: "TD-07 pending — FFmpeg Integration"
  - id: OQ-8
    status: open
    summary: "TD-08 pending — Worker Access to the Source Video"
  - id: OQ-9
    status: open
    summary: "TD-09 pending — Thumbnail Frame Selection"
  - id: OQ-10
    status: open
    summary: "TD-10 pending — Media Metadata Persistence Shape"
  - id: OQ-11
    status: open
    summary: "TD-11 pending — Unique Video URL Identifier"
  - id: OQ-12
    status: open
    summary: "TD-12 pending — Playback (Streaming) and Download Delivery"
  - id: OQ-13
    status: open
    summary: "TD-13 pending — Access Policy for Video Delivery in Phase 03"
  - id: OQ-14
    status: open
    summary: "TD-14 pending — Video Status Lifecycle and Failure Handling"
  - id: OQ-15
    status: open
    summary: "TD-15 pending — Job Publishing Consistency and Idempotency"
  - id: OQ-16
    status: open
    summary: "TD-16 pending — Testing Strategy for Storage, Queue and FFmpeg"
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

- **AMB-1** — The capability "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload" uses the word *rascunho*, while `## Scope → Out of scope` assigns the "fluxo de publicação" to the neighbor Fase 04 (whose own bullet is "Fluxo de rascunho → publicação"). It is not stated whether the Phase 03 *rascunho* is the same state Phase 04 publishes from, or only the ingestion state "upload not finished" — the answer changes the Data Model (one column vs two dimensions) and what Phase 04 inherits. Explicit choice: (a) Phase 03 *rascunho* = ingestion state inside the video status lifecycle (`phase-03-videos/TD-14`); publication becomes a separate dimension introduced by Phase 04; (b) Phase 03 *rascunho* = publication draft, so Phase 03 must also model "unpublished" independently of processing.
- **AMB-2** — "Pré-cadastro **automático**" does not say which fields the draft receives without user input, while the video record needs at least a title (Phase 04 later edits "título, descrição, categoria"). Without this, `/plan-build` cannot fix the initiation request contract. Explicit choice: (a) title defaults to the original file name without extension (client may send an optional `title`), other descriptive fields stay empty until Phase 04; (b) the client must send a title at initiation (required field).

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

- **OQ-1** — TD-01 pending — Background Job Queue Technology. Resolution: fill the **Decision:** field of TD-01 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate phase-03-videos.
- **OQ-2** — TD-02 pending — Object Storage Client Library. Resolution: fill the **Decision:** field of TD-02 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate phase-03-videos.
- **OQ-3** — TD-03 pending — Storage Organization, Keys and Endpoints. Resolution: fill the **Decision:** field of TD-03 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate phase-03-videos.
- **OQ-4** — TD-04 pending — Upload Protocol for Files up to 10GB. Resolution: fill the **Decision:** field of TD-04 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate phase-03-videos.
- **OQ-5** — TD-05 pending — Upload Size Limit and Part Sizing Policy. Resolution: fill the **Decision:** field of TD-05 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate phase-03-videos.
- **OQ-6** — TD-06 pending — Video Worker Runtime Model. Resolution: fill the **Decision:** field of TD-06 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate phase-03-videos.
- **OQ-7** — TD-07 pending — FFmpeg Integration. Resolution: fill the **Decision:** field of TD-07 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate phase-03-videos.
- **OQ-8** — TD-08 pending — Worker Access to the Source Video. Resolution: fill the **Decision:** field of TD-08 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate phase-03-videos.
- **OQ-9** — TD-09 pending — Thumbnail Frame Selection. Resolution: fill the **Decision:** field of TD-09 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate phase-03-videos.
- **OQ-10** — TD-10 pending — Media Metadata Persistence Shape. Resolution: fill the **Decision:** field of TD-10 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate phase-03-videos.
- **OQ-11** — TD-11 pending — Unique Video URL Identifier. Resolution: fill the **Decision:** field of TD-11 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate phase-03-videos.
- **OQ-12** — TD-12 pending — Playback (Streaming) and Download Delivery. Resolution: fill the **Decision:** field of TD-12 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate phase-03-videos.
- **OQ-13** — TD-13 pending — Access Policy for Video Delivery in Phase 03. Resolution: fill the **Decision:** field of TD-13 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate phase-03-videos.
- **OQ-14** — TD-14 pending — Video Status Lifecycle and Failure Handling. Resolution: fill the **Decision:** field of TD-14 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate phase-03-videos.
- **OQ-15** — TD-15 pending — Job Publishing Consistency and Idempotency. Resolution: fill the **Decision:** field of TD-15 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate phase-03-videos.
- **OQ-16** — TD-16 pending — Testing Strategy for Storage, Queue and FFmpeg. Resolution: fill the **Decision:** field of TD-16 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate phase-03-videos.

### UI Coverage Gaps

_None._

## Resolved Issues

_No issues resolved yet._
