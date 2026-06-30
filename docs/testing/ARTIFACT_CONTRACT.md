# Artifact Contract

Recursion test artifacts should make failures diagnosable without storing sensitive chat, provider, or credential material. Artifacts are evidence of behavior, not a second storage system.

## Roots

Default roots:

```text
artifacts/playwright-readiness/<run-id>/
artifacts/live-smoke/sillytavern/<run-id>/
artifacts/alpha-gate/<run-id>/
```

Live runs should keep all output under one run root. Paths stored inside reports should be relative to the run root when possible.

## Required Live Files

Every live smoke run should write:

| File | Purpose |
| --- | --- |
| `report.json` | Structured machine-readable result. |
| `summary.md` | Human-readable result and next action. |
| `live-log.jsonl` | Bounded chronological stage log for the run. |
| `screenshots/desktop.png` | Desktop viewport proof. |
| `screenshots/phone.png` | Phone viewport proof. |
| `playwright/trace.zip` | Playwright trace when trace capture is enabled. |
| `storage/probe.json` | Sanitized storage probe result. |
| `prompt/latest-packet-metadata.json` | Prompt packet metadata, hashes, selected cards, install status, and clear status. |
| `activity/latest-run.json` | Last visible Activity Ribbon state and compact stage timeline. |
| `diagnostics/redaction-check.json` | Redaction scan result for generated artifacts. |

Readiness-only runs should write `report.json`, `summary.md`, screenshots, and trace when enabled. They do not write live prompt, storage, or activity artifacts.

## Report Shape

Recommended `report.json` shape:

```json
{
  "recordType": "recursion.liveSmokeReport",
  "schemaVersion": 1,
  "runId": "20260630-000000",
  "generatedAt": "2026-06-30T00:00:00.000Z",
  "status": "pass",
  "strict": true,
  "environment": {
    "baseUrl": "http://127.0.0.1:8000",
    "user": "recursion-soak-a",
    "headless": true,
    "nodeVersion": "v22.0.0",
    "platform": "win32"
  },
  "extension": {
    "servedStatus": "served-extension-match",
    "manifestHash": "sha256-example",
    "checkedFiles": [
      {
        "path": "manifest.json",
        "checkoutHash": "sha256-example",
        "servedHash": "sha256-example",
        "status": "match"
      }
    ]
  },
  "checks": [
    {
      "id": "recursion-bar-rendered",
      "status": "pass",
      "durationMs": 120,
      "details": {
        "visible": true
      }
    }
  ],
  "artifacts": {
    "summary": "summary.md",
    "liveLog": "live-log.jsonl",
    "desktopScreenshot": "screenshots/desktop.png",
    "phoneScreenshot": "screenshots/phone.png"
  },
  "warnings": [],
  "failures": [],
  "nextAction": "none"
}
```

Allowed statuses:

- `pass`;
- `fail`;
- `environment-fail`;
- `stale-extension`;
- `unsafe-user`;
- `manual-required`;
- `skipped`.

## Live Log Shape

`live-log.jsonl` is a compact event stream. Each line is one JSON object:

```json
{
  "recordType": "recursion.liveSmokeEvent",
  "schemaVersion": 1,
  "runId": "20260630-000000",
  "recordedAt": "2026-06-30T00:00:01.000Z",
  "phase": "prompt-install",
  "severity": "info",
  "label": "Prompt packet installed",
  "details": {
    "packetId": "packet-example",
    "packetHash": "sha256-example",
    "selectedCards": 5
  }
}
```

Events should use compact, user-safe labels. The log is not a transcript and not a provider request archive.

## Prompt Packet Metadata

`prompt/latest-packet-metadata.json` should include:

```json
{
  "recordType": "recursion.promptPacketMetadata",
  "schemaVersion": 1,
  "packetId": "packet-example",
  "runId": "20260630-000000",
  "snapshotId": "snapshot-example",
  "sceneKeyHash": "sha256-example",
  "footprint": "normal",
  "tokenEstimate": 620,
  "packetHash": "sha256-example",
  "install": {
    "status": "installed",
    "hostKey": "recursion.promptPacket",
    "installedAt": "2026-06-30T00:00:02.000Z"
  },
  "clear": {
    "status": "cleared",
    "clearedAt": "2026-06-30T00:00:04.000Z"
  },
  "cards": [
    {
      "id": "card-example",
      "family": "Scene Frame",
      "emphasis": "normal",
      "tokenEstimate": 90
    }
  ],
  "omitted": [
    {
      "family": "Open Threads",
      "reason": "budget"
    }
  ]
}
```

The full prompt body is excluded by default. Debug exports may include bounded excerpts only through an explicit user action outside the normal smoke path.

## Storage Probe

`storage/probe.json` should prove the dedicated user can operate on Recursion-owned storage:

```json
{
  "recordType": "recursion.storageProbeResult",
  "schemaVersion": 1,
  "runId": "20260630-000000",
  "user": "recursion-soak-a",
  "status": "pass",
  "ownProbeVisible": true,
  "otherProbeVisibleCount": 0,
  "write": "pass",
  "verify": "pass",
  "read": "pass",
  "delete": "pass"
}
```

Probe records should include logical keys and hashes, not absolute private filesystem paths.

## Redaction Rules

Artifacts must not contain:

- API keys;
- provider bearer tokens;
- cookies;
- CSRF tokens;
- authorization headers;
- passwords;
- raw provider prompts;
- raw provider responses;
- full chat transcripts;
- hidden chain-of-thought;
- private story plans;
- private diagnostic notes intended for inspectors only;
- raw World Info, Memory Books, Summaryception, or VectFox content;
- full local paths that expose user names when a logical path is enough.

Artifacts may contain:

- provider lane names;
- provider source type;
- resolved model names;
- normalized error categories;
- status codes;
- duration and token counts;
- prompt packet hashes;
- source message ids or hashes;
- card ids, families, emphasis, and token estimates;
- bounded user-facing status labels;
- screenshots of visible Recursion UI with secret fields hidden or empty.

## Redaction Check

Every live run should scan generated JSON, JSONL, Markdown, and text artifacts before reporting success.

The scan should fail on sensitive field names and obvious secret-like values:

```text
apiKey
authorization
bearer
cookie
csrf
password
secret
session
rawPrompt
rawResponse
providerPrompt
providerResponse
```

The scan should allow those strings in this documentation and in redaction rule descriptions, but generated run artifacts should not contain them except in a `redactedFields` list.

## Summary Shape

`summary.md` should be short and operational:

```markdown
# Recursion Live Smoke

Status: pass
Run: 20260630-000000
User: recursion-soak-a
Strict: true

## Checks

- Preflight: pass
- Recursion Bar: pass
- Activity Ribbon: pass
- Observe mode: pass
- Auto Utility pass: pass
- Prompt cleanup: pass

## Artifacts

- Desktop screenshot: screenshots/desktop.png
- Phone screenshot: screenshots/phone.png
- Prompt metadata: prompt/latest-packet-metadata.json
- Live log: live-log.jsonl

## Next Action

No action required.
```

The summary should include warnings and failures first when they exist.

## Retention

Artifacts are local developer evidence. They may be deleted when no longer needed.

Keep:

- latest passing readiness report;
- latest passing no-generation live smoke;
- latest passing generation-enabled Utility smoke;
- latest failing run until the failure has a contract regression or fix.

Do not promote live artifacts into product storage. Recursion runtime storage remains cache-oriented and bounded.
