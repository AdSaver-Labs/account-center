# MVP Evidence

Date: 2026-07-09

## Scope

Implemented Phase 1 plus MVP read-only/dry-run command surface and the first runtime adapter layer:

- TypeScript monorepo with `packages/core` and `packages/cli`.
- Root scripts: `npm test`, `npm run typecheck`, `npm run build`, `npm run checkpoint`.
- Core schemas for provider, runtime, profile, usage, route, policy, lease, reauth, and audit.
- Redaction library with tests.
- Dependency-free file-backed status store.
- Fixture-backed status export from `tests/fixtures/status.fixture.json`.
- Runtime source selection with `--source fixture|openclaw`; default remains `fixture`.
- OpenClaw adapter config through `ACCOUNT_CENTER_OPENCLAW_WORKSPACE` and `ACCOUNT_CENTER_OPENCLAW_CLI`.
- OpenClaw adapter can normalize no-secret Sentinel/OpenClaw status into the Account Center status schema.
- `account-center` CLI commands:
  - `status --json`
  - `guard`
  - `accounts list`
  - `routes next`
  - `doctor`
  - `audit list`
  - dry-run `routes auto/use/remove`
  - dry-run `accounts disable/enable`
  - dry-run `models disable/enable`
- Checkpoint/gate updater writes token-free `.account-center/status.json` and `.account-center/gate.json`.

## Safety

- Fixture mode is still the default and does not read live OpenClaw, Hermes, or Codex stores.
- OpenClaw mode is explicit: use `--source openclaw` or `ACCOUNT_CENTER_SOURCE=openclaw`.
- OpenClaw read commands use no-secret status files or existing read-only status commands.
- `/home/Alej/.openclaw` is not touched by tests; OpenClaw tests use mocked command runners and temp workspaces.
- Dry-run commands emit receipts with `applied: false` and `liveRuntimeMutation: false`.
- `routes auto/use/remove --source openclaw --apply` is the only apply path currently wired, and it shells out to the existing account-routing switch script with explicit arguments.
- `accounts disable/enable --apply` and `models disable/enable --apply` report unsupported unless a safe existing OpenClaw account-routing command is available; they do not edit runtime stores directly.
- Account Center never edits sessions, prompts, memory, bootstrap, or unrelated OpenClaw runtime files.
- Manual/chat docs emphasize `/auth` compatibility as the MVP manual command.

## Verification

Commands run successfully:

```bash
npm install
npm test
npm run typecheck
npm run build
node packages/cli/dist/index.js status --json --no-write-export
node packages/cli/dist/index.js status --source fixture --json --no-write-export
node packages/cli/dist/index.js status --json
node packages/cli/dist/index.js guard --provider openai --runtime openclaw --json
node packages/cli/dist/index.js accounts list
node packages/cli/dist/index.js routes next
node packages/cli/dist/index.js models list
node packages/cli/dist/index.js doctor
node packages/cli/dist/index.js audit list --limit 20
node packages/cli/dist/index.js routes auto
node packages/cli/dist/index.js routes use helper-2
node packages/cli/dist/index.js routes remove helper-1
node packages/cli/dist/index.js accounts disable helper-1
node packages/cli/dist/index.js accounts enable helper-1
node packages/cli/dist/index.js models disable openai/gpt-5.3-codex
node packages/cli/dist/index.js models enable openai/gpt-5.3-codex
```

Live read-only OpenClaw smoke commands when OpenClaw is present:

```bash
ACCOUNT_CENTER_OPENCLAW_WORKSPACE=/home/Alej/.openclaw/workspace \
ACCOUNT_CENTER_OPENCLAW_CLI=/home/Alej/.openclaw/workspace/ops/scripts/oauth_routing_cli.py \
node packages/cli/dist/index.js status --source openclaw --json --no-write-export

ACCOUNT_CENTER_OPENCLAW_WORKSPACE=/home/Alej/.openclaw/workspace \
ACCOUNT_CENTER_OPENCLAW_CLI=/home/Alej/.openclaw/workspace/ops/scripts/oauth_routing_cli.py \
node packages/cli/dist/index.js accounts list --source openclaw --no-write-export

ACCOUNT_CENTER_OPENCLAW_WORKSPACE=/home/Alej/.openclaw/workspace \
ACCOUNT_CENTER_OPENCLAW_CLI=/home/Alej/.openclaw/workspace/ops/scripts/oauth_routing_cli.py \
node packages/cli/dist/index.js routes next --source openclaw --no-write-export

ACCOUNT_CENTER_OPENCLAW_WORKSPACE=/home/Alej/.openclaw/workspace \
ACCOUNT_CENTER_OPENCLAW_CLI=/home/Alej/.openclaw/workspace/ops/scripts/oauth_routing_cli.py \
node packages/cli/dist/index.js doctor --source openclaw --json --no-write-export
```

Key observed outputs:

```text
npm test: 16 tests passed
npm run typecheck: account-center checkpoint typecheck: passed
npm run build: account-center checkpoint build: passed
routes next: Next eligible: openai:helper-2
models list: openai/gpt-5.3-codex and openai/gpt-5.5 from fixtures
doctor: Doctor: OK; Source: fixture; Fixture only: yes
audit list: evt_fixture_status status.export dryRun=true Fixture status export loaded
```

Representative guard output:

```json
{
  "ok": true,
  "reason": "usable_account_found",
  "next": "openai:helper-2"
}
```

Representative dry-run receipt shape:

```json
{
  "applied": false,
  "dryRun": true,
  "liveRuntimeMutation": false,
  "receipt": {
    "action": "route.auto",
    "warnings": ["fixture_only", "no_live_mutation"]
  }
}
```

Representative OpenClaw read-only status shape:

```json
{
  "schemaVersion": "account-center.status.v1",
  "noSecrets": true,
  "source": "openclaw",
  "runtimes": [{ "key": "openclaw" }]
}
```
