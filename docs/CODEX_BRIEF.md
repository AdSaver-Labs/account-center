# Codex Engineering Teammate Brief: Account Center + Sentinel Generalization

Alej asked Jack to familiarize the Codex colleague/engineering teammate with the current Sentinel and ask for an independent research-backed plan.

## Context

Current private Sentinel/OpenClaw setup solves account routing for ChatGPT/Codex-style accounts:

- no-token account status polling;
- usage window tracking;
- Telegram/manual commands;
- runtime auth-order switching;
- last-resort account policy;
- reauth/device-code helper flows;
- status export for Jack/Hermes.

Relevant private local references, read only, do not copy secrets:

- `/home/Alej/.openclaw/workspace/3-Resources/codex-account-ops/README.md`
- `/home/Alej/.openclaw/workspace/3-Resources/codex-account-ops/README-JACK-SENTINEL-CONTRACT.md`
- `/home/Alej/.openclaw/workspace/3-Resources/codex-account-ops/scripts/codex-account-sentinel.mjs`
- `/home/Alej/.openclaw/workspace/3-Resources/codex-account-ops/scripts/codex-auth-switch.mjs`
- `/home/Alej/.openclaw/workspace/ops/scripts/oauth_pool_router.py`
- `/home/Alej/.openclaw/workspace/ops/scripts/oauth_routing_cli.py`
- `/home/Alej/.openclaw/workspace/ops/scripts/oauth_command_router.py`
- `/home/Alej/.openclaw/workspace/knowledge/standards/protocols/codex-engineering-team-integration-protocol.md`

The new public project must be agent-agnostic and not tied only to Hermes or OpenClaw.

## Task

Please produce an independent research-backed technical plan in `docs/CODEX_RESEARCH_PLAN.md`.

Include:

1. What the current Sentinel does and the core concepts to preserve.
2. Best way to rework/build on top of Sentinel into a generic Account Center app.
3. Architecture recommendation.
4. Adapter interface for arbitrary agents/runtimes.
5. Chat/Telegram/manual commands.
6. Security and secret boundaries.
7. How Codex itself should integrate as a development teammate/runtime.
8. Recommended MVP build sequence.
9. Risks and open questions.

Constraints:

- Do not copy or print secrets/tokens/auth blobs.
- Do not modify `/home/Alej/.openclaw`.
- Only write inside this repository.
- Treat this as planning/research, not implementation.
