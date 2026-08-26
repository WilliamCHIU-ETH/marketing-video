# ChipK Capture compatibility matrix

Marketing Video consumes ChipK Capture only through its versioned CLI/JSON Port. The Provider remains an
optional sibling executable and is not an npm dependency, install prerequisite, or ordinary CI
dependency of this repository.

## Consumer lock

| Provider ID | Contract | Operations | Tool version | Runtime policy | Release identity |
|---|---:|---|---:|---|---|
| `chipk-simulator-capture` | `1` | screenshot, record | `0.3.1` | Enabled when the existing request policy and validation gates pass | tag `v0.3.1`; commit `null`; `pending-provider-attestation` |
| `chipk-simulator-capture` | `2` | prepared-video | `0.3.1` | Synthetic conformance only; live disabled by `readyToPlaceLiveEnabled: false` | tag `v0.3.1`; commit `null`; `pending-provider-attestation` |

The top-level lock pins the observable Provider tool version, but enablement is contract-specific.
Contract v1 remains top-level capability compatible and may use screenshot／record at `0.3.1` after
its existing policy and artifact validation gates pass. The v2 consumer selects exactly one
`contractCapabilities` v2 entry and the supported presentation profile, including its closed
`stockIds: ["3441"]`; it does not infer v2 support from top-level operations. A matching version or
an advertised profile does not enable live v2: `readyToPlaceLiveEnabled` must be exactly `true`, and
the current lock deliberately sets it to `false`. Missing or non-boolean values therefore fail closed.

The lock currently records `release.tag: v0.3.1`, `release.commit: null`, and
`release.status: pending-provider-attestation`; this is not a verified release identity. The Provider
CLI exposes only the `capabilities` and `acquire` command surface and does not reveal a release
commit, while Marketing Video does not enter the provider repository to infer Git metadata. Status
may become `released` only after the Provider owner or release CI supplies an immutable release
manifest containing the tag, commit, and binary digest.

`config/chipk-capture-provider.lock.json` is the App-owned runtime lock. A version mismatch is
handled by the existing policy: `prefer-capture` falls back with
`provider_version_incompatible`, while `require-capture` fails closed. `prepared-video` only accepts
`require-capture`, so it cannot silently become raw media or an existing asset. A job with no
acquisition intent and `disable-capture` performs zero Provider probes.

## Cross-repo gate

Use the Provider-owned synthetic conformance executable so the real process/JSON boundary runs both
the legacy v1 screenshot gate and the complete v2 prepared-video consumer lifecycle without
Simulator access:

```bash
cd /Users/chiu/Developer/marketing-video/app
npm run test:chipk-provider-compat -- \
  --provider-bin /absolute/path/to/chipk-simulator-capture/test/conformance-cli.js
```

The command requires an explicit absolute executable path and writes synthetic state under an OS
temporary directory. Its v2 path validates the exact five-role bundle and actual media bytes, stages
the prepared MP4 into a Run, compiles the placement, then proves delayed Project Asset／Revision
selection and persisted timeline-ready evidence. It fails if a raw fallback appears. The
Provider-owned fixture must therefore emit a genuinely decodable silent H264 MP4 rather than trust
stubbed metadata. App-local tests additionally cover stale/hash rejection and render-input binding.

The App validates the outer role, path, hash, media, and result-evidence contract, then parses the
`capture-manifest`, `presentation-plan`, and `preparation-manifest` sidecars. Route／stock／request／
profile／source／output／catalog identities and every cross-file hash must agree with the request,
advertised profile capability, result evidence, and five artifact descriptors before the bundle is
accepted. Missing or drifted provenance fails closed.

Provider `0.3.1` does advertise `runReadiness.vipSession=verified_before_mutation`; that readiness
signal does not enable prepared-video live acquisition. Marketing Video deliberately keeps
`readyToPlaceLiveEnabled: false`, so contract v2 `mode=live` fails with
`provider_ready_to_place_live_disabled` before Provider acquire even when readiness is advertised.
The flag remains closed until the v2 cutover receives a formal review. Synthetic conformance remains
supported; a live Simulator/session and final rendered pixels remain a separate, blocked acceptance run.

The ordinary `npm run test:material-provider` and `npm run smoke` paths remain Provider-free and do
not require the sibling repository.

## Known coupling before v2 live cutover

`server/public/index.html:1575` still compares prepared evidence against Provider version `0.3.0`.
Because `readyToPlaceLiveEnabled` is currently false, the App cannot legitimately produce `0.3.1`
live prepared evidence, so this stale UI constant does not create a current false negative. It is
not a safety gate. Before setting `readyToPlaceLiveEnabled` to true, the cutover must first remove or
update that coupling and its UI fixtures so the frontend consumes the same compatibility truth as
the backend.

## Rollback to 0.3.0

An emergency rollback is an atomic consumer-lock rollback: restore `toolVersion` to `0.3.0` and
restore the previously attested release identity to tag `v0.3.0`, commit
`586fbe7414ab0c25d78ae6e462887fe72030e0a7`, status `released`. Keep
`readyToPlaceLiveEnabled: false`; rollback must not double as a v2 cutover. The matching executable
and the lock must move together, followed by the Provider-free compatibility tests.

This rollback removes the supported `0.3.1` contract v1 CTA live-capture path. Operators must treat
CTA real-device acquisition as unavailable after rollback rather than silently run a `0.3.1`
executable against the `0.3.0` lock or substitute generated media. Contract v2 live remains disabled.
