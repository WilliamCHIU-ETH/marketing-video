# Environment baseline

As of 2026-08-18, the repository's first operational target is the isolated localhost UI and free smoke path. A passing localhost check does not prove paid provider generation or a reproducible final render.

## Version-controlled contract

- Node.js target: `22.x` (`.nvmrc` and `package.json#engines`)
- JavaScript dependencies: project-local `node_modules/`, reproduced with `npm ci`
- npm cache: project-local `.cache/npm/`
- Runtime jobs: project-local ignored `runtime-data/`, or an explicit `DATA_DIR`
- Brand media: workspace-local `../data/assets/`, exposed through an ignored `assets` symlink
- Provider secrets: project-local ignored `.env`; only `.env.example` is committed
- Server binding: `127.0.0.1`; LAN access remains disabled
- Local ASR runtime: Homebrew `whisper-cpp` provides the external `whisper-cli` command
- Whisper model: pinned `ggml-base-q5_1.bin`, downloaded and SHA-256 verified by `npm run setup:whisper`
- Whisper model cache: keep local weights under ignored `.cache/whisper/`; do not commit them

Do not install project npm packages globally, write provider keys into shell startup files, or commit brand/runtime media, caches, generated output, credentials, or local model weights.

## Verified on this checkout

- `npm run smoke`: pass
  - localhost UI returned HTTP 200
  - health endpoint ran in test mode with the worker disabled
  - fixture job data stayed in a temporary external `DATA_DIR`
  - provider keys were empty and no outbound or child-process attempt was observed
  - unsafe LAN binding and repo-internal test data paths were rejected
- FFmpeg and ffprobe: available
- Tesseract with `chi_tra`: available
- Project npm dependencies: available

## Known gaps before full rendering

- The active shell currently uses Node.js 24, while the repository target is Node.js 22.
- `whisper-cli` and its pinned model are only required for transcription and the full pipeline, not localhost or smoke.
- Valid `public/NotoSansTC-Regular.ttf` and `public/NotoSansTC-Bold.ttf` are missing.
- Paid provider keys are intentionally unset and must not be required by smoke tests.

## Repeatable checks

```bash
npm ci
npm run setup:whisper
npm run doctor
npm run test:transcription
npm run typecheck
npm run smoke
```

Run `npm run doctor:full` only when validating the complete generation, transcription, and render pipeline.
