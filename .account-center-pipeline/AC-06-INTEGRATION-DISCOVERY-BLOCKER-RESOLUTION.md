# AC-06 Integration Discovery Blocker Resolution

**Status:** bounded design/evidence artifact; credential deletion remains blocked.

**Decision:** Do not enable OpenClaw/Sentinel credential deletion until the provider supplies and documents the contract below.

## Scope and hard stop

This artifact is a discovery result, not an adapter implementation or an approval to mutate anything. No live credential delete, provider apply, provider probe/test, re-login, store edit, Sentinel mutation, or recovery exercise is permitted for AC-06. In particular, Account Center must not use undocumented OpenClaw internals, edit `auth-profiles.json`, `auth-state.json`, or SQLite, invoke a browser flow, or treat a command exit code or a status snapshot as deletion proof.

`/auth delete <target>` therefore remains `BLOCKED`/`UNPROVEN`. A dry-run may describe the block, but it must not attempt a provider transaction.

## Installed OpenClaw evidence

Evidence was inspected locally from the installed package, not inferred from a live mutation:

- `/home/Alej/.npm-global/lib/node_modules/openclaw/package.json` identifies installed OpenClaw as **`2026.7.1-2`** (lines 1–18).
- `/home/Alej/.npm-global/lib/node_modules/openclaw/docs/cli/models.md` documents the `models auth` command surface (lines 134–180). It documents `models auth login --force` as removing **existing profiles for the provider** before re-login (line 154): provider-wide removal during a re-login workflow, not an exact-profile delete transaction.
- The same document describes `models auth list` as listing saved profiles (line 152), but documents no public exact-profile credential-delete command or API; its listed commands contain no delete operation (lines 136–147).
- No documented provider-owned backup/rollback transaction, recovery operation, redacted deletion receipt, or fresh authoritative post-delete proof is present in that CLI reference. `models status --probe` is explicitly a live probe that can make real requests, consume tokens, and trigger rate limits (lines 42–49), so it is not permitted as AC-06 validation and would not establish deletion anyway.

**Conclusion:** `models auth login --force` is rejected as an integration substitute: it is provider-wide/destructive and couples removal to re-login. It cannot establish the identity, reversibility, receipt, or postcondition required for deleting one selected credential profile.

## Compatibility invariants

Until a conforming capability is available, and after it is integrated:

1. The human `/auth` and `/auth status` command format is byte-compatible with the established status contract. This work must not add a delete-policy banner, reorder lines, normalize whitespace, or otherwise alter the normal status rendering.
2. Detailed Sentinel output remains intact, including its existing account/route diagnostics, usage-window detail, warnings, and redaction behavior. A delete block is rendered only on the delete path/help contract, never by degrading or replacing Sentinel status.
3. The Hermes/Dexter eligibility policy remains **weekly-only**. Credential-delete work must not reinterpret it as a 5-hour/daily eligibility rule, alter weekly thresholds, alter account roles, or cause route selection.
4. Existing AC-06 process-private blocked-delete receipt helper and receipt filesystem repairs are out of scope. Account Center continues to report only its redacted local blocked-operation metadata; that metadata is not proof that a provider credential was deleted.

## Required provider capability contract

The provider must expose a supported, versioned, documented interface. Account Center is only a client of this interface; it must not receive credential material or provider backup locations.

### Exact target identity

Every operation must accept an opaque, provider-issued `target` identity with all of these fields bound by the provider:

```text
providerId             // canonical provider namespace, e.g. "openai"
profileId              // exact saved credential-profile identity, not an email/display name
agentScope             // exact configured OpenClaw agent identity/store scope
credentialGeneration   // provider-issued version/generation for compare-and-delete safety
```

The provider resolves and authorizes this tuple atomically. Account Center may select an identity only from a current provider status response; it must never derive identity from a display name, email, filesystem path, config heuristic, or auth-order position. A missing, stale, ambiguous, inherited, or cross-agent target must fail before prepare.

### Transaction interface

Names are illustrative but the observable semantics are mandatory. Inputs and outputs must contain no credential, token, cookie, API key, refresh token, email, raw filesystem path, or backup contents.

```ts
type CredentialTarget = {
  providerId: string;
  profileId: string;
  agentScope: string;
  credentialGeneration: string;
};

type OpaqueReceiptHandle = string; // unguessable provider-issued reference; not a path or secret

type PrepareDeleteRequest = {
  target: CredentialTarget;
  idempotencyKey: string;
  expectedStatusRevision: string;
};

type PreparedDelete = {
  transactionId: string;
  target: CredentialTarget;
  expiresAt: string;
  receiptHandle: OpaqueReceiptHandle;
  rollbackAvailable: true;
};

interface ProviderCredentialDeletionV1 {
  prepareDelete(request: PrepareDeleteRequest): Promise<PreparedDelete>;
  commitDelete(transactionId: string, idempotencyKey: string): Promise<{
    transactionId: string;
    receiptHandle: OpaqueReceiptHandle;
    state: "committed" | "already_committed";
  }>;
  rollbackDelete(transactionId: string, idempotencyKey: string): Promise<{
    transactionId: string;
    receiptHandle: OpaqueReceiptHandle;
    state: "rolled_back" | "already_rolled_back";
  }>;
  recoverDelete(transactionId: string, idempotencyKey: string): Promise<{
    transactionId: string;
    receiptHandle: OpaqueReceiptHandle;
    state: "prepared" | "committed" | "rolled_back" | "recovery_required";
  }>;
  getCredentialDeletionStatus(input: {
    transactionId?: string;
    target?: CredentialTarget;
    minimumStatusRevision?: string;
  }): Promise<AuthoritativeCredentialDeletionStatus>;
}
```

Required semantics:

- **Prepare:** validates the exact live target and expected revision, takes a provider-owned rollback-capable backup before any store change, reserves one transaction, and returns an opaque receipt handle. It changes neither routing nor credential availability.
- **Commit:** is idempotent, affects only the prepared tuple, is atomic from the provider's perspective, and returns only a redacted/opaque handle. It must never expand to all profiles for a provider or initiate login.
- **Rollback:** is idempotent and restores only the provider-owned prepared backup for that transaction. It must be available until terminal proof is retained under provider policy.
- **Recover:** is required after transport failure, timeout, restart, or uncertain outcome. It reports a terminal state or `recovery_required`; it must not guess or repeat a destructive write.
- **Status proof:** returns a fresh, authoritative, provider-read status revision after commit/recovery. It must identify the exact requested tuple as absent/deleted and distinguish it from a merely reordered, hidden, unreadable, inherited, or provider-wide-cleared profile. An old cached Sentinel export, exit status, and generic provider health are not proof.

Account Center may expose success only when a `commitDelete` result is followed by a newer authoritative `getCredentialDeletionStatus` proof for the same target and transaction. Any missing/expired receipt, stale revision, mismatch, ambiguous result, or transport uncertainty is `UNPROVEN`/`recovery_required`, stops automation, and preserves the opaque handle for operator escalation.

## Filesystem and receipt boundary

| Owner | May own | Must not expose or do |
|---|---|---|
| Provider/OpenClaw | Credential store, exact-profile mutation, provider-owned encrypted/private backup, transaction journal, restoration, authoritative proof data | Must not delegate credential backup/restore to Account Center or disclose backup paths/contents/credentials. |
| Account Center | Its existing process-private receipt directory and minimal redacted metadata: operation class, outcome, timestamp, opaque transaction/receipt handle, and proof state | Must not copy credentials, backups, raw target identity, filesystem paths, or provider store snapshots; must not represent its local receipt as provider deletion proof. |
| Sentinel | Read-only detailed status compatibility surface | Must not be edited, used as a transaction journal, or treated as authoritative fresh deletion proof. |

The provider receipt handle is opaque and stable enough to reconcile a transaction. Account Center may store a redacted correlation reference derived from it only in its process-private receipt metadata. It must not transform that metadata into a backup, a recovery mechanism, or evidence stronger than the provider status proof.

## Acceptance criteria for enablement

Enablement is eligible for review only when all items are demonstrated with non-production fixture/sandbox evidence supplied by the provider capability owner:

1. A public, versioned OpenClaw/provider document specifies an exact-profile delete interface rather than `login --force`.
2. The API requires the complete exact target tuple and rejects ambiguous, stale-generation, wrong-agent, inherited, and provider-wide targets before mutation.
3. Prepare creates a provider-owned rollback-capable backup before change and exposes neither backup content nor location.
4. Commit, rollback, and recover are idempotent, transaction-bound, and cannot affect another profile, provider, or agent.
5. The provider returns an opaque redacted receipt handle and Account Center can record only permitted process-private redacted metadata.
6. Fresh authoritative status proof is revisioned and proves the exact selected profile is deleted after commit; it distinguishes the stated false positives.
7. Failure, timeout, crash/restart, and uncertain-state cases converge through recover/status to a terminal state or explicit `recovery_required`, never a guessed success.
8. Compatibility tests prove byte-identical normal `/auth status` output, preserve detailed Sentinel output, and preserve Hermes/Dexter weekly-only policy.
9. An independent security/spec review confirms no direct store edit, undocumented internal, live credential, live Sentinel mutation, or live deletion test was used.

## Rejection evidence / fail-closed conditions

Reject the integration and keep delete `BLOCKED`/`UNPROVEN` if any of the following is the only available behavior or evidence:

- `models auth login --force`, re-login, auth-order manipulation, a browser/UI workflow, agent deletion, or provider-wide profile clearing is offered instead of exact-profile deletion.
- The target is an email, display label, filename, loose profile string, or default agent inference rather than the full provider-issued identity tuple.
- Backup/rollback is absent, caller-owned, path-based, non-atomic, undocumented, or cannot be recovered after an interrupted request.
- A receipt contains secret material or a raw provider filesystem path, is not opaque/redacted, or is only an Account Center local receipt.
- Proof is based on an exit code, stale status export, generic health, changed auth ordering, disappearance from one listing, cached snapshot, or a live probe without an authoritative exact-target status revision.
- Any validation needs a production credential, live delete/apply, re-login, Sentinel mutation, or modification of the existing AC-06 receipt helper.
- Normal `/auth status` bytes, detailed Sentinel output, or Hermes/Dexter weekly-only policy change as a side effect.

## Smallest external capability request

Request one narrow provider feature, not a general credential-store API:

> **OpenClaw Provider Credential Deletion Transaction v1:** for one exact provider-issued profile identity in one configured agent store, expose documented `prepareDelete`, `commitDelete`, `rollbackDelete`, `recoverDelete`, and revisioned `getCredentialDeletionStatus`. The provider retains the rollback backup and transaction journal; every response is secret-free and returns only opaque transaction/receipt handles plus authoritative proof state. The capability must be fixture/sandbox testable without a production credential and must not reuse `models auth login --force`.

Until this feature and the acceptance evidence exist, Account Center has no supported deletion integration path.

## Bounded validation for this artifact

This document was produced from static inspection only. Validation must be documentation/repository validation only; do not run OpenClaw auth login, `--force`, probe, delete, apply, Sentinel, or credential-store commands. The recorded validation commands for this change are:

```bash
git diff --check
git diff --name-only -- . ':!/.account-center-pipeline/AC-06-INTEGRATION-DISCOVERY-BLOCKER-RESOLUTION.md'
python3 - <<'PY'
from pathlib import Path
p = Path('.account-center-pipeline/AC-06-INTEGRATION-DISCOVERY-BLOCKER-RESOLUTION.md')
text = p.read_text(encoding='utf-8')
required = [
    '2026.7.1-2', 'models auth login --force', 'byte-compatible',
    'weekly-only', 'prepareDelete', 'commitDelete', 'rollbackDelete',
    'recoverDelete', 'getCredentialDeletionStatus', 'OpaqueReceiptHandle',
    'No live credential delete, provider apply, provider probe/test',
]
missing = [term for term in required if term not in text]
assert not missing, missing
print('AC-06 artifact static contract check: passed')
PY
```
