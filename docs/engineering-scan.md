# Engineering scan — 2026-08-18

## Result

Localhost milestone can proceed. Full video generation and LAN exposure remain blocked.

## P0 addressed in the candidate

- Default bind changed from `0.0.0.0` to `127.0.0.1`.
- Non-local bind is rejected unless `ALLOW_INSECURE_LAN=1` is explicitly set.
- `brand` is restricted to the directories returned by `listBrands()`.
- Brand execution now uses `execFileSync(process.execPath, args)` instead of interpolated shell text.
- Upload filenames are allowlisted, video/image size limits are enforced, and writes use a temporary file followed by atomic rename.
- `?admin=1` is disabled by default; `/api/unlock` now requires local admin context.
- Unlock only removes a parseable lock whose recorded PID is no longer alive; active, detached and legacy/unknown locks fail closed.
- Smoke tests use explicit `TEST_MODE`, temporary `DATA_DIR`, disabled worker and blank provider keys.
- `TEST_MODE` rejects every repo-contained data path, including symlink resolution back into the repo.

## Dependency baseline

- `npm ci`: pass.
- `npm ls --depth=0`: pass.
- Remotion packages upgraded together from `4.0.459` to `4.0.512`.
- `npm audit`: reduced from 10 high-severity findings to 0 known findings at scan time.
- TypeScript `--noEmit`: pass on Node 22.23.2 and the currently installed Node 24 runtime.

This does not prove that rendered video output is visually identical after the Remotion patch upgrade. A render regression fixture is required in phase 2.

## Remaining P1 blockers

- `whisper` command is missing, so transcription and the full pipeline are not ready.
- 原專案的 `public/NotoSansTC-Regular.ttf` 與 `NotoSansTC-Bold.ttf` 實際是 HTML，不是字型；候選 baseline 不納入這兩個錯誤檔案，需從可驗證來源補回真正字型後才能做 render regression。
- Provider keys are intentionally absent from the candidate repo.
- Historical review jobs are incomplete and must be recovered before cleanup.
- Original credential files have permissions `664`; change them to `600` before future use.

## P2 backlog

- Replace the single-file server with HTTP/application/storage/worker modules.
- Move `public/` and generated JSON out of the shared repository workspace into job-local state.
- Add real LAN authentication before any non-local deployment.
- Add request schemas, structured logging, rate limiting and security headers.
- Add unit tests, render regression fixtures and CI.
- Decide whether OCR/transcription binaries are host dependencies or isolated worker dependencies.
