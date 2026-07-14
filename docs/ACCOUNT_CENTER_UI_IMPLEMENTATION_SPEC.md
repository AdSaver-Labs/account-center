# Account Center UI implementation specification

**Status:** implementation-ready UI specification; API contract dependencies are explicitly called out.  This document does not authorize UI code to bypass the Account Center command executor, runtime adapters, confirmation policy, or API security model.

## 1. Product rules and information architecture

Account Center is a local, bearer-protected recovery and control plane.  It presents redacted operational metadata, never credentials, OAuth payloads, access/refresh tokens, raw runtime configuration, or device-worker files. Exact account email may be shown in the local app to the local operator, but it must not be copied into browser logs, audit summaries, analytics, toast text, or exported receipts by default.

The app has a persistent top bar with the connection/freshness state, a runtime-and-scope context selector, and a compact navigation rail or tab bar:

1. **Dashboard** — health, current route/model summary, warnings, pending guided-auth work, and safe next actions.
2. **Accounts & Routing** — connected accounts, capacity/auth health, route order, scope-specific route controls, and account lifecycle actions.
3. **Guided Add / Reauthenticate** — challenge creation and the durable challenge lifecycle.
4. **Models & Fallbacks** — separate requested, effective, eligibility, and proof states for the selected runtime/scope.
5. **Receipts & Audit** — mutation evidence, dry-run outcomes, verification, backups, warnings, and filters.

The destructive confirmation is a modal/drawer layer launched from Accounts & Routing (and, when applicable, Models & Fallbacks); it is not a destination. Navigation preserves the selected `runtime + scope` when that scope exists in the next view. A changed scope must refetch scope-scoped data and return focus to the destination heading. Never silently broaden an action from a named scope to `all`.

### Context selector

The selector is the shared control for every action that acts on a runtime. It contains runtime, scope, and a capability/status badge. Scope labels must make the target concrete: `OpenClaw / Dexter — agent:qa-manager`, `Hermes / Jack — profile:default`, or `Codex — default`. Codex chat/session scopes and Hermes sessions are shown only when detected; they are read-only unless the API declares the specific write capability.

It has three valid presentations:

| State | Presentation | Action rule |
| --- | --- | --- |
| One available scope | Read-only context chip; do not add a meaningless selector. | Actions use that scope. |
| Multiple available scopes | Labeled combobox with runtime grouped first, then scope. | Changing it requires refresh of scoped cards. |
| No readable scopes | Inline unavailable state with a retry action and capability explanation. | All scoped mutations are disabled. |

Do not infer capability from runtime name. Use API-provided flags for `readStatus`, `mutateRoutes`, `startReauth`, and `mutateModels`, plus endpoint/action results for finer-grained support.

## 2. Shared UI states and honest-state language

Every screen and every actionable card implements the following states. These are product states, not just colors; each has text, an icon, programmatic status, and an appropriate next action.

| State | Meaning and UI | Allowed action |
| --- | --- | --- |
| Loading | Skeleton preserves the final layout; announce “Loading [view]” once in a polite live region. Do not show stale data as current. | Cancel navigation; retry is available after failure. |
| Empty | The request succeeded but has no records (for example no accounts, routes, challenges, receipts, or catalog entries). Explain why it can be empty and offer only supported next actions. | Supported primary CTA, otherwise capability explanation. |
| Error | Fetch/action failed or response is malformed. Preserve previously verified data with its observed timestamp, show a non-secret error summary and a retry. | Retry; no speculative mutation retry without a fresh confirmation/idempotency result. |
| Read-only | Data is observable but the selected scope is not safely writable. Use a neutral “Read-only” badge and state what cannot change and why. | Read/copy safe details; show a documented manual fallback only when the API supplies it. |
| Unsupported | The runtime/adapter does not implement this operation. Use “Unsupported by this runtime,” not “disabled” or “coming soon.” | Link/copy an API-supplied safe manual fallback if present; otherwise none. |
| UNPROVEN | The action/state could not be verified, or proof is absent/stale. Use the literal `UNPROVEN` badge, amber styling, and no success language. | Refresh/recheck, inspect receipt, or perform an explicitly offered safe retry. |
| Blocked | A guard (exact match, eligibility, active challenge, lock, policy) prevented the action. Show its structured reason. | Resolve the reason; do not offer a bypass unless the API explicitly supports a separate confirmed force operation. |
| Success/applied | API returns `applied` and post-operation proof is verified. Show what changed, selected scope, timestamp, and receipt link. | View receipt / undo only if API provides a guarded rollback action. |
| Dry run | A preview only. It must visually differ from success and say “No change was made.” | Review then launch the normal confirmation/action. |

The first screen is intentionally **not** treated as an error before connection: it is a `not_connected` empty state with a launch-token form. Store the token only in memory for the current page; clear the input after a page reload and never persist it in local/session storage, URL, query string, history, or error output.

## 3. Screen specifications

### 3.1 Dashboard

**Purpose:** answer “what needs attention, what is currently in use, and what can I safely do next?” without turning the dashboard into a second routing editor.

**Layout, desktop:** summary strip, then a two-column grid. The left column contains runtime health and priority warnings; the right contains selected-scope current route/model and pending guided-auth. Below is a full-width concise account table. Desktop has a max content width of 1440 px and no horizontal page scrolling.

**Layout, narrow:** context selector and summary stack; cards become one column. The account table becomes labelled account cards (not a clipped table). Keep the most relevant status, active route, auth state, remaining capacity, and action menu visible.

**Content and behavior:**

- Connection bar: `Local-only`, connection authentication state, `Last verified` timestamp, and Refresh. The token entry is shown only before an authenticated response or after authorization expiry. A 401 returns focus to the token field and says “Launch token rejected”; it does not imply that account data is invalid.
- Runtime health: one row per runtime with capability badges and a truthful status (`available`, `read-only`, `unsupported`, `UNPROVEN`, or error). Do not call a readable runtime “online” merely because `readStatus` is true.
- Attention list: deduplicated warnings ordered by severity: failed/expired auth, route/model `UNPROVEN`, low capacity, locks, then informational warnings. Each links to the relevant view and scope.
- Selected-context card: active route target and fallback count, requested/effective model and proof badge. Missing values are “Not reported,” never fabricated as default.
- Guided-auth card: pending/polling challenges with countdown and lifecycle status. It links to the challenge detail; expiry is local display only and must be reconciled from server state on refresh.
- Account overview: status only. Row actions are menus that navigate to Accounts & Routing with the target selected; no direct destructive action lives on Dashboard.
- Quick actions: only show a CTA if the corresponding capability is true. Route `Auto-select` is a preview-first action; `Add account` is available only where `startReauth`/add capability is supplied. Otherwise show the state badge rather than a dead button.

**Dashboard API needs:** `GET /api/status`; `GET /api/scopes` for context; eventually a selected-scope route/model summary may be embedded in status or supplied by read endpoints. The currently checked-in server supports only `GET /api/status`; until the remaining endpoints are complete, Dashboard is the only fully functional app screen and all future controls remain visibly unavailable.

### 3.2 Accounts & Routing

**Purpose:** inspect accounts and edit only the selected runtime/scope’s account route. “Remove” and “Delete” are distinct actions in placement, copy, and confirmation.

**Layout:** a selected-context header; a route card; account list; account inspector drawer. On desktop the route card and filters sit beside the list. On narrow screens the inspector is a full-height dialog and each account is a card. Filter/sort by health, auth state, role, eligibility, and route position; do not filter out unusable accounts by default because recovery work depends on seeing them.

**Account row/card fields:** local label/identity, provider, role, enabled state, compatible runtimes, auth status, usage windows (with exact “unreadable” where null), cooldown, current route position, and model eligibility where reported. Avoid treating a profile label as an exact deletion identity; the API must resolve and return the canonical connected target.

**Route card:** active profile, ordered fallback list, last verified/updated timestamp, lock status, and warning list. The order represents the API/runtime’s route order; drag-and-drop is not in scope unless a supported ordered-routing mutation is added. `Use this account` and `Auto-select eligible account` initiate preview requests first. A completed preview opens a normal confirmation sheet summarizing runtime, scope, selected account, expected route impact, warnings, and dry-run receipt before live apply.

**Account lifecycle actions:**

- **Add account** opens Guided Add with the current provider/runtime/scope preselected. It never pretends an account is connected before the challenge completes and verifies.
- **Reauthenticate** opens Guided Reauth with the selected canonical account; current working auth remains in use until verification completes.
- **Remove from routing** is a normal confirmation, labelled `Remove from this route`. Its confirmation says “This changes routing only. Credentials remain saved.” It must show the single runtime/scope and route impact. Successful output links to receipt.
- **Delete credentials** opens the strong destructive confirmation in section 3.6. It is unavailable unless the API says the target exactly matches a connected credential and the scope/runtime supports deletion.
- Enable/disable actions, if retained by the API, must say whether they affect eligibility, routing, or credentials and use an API-returned impact summary.

**Accounts/Routing API needs:** `GET /api/status`, `GET /api/scopes`, and planned `POST /api/routes/auto`, `POST /api/routes/use`, `POST /api/routes/remove`, `POST /api/accounts/delete`, `POST /api/accounts/add`, and `POST /api/accounts/reauth`. Each mutation request needs `runtime`, structured `scope`, provider/target as applicable, `dryRun`, a client request/idempotency key, and CSRF/auth headers. Each response needs a discriminated result, audit/request ID, redacted receipt summary/link, warnings, and proof/verification state. Do not build UI-side routing resolution.

### 3.3 Guided Add / Reauthenticate lifecycle

**Purpose:** guide a durable, server-owned device-auth challenge without holding credentials in the browser. It is a single reusable flow with a clearly visible mode: `Add account` or `Reauthenticate account`.

**Start step:** show selected provider/runtime/scope, an email field for Add, and the existing canonical account identity for Reauth. Validate email locally only for basic format; server validation is authoritative. Explain that one active challenge exists per `provider + runtime + normalized email + scope kind + scope id`; a new reauth may replace a pending reauth only after explicit confirmation and must never silently cancel an add. Start supports a dry-run preview if offered by API, then a normal start confirmation with the operation label and scope.

**Challenge step:** show mode, account label/redacted display as supplied, verification URL, user code, expiry timestamp/countdown, status, and server update time. The code and URL are sensitive operational values: render as text, provide separate `Copy code` and `Open verification page` buttons, do not auto-open a browser window, do not put either in the URL, and do not expose them in aria-live announcements. Copy success says only “Code copied.” Provide an API-supplied manual fallback command as an optional collapsed section; it must contain no token.

**Lifecycle state machine:**

| Server state/result | UI behavior |
| --- | --- |
| `started` / `pending` | Show verification instructions, countdown, Cancel, and periodic status refresh using server-provided polling interval (fallback: visible manual Refresh, no faster than 5 seconds). |
| `polling` | Keep instructions visible; show “Checking completion” without a spinner that implies browser-owned work. |
| worker disconnected, still valid | `UNPROVEN`/attention card: “We cannot currently reach the worker; this challenge is still valid until [time].” Offer Refresh and manual fallback, not a false failure. |
| `complete` + route verified | Success screen: account saved, whether routing changed, exact selected scope, receipt link, and return-to-accounts CTA. |
| `complete` + route activation failed | Partial result, not success: “Authentication completed; routing was not verified.” Preserve the old route; show receipt, route retry only if API offers it, and Accounts link. |
| authenticated wrong account | Failure/blocked state naming the mismatch only as safely returned. Do not route it; show Cancel/Retry and receipt. |
| `failed` | Failure summary, receipt/details, Retry as a new challenge, and Close. |
| `expired` | Expired state with original expiry time; code and open buttons are disabled; Retry starts a new challenge. |
| `cancelled` | Explain no credentials were changed by cancellation unless API result says otherwise; allow new start. |
| active challenge conflict | Show existing challenge’s mode/scope/status. Offer “View existing”; replacement requires a dedicated confirmation only for a reauth conflict. |

The list view groups active challenges first and keeps completed/failed/expired/cancelled history filterable. Challenge detail is deep-linkable only by opaque ID within the protected local app; never encode code, URL, email, or token in the path/query. On reload, fetch server-authoritative challenge state before showing controls.

**Guided-auth API needs:** planned `POST /api/accounts/add`, `POST /api/accounts/reauth`, `GET /api/reauth`, `GET /api/reauth/:id`, and `POST /api/reauth/:id/cancel`. Start returns a challenge view only, never worker/session/result file paths or credentials. Challenge view needs ID, mode, provider/runtime/scope, profile hint, optional local-display identity, verification URI/code, expiry, polling interval, lifecycle status, timestamps, warnings, result summary/profile, receipt reference, and structured reason/manual fallback when unsupported. Mutations need anti-CSRF, request/audit ID, no-store response, and idempotency handling.

### 3.4 Models & Fallbacks

**Purpose:** make model selection understandable without conflating it with account routing or catalog availability.

**Layout:** selected context header; a current-selection card; fallback-chain editor; model catalog table/cards; proof/activity drawer. The four primary values are always separate: **requested policy**, **effective runtime model**, **eligible account support**, and **verification/proof**. If any is absent, display `Not reported`; never derive an effective model from requested intent.

Each catalog item shows provider/model identifier, catalog state, account eligibility, probe status/time, and action availability. Use these exact semantics:

- `supported`: validated for selected runtime/scope/account context; can be selected only if write capability permits.
- `unsupported_by_account`: known unavailable to the usable account; never offer persistent use.
- `not_in_catalog`: not advertised by the runtime catalog; do not invent it.
- `unknown`: no safe determination; show `UNPROVEN`, not an enabled “Use” action.
- `read_only_runtime`: observable configuration but no mutation support; show Read-only.

`Use model`, `Auto-pick best model`, fallback add/remove/clear, and `Probe model` each begin with an API preview or action-specific confirmation. Include runtime/scope, desired model/fallback order, expected session impact, validation/proof requirement, and whether it is a single agent/profile or `all`. A named OpenClaw agent is normal confirmation; OpenClaw `all` is strong confirmation. Hermes default and Codex default warn that existing sessions/chats may retain the prior model. Codex chat/session controls remain read-only until a safe write capability is detected. Never claim applied until post-operation proof is verified; an accepted write without proof is `UNPROVEN`.

Fallback editing is an ordered list with move controls (`Move earlier/later`) rather than drag-only interaction. Empty fallback chain says “No fallback configured”; it does not mean automatic account routing is disabled.

**Models API needs:** the plan requires read/mutation operations equivalent to model list/status/use/auto/fallback add/remove/clear/probe and model enable/disable. Before implementation, define protected API routes and result unions with the same shared-executor requirement as account operations. Read data needs per-scope catalog, `ModelPreference` (desired, applied, status, proof, warnings), fallback order, eligibility, and capability. Mutation responses need dry-run/applied/blocked/unsupported/failed state, verification proof, audit ID, and receipt reference.

### 3.5 Receipts & Audit

**Purpose:** provide evidence and recovery context, not a raw log viewer.

The default page is reverse chronological with filters for date, runtime/scope, action category, outcome (`applied`, `dry_run`, `blocked`, `failed`, `UNPROVEN`), and target label. An audit row contains timestamp, action verb, selected runtime/scope, redacted target summary, outcome, dry-run marker, warnings count, and audit ID. It must not show raw `before`/`after` configuration blobs.

The receipt detail drawer shows: plain-language outcome; action and target; runtime/scope; request/audit ID; started/completed times; dry-run/applied/verification state; warnings; backup/rollback availability as redacted metadata; result summary; and a local receipt reference. For delete, it must make clear that the backup was created before the attempt and whether outcome proof is verified or `UNPROVEN`. Copy action copies a redacted operator summary, not raw receipt JSON. Any download/export needs an explicit redaction warning and only exists if the API provides a safe redacted artifact.

Empty audit history says there are no recorded Account Center operations; it must not imply no changes happened outside Account Center. Receipt fetch errors show immutable list metadata and a retry. Missing receipt referenced by a completed action is an `UNPROVEN` evidence state.

**Receipts/Audit API needs:** planned `GET /api/audit` with pagination/filtering and a protected receipt-detail route or a receipt object supplied in mutation/audit responses. Existing status has a small `audit` array, which may seed a read-only summary but is not sufficient for paginated evidence. Return redacted structured fields only; browser UI must never read local receipt paths directly.

### 3.6 Strong destructive confirmation

This is required for credential **Delete** and for scope-wide model/fallback operations. It is a modal dialog on desktop and full-screen dialog on narrow viewports. Opening it moves focus to the dialog heading; closing returns focus to the initiating action. Escape cancels only before the final submit and never dismisses an in-flight request.

For credential delete, the dialog must show the API-confirmed canonical connected identity, provider, runtime, exact scope, operation text `Delete credentials`, and explicit impact: “Removes credentials. This is not routing removal.” It also shows backup/receipt guard status, what is preserved (sessions, prompts, memory, bootstrap, workspaces), and post-action verification expectation. The final control is disabled until the user types the exact API-returned confirmation token/identity (case-normalization rules supplied by API) and checks an acknowledgement. The submit label includes the verb: `Delete credentials`. No action may be submitted if exact-match, backup, runtime adapter, or capability guard is not confirmed; instead render Blocked/Unsupported/UNPROVEN.

For `Remove from routing`, use a separate, smaller confirmation: “Remove from routing only — credentials stay saved.” It must never reuse delete styling or language. For route/model changes, use normal confirmation with a preview/receipt summary. Any non-idempotent request disables duplicate submit, communicates progress, and resolves from the server result rather than timing out locally into a presumed failure.

## 4. API interaction contract for the UI

The UI is a protected local API client only. It does not execute shell commands, access adapter files, choose routing targets, write receipts, or retain auth material. All mutations use the shared command executor through the API.

Every response that drives a screen must include a stable schema/version or discriminant, server timestamp, redacted warnings, and no-store headers. Every mutation uses the bearer token plus API-selected CSRF protection and includes a client request/idempotency key. A mutation response must be a discriminated union, at minimum `dry_run`, `started`, `applied`, `blocked`, `validation_error`, `unsupported_by_runtime`, `failed`, or `unproven`; UI behavior branches on `kind`, never string matching a human summary. Responses should include `requestId` and `auditId` where applicable.

| UI need | Planned endpoint/action | Minimum data / result |
| --- | --- | --- |
| Bootstrap/status | `GET /api/status` | Current status schema, runtime capabilities, accounts, routes, policy, challenges, recent audit, warnings, no-secrets assertion. |
| Runtime context | `GET /api/scopes` | RuntimeScope list and per-scope read/write capabilities. |
| Route preview/apply | `POST /api/routes/auto`, `/use`, `/remove` | Scope, target/selection, `dryRun`, route impact, lock/guard warnings, receipt, proof/result union. |
| Account delete | `POST /api/accounts/delete` | Canonical exact-match target, confirmation challenge/requirements, backup and verification result, receipt/audit IDs. |
| Add/reauth start | `POST /api/accounts/add`, `/reauth` | Challenge view and conflict/unsupported/result union only. |
| Challenge list/detail/cancel | `GET /api/reauth`, `GET /api/reauth/:id`, `POST /api/reauth/:id/cancel` | Durable lifecycle state, expiry, safe verification data, warnings, receipts. |
| Audit evidence | `GET /api/audit` and safe receipt detail | Paginated redacted events and a redacted receipt detail view. |
| Models/fallbacks | API routes to be finalized from model command contract | Per-scope catalog/preference/fallback/proof plus preview/apply/probe unions. |

Current implementation note: `packages/cli/src/server.ts` provides `GET /api/status` behind a bearer token and serves a read-only HTML status shell. It does **not** yet provide the planned mutation, scope, challenge, audit, or model endpoints. The implementation pass should preserve the existing no-store and bearer behavior while replacing the status-only shell only after the API contract exists.

## 5. Visual system and reusable components

Use the existing dark local-control-plane direction, but implement a coherent token layer rather than page-local values. Respect user `prefers-color-scheme` only if a light theme is later designed and contrast-tested; dark is the initial supported theme.

| Token | Value / rule |
| --- | --- |
| `color.bg` / `surface` / `surfaceRaised` | `#0c1117` / `#141b23` / `#101720` |
| `color.text` / `muted` / `border` | `#edf3f8` / `#9eabb9` / `#2a3541` |
| `color.accent` / `focus` | `#79d4b4` / `#8ec5ff` |
| `color.warning` / `danger` | `#f1bd67` / `#ee8290` |
| Status rule | Never rely on color alone; pair icon, text label, and badge. `UNPROVEN` is amber; error/danger is red; read-only/unknown neutral; verified success green. |
| Typography | System UI for long-form/UI copy; mono only for IDs, codes, models, and technical values. Base 16 px body, 14 px dense table text minimum, 1.45+ line height. |
| Spacing | 4 px base grid: 4, 8, 12, 16, 24, 32. Minimum interactive target 44 by 44 CSS px. |
| Shape/elevation | 6 px controls, 10 px panels; 1 px borders. Use elevation sparingly; dialogs have backdrop and clearly bounded surface. |
| Focus | 3 px visible `color.focus` outline with 2 px offset; never remove it. |

Required components: application shell; connection status; runtime/scope selector; status badge; capability badge; card/panel; data table and responsive record card; account row; route order list; capacity meter (with textual percentage/unknown); alert/banner; empty state; skeleton; inline field error; toast/live-region announcer; action menu; preview/normal confirmation sheet; strong destructive dialog; guided-auth challenge card; code display with copy action; receipt/audit drawer; fallback order editor; pagination/filter controls.

Use semantic buttons for actions and links only for navigation. Disabled actions include a concise adjacent reason; `aria-disabled` alone is not a substitute for disabled semantics. Avoid icon-only controls unless they have an accessible name and visible tooltip on keyboard focus.

## 6. Responsive, keyboard, and screen-reader requirements

Support 320 CSS px through wide desktop without content loss or two-dimensional page scrolling. At roughly 760 px, collapse multi-column dashboard layouts, convert account/model tables to labelled record cards, and make dialogs full-screen. At roughly 430 px, stack form controls and make primary destructive/confirm actions full width. Do not hide capacity, proof, or state information merely to fit a narrow viewport; use disclosure sections with clear summaries.

Keyboard requirements:

- Skip link goes to the main workspace; logical document landmarks are header, navigation, main, and complementary/drawer where used.
- Tab order follows visual and task order. The scope selector, filters, menus, and dialogs are fully operable without pointer or drag gestures.
- Menus use Arrow keys/Home/End/Escape and return focus to their trigger. Comboboxes expose selected runtime and scope in their accessible name.
- Modal dialogs trap focus, restore focus on close, and use an explicit Cancel button. In-flight dialogs prevent duplicate submission but retain status text.
- Copy code, refresh, retry, preview, and confirm all have keyboard-visible focus and non-ambiguous labels.

Screen-reader requirements:

- Use native headings in order and real table headers where a table remains a table. Responsive record cards use `dl`/label-value semantics rather than visually styled anonymous divs.
- Announce connection, loading completion, action result, and field validation in a polite live region. Use assertive announcement only for a destructive-action failure that requires immediate attention. Do not announce device codes, URLs, exact emails, tokens, or long receipt contents.
- Status badges have visible text and an equivalent accessible name, for example `UNPROVEN — route verification unavailable`.
- Countdown has a static expiry timestamp plus periodic, throttled updates; it must not flood live regions. Expiry triggers one announcement and moves focus nowhere automatically.
- Meet WCAG 2.2 AA contrast and text-resize/reflow expectations; honor `prefers-reduced-motion` by eliminating nonessential animation.

## 7. Implementation and test acceptance checklist

- Build the app against fixture/API contracts, never direct core/runtime access from the browser.
- Cover each shared state (loading, empty, error, read-only, unsupported, `UNPROVEN`, blocked, dry-run, applied) in component/interaction tests.
- Cover Add and Reauth through pending, polling, completion, partial route failure, wrong-account, worker-disconnected, expired, cancelled, failed, and conflict states.
- Assert remove says routing-only and delete requires exact target plus typed confirmation; assert no email/token/code is exposed through live-region text, URL, local storage, or error logging.
- Test desktop and 320/430/760 px layouts; keyboard paths for context selection, account action menu, fallback reorder, copy code, and both confirmation dialogs; run automated accessibility checks plus manual screen-reader smoke.
- Mock API result unions, including malformed/unknown values, and render unknown values as error/`UNPROVEN`, never success.
- Verify a mutation result produces a receipt/audit link and that absent proof remains `UNPROVEN`.

No UI-only fixture change is required for this specification. The existing fixture remains useful for the current read-only Dashboard, while implementation should add dedicated redacted API fixtures for the result unions above once the API contract is introduced.
