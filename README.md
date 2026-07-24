# Account Center

Open-source account routing, reauthentication, and usage-control center for AI agents.

**Status:** Phase 1 MVP scaffold. The repo now includes a TypeScript workspace with fixture-backed schemas, redaction, policy checks, checkpoint/gate files, and a dry-run `account-center` CLI.

## Problem

AI agents increasingly depend on multiple model/provider accounts: OpenAI/ChatGPT Codex, OpenRouter, Anthropic, Copilot, local gateways, and future agent-specific backends. Today, account switching is usually hidden inside one agent runtime, a one-off script, or manual config editing.

That creates recurring failures:

- one account hits daily/weekly limits and the agent stops;
- manual OAuth reauth is hard from Telegram or chat surfaces;
- agent runtimes disagree about provider names or auth stores;
- no shared, safe dashboard exists for account health, routing order, and last-resort policies;
- credentials get mixed with status data, making open collaboration unsafe.

## Vision

Account Center is a local-first, agent-agnostic control plane for AI account health and routing.

It should work with **any agent runtime**, not just Hermes or OpenClaw, by exposing stable adapters and interfaces:

- CLI
- HTTP API
- Telegram/chat command bridge
- web dashboard
- plugin/adapter SDK
- status export JSON

## Core goals

1. **See accounts** — list connected accounts, provider, model family, health, quota windows, and routing role.
2. **Switch safely** — choose the next usable account without leaking tokens or mutating unrelated agent state.
3. **Reauthenticate** — start OAuth/device-code flows from CLI or chat, then persist credentials via adapter-specific stores.
4. **Enforce policy** — backup accounts, last-resort rules, project leases, cooldowns, model compatibility, and usage thresholds.
5. **Integrate anywhere** — adapters for OpenClaw, Hermes, LiteLLM-style gateways, custom agents, and future runtimes.
6. **Stay safe** — never expose raw OAuth tokens/API keys in chat, logs, docs, or status exports.

## Initial deliverables

- `ACCOUNT_CENTER.md` — full product/technical plan.
- `docs/COMMANDS.md` — manual Telegram/chat/CLI command design.
- `docs/ARCHITECTURE.md` — adapter-first architecture.
- `docs/ROADMAP.md` — phased implementation roadmap.
- `docs/RESEARCH.md` — current findings and local Sentinel lessons.
- `packages/core` — schemas, redaction, file-backed status store, and routing policy.
- `packages/cli` — fixture-backed read-only/dry-run CLI.

## MVP CLI

```bash
npm install
npm test
npm run typecheck
npm run build
node packages/cli/dist/index.js status --json
node packages/cli/dist/index.js guard --provider openai --runtime openclaw --json
node packages/cli/dist/index.js routes auto
node packages/cli/dist/index.js auth /auth status --json
node packages/cli/dist/index.js auth /auth next --source openclaw
node packages/cli/dist/index.js providers probe --provider all --json
node scripts/chatops.mjs "/auth status --json"
ACCOUNT_CENTER_GENERIC_COMMAND="node examples/generic-agent-status.mjs" \
  node packages/cli/dist/index.js status --source generic-command --json
ACCOUNT_CENTER_GENERIC_COMMAND="node examples/pi-agent-status.mjs" \
  node packages/cli/dist/index.js guard --source generic-command --runtime pi-agent --ensure-route --json
ACCOUNT_CENTER_GENERIC_COMMAND="node examples/odysseus-status.mjs" \
  node packages/cli/dist/index.js guard --source generic-command --runtime odysseus --ensure-route --json
```

The CLI uses `tests/fixtures/status.fixture.json` by default and writes token-free local status files under `.account-center/`. Live OpenClaw reads require explicit `--source openclaw` or `ACCOUNT_CENTER_SOURCE=openclaw`. Mutation-shaped commands stay dry-run unless `--apply` is explicit and supported.

## Local team-beta panel (read-only)

After building, launch the local control panel on an ephemeral **loopback-only** port:

```bash
umask 077
token_file="$(mktemp)"
TOKEN_FILE="$token_file" node -e 'process.stdin.on("data", value => require("node:fs").writeFileSync(process.env.TOKEN_FILE, value.trim() + "\n", { mode: 0o600 }))'
node packages/cli/dist/index.js serve --port 0 --source fixture --token-file "$token_file"
```

When prompted by the `node -e` command, paste the launch token and press `Ctrl+D`. The token is read from standard input and written only to an owner-only file; it is never a shell argument or terminal output. The launcher prints the actual `127.0.0.1` URL, but never the token. Open the URL locally and enter the token into the page; it stays in page memory only. Do not put the token in a URL, shell history, issue, chat message, or redirected terminal log. Stop the panel with `Ctrl+C`, then remove the token file with `rm -f "$token_file"`.

The initial beta path is limited to protected status, limits, scopes, model catalog, local guided-auth challenge inventory/cancellation, and redacted audit/operation history. Routing, model changes, account deletion, and live guided-auth completion remain visibly blocked or `UNPROVEN` until their supported runtime contracts and proof gates exist.

## Manual chat bridge

Phase 2 adds an actual `/auth` parser/bridge over the CLI:

```bash
node packages/cli/dist/index.js auth /auth status --json
node packages/cli/dist/index.js auth /auth accounts
node packages/cli/dist/index.js auth /auth next --source openclaw
node packages/cli/dist/index.js auth /auth auto
```

`/auth` is the manual/chat command. The bridge rejects the old manual command name instead of promoting it.

## Agent-safe operation

Account Center is intended to be safely operated by self-hosted or bridged agents as well as through the local dashboard. Agents use the protected loopback API and CLI JSON contracts — never browser scraping or direct credential-store edits.

Start every automated workflow with the bearer-protected capability document:

```bash
curl -H "Authorization: Bearer $ACCOUNT_CENTER_LAUNCH_TOKEN" \
  http://127.0.0.1:4317/api/capabilities
```

The running server declares which actions are genuinely available, blocked, unsupported, or `UNPROVEN`. Agents must treat anything other than verified `available`/`applied` results as non-success, use dry-runs and explicit confirmation for mutations, preserve scope isolation, use idempotency keys, and retain only redacted receipt/audit IDs.

See [Agent Operations Contract](docs/AGENT_OPERATIONS.md) for the complete integration, safety, and recovery rules.

## Generic adapter SDK

Any agent can integrate before a native adapter exists by exposing a no-secret JSON status command:

```bash
ACCOUNT_CENTER_GENERIC_COMMAND="node examples/generic-agent-status.mjs" \
node packages/cli/dist/index.js status --source generic-command --json
```

For automatic usage-based routing, agents can run:

```bash
node packages/cli/dist/index.js guard --ensure-route --json
node packages/cli/dist/index.js auth /auth ensure --json
```

Without `--apply`, this only plans the route change and returns a receipt-shaped dry-run result. With a configured adapter apply command and explicit `--apply`, the adapter may switch routes according to policy.

Provider/subscription probes summarize no-token usage windows:

```bash
node packages/cli/dist/index.js providers probe --provider all --json
node packages/cli/dist/index.js auth /auth probe --provider all --json
```

The local ChatOps wrapper accepts raw `/auth ...` messages and can be wired into Telegram/Hermes/OpenClaw bridges:

```bash
node scripts/chatops.mjs "/auth status --json"
```

A Hermes plugin is included under `integrations/hermes-plugin/`. It registers `/auth` as a real Hermes slash command and delegates to `scripts/chatops.mjs`:

```bash
python3 integrations/hermes-plugin/test_account_center_plugin.py
```

See `docs/HERMES_INTEGRATION.md` for the exact profile install/config and Telegram command-menu verification steps.

First-class target examples are documented in `docs/ADAPTER_MATRIX.md`, including PI agent and Odysseus / PewDiePie harness. Both work through the generic adapter contract today and can become native adapters once their real runtime status/apply APIs are known.

## Non-goals for v0

- Bypassing provider terms, limits, fraud controls, or payment requirements.
- Sharing credentials between unrelated users.
- Cloud custody of OAuth tokens by default.
- Hard-coding for one agent runtime.

## License

MIT. See `LICENSE`.
