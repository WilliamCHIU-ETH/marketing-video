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
a genuinely new create requires a new Revision. `--heygen-title` is a readable prefix rather than an
identity override: Project/Run or EXP/Revision identity remains appended.

Manual CLI invocation must supply all of `--project-id`, `--revision`, and `--run-id`, or both
`--experiment` and `--revision`. Missing or mixed identity fails before workspace mutation, MiniMax,
HeyGen upload, or create. Timestamp and PID are not accepted as paid-request identity.

## Provider ledger

The complete payload is built and its non-empty title plus canonical logical key are durably recorded
before `fetch`. Managed runs write `provider-ledger.json` beside `job.json`; explicit CLI runs write under
`DATA_DIR/provider-ledgers/`. Both locations are runtime data and remain outside Git. `DATA_DIR`, the
ledger directory, identity files, and the ledger file must be ordinary non-symlink filesystem nodes.
Ledger mutation uses an atomic lock and reloads the on-disk state, so a second process fails closed
instead of trusting a stale in-memory copy.

For the MiniMax/audio-driven fallback, every exact HeyGen create request is reserved in the ledger
before MiniMax TTS or HeyGen audio upload starts. The later video-create call must consume that same
reservation; an identity mismatch fails before `fetch`.

The ledger stores only the minimum correlation evidence:

- Project/Revision/Run or explicit experiment identity;
- local request ID, API path kind, exact Dashboard title, canonical logical key, and optional segment;
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
HeyGen received the request. In the MiniMax fallback it can be written before TTS; in every path it is
present before the HeyGen create `fetch`. If a process exits before the provider response, the entry
can remain `prepared`. A later run therefore refuses the same logical request even if its title changes;
an operator must inspect the ledger and provider Dashboard instead of risking a duplicate charge.

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
