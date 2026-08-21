# Marketing Video Agent Guide

This file is the canonical operating contract for coding agents in this repository. Tool-specific entrypoints should point here instead of duplicating these rules.

## Truth sources

Use the current checkout as implementation truth. Read these documents for the decision and evidence boundary:

1. `README.md`: product entrypoint and quick start.
2. `docs/milestone-01.md`: what the current baseline does and does not prove.
3. `docs/operator-runbook.md`: supported local commands and operating procedure.
4. `docs/engineering-scan.md`: addressed risks and remaining backlog.

Historical artifacts are context only, not current architecture or product truth.

## Product boundary

This repository hosts a localhost UI that creates queued video jobs and a worker pipeline that can call HeyGen, transcribe speech, align visual material, and render with Remotion.

- A running localhost server is not evidence that paid provider generation works.
- A historical MP4 is not evidence that the current checkout is reproducible.
- Never invoke paid provider scripts during tests unless the user explicitly authorizes that run.

## HeyGen create naming

- Every HeyGen create request must send a non-empty `title` so the Dashboard entry can be matched to its experiment, revision, duration, and credits.
- Experimental videos use `測試用EXP-NNN-VN`, for example `測試用EXP-001-V1`. Normalize `experience-001` to `EXP-001` and `v1` to `V1`.
- Generate and verify the title in the payload dry-run before the paid request. When a provider ledger exists, save the same title there.
- Renaming is metadata only. Never regenerate a video merely to change its title.

## Architecture

- `server/public/index.html`: browser UI.
- `server/index.js`: HTTP API, filesystem job store, queue, worker launcher.
- `run.js`: legacy pipeline orchestrator.
- `scripts/`: provider-adjacent processing, OCR, transcription, alignment and maintenance tools.
- `src/`: React/Remotion compositions.
- `assets/`: ignored local media source pack; in the managed workspace it points to `../data/assets/`.
- `runtime-data/projects/`: durable Project, Revision, reusable asset manifest, and project outputs; ignored by Git.
- `runtime-data/jobs/`: temporary Run workspace and logs; ignored by Git and eligible for retention cleanup.
- `runtime-data/archive/`: legacy output archive for jobs created before project versioning.
- `public/` and generated JSON under `src/`: transitional shared render workspace; treat as mutable until phase 2 refactoring.

Keep code, configuration, documentation, and sanitized fixtures in this repository. Keep brand media, historical videos, job state, provider caches, archives, and runtime output outside Git. Do not move, rewrite, or delete source data while inspecting it.

New user-visible video work follows `Project → Revision → Run`. Do not create a new Project merely to iterate V1 into V2. Runs may remain isolated in their own folders, but users should manage the Project and its revisions rather than runtime folders.

Project Assets distinguish `image`, general B-Roll `video`, and `speaker-video`. Never infer the role from the file extension alone, and never reuse a `speaker-video` as B-Roll. The current automatic OCR／shot-planning path consumes images; storing and previewing B-Roll does not by itself prove that the clip is edited into the rendered output.

## Optional ChipK Capture provider

ChipK Simulator acquisition is an optional sibling provider. Its source, skill, route catalog,
Simulator/session rules, and standalone tests belong in
`../chipk-simulator-capture/`; read that repository's `AGENTS.md` and Capture skill before changing
provider behavior. Do not copy provider implementation back into this repository.

Marketing Video owns only the `MaterialAcquisitionPort`, CLI/JSON adapter, fallback policy,
caller-owned job acquisition directory, result verification, Project Asset ingest, and downstream
editing. It must not import provider source or directly operate `simctl`, Deep Links, OCR, sessions,
or gestures. With no `materialAcquisition` intent, the existing provider-free flow must remain
unchanged; `disable-capture` must not probe the provider.

## Safe validation

Run in this order:

```bash
npm ci
npm run doctor
npm run typecheck
npm run smoke
```

`npm run smoke` must use `TEST_MODE=1`, an explicit temporary `DATA_DIR`, disabled worker, and empty provider keys. It must not modify `public/`, `src/`, or historical data.

## Data safety

- Cleanup begins with `npm run cleanup:plan`; there is intentionally no apply command.
- Never delete `review`, active, unarchived fallback, or paid-cache data based only on age or extension.
- Do not read or print `.env` or credential contents.
- Default server binding is `127.0.0.1`; do not expose LAN access before authentication exists.
