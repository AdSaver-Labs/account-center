# Agent adapter matrix

Account Center supports runtimes in two layers:

1. **generic-command adapter** — any agent or harness can integrate by exposing no-secret Account Center status JSON. It is read-only; it never runs an agent-supplied apply command.
2. **native adapter** — a first-class adapter once we know the runtime's real status, routing, backup, and rollback APIs.

The generic layer is how we make PI agent, Odysseus/PewDiePie harness, and unknown future agents work before writing bespoke code for each one.

## Target matrix

| Agent / harness | Current support | Native target | Status command example | Apply support |
|---|---:|---:|---|---|
| OpenClaw / Dexter | read-only live adapter + hardened apply path foundation | yes | `--source openclaw` | Phase 4 hardened route apply |
| Hermes / Jack | generic-command now; native adapter planned | yes | TBD Hermes status exporter | planned |
| Codex CLI/app/colleague | generic-command now; native adapter planned | yes | TBD Codex status exporter | planned |
| PI agent | generic-command now via example | yes, after runtime shape is known | `node examples/pi-agent-status.mjs` | blocked until protected native adapter |
| Odysseus / PewDiePie harness | generic-command now via example | yes, after harness APIs are known | `node examples/odysseus-status.mjs` | blocked until protected native adapter |
| Any future shell/container/browser agent | generic-command now | optional | any command that prints `account-center.status.v1` | blocked until protected native adapter |

## Contract every agent must satisfy

A status command must:

- print JSON to stdout;
- include no secrets, no tokens, no refresh tokens, no cookies, and no credential file contents;
- identify providers, profiles, usage windows, routes, policy, and warnings using Account Center schemas;
- set `noSecrets: true` only if the exporter has intentionally redacted its output;
- exit non-zero if status cannot be trusted.

Live apply is deliberately unavailable through the generic adapter. An arbitrary agent-supplied shell command cannot establish Account Center's server-owned scope, exact review confirmation, idempotency, durable redacted receipt/audit, or authoritative read-after-write proof. A runtime needs a protected native adapter before Account Center can expose live mutation.

## PI agent integration path

Current verified Account Center path:

```bash
ACCOUNT_CENTER_GENERIC_COMMAND="node examples/pi-agent-status.mjs" \
node packages/cli/dist/index.js status --source generic-command --json --no-write-export

ACCOUNT_CENTER_GENERIC_COMMAND="node examples/pi-agent-status.mjs" \
node packages/cli/dist/index.js guard --source generic-command --runtime pi-agent --ensure-route --json
```

To make this real for PI agent, replace `examples/pi-agent-status.mjs` with PI's actual no-secret status exporter. The exporter can read PI's runtime status, subscription handles, model availability, and usage snapshots, but must not print credentials.

## Odysseus / PewDiePie harness integration path

Current verified Account Center path:

```bash
ACCOUNT_CENTER_GENERIC_COMMAND="node examples/odysseus-status.mjs" \
node packages/cli/dist/index.js status --source generic-command --json --no-write-export

ACCOUNT_CENTER_GENERIC_COMMAND="node examples/odysseus-status.mjs" \
node packages/cli/dist/index.js guard --source generic-command --runtime odysseus --ensure-route --json
```

To make this real for Odysseus, replace `examples/odysseus-status.mjs` with a harness status exporter that reports the harness's configured provider accounts, active route, and usage windows.

## What cannot be guaranteed 100%

Account Center can guarantee the **adapter contract** and test its own behavior for conforming adapters. It cannot guarantee an unknown agent works until that agent exposes either:

- a no-secret status command that Account Center can read; and
- an apply/switch command or API if live automatic switching is expected.

For every new agent, the proof checklist is:

1. run status exporter;
2. validate JSON schema;
3. run `guard --ensure-route` dry-run;
4. run apply against a test/sandbox runtime;
5. verify backup/rollback receipt;
6. only then enable live apply.
