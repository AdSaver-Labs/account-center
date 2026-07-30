# AC-06 blocker resolution R3 — fail-closed opaque-contract integrity

State: PLANNED
Owner: Account Center production coordinator

## Internal issue

The previous receipt loaders validated only the receipt shape and string types. A
locally corrupted contract could therefore replace public delete text with
identity-bearing or path-bearing content, and ChatOps read the contract without
validation. This is an internal contract-boundary issue, not an external
OpenClaw/Dexter blocker. The owned native exact-account transaction remains the
required integration path and will not be executed.

## Bounded resolution plan

1. Define the two complete, fixed public receipt texts in the versioned contract
   loader and reject empty, changed, or unsafe public values; retain the existing
   native sentinel check.
2. Apply that same fail-closed validation to the CLI, ChatOps, MCP, and Hermes
   consumers so no transport can emit a locally substituted delete receipt.
3. Add fixture-only tampered-contract regressions for the loaders/transports;
   mock every subprocess and do not launch the native helper.
4. Run build, full test, security QA, diff review, and the release checkpoint.
   Preserve the full Sentinel `/auth` format, the Hermes/Dexter weekly-only
   policy, and the Dexter `/auth delete` transport.
