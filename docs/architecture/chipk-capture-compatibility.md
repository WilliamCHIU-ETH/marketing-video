# ChipK Capture compatibility matrix

Marketing Video consumes ChipK Capture only through its versioned CLI/JSON Port. The Provider remains an
optional sibling executable and is not an npm dependency, install prerequisite, or ordinary CI
dependency of this repository.

## Consumer lock

| Provider ID | Contract | Operations | Tool version | Release identity |
|---|---:|---|---:|---|
| `chipk-simulator-capture` | `1` | screenshot, record | `0.3.0` | `v0.3.0` at `586fbe7414ab0c25d78ae6e462887fe72030e0a7` |
| `chipk-simulator-capture` | `2` | prepared-video | `0.3.0` | `v0.3.0` at `586fbe7414ab0c25d78ae6e462887fe72030e0a7` |

Top-level capability schema and operations remain v1-compatible. The v2 consumer selects exactly
one `contractCapabilities` v2 entry and the supported presentation profile, including its closed
`stockIds: ["3441"]`; it does not infer v2 support from top-level operations. The lock records the
immutable Provider release identity after the release gate; the CLI does not claim to prove Git metadata.

`config/chipk-capture-provider.lock.json` is the App-owned runtime lock. A version mismatch is
handled by the existing policy: `prefer-capture` falls back with
`provider_version_incompatible`, while `require-capture` fails closed. `prepared-video` only accepts
`require-capture`, so it cannot silently become raw media or an existing asset. A job with no
acquisition intent and `disable-capture` perform zero Provider probes.

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

Provider v0.3.0 does not advertise `runReadiness.vipSession=verified_before_mutation`, so
prepared-video `mode=live` fails before Provider acquire. Synthetic conformance remains supported;
a live Simulator/session and final rendered pixels remain a separate, blocked acceptance run.

The ordinary `npm run test:material-provider` and `npm run smoke` paths remain Provider-free and do
not require the sibling repository.
