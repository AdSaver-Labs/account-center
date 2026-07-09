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
```

The CLI uses `tests/fixtures/status.fixture.json` by default and writes token-free local status files under `.account-center/`. Live OpenClaw reads require explicit `--source openclaw` or `ACCOUNT_CENTER_SOURCE=openclaw`. Mutation-shaped commands stay dry-run unless `--apply` is explicit and supported.

## Manual chat bridge

Phase 2 adds an actual `/auth` parser/bridge over the CLI:

```bash
node packages/cli/dist/index.js auth /auth status --json
node packages/cli/dist/index.js auth /auth accounts
node packages/cli/dist/index.js auth /auth next --source openclaw
node packages/cli/dist/index.js auth /auth auto
```

`/auth` is the manual/chat command. The bridge rejects the old manual command name instead of promoting it.

## Non-goals for v0

- Bypassing provider terms, limits, fraud controls, or payment requirements.
- Sharing credentials between unrelated users.
- Cloud custody of OAuth tokens by default.
- Hard-coding for one agent runtime.

## License

MIT. See `LICENSE`.
