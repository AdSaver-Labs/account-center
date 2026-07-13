# Account Center Control App + Guided Auth Implementation Plan

> **For Hermes:** Do not execute this plan until Alej explicitly gives the green light. Use subagent-driven-development / supervised Codex implementation task-by-task only after approval.

**Goal:** Build the Account Center command contract, guided `/auth add` + `/auth reauth` flow, Hermes/OpenClaw/Codex runtime-scope switching model, local API, and first app UI MVP so Alej can recover accounts even when an agent/app is out of limits or broken.

**Architecture:** Account Center is the account/auth/routing control plane. All chat commands, terminal commands, MCP tools, and app buttons call the same command router and runtime adapters. OpenClaw switches by named agent, Hermes switches by profile/session/default Jack route, and Codex switches by chat/session/default profile because Codex does not have OpenClaw-style agents.

**Tech Stack:** TypeScript monorepo, Node.js CLI/API, existing OpenClaw device-auth worker as seed adapter, future local UI consuming one local API. No raw credential display. No Shared Brain implementation in this plan.

---

## 0. Non-negotiable boundaries

1. **Account Center and Shared Brain stay separate.**
   - This plan touches `/home/Alej/account-center-draft` only.
   - Shared Brain plans stay under Jack/Dexter brain project files.
2. **Account Center is the primary recovery/control surface.**
   - Codex MCP and local Codex TUI patches are conveniences, not the product foundation.
3. **Hermes must be first-class.**
   - Every agent/scope switch abstraction must support Hermes/Jack via app UI and terminal/CLI.
4. **Codex scope is not OpenClaw agent scope.**
   - Codex scope should be `default`, `chat`, `session`, or app-server/remote-control target when detectable.
5. **Guided add/reauth is required.**
   - `/auth add <email>` and `/auth reauth <email>` must start, track, expire, complete, and report provider auth challenges from Account Center, not only print fallback commands.

---

## 1. Current verified starting state

### Existing working surfaces

- Account Center repo: `/home/Alej/account-center-draft`
- Current pushed commit before this plan: `5f56d15 feat: allow guarded live auth controls`
- Codex MCP server `account-center` is registered and live mutations are enabled through Account Center guardrails.
- Manual route commands apply by default:
  - `/auth auto`
  - `/auth use <email-or-profile>`
  - `/auth remove <email-or-profile>`
  - `/auth delete <email-or-profile>`
- `--dry-run` previews.
- Fake delete is blocked by exact-match logic.
- Verification at latest commit:
  - `35/35 tests passed`
  - `npm run typecheck` passed
  - `npm run build` passed

### Existing gap from screenshot

| Command | Current issue |
|---|---|
| `/auth add <email>` | Exposed, but app-grade guided flow still needs implementation. |
| `/auth reauth <email>` | Exposed, but app-grade guided flow still needs implementation. |

### Existing useful seed

OpenClaw already has a no-token device auth worker:

```text
/home/Alej/.openclaw/workspace/3-Resources/codex-account-ops/scripts/codex-device-auth-telegram.mjs
```

It supports:

```bash
node codex-device-auth-telegram.mjs start --email <email>
```

Observed behavior from source:

- requests OpenAI device auth code;
- writes session JSON under `state/device-auth`;
- returns `PENDING_DEVICE_AUTH` with:
  - `email`
  - `url`
  - `code`
  - `expiresMinutes`
  - `sessionFile`
  - `resultFile`
  - `workerPid`
- worker polls provider;
- exchanges authorization for tokens;
- saves credentials to OpenClaw auth store;
- calls routing activation;
- sends Telegram success/failure.

Account Center should wrap/model this cleanly instead of leaving it as a raw fallback.

---

## 2. Target command contract

Create `docs/AUTH_COMMAND_CONTRACT.md` as the official spec.

| Command | Class | Default | Preview | Required guards |
|---|---|---|---|---|
| `/auth` | read | read-only | n/a | no secrets |
| `/auth status` | read | read-only | n/a | no secrets |
| `/auth list` | read | read-only | n/a | no secrets |
| `/auth auto` | route mutation | live apply | `--dry-run` | eligible target, runtime lock, receipt |
| `/auth use <target>` | route mutation | live apply | `--dry-run` | exact connected route target, runtime lock, receipt |
| `/auth remove <target>` | route mutation | live apply | `--dry-run` | exact connected route target, routing-only, receipt |
| `/auth delete <target>` | credential mutation | live apply | `--dry-run` | exact connected credential target, backup, receipt |
| `/auth add <email>` | guided auth | start guided flow | `--dry-run` | valid email, one active challenge/account, no raw tokens |
| `/auth reauth <email>` | guided auth | start guided flow | `--dry-run` | valid email/profile, one active challenge/account, no raw tokens |
| `/auth audit` | read | read-only | n/a | redacted |
| `/auth doctor` | read | read-only | n/a | redacted diagnostics |
| `/oauth ...` | invalid | reject | n/a | must say manual command is `/auth` |

Terminology:

- **delete** = credential deletion.
- **remove** = routing removal only.
- **reauth** = refresh existing/broken/expired credential.
- **add** = add a new provider account, then route it when usable.

---

## 3. Runtime/scope model

Create a neutral scope model so the app can target Hermes/OpenClaw/Codex correctly.

### Files

- Create: `packages/core/src/scopes.ts`
- Create: `packages/core/src/scopes.test.ts`
- Modify: `packages/core/src/schemas.ts`
- Modify: `packages/core/src/runtime-adapters.ts`

### Types

```ts
export type RuntimeKind = 'openclaw' | 'hermes' | 'codex' | 'generic-command' | `custom:${string}`;

export type ScopeKind =
  | 'agent'      // OpenClaw named agents
  | 'profile'    // Hermes profile
  | 'session'    // Hermes/Codex session
  | 'chat'       // Codex app/chat-oriented scope
  | 'default'
  | 'all';

export interface RuntimeScope {
  runtime: RuntimeKind;
  scopeKind: ScopeKind;
  scopeId: string;
  label: string;
  canReadStatus: boolean;
  canSwitchRoute: boolean;
  canStartAuth: boolean;
  canDeleteCredentials: boolean;
}
```

### Mapping

| Runtime | App label | Scope model |
|---|---|---|
| OpenClaw | OpenClaw / Dexter | `agent:main`, `agent:qa-manager`, `agent:test-engineer`, `agent:security-auditor`, `agent:code-reviewer`, `all` |
| Hermes | Hermes / Jack | `profile:default`, `session:<id>` if supported, `default` |
| Codex | Codex | `default`, `chat:<id>` if app-server exposes it, `session:<id>` for CLI sessions |
| Generic | External agent | adapter-defined |

### Acceptance

- `listRuntimeScopes()` returns OpenClaw agent scopes without touching sessions.
- `listRuntimeScopes()` returns Hermes default/profile scopes by inspecting Hermes config/profile state safely.
- Codex returns at least `default`; later app-server can add chat/session scopes.
- Scope rows never contain secrets.

---

## 4. Official command contract tasks

### Task 4.1 — Write `AUTH_COMMAND_CONTRACT.md`

**Files:**

- Create: `docs/AUTH_COMMAND_CONTRACT.md`
- Modify: `docs/ACCOUNT_CENTER_CONTROL_APP_STRATEGY.md`
- Modify: `docs/CODEX_ACCOUNT_CENTER_MCP.md`

**Steps:**

1. Write the command matrix from Section 2.
2. Include route/remove/delete distinctions.
3. Include runtime/scope behavior for Hermes/OpenClaw/Codex.
4. Include app button equivalents.
5. Include CLI examples.
6. Include exact safety contract.

**Verification:**

```bash
npm run typecheck
npm run build
```

Expected: pass.

### Task 4.2 — Contract fixtures/tests

**Files:**

- Create: `packages/cli/src/auth-command-contract.test.ts`
- Modify: `packages/cli/src/auth-bridge.test.ts`

**Steps:**

1. Add tests proving every command in the doc maps through `parseAuthCommand()`.
2. Add tests for `--dry-run` preserving preview.
3. Add tests for `/oauth` rejection.
4. Add tests for `/auth <email>` shortcut mapping to route use.

**Verification:**

```bash
npm test
```

Expected: all tests pass.

---

## 5. Guided auth domain model

### Task 5.1 — Expand `ReauthChallenge`

**Files:**

- Modify: `packages/core/src/schemas.ts`
- Modify: `tests/fixtures/status.fixture.json`
- Modify: `packages/core/src/runtime-adapters.test.ts`

**Current type:**

```ts
export interface ReauthChallenge {
  id: string;
  provider: ProviderKey;
  profileHint: string;
  userCode?: string;
  verificationUri?: string;
  expiresAt: string;
  status: 'pending' | 'complete' | 'expired' | 'failed';
}
```

**Target type:**

```ts
export interface ReauthChallenge {
  id: string;
  provider: ProviderKey;
  runtime: RuntimeKey;
  scope?: RuntimeScope;
  mode: 'add' | 'reauth';
  profileHint: string;
  email?: string;
  userCode?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  expiresAt: string;
  pollingIntervalSeconds?: number;
  status: 'pending' | 'polling' | 'complete' | 'expired' | 'failed' | 'cancelled';
  resultProfileId?: string;
  resultSummary?: string;
  resultReceiptPath?: string;
  workerPid?: number | null;
  sessionFile?: string;
  resultFile?: string;
  createdAt: string;
  updatedAt: string;
  warnings: string[];
}
```

**Acceptance:**

- Schema accepts existing fixture plus expanded fields.
- No token fields allowed in challenge model.
- Redaction strips accidental secrets in `resultSummary`.

### Task 5.2 — Reauth store abstraction

**Files:**

- Create: `packages/core/src/reauth-store.ts`
- Create: `packages/core/src/reauth-store.test.ts`

**Behavior:**

Use local JSON files for MVP:

```text
.account-center/reauth/challenges/<challenge-id>.json
.account-center/reauth/results/<challenge-id>.json
```

Functions:

```ts
createChallenge(input): Promise<ReauthChallenge>
readChallenge(id): Promise<ReauthChallenge>
listChallenges(): Promise<ReauthChallenge[]>
updateChallenge(id, patch): Promise<ReauthChallenge>
expireOldChallenges(now): Promise<ReauthChallenge[]>
cancelChallenge(id): Promise<ReauthChallenge>
```

**Acceptance:**

- Atomic write via temp file + rename.
- File mode `0600` where supported.
- Reject challenge JSON containing keys matching `/token|refresh|access|secret|password/i`.

---

## 6. Guided auth runtime adapter contract

### Task 6.1 — Add runtime adapter methods

**Files:**

- Modify: `packages/core/src/runtime-adapters.ts`
- Modify: `packages/core/src/schemas.ts`
- Create: `packages/core/src/runtime-adapter-contract.test.ts`

**Add:**

```ts
interface RuntimeAdapter {
  readStatus(): Promise<AccountCenterStatus>;
  doctor(): Promise<unknown>;
  mutate(input: RuntimeMutationInput): Promise<RuntimeMutationResult>;
  listScopes?(): Promise<RuntimeScope[]>;
  startAuth?(input: StartAuthInput): Promise<StartAuthResult>;
  pollAuth?(challengeId: string): Promise<ReauthChallenge>;
  cancelAuth?(challengeId: string): Promise<ReauthChallenge>;
}
```

```ts
interface StartAuthInput {
  mode: 'add' | 'reauth';
  provider: ProviderKey;
  runtime: RuntimeKey;
  email: string;
  scope?: RuntimeScope;
  apply: boolean;
  receiptPath: string;
}
```

**Acceptance:**

- Existing adapters compile.
- Adapters that cannot start auth return a structured unsupported result.
- `startAuth` never returns raw tokens.

### Task 6.2 — OpenClaw guided auth adapter

**Files:**

- Modify: `packages/core/src/runtime-adapters.ts`
- Create: `packages/core/src/openclaw-guided-auth.test.ts`

**Implementation:**

Wrap existing script:

```bash
node ~/.openclaw/workspace/3-Resources/codex-account-ops/scripts/codex-device-auth-telegram.mjs start --email <email>
```

For testability, use env vars:

```text
CODEX_AUTH_TEST_MOCK_DEVICE=1
CODEX_AUTH_NO_SEND=1
```

Parsing expected stdout:

```json
{
  "status": "PENDING_DEVICE_AUTH",
  "email": "...",
  "url": "https://auth.openai.com/codex/device",
  "code": "...",
  "expiresMinutes": 15,
  "sessionFile": "...",
  "resultFile": "...",
  "workerPid": 123
}
```

Map to `ReauthChallenge`.

**Acceptance:**

- `/auth add <email>` with OpenClaw source starts challenge in mock mode in tests.
- Response shows URL/code/expiry, never tokens.
- Challenge has `mode: 'add'`.
- `/auth reauth <email>` has `mode: 'reauth'`.
- Worker result file can be polled and mapped to complete/failed.

### Task 6.3 — Hermes guided auth placeholder + route adapter discovery

**Files:**

- Create: `packages/core/src/hermes-adapter.ts`
- Create: `packages/core/src/hermes-adapter.test.ts`
- Modify: `packages/core/src/runtime-adapters.ts`

**Goal:** Hermes is first-class even if the first MVP only exposes status/scope and returns clear unsupported for direct provider add.

Discovery commands to verify while implementing:

```bash
hermes auth list openai-codex
hermes auth add --help
hermes config path
hermes profile list
hermes status --all
```

Possible Hermes scopes:

```text
runtime=hermes scopeKind=profile scopeId=default label='Hermes default profile / Jack'
runtime=hermes scopeKind=session scopeId=<session-id> label='Hermes session <title>' if safe to expose later
```

Acceptance:

- Terminal command exists for Hermes status/scope listing.
- App can show Hermes/Jack as selectable runtime/scope.
- If Hermes add/reauth cannot be safely automated yet, output says `unsupported_by_runtime` with exact manual fallback.
- No Hermes auth JSON/tokens are printed.

### Task 6.4 — Codex guided auth scope model

**Files:**

- Create: `packages/core/src/codex-adapter.ts`
- Create: `packages/core/src/codex-adapter.test.ts`

**Goal:** Codex does not pretend to have OpenClaw-style named agents.

Initial scopes:

```text
runtime=codex scopeKind=default scopeId=default label='Codex default account route'
```

Investigate later scopes:

```bash
codex app-server --help
codex remote-control --help
codex sessions/list if available
```

Acceptance:

- App can select Codex default scope.
- Codex MCP remains a client surface to Account Center, not the only control plane.
- Any future app-server chat/session mapping is capability-detected, not assumed.

---

## 7. CLI command implementation

### Task 7.1 — Make `/auth add` and `/auth reauth` start real guided flows

**Files:**

- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/src/auth-bridge.ts`
- Modify: `packages/cli/src/cli.test.ts`

**Behavior:**

```bash
ACCOUNT_CENTER_SOURCE=openclaw node scripts/chatops.mjs '/auth add user@example.com'
```

Should output:

```text
OpenAI Codex device-code auth started
Account: user@example.com
Visit: https://auth.openai.com/codex/device
Code: XXXX-XXXX
Expires: 15 minutes
Status: pending
No LLM/model tokens are used.
```

For `/auth reauth`:

```text
OpenAI Codex reauth started
Account: user@example.com
...
```

Dry-run:

```bash
/auth add user@example.com --dry-run
```

Should not call device script; should explain what would happen.

Acceptance:

- Missing email returns usage.
- Invalid email returns error.
- `--dry-run` no worker.
- Live start uses adapter and writes challenge record.
- No raw credential values in output.

### Task 7.2 — Add challenge status commands

**Files:**

- Modify: `packages/cli/src/auth-bridge.ts`
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/src/auth-bridge.test.ts`

Commands:

```text
/auth reauth status
/auth reauth status <challenge-id>
/auth reauth cancel <challenge-id>
/auth add status
```

Output:

```text
Guided auth challenges
- <id> user@example.com pending expires in 11m
```

Acceptance:

- Can list pending/complete/failed/expired challenges.
- Can cancel pending challenge.
- Expired challenges show expired.
- Completed challenge links to receipt/result summary.

---

## 8. Local API/server MVP

### Task 8.1 — API shape

**Files:**

- Create: `packages/api/src/server.ts`
- Create: `packages/api/src/routes.ts`
- Create: `packages/api/src/server.test.ts`
- Modify: root `package.json` workspaces if needed

Endpoints:

```text
GET  /api/status
GET  /api/scopes
POST /api/routes/auto
POST /api/routes/use
POST /api/routes/remove
POST /api/accounts/delete
POST /api/accounts/add
POST /api/accounts/reauth
GET  /api/reauth
GET  /api/reauth/:id
POST /api/reauth/:id/cancel
GET  /api/audit
```

Safety:

- Bind to localhost by default.
- No credentials in response.
- Mutations call same core command/router, not duplicate logic.

Acceptance:

- API tests use fixture/mock adapter.
- No endpoint bypasses exact-match delete logic.
- Add/reauth endpoints return challenge view only.

### Task 8.2 — Server command

**Files:**

- Modify: `packages/cli/src/index.ts`
- Create: `packages/cli/src/server-command.test.ts`

Command:

```bash
account-center server --host 127.0.0.1 --port 3420
```

Acceptance:

- Starts local API.
- Prints URL and safety mode.
- Health check works.

---

## 9. App UI MVP

### Task 9.1 — UI scaffold

**Files:**

- Create: `packages/app/` or `apps/control-panel/` depending repo convention.
- Create: `docs/UI_MVP.md`

Recommended first UI can be a web app served by local API before native packaging.

Views:

1. **Overview**
   - runtimes: Hermes, OpenClaw, Codex
   - health badges
   - current active account
2. **Scopes**
   - OpenClaw agents
   - Hermes profiles/default Jack
   - Codex default/chat/session if detectable
3. **Accounts**
   - usage windows
   - auth state
   - routing enabled
4. **Guided Auth**
   - add account
   - reauth account
   - show device URL/code
   - timer/expiry
   - pending/completed/failed state
5. **Actions**
   - Auto-switch
   - Use account
   - Remove from routing
   - Delete credentials
   - Add
   - Reauth
6. **Receipts/Audit**

Acceptance:

- UI has no standalone mutation logic.
- UI calls local API only.
- Delete has confirmation affordance.
- Remove clearly says route-only.
- Add/reauth guided flow works against mock mode before live mode.

### Task 9.2 — UX details Codex should design

Codex UI/UX agent should produce:

- 2-3 layout variants for control panel.
- State machine screens for add/reauth:
  1. enter email
  2. show code + link
  3. waiting/polling
  4. saved + routed
  5. saved but routing failed
  6. failed/expired + retry
- agent/scope selector component.
- account row component.
- danger confirmation modal for delete.
- audit/receipt drawer.
- menu-bar/always-on overlay follow-up design, but not in MVP unless small.

---

## 10. Installer/capability detector

### Task 10.1 — Runtime capability detector

**Files:**

- Create: `packages/core/src/capabilities.ts`
- Create: `packages/core/src/capabilities.test.ts`
- Modify: `docs/ACCOUNT_CENTER_CONTROL_APP_STRATEGY.md`

Detect:

Hermes:

- `hermes` binary/path.
- config path.
- active profile.
- gateway status.
- desktop backend status.
- auth list support.

OpenClaw:

- binary path.
- version.
- gateway health.
- agents list.
- auth switch script.
- device auth script.

Codex:

- binary path/version.
- MCP server `account-center` installed/enabled.
- app-server/remote-control availability.
- custom slash command support if discovered.

Acceptance:

- Prints `supported`, `installed`, `needs_setup`, `unsupported_by_runtime`, `unknown`.
- Detector has no side effects.
- Works from terminal and API.

---

## 11. Verification matrix

Before implementation is considered complete:

```bash
cd /home/Alej/account-center-draft
node --check scripts/account-center-mcp.mjs
npm test
npm run typecheck
npm run build
```

Manual smokes with redaction:

```bash
ACCOUNT_CENTER_SOURCE=openclaw node scripts/chatops.mjs '/auth'
ACCOUNT_CENTER_SOURCE=openclaw node scripts/chatops.mjs '/auth add test@example.invalid --dry-run'
ACCOUNT_CENTER_SOURCE=openclaw CODEX_AUTH_TEST_MOCK_DEVICE=1 CODEX_AUTH_NO_SEND=1 node scripts/chatops.mjs '/auth add test@example.invalid'
ACCOUNT_CENTER_SOURCE=openclaw node scripts/chatops.mjs '/auth reauth status'
ACCOUNT_CENTER_SOURCE=openclaw node scripts/chatops.mjs '/auth delete nobody@example.invalid'
```

Expected:

- `/auth` prints limits.
- dry-run add does not start worker.
- mock live add returns URL/code/challenge without tokens.
- status lists challenge.
- fake delete blocks exact-match.

OpenClaw agent smoke after routing changes:

```bash
/home/Alej/.npm-global/bin/openclaw agent --agent qa-manager --message 'Smoke test only. Reply exactly: QA_MANAGER_OK' --json --timeout 180
```

Hermes smoke after Hermes adapter:

```bash
hermes status --all
hermes auth list openai-codex
```

No raw auth JSON or token rows printed.

---

## 12. Suggested commit sequence

1. `docs: define auth command contract`
2. `feat: add runtime scope model`
3. `feat: add guided auth challenge store`
4. `feat: wrap openclaw device auth as guided flow`
5. `feat: implement auth add reauth commands`
6. `feat: add hermes runtime scope adapter`
7. `feat: add codex runtime scope adapter`
8. `feat: add account center local api`
9. `feat: add control panel ui mvp`
10. `docs: add app ui and guided auth evidence`

---

## 13. Review questions for Dexter and Codex

Ask Dexter/OpenClaw:

1. Is the guided auth wrapper safe with existing OpenClaw credential/session preservation rules?
2. Should Account Center call `codex-device-auth-telegram.mjs` directly, or should that logic be moved into Account Center and OpenClaw become an adapter?
3. Are there OpenClaw agent routing edge cases missing from the `RuntimeScope` model?
4. What exact smoke tests should run after add/reauth completes?
5. Any risk to Dexter sessions/prompts/memory/bootstrap?

Ask Codex:

1. Is this API/UI sequence implementable cleanly in the current repo?
2. What UI architecture should be used for the MVP control panel?
3. How should Codex chat/session/default scope be represented without pretending Codex has OpenClaw-style agents?
4. How should guided add/reauth states be shown for best UX?
5. Should Codex app-server/remote-control be used in MVP or deferred?

---

## 14. Initial recommendation before peer review

Build in this order:

1. Official `/auth` command contract.
2. Runtime/scope model with Hermes included from day one.
3. Guided auth challenge store.
4. OpenClaw guided add/reauth adapter wrapping the existing worker.
5. CLI/chat `/auth add` and `/auth reauth` live flow.
6. Local API.
7. UI MVP.
8. Codex TUI/app-server convenience integration.

Reason: this gives Alej the practical recovery flow fastest while keeping Account Center independent from Codex TUI internals and separate from Shared Brain.


---

## 15. Peer review results and required amendments

### 15.1 Codex implementation/UI review

Codex reviewed the plan from the repo and agreed the build order is directionally right, but identified blockers that must be addressed **before UI scaffolding**.

Required changes:

1. **Add a unified core command executor before API/UI.**
   - Create a core `executeAuthCommand(input)` / `executeAccountCenterAction(input)` contract.
   - CLI, MCP, local API, and app must all call this same executor.
   - No UI/API-specific mutation logic.

2. **Preserve `/auth add` vs `/auth reauth` mode.**
   - Current `parseAuthCommand()` collapses both to `['reauth', 'start', ...]`.
   - Change internal command shape to preserve mode, for example:
     - `/auth add <email>` → `['reauth', 'start', '--mode', 'add', <email>]`
     - `/auth reauth <email>` → `['reauth', 'start', '--mode', 'reauth', <email>]`
   - Tests must prove mode survives parsing, CLI execution, API calls, and UI-triggered actions.

3. **Define authoritative guided-auth lifecycle ownership.**
   - Account Center challenge store is authoritative for UI/API state.
   - Runtime worker files are adapter artifacts.
   - Polling reconciles worker result files back into Account Center challenge state.
   - Specify worker death, missing result file, Account Center restart, timeout, wrong-account completion, route-activation failure, and expired challenge behavior.

4. **Add local API security before app UI.**
   - Localhost binding is not enough.
   - Add an ephemeral local bearer token or equivalent launch secret.
   - Lock CORS to the app origin.
   - Add CSRF protection for browser UI requests.
   - Add `Cache-Control: no-store` for auth challenge responses.
   - Include request/audit IDs on mutations.

5. **Use discriminated result types.**
   - Avoid generic `unknown` payloads for UI-critical actions.
   - Define unions such as:
     - `started`
     - `dry_run`
     - `unsupported_by_runtime`
     - `validation_error`
     - `blocked`
     - `failed`
     - `applied`
   - The UI should render by `kind`, not by guessing response shape.

6. **Avoid optional adapter methods for app-critical capabilities.**
   - Prefer required methods that return `unsupported_by_runtime` when not available.
   - This keeps capability branching inside adapters/core, not scattered through CLI/API/UI.

7. **Define Codex write semantics explicitly.**
   - `codex/default` initially means Account Center’s Codex default route/profile control surface.
   - `codex/chat:*` and `codex/session:*` are read-only until Codex app-server/remote-control exposes safe write capability.
   - Never imply Codex has OpenClaw-style named agents.

8. **Expand guided-auth UX states.**
   - Add UI affordances for:
     - copy code;
     - open verification URL;
     - manual fallback command;
     - worker disconnected but challenge still valid;
     - already connected account;
     - authenticated wrong account;
     - complete but route activation failed;
     - expired/cancelled/retry.

9. **Add confirmation policy matrix.**
   - Delete requires strong confirmation.
   - Remove must clearly say routing-only.
   - Use/auto/add/reauth need visible action labels, disabled states, dry-run preview where applicable, and receipt links.

10. **Define concurrency/locking key.**
    - Guided auth uniqueness key:
      `provider + runtime + normalizedEmail + scopeKind + scopeId`.
    - Decide that a new `reauth` may replace/cancel an existing pending `reauth` for the same key only after explicit user confirmation; it must not silently cancel an `add`.

11. **Define local email redaction boundary.**
    - Local app can display exact emails to Alej.
    - Logs, shared summaries, MCP responses, and receipts should redact unless exact display is required.

### 15.2 Dexter/OpenClaw safety review

Dexter main could not complete the review because OpenClaw main hit gateway timeout and embedded fallback reported `MissingAgentHarnessError: Requested agent harness "codex" is not registered.` A shorter review through OpenClaw QA Manager succeeded and produced the following safety requirements.

Required changes:

1. **Separate auth material from runtime state.**
   - `remove/delete` must never touch OpenClaw sessions, prompts, memory, bootstrap files, or agent workspaces.
   - Credentials/tokens/routing are the only mutation targets unless Alej explicitly approves broader cleanup.

2. **Use scope-aware destructive confirmations.**
   - Confirm exact runtime, scope, account identity, and credential path impact before destructive actions.
   - The UI should show whether the target is Hermes profile/default Jack, OpenClaw named agent, or Codex default/chat/session.

3. **Make reauth atomic with rollback.**
   - Stage new credentials first.
   - Verify identity and usability.
   - Swap/activate only after verification.
   - If device auth fails/expires/wrong-account occurs, keep existing working auth intact.

4. **Prevent cross-scope credential bleed.**
   - Codex session auth must not overwrite Codex default unless target scope is default.
   - Hermes Jack/default profile must not overwrite another Hermes profile.
   - OpenClaw agent auth/routing must not overwrite another named agent unless scope is `all` and explicitly requested.

5. **Handle active sessions explicitly.**
   - If an OpenClaw named agent has active sessions, Account Center should warn or require confirmation where route/auth changes could affect mid-run behavior.
   - Reauth must preserve session continuity and never mutate prompts/bootstrap/memory.

6. **Require proof after add/reauth/use.**
   - Each operation should end with read-only verification:
     - account identity;
     - runtime;
     - scope;
     - token validity/auth health;
     - active route/selected scope.
   - If verification is missing, report `UNPROVEN`, not success.

### 15.3 Revised build order after peer review

Replace the initial build order with this stricter sequence:

1. Official `/auth` command contract.
2. **Core command executor** used by CLI, MCP, API, and app.
3. Runtime/scope model with Hermes included from day one.
4. Discriminated result types and confirmation policy matrix.
5. Guided auth challenge store and lifecycle ownership rules.
6. OpenClaw guided add/reauth adapter wrapping the existing worker.
7. CLI/chat `/auth add` and `/auth reauth` live flow preserving add vs reauth mode.
8. Hermes runtime scope/status adapter.
9. Codex default scope adapter with chat/session read-only until safe write capability exists.
10. Local API with bearer/CSRF/CORS/no-store/audit-ID protections.
11. Thin schema-driven UI MVP.
12. Codex TUI/app-server convenience integration only after app/control plane is stable.

### 15.4 New implementation tasks to insert before API/UI

#### Task A — Core command executor

**Files:**

- Create: `packages/core/src/command-executor.ts`
- Create: `packages/core/src/command-executor.test.ts`
- Modify: `packages/cli/src/index.ts`
- Modify: `scripts/account-center-mcp.mjs`

**Acceptance:**

- CLI calls executor.
- MCP calls executor.
- Future API calls executor.
- Tests prove command results are identical across CLI and executor fixtures.

#### Task B — Preserve add/reauth mode

**Files:**

- Modify: `packages/cli/src/auth-bridge.ts`
- Modify: `packages/cli/src/auth-bridge.test.ts`

**Acceptance:**

- `/auth add user@example.com` maps to mode `add`.
- `/auth reauth user@example.com` maps to mode `reauth`.
- `startReauth()` receives mode explicitly.

#### Task C — Challenge lifecycle authority spec

**Files:**

- Create: `docs/GUIDED_AUTH_LIFECYCLE.md`
- Modify: `docs/AUTH_COMMAND_CONTRACT.md`

**Acceptance:**

- Defines Account Center challenge store as authoritative.
- Defines worker artifact reconciliation.
- Defines restart, missing result, wrong account, route failure, cancel, timeout, and retry semantics.

#### Task D — API security spec before server implementation

**Files:**

- Create: `docs/LOCAL_API_SECURITY.md`

**Acceptance:**

- Local bearer token/launch secret defined.
- CORS/CSRF/no-store/audit-ID policies defined.
- UI never gets broad unauthenticated mutation access.

#### Task E — Post-operation proof contract

**Files:**

- Create: `docs/POST_OPERATION_VERIFICATION.md`
- Modify: runtime adapter tests.

**Acceptance:**

- `add`, `reauth`, `use`, `auto`, `remove`, and `delete` return `verified`, `unproven`, or `failed` proof state.
- UI and CLI never show success when proof is missing.
