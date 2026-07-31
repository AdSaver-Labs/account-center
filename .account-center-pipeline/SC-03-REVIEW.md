# SC-03 Review — model policy truth gate

State: REVIEWED
Candidate: `main`
Owner: Account Center production coordinator

## Scoped review

The reviewed implementation is the already-present shared public model contract (`PublicModelCatalogView`) and its protected CLI/API/UI consumers. It independently publishes:

- observed catalog and per-model eligibility (`models` / `selectable` / disabled-policy rationale);
- requested policy, effective runtime model, and fallback chain as separate `not_reported` facts when authoritative evidence is absent;
- verification as explicit `UNPROVEN`, never inferred from catalog observation;
- selected runtime only after the server validates an exact observed `runtime=...&scope=default` context.

The fixtures cover disabled-versus-observed catalog state, missing selection evidence, malformed selected-scope evidence, hostile labels, and redaction. They fail closed without invoking an adapter mutation. CLI `models list` and `/api/models` use the same `account-center.models.v1` projection.

## Preservation review

- Owned helper is present, owner-only, non-symlink, and SHA-256 trust pin matches: `4c09c926e94500f02f34a19ca80fbec280003227588d2b4f0d1d1085ee7fba37`.
- Account Center still calls only the owned runtime-local `codex-auth-delete.py` transaction after exact-target resolution and accepts only `{action:"account.delete",state:"DELETED",receipt:"opaque-owned-delete"}` across the public boundary.
- Hermes plugin tests exercise the shared fixture ChatOps path and accept only the two canonical opaque outputs. No native helper was executed.
- Full deterministic suite preserves Sentinel `/auth` compatibility, Dexter `/auth delete`, and weekly-only public capacity behavior.

## Evidence

- `npm run test`: PASS — 260 Node tests and 19 Hermes plugin tests.
- `npm run qa:security`: PASS — typecheck, build, 260 Node tests, 19 Hermes plugin tests, 15 Playwright/axe tests, secret scan (148 tracked files), and `npm audit` (0 high vulnerabilities).
- `git diff --check`: PASS.
- No live deletion, native helper execution, interactive login, provider request, credential/store write, route mutation, session/service operation, or runtime mutation occurred.

## Verdicts

- Spec: passed
- Quality: passed
- QA/security: passed
