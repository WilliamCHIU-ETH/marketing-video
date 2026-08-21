# ChipK Capture compatibility matrix

Marketing Video consumes ChipK Capture only through its CLI/JSON v1 Port. The Provider remains an
optional sibling executable and is not an npm dependency, install prerequisite, or ordinary CI
dependency of this repository.

## Consumer lock

| Provider ID | Contract | Tool version | Release tag | Release commit |
|---|---:|---:|---|---|
| `chipk-simulator-capture` | `1` | `0.2.0` | `v0.2.0` | `87c033bed59fd53242b1679bc71b39fb20a11832` |

Runtime verifies only the Provider ID, contract version, and reported tool version. The release
tag and commit record the immutable source identity that passed the release gate; the CLI does not
claim to prove Git metadata.

`config/chipk-capture-provider.lock.json` is the App-owned runtime lock. A version mismatch is
handled by the existing policy: `prefer-capture` falls back with
`provider_version_incompatible`, while `require-capture` fails closed. A job with no acquisition
intent and `disable-capture` perform zero Provider probes.

## Cross-repo gate

Use the Provider-owned synthetic conformance executable so the real process/JSON, request/result,
artifact validation, and Project Asset ingest seams run without Simulator access:

```bash
cd /Users/chiu/Developer/marketing-video/app
npm run test:chipk-provider-compat -- \
  --provider-bin /absolute/path/to/chipk-simulator-capture/test/conformance-cli.js
```

The command requires an explicit absolute executable path, writes all generated PNG/manifest/job
state under an OS temporary directory, and removes it at completion. It proves the supported pair
and a version-mismatch negative case. It does not prove a live Simulator/session, a real product
screenshot, timeline placement, or final rendered pixels.

The ordinary `npm run test:material-provider` and `npm run smoke` paths remain Provider-free and do
not require the sibling repository.
