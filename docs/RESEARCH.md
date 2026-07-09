# Research Notes

## Local Sentinel/OpenClaw/Hermes findings

The current VPS has a working private Sentinel/account-routing system with these pieces:

- Sentinel script: `codex-account-sentinel.mjs`
- Auth switch script: `codex-auth-switch.mjs`
- Telegram/device auth scripts: `codex-device-auth-telegram.mjs`, `oauth_telegram_reauth.py`, `oauth_telegram_bridge.py`
- Router: `oauth_pool_router.py`
- CLI wrapper: `oauth_routing_cli.py`
- Status export: `CODEX-ACCOUNT-STATUS.json`
- Hermes read contract: `README-JACK-SENTINEL-CONTRACT.md`

Important lessons:

1. Status exports must be token-free.
2. Provider namespace drift happens (`openai-codex:*` vs `openai:*`). Account Center needs adapter-level migrations and aliases.
3. Usage probes and live generation can disagree. Verification should distinguish "usage endpoint readable" from "live inference works".
4. `info@adsaveragency.com` style business accounts need last-resort/backup-only policy controls.
5. Reauth from Telegram is possible but must handle Cloudflare/rate limits/manual approval.
6. Remove-from-routing must not mean delete credentials.
7. Agent work product (sessions/prompts/memory/bootstrap) must be protected from account routing changes.

## Comparable ecosystem patterns

### LiteLLM

LiteLLM is a strong adjacent reference: it provides an OpenAI-compatible proxy, virtual keys, budgets, rate limits, logging, and model routing across providers. Account Center should not duplicate a full LLM proxy in v0; instead it should integrate with LiteLLM-like gateways as one adapter and focus on account lifecycle/control-plane UX.

Reference observed locally via GitHub CLI:

- `BerriAI/litellm` — Python SDK/proxy server for 100+ LLM APIs with cost tracking, guardrails, load balancing, and logging.

### Agent-specific auth stores

Hermes and OpenClaw have different auth storage and routing semantics. Account Center should avoid copying tokens between them; it should coordinate through adapters and profile handles.

### ChatOps

Telegram-style commands are essential because operators often need to fix account routing while away from the terminal. Commands must be terse, safe, and receipt-backed.

## Research gaps for Codex/Dexter to fill

- Best TypeScript framework for CLI/server/dashboard monorepo.
- Whether to build on LiteLLM or stay orthogonal.
- Generic OAuth/device-code architecture across providers.
- Secure local secret storage choices: OS keychain, encrypted sqlite, adapter-owned stores.
- Best adapter SDK boundaries for OpenClaw, Hermes, Codex CLI, Claude Code, and generic agents.
- How to represent model compatibility and provider-specific limits cleanly.
