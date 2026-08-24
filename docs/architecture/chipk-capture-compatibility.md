# ChipK Capture compatibility matrix

Marketing Video consumes ChipK Capture only through its versioned CLI/JSON Port. The Provider remains an
optional sibling executable and is not an npm dependency, install prerequisite, or ordinary CI
dependency of this repository.

## Consumer lock

| Provider ID | Contracts | Tool version | Release tag | Release commit |
|---|---:|---:|---|---|
| `chipk-simulator-capture` | `1`, `2` | `0.3.0` | `v0.3.0` | `586fbe7414ab0c25d78ae6e462887fe72030e0a7` |

Runtime verifies the Provider ID, capability schema, independent v1/v2 contract capabilities,
schema paths, requested operation/profile coverage, and reported tool version. The release
tag and commit record the immutable source identity that passed the release gate; the CLI does not
claim to prove Git metadata.

`config/chipk-capture-provider.lock.json` is the App-owned runtime lock. A version mismatch is
handled by the existing policy: `prefer-capture` falls back with
`provider_version_incompatible`, while `require-capture` fails closed. A job with no acquisition
intent and `disable-capture` perform zero Provider probes.

Contract v1 remains the unchanged screenshot/raw-recording boundary. Contract v2 accepts only
`operation=prepared-video` with an advertised `presentation.profileId`, route, and stock. The
consumer rejects unsupported coverage before acquisition; it never rewrites the request as a v1
screenshot or recording. A successful v2 response must contain the exact five-file
`ready-to-place/` bundle. The App rechecks safe paths, regular files, SHA-256, MIME/media metadata,
closed ready-to-place evidence, and cross-file source/plan/output provenance before ingesting
`prepared.mp4` as a Project-owned `video` Asset.

Ingest proves only Project availability and Revision selection. The acquisition result and its
private evidence file retain provider/request/profile/bundle provenance. No timeline position or
final-render use is inferred or created by this compatibility layer.

## Live cutover blocker

Provider `v0.3.0` does not advertise `runReadiness.vipSession=verified_before_mutation`. Contract v2
synthetic/test compatibility is accepted, but the App rejects `mode=live` prepared-video before
calling acquire with `provider_live_readiness_unverified`. Do not point the active
`CHIPK_CAPTURE_BIN` at this release for live use or bypass this gate. A later synchronized Provider
release must add the reviewed readiness capability and rerun Provider preflight/media conformance,
this cross-repo gate, and the provider-free App regression before live cutover.

## Cross-repo gate

Use the Provider-owned synthetic conformance executable so the real process/JSON, request/result,
artifact validation, and v1 image/v2 video Project Asset ingest seams run without Simulator access:

```bash
cd /Users/chiu/Developer/marketing-video/app
npm run test:chipk-provider-compat -- \
  --provider-bin /absolute/path/to/chipk-simulator-capture/test/conformance-cli.js
```

The command requires an explicit absolute executable path, writes all generated PNG/MP4/manifest/job
state under an OS temporary directory, and removes it at completion. It proves both contract
capabilities, the real CLI boundary, strict consumer validation, Project ownership, and a
version-mismatch negative case. It does not prove a live Simulator/session, a real product
screenshot, timeline placement, or final rendered pixels.

The ordinary `npm run test:material-provider` and `npm run smoke` paths remain Provider-free and do
not require the sibling repository.
