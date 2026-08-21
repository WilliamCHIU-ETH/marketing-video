# HeyGen paid request traceability

Every supported HeyGen video create request in this repository must go through the attributable
`run.js` path before the network call is sent. This is an operational trace contract; it does not
prove that paid generation succeeds or that HeyGen reports the final credit charge.

## Managed Project Run

`server/index.js` gives `run.js` a unique `WORKSPACE_RUN_TOKEN`. Before any paid create request,
`run.js` resolves that token to exactly one `DATA_DIR/jobs/<run>/job.json`, then verifies:

- the Run directory, `job.id`, and optional `job.runId` agree;
- the referenced Project and Revision exist inside `DATA_DIR/projects/`;
- the Revision's `projectId`, `jobId`, and `runId` agree with the Run;
- `job.status`, `job.workspaceRunStatus`, and `revision.status` are all currently `preparing`;
- none of the identity files or directories escape containment through a symlink.

Zero matches, duplicate matches, malformed identity, or containment failure stops before the create
request. The token is only a lookup capability; it is not written to the title or ledger.

## Dashboard title

Managed requests use this deterministic base title:

```text
MV-<projectId>-V<revisionNumber>-<runId>
```

An experimental manual run can use `--experiment=EXP-001 --revision=V1`; its base title remains
`測試用EXP-001-V1`. Multi-speaker creates append `-S01A`, `-S02B`, and so on, so parallel segments
never share one Dashboard title. The corresponding experiment ledger name is deterministic for the
EXP/Revision pair, so a later process sees the earlier reservation. `--experiment-run-id` is rejected:
a genuinely new create requires a new Revision. EXP contexts reject `--heygen-title` and
`HEYGEN_VIDEO_TITLE` so the canonical `測試用EXP-NNN-VN` marker cannot be replaced. Project contexts
may use `--heygen-title` as a readable prefix, while Project/Run identity remains appended.

Manual CLI invocation must supply all of `--project-id`, `--revision`, and `--run-id`, or both
`--experiment` and `--revision`. Missing or mixed identity fails before workspace mutation, MiniMax,
HeyGen upload, or create. Timestamp and PID are not accepted as paid-request identity.

## Provider ledger

The complete payload is built and its non-empty title plus canonical logical key are durably recorded
before `fetch`. Managed and explicit Project invocations derive the same ledger filename from the full
canonical Project/Revision/Run trace and write under `DATA_DIR/provider-ledgers/`. The entry method and
mutable title are not part of that namespace, so either managed/manual entry order encounters the same
reservation before provider work. Experiment ledgers remain deterministic for their EXP/Revision pair.
These files are runtime data and remain outside Git. `DATA_DIR`, the ledger directory, identity files,
and the ledger file must be ordinary non-symlink filesystem nodes. The trace JSON is an immutable header;
reservations and state transitions are immutable event files in its adjacent event directory. Each event
is fsynced and published by a no-clobber hard link, then the destination is proved to be the same inode and
bytes as the verified temporary file. A concurrent destination therefore wins without being overwritten,
while the current request reloads or fails closed. No mutable JSON snapshot is replaced with POSIX rename.

Ledger access also uses an atomic cooperative lock and reloads the on-disk header plus all events instead
of trusting stale in-memory state. The tracer pins the real path plus device/inode identity of `DATA_DIR`,
`provider-ledgers`, the header, and the event directory, then revalidates directory, lock, temporary file,
event, and ledger containment throughout every read/write cycle. Renaming either root, replacing it with a
symlink, or replacing a validated temp/header/event stops before paid transport. After any local
`onPrepared` callback, the exact `prepared` reservation and pinned identities are re-read immediately
before `fetch`, for both newly created and pre-reserved requests.

For the MiniMax/audio-driven fallback, every exact HeyGen create request is reserved in the ledger
before MiniMax TTS or HeyGen audio upload starts. The same exact reservation and pinned filesystem
identities are freshly verified immediately before each MiniMax TTS and HeyGen upload callback. The
later video-create call must consume and reverify that reservation; an identity mismatch fails before
the corresponding paid callback or `fetch`.

A `prepared` reservation is not permission to execute a paid operation. Immediately before MiniMax
TTS, HeyGen audio upload, or HeyGen create transport, the process must durably publish an immutable
operation claim for the canonical reservation and one allowlisted operation key: `minimax-tts`,
`heygen-audio-upload`, or `heygen-video-create`. Publishing is no-clobber, so concurrent attempts at
the same reservation/operation have exactly one winner before provider code starts. Different
operations on one reservation remain valid, and each multi-speaker segment has its own canonical
reservation, so legitimate operations and segments do not block one another.

An operation claim is intentionally fail-closed. If the process crashes or loses the provider
response after the claim, a retry must not execute that same paid operation automatically. The
operator must reconcile the immutable ledger with the provider Dashboard before deciding whether a
new Revision is required. This prevents a retry from turning uncertain provider state into a duplicate
charge; it does not prove the provider received or completed the claimed operation.

The ledger stores only the minimum correlation evidence:

- Project/Revision/Run or explicit experiment identity;
- local request ID, API path kind, exact Dashboard title, canonical logical key, and optional segment;
- immutable paid-operation claim ID, operation key, and claim timestamp;
- `prepared`, `submitted`, `completed`, or `failed` state;
- provider video ID after submission;
- duration and credit values only when present in the provider status response.

Script text, audio asset IDs, avatar IDs, API keys, workspace tokens, and provider response bodies are
not stored. When HeyGen does not return credits, the ledger records `credits: null` with explicit
`creditsEvidence`; it must not estimate a charge.

The canonical key hashes trace identity, API kind, and normalized segment identity; it deliberately
does not include the mutable Dashboard title. Changing `--heygen-title` therefore cannot bypass the
duplicate-create guard for the same Project/Revision/Run or EXP/Revision logical request.

`prepared` proves a paid pipeline reservation and the exact future HeyGen payload title, not that
HeyGen received the request. An operation claim proves only that this system granted one local attempt,
not that provider transport succeeded. In the MiniMax fallback the reservation can be written before
TTS; in every path it is present before the HeyGen create `fetch`. If a process exits before the
provider response, the entry can remain `prepared` with one or more operation claims. A later run
therefore refuses the same logical request or claimed operation even if its title changes; an operator
must inspect the ledger and provider Dashboard instead of risking a duplicate charge.

## Dry-run

`node run.js --dry-run` requires the same explicit or managed identity but does not require provider
keys. It executes before dotenv loading, provider-key reads, workspace lock/owner writes, staging
cleanup, child processes, MiniMax TTS, HeyGen upload, create, poll, or download. It prints JSON
containing the exact create endpoint, API kind, normalized segment, Dashboard title, canonical logical
key, trace, the planned ledger path, and allowlisted payload-safe metadata. It never prints script
text, avatar/voice/audio IDs, keys, or provider response data.

Dry-run resolves identity and plans requests through a read-only context. It never creates `DATA_DIR`,
provider-ledger directories, ledger files, temporary files, or locks, and it never rewrites or renames
an existing ledger. A later real run is therefore not blocked or otherwise mutated by its preview.

## Validation boundary

Unit tests use filesystem fixtures and pure payload builders. They do not set provider keys, call
HeyGen, call MiniMax, upload audio, poll a provider, or claim paid-path production readiness.

The historical standalone diagnostics `scripts/test-v3-videos.js`, `scripts/test-avatar-iv.js`, and
`scripts/verify-dual.js` are retired. Each deterministically exits through the shared retirement guard
before dotenv, API-key access, MiniMax, upload, or `fetch`; the former `npm run test:v3` entry is removed.
Their historical bodies remain only as source context and are not supported execution paths.
