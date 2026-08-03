# SC-01 — explicit runtime/scope everywhere R1

**State:** PLANNED
**Candidate:** retain the checked-out Account Center candidate while making the runtime/scope public-contract truth explicit and fail-closed for the authoritative `hermes`, `openclaw`, and `codex` runtimes only.

## Internal issue

The existing public projections recognize the three runtime labels, but SC-01 has no current checkpoint-owned proof that every protected consumer accepts only an authoritative runtime/scope tuple and does not turn malformed, repeated, unsupported, or private runtime/scope input into another runtime's inventory or capability. This is internal contract/test ownership work. It is not an upstream CLI issue and does not affect AC-06's owned native exact-account transaction.

## Bounded resolution plan

1. Map public API, CLI, MCP/ChatOps, control-panel, and Hermes automation runtime/scope selectors plus their existing validation tests.
2. Add focused adversarial fixtures for the three authoritative runtime labels and explicit default/agent scope rules; reject unknown, repeated, mixed-case, and malformed selector forms before a protected read/mutation can select a context.
3. Make the smallest shared validation/projection change required to keep runtime and scope truth consistent at every consumer boundary; do not add a generic runtime adapter or capability.
4. Re-run the owned-delete Account Center/Hermes/Dexter fixture contracts and Sentinel `/auth` normal-status fixture to prove the protected AC-06 transport and formatting stay unchanged.
5. Run deterministic build/test/security/browser QA, review output redaction plus weekly-only policy, and merge only after all gates are green.

## No-touch invariants

- No live credential deletion, interactive login, provider request, route/model mutation, Sentinel operation, or service operation.
- Preserve the Alej-owned `codex-auth-delete.py` transaction, the sole `opaque-owned-delete` receipt, and the working Dexter `/auth delete` command.
- Preserve the full locked Sentinel `/auth` rendering and Hermes/Dexter weekly-only capacity policy.
- Tests use fixtures/mocks only; no live credential directory is available to delete tests.
