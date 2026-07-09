# Account Center

Open-source account routing, reauthentication, and usage-control center for AI agents.

**Status:** planning-first seed repo. This repository starts from a working private Sentinel/OpenClaw/Hermes account-routing setup and generalizes it into an agent-agnostic product.

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

## Non-goals for v0

- Bypassing provider terms, limits, fraud controls, or payment requirements.
- Sharing credentials between unrelated users.
- Cloud custody of OAuth tokens by default.
- Hard-coding for one agent runtime.

## License

MIT. See `LICENSE`.
