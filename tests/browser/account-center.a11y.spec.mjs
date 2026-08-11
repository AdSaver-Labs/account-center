import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { AuditStore, AuthChallengeStore, MutationRepository } from "../../packages/core/dist/index.js";
import { AccountUiPreferencesStore } from "../../packages/cli/dist/account-preferences-store.js";
import { createAccountCenterServer } from "../../packages/cli/dist/server.js";

/**
 * This suite intentionally owns a fixture-only server. It never starts the CLI,
 * reads a local credential store, or reuses a user browser/session.
 */
const gate = test.extend({
  panel: async ({ page }, use) => {
    const root = await mkdtemp(join(tmpdir(), "account-center-a11y-"));
    const token = randomBytes(32).toString("base64url");
    const challengeStore = new AuthChallengeStore(join(root, "challenges.json"));
    await challengeStore.create({
      mode: "reauth",
      provider: "openai",
      runtime: "hermes",
      // Match the fixture adapter's exact protected runtime-context selector.
      scope: "default",
      target: "fixture-only-target"
    });
    const mutationRepository = new MutationRepository(join(root, "operations"), { operationId: () => "op_fixture_detail" });
    const claim = await mutationRepository.claim({
      idempotencyKey: "fixture-operation-detail-key",
      requestDigest: "a".repeat(64),
      audit: { action: "route.use", provider: "openai", runtime: "hermes", scopeKind: "default", scopeIdDigest: "b".repeat(64), targetDigest: "c".repeat(64) }
    });
    if (claim.kind !== "execute") throw new Error("fixture operation must be executable");
    await mutationRepository.complete({ operationId: claim.operationId, outcome: "blocked", warningCodes: ["runtime_unavailable"] });
    const app = createAccountCenterServer({
      token,
      source: "fixture",
      auditStore: new AuditStore(join(root, "audit.json")),
      challengeStore,
      mutationRepository,
      accountUiPreferencesStore: new AccountUiPreferencesStore(root)
    });
    const { port } = await app.listen();
    const baseURL = `http://127.0.0.1:${port}`;
    try {
      await use({ page, token, baseURL });
    } finally {
      // Chromium keeps loopback HTTP connections alive. Leave the fixture origin
      // before closing its server so teardown cannot consume the test timeout.
      await page.goto("about:blank");
      await app.close();
      // Closing a loopback server does not make already-dispatched browser
      // requests disappear synchronously. Bound the fixture-only cleanup retry
      // so an in-flight store write cannot race recursive temp-dir removal.
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
});

async function open(panel) {
  await panel.page.goto(panel.baseURL, { waitUntil: "domcontentloaded" });
  const skip = panel.page.getByRole("button", { name: "Skip for now" });
  if (await skip.isVisible()) await skip.click();
}

async function connect(panel) {
  await panel.page.getByLabel("Launch token").fill(panel.token);
  await panel.page.getByRole("button", { name: "Refresh status" }).click();
  await expect(panel.page.locator("#notice")).toContainText("workspace refreshed", { ignoreCase: true });
}

async function openMore(panel) {
  await panel.page.getByRole("tab", { name: "More" }).click();
}

async function openAdvancedDiagnostics(panel) {
  const advanced = morePanel(panel).locator("#advanced-diagnostics");
  if (!(await advanced.getAttribute("open"))) await advanced.locator("summary").click();
}

function homePanel(panel) { return panel.page.locator("#home-view"); }
function accountsPanel(panel) { return panel.page.locator("#accounts-view"); }
function morePanel(panel) { return panel.page.locator("#more-view"); }

async function assertNoSeriousOrCriticalAxeViolations(page, testInfo) {
  const results = await new AxeBuilder({ page }).analyze();
  const seriousOrCritical = results.violations.filter((violation) =>
    violation.impact === "serious" || violation.impact === "critical"
  );
  const lowerSeverity = results.violations.filter((violation) =>
    violation.impact !== "serious" && violation.impact !== "critical"
  ).map(({ id, impact, help, nodes }) => ({ id, impact, help, nodes: nodes.length }));
  await testInfo.attach("axe-lower-severity-violations.json", {
    body: JSON.stringify(lowerSeverity, null, 2),
    contentType: "application/json"
  });
  expect(seriousOrCritical, "axe serious/critical violations").toEqual([]);
}

gate("rejects an invalid launch token and repairs focus to the token field", async ({ panel }) => {
  await open(panel);
  const tokenField = panel.page.getByLabel("Launch token");
  await tokenField.fill("invalid-fixture-token");
  await panel.page.getByRole("button", { name: "Refresh status" }).click();
  await expect(panel.page.getByRole("status")).toContainText("token rejected", { ignoreCase: true });
  await expect(tokenField).toBeFocused();
});

gate("supports roving tab navigation with ArrowRight, ArrowLeft, Home, and End", async ({ panel }) => {
  await open(panel);
  await connect(panel);
  const home = panel.page.getByRole("tab", { name: "Home" });
  await home.focus();
  await home.press("ArrowRight");
  await expect(panel.page.getByRole("tab", { name: "Accounts" })).toBeFocused();
  await panel.page.keyboard.press("ArrowLeft");
  await expect(home).toBeFocused();
  await panel.page.keyboard.press("End");
  await expect(panel.page.getByRole("tab", { name: "More" })).toBeFocused();
  await panel.page.keyboard.press("Home");
  await expect(home).toBeFocused();
  await expect(home).toHaveAttribute("aria-selected", "true");
});

gate("uses a calm Home, Accounts, and More navigation model", async ({ panel }) => {
  await open(panel);
  await expect(panel.page.getByRole("tab")).toHaveText(["Home", "Accounts", "More"]);
  await expect(homePanel(panel)).toContainText("Runtime health");
  await expect(homePanel(panel)).toContainText("Attention");
  await expect(homePanel(panel)).toContainText("Visible accounts");
  await expect(homePanel(panel)).not.toContainText("Model policy");
  await panel.page.getByRole("tab", { name: "More" }).click();
  await expect(morePanel(panel)).toContainText("Settings");
  await expect(morePanel(panel)).toContainText("Advanced");
});

gate("offers a skippable, replayable first-run welcome without loading runtime data", async ({ panel }) => {
  await panel.page.goto(panel.baseURL, { waitUntil: "domcontentloaded" });
  const welcome = panel.page.locator("#onboarding-dialog");
  await expect(welcome).toBeVisible();
  await expect(welcome).toContainText("A local, redacted control panel");
  await expect(welcome).toContainText("does not connect to a runtime");
  await welcome.getByRole("button", { name: "Skip for now" }).click();
  await expect(welcome).toBeHidden();
  await expect(panel.page.getByLabel("Launch token")).toBeFocused();
  await openMore(panel);
  await panel.page.getByRole("button", { name: "Replay welcome" }).click();
  await expect(welcome).toBeVisible();
  await expect(welcome).toContainText("Step 1 of 4");
  await assertNoSeriousOrCriticalAxeViolations(panel.page, test.info());
});

gate("keeps first-run safety boundaries readable on a narrow screen", async ({ panel }) => {
  await panel.page.setViewportSize({ width: 320, height: 720 });
  await panel.page.goto(panel.baseURL, { waitUntil: "domcontentloaded" });
  const welcome = panel.page.locator("#onboarding-dialog");
  await welcome.getByRole("button", { name: "Continue" }).click();
  await welcome.getByRole("button", { name: "Continue" }).click();
  await expect(welcome).toContainText("Only supported actions are offered");
  await expect(welcome).toContainText("Routing, model changes, and runtime sign-in changes remain unavailable without proof");
  await expect.poll(() => panel.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await assertNoSeriousOrCriticalAxeViolations(panel.page, test.info());
});

gate("keeps technical diagnostics behind an explicit Advanced disclosure", async ({ panel }) => {
  await open(panel);
  await connect(panel);
  await openMore(panel);
  const advanced = morePanel(panel).locator("#advanced-diagnostics");
  await expect(advanced).not.toHaveAttribute("open", "");
  await expect(advanced.locator("#catalogs-view")).toBeHidden();
  await expect(advanced.locator("#models-fallbacks-view")).toBeHidden();
  await expect(advanced.locator("#audit-view")).toBeHidden();
  await expect(advanced.locator("#settings-view")).toBeHidden();
  await advanced.locator("summary").click();
  await expect(advanced).toHaveAttribute("open", "");
  await expect(advanced.locator("#catalogs-view")).toBeVisible();
  await expect(advanced.locator("#audit-view")).toBeVisible();
});

gate("keeps More connection and sign-in help easy to scan on a narrow screen", async ({ panel }) => {
  await panel.page.setViewportSize({ width: 320, height: 720 });
  await open(panel);
  await connect(panel);
  await openMore(panel);
  const more = morePanel(panel);
  const help = more.getByLabel("Everyday settings help");
  await expect(help).toBeVisible();
  await expect(help).toContainText("Local connection");
  await expect(help).toContainText("Need to sign in?");
  await expect(help).toContainText("Getting started");
  await expect(help.locator("article")).toHaveCount(3);
  await expect(more.locator("#advanced-diagnostics")).not.toHaveAttribute("open", "");
  await expect.poll(() => panel.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await assertNoSeriousOrCriticalAxeViolations(panel.page, test.info());
});

gate("uses plain-language, fail-closed Guided auth status details", async ({ panel }) => {
  await open(panel);
  await openMore(panel);
  const guided = panel.page.locator("#guided-view");
  await expect(guided.locator("#guided-freshness")).toHaveText("Status unavailable");
  await expect(guided.locator("#guided-freshness")).toHaveAttribute("aria-describedby", "guided-freshness-detail");
  await expect(guided.locator("#guided-freshness-detail")).toContainText("No sign-in result is shown");
  await connect(panel);
  await expect(guided.locator("#guided-freshness")).toHaveText("Records checked");
  await expect(guided.locator("#guided-freshness-detail")).toContainText("does not confirm that sign-in was completed");
  await assertNoSeriousOrCriticalAxeViolations(panel.page, test.info());
});

gate("uses plain-language, fail-closed audit and operation snapshot details", async ({ panel }) => {
  await open(panel);
  await openMore(panel);
  await openAdvancedDiagnostics(panel);
  const audit = panel.page.locator("#audit-view");
  const operations = audit.locator(".panel").filter({ has: panel.page.locator("#operation-freshness") });
  await expect(audit.locator("#audit-freshness")).toHaveText("Status unavailable");
  await expect(audit.locator("#audit-freshness")).toHaveAttribute("aria-describedby", "audit-freshness-detail");
  await expect(audit.locator("#audit-freshness-detail")).toContainText("Previously loaded evidence is not shown as current");
  await expect(operations.locator("#operation-freshness")).toHaveText("Status unavailable");
  await expect(operations.locator("#operation-freshness")).toHaveAttribute("aria-describedby", "operation-freshness-detail");
  await expect(operations.locator("#operation-freshness-detail")).toContainText("Previously loaded evidence is not shown as current");
  await connect(panel);
  await expect(audit.locator("#audit-freshness")).toHaveText("Records checked");
  await expect(operations.locator("#operation-freshness")).toHaveText("Records checked");
  await panel.page.getByLabel("Launch token").fill("invalid-fixture-token");
  await audit.getByRole("button", { name: "Filter audit history" }).click();
  await expect(audit.locator("#audit-freshness")).toHaveText("Status unavailable");
  await operations.getByRole("button", { name: "Filter operation history" }).click();
  await expect(operations.locator("#operation-freshness")).toHaveText("Status unavailable");
  await assertNoSeriousOrCriticalAxeViolations(panel.page, test.info());
});

gate("uses plain-language, fail-closed model-policy evidence details", async ({ panel }) => {
  await open(panel);
  await openMore(panel);
  await openAdvancedDiagnostics(panel);
  const models = panel.page.locator("#models-fallbacks-view");
  await expect(models.locator("#models-fallbacks-badge")).toHaveText("Status unavailable");
  await expect(models.locator("#models-fallbacks-badge")).toHaveAttribute("aria-describedby", "models-fallbacks-detail");
  await expect(models.locator("#models-fallbacks-detail")).toContainText("No model setting or fallback is shown as current");
  await connect(panel);
  await expect(models.locator("#models-fallbacks-badge")).toHaveText("Read-only evidence");
  await expect(models.locator("#models-fallbacks-detail")).toContainText("does not show a currently applied model setting or enable changes");
  await expect(models).not.toContainText("UNPROVEN");
  await panel.page.route("**/api/models?runtime=hermes&scope=default", async (route) => route.abort());
  await panel.page.getByRole("button", { name: "Refresh status" }).click();
  await expect(models.locator("#models-fallbacks-badge")).toHaveText("Status unavailable");
  await expect(models).toContainText("No model is shown as selectable");
  await expect(models).not.toContainText("UNPROVEN");
  await assertNoSeriousOrCriticalAxeViolations(panel.page, test.info());
});

gate("names the selected scope for Home accounts without claiming an active route", async ({ panel }) => {
  await open(panel);
  await connect(panel);
  const homeScope = homePanel(panel).locator("#home-account-scope");
  await expect(homeScope).toHaveText("Showing the verified account inventory for hermes / default. This list does not identify an active route.");

  await panel.page.getByLabel("Runtime & scope").selectOption("openclaw|default");
  await expect(panel.page.getByRole("status")).toContainText("Observed scoped runtime data refreshed.");
  await expect(homeScope).toHaveText("Showing the verified account inventory for openclaw / default. This list does not identify an active route.");
  await expect(homeScope).not.toContainText("Active:");
});

gate("takes an attention-item guided-auth link to the accessible More section", async ({ panel }) => {
  await open(panel);
  await connect(panel);
  await homePanel(panel).getByRole("button", { name: "View guided auth" }).click();
  await expect(panel.page.getByRole("tab", { name: "More" })).toHaveAttribute("aria-selected", "true");
  await expect(morePanel(panel)).toBeVisible();
  await expect(panel.page.locator("#guided-view")).toBeFocused();
  await expect(panel.page.locator("#guided-view")).toContainText("Guided auth");
});

gate("renders accounts/routing and settings as truthful protected states", async ({ panel }) => {
  await open(panel);
  await connect(panel);
  await panel.page.getByRole("tab", { name: "Accounts" }).click();
  const accountsRouting = accountsPanel(panel);
  await expect(accountsRouting).toContainText(/No route reported|Active:/i);
  await expect(accountsRouting).toContainText(/Route changes unavailable/i);
  await expect(accountsRouting).toContainText(/UNPROVEN/i);
  await openMore(panel);
  const settings = morePanel(panel);
  await expect(settings).toContainText(/No verified release status reported/i);
  await expect(settings).toContainText(/Update Center is unavailable/i);
  await expect(settings).toContainText(/blocked/i);
});

gate("labels the selected fixture account Active while non-selected accounts remain Saved", async ({ panel }) => {
  await open(panel);
  await connect(panel);
  await panel.page.getByLabel("Runtime & scope").selectOption("openclaw|default");
  await expect(panel.page.getByRole("status")).toContainText("Observed scoped runtime data refreshed.");
  await panel.page.getByRole("tab", { name: "Accounts" }).click();
  const accounts = accountsPanel(panel).locator("#account-visibility-state");
  await expect(accounts.locator(".record strong")).toContainText(["account-1 · Active", "account-2 · Saved"]);
  await expect(accounts.locator(".record strong").filter({ hasText: / · Active$/ })).toHaveCount(1);
  await expect(accounts.locator(".record strong").filter({ hasText: / · Saved$/ })).toHaveCount(3);
});

gate("returns the selected Active fixture account to Active after local hide and restore", async ({ panel }) => {
  await open(panel);
  await connect(panel);
  const scope = panel.page.getByLabel("Runtime & scope");
  await scope.selectOption("openclaw|default");
  await expect(panel.page.getByRole("status")).toContainText("Observed scoped runtime data refreshed.");
  await panel.page.getByRole("tab", { name: "Accounts" }).click();
  const accounts = accountsPanel(panel).locator("#account-visibility-state");
  const selected = accounts.locator(".record").filter({ hasText: "account-1 · Active" });

  await selected.getByRole("button", { name: "Hide account locally; credentials stay connected" }).click();
  await expect(scope).toHaveValue("openclaw|default");
  await expect(accounts).toContainText("account-1 · Hidden");

  await accounts.getByRole("button", { name: "Restore account to everyday lists" }).click();
  await expect(scope).toHaveValue("openclaw|default");
  await expect(accounts).toContainText("account-1 · Active");
});

gate("keeps other selected-scope accounts Saved when the Active fixture account is hidden", async ({ panel }) => {
  await open(panel);
  await connect(panel);
  await panel.page.getByLabel("Runtime & scope").selectOption("openclaw|default");
  await expect(panel.page.getByRole("status")).toContainText("Observed scoped runtime data refreshed.");
  await panel.page.getByRole("tab", { name: "Accounts" }).click();
  const accounts = accountsPanel(panel).locator("#account-visibility-state");
  const selected = accounts.locator(".record").filter({ hasText: "account-1 · Active" });

  await selected.getByRole("button", { name: "Hide account locally; credentials stay connected" }).click();
  await expect(accounts.locator(".record strong").filter({ hasText: / · Saved$/ })).toHaveCount(3);
  await expect(accounts.locator(".record strong")).toContainText(["account-1 · Hidden", "account-2 · Saved"]);
});

gate("keeps the selected Active fixture account Active when a Saved account is hidden", async ({ panel }) => {
  await open(panel);
  await connect(panel);
  const scope = panel.page.getByLabel("Runtime & scope");
  await scope.selectOption("openclaw|default");
  await expect(panel.page.getByRole("status")).toContainText("Observed scoped runtime data refreshed.");
  await panel.page.getByRole("tab", { name: "Accounts" }).click();
  const accounts = accountsPanel(panel).locator("#account-visibility-state");
  const saved = accounts.locator(".record").filter({ hasText: "account-2 · Saved" });

  await saved.getByRole("button", { name: "Hide account locally; credentials stay connected" }).click();
  await expect(scope).toHaveValue("openclaw|default");
  await expect(accounts.locator(".record strong")).toContainText(["account-1 · Active", "account-2 · Hidden"]);
  await expect(accounts.locator(".record strong").filter({ hasText: / · Active$/ })).toHaveCount(1);
});

gate("keeps the same fixture account visible in another selected runtime scope when hidden locally", async ({ panel }) => {
  await open(panel);
  await connect(panel);
  const scope = panel.page.getByLabel("Runtime & scope");
  await scope.selectOption("openclaw|default");
  await expect(panel.page.getByRole("status")).toContainText("Observed scoped runtime data refreshed.");
  await panel.page.getByRole("tab", { name: "Accounts" }).click();
  const openclawAccounts = accountsPanel(panel).locator("#account-visibility-state");
  await openclawAccounts.locator(".record").filter({ hasText: "account-1 · Active" }).getByRole("button", { name: "Hide account locally; credentials stay connected" }).click();
  await expect(openclawAccounts).toContainText("account-1 · Hidden");

  await scope.selectOption("hermes|default");
  await expect(panel.page.locator("#notice")).toContainText("Observed scoped runtime data refreshed.");
  const hermesAccounts = accountsPanel(panel).locator("#account-visibility-state");
  await expect(hermesAccounts).toContainText("account-1 · Saved");
  await expect(hermesAccounts).not.toContainText("account-1 · Hidden");
});

gate("restores a selected-scope Hidden Saved account to Saved while the Active account stays Active", async ({ panel }) => {
  await open(panel);
  await connect(panel);
  const scope = panel.page.getByLabel("Runtime & scope");
  await scope.selectOption("openclaw|default");
  await expect(panel.page.getByRole("status")).toContainText("Observed scoped runtime data refreshed.");
  await panel.page.getByRole("tab", { name: "Accounts" }).click();
  const accounts = accountsPanel(panel).locator("#account-visibility-state");
  const saved = accounts.locator(".record").filter({ hasText: "account-2 · Saved" });

  await saved.getByRole("button", { name: "Hide account locally; credentials stay connected" }).click();
  await expect(accounts.locator(".record strong")).toContainText(["account-1 · Active", "account-2 · Hidden"]);

  await accounts.getByRole("button", { name: "Restore account to everyday lists" }).click();
  await expect(scope).toHaveValue("openclaw|default");
  await expect(accounts.locator(".record strong")).toContainText(["account-1 · Active", "account-2 · Saved"]);
  await expect(accounts.locator(".record strong").filter({ hasText: / · Active$/ })).toHaveCount(1);
  await expect(accounts.locator(".record strong").filter({ hasText: / · Saved$/ })).toHaveCount(3);
});

gate("restores only the chosen selected-scope Hidden Saved fixture account", async ({ panel }) => {
  await open(panel);
  await connect(panel);
  await panel.page.getByLabel("Runtime & scope").selectOption("openclaw|default");
  await expect(panel.page.getByRole("status")).toContainText("Observed scoped runtime data refreshed.");
  await panel.page.getByRole("tab", { name: "Accounts" }).click();
  const accounts = accountsPanel(panel).locator("#account-visibility-state");
  const firstSaved = accounts.locator(".record").filter({ hasText: "account-2 · Saved" });
  const secondSaved = accounts.locator(".record").filter({ hasText: "account-3 · Saved" });

  await firstSaved.getByRole("button", { name: "Hide account locally; credentials stay connected" }).click();
  await expect(accounts.locator(".record strong").filter({ hasText: "account-2 · Hidden" })).toHaveCount(1);
  await secondSaved.getByRole("button", { name: "Hide account locally; credentials stay connected" }).click();
  await expect(accounts.locator(".record strong")).toContainText(["account-2 · Hidden", "account-3 · Hidden"]);

  const firstHidden = accounts.locator(".record").filter({ hasText: "account-2 · Hidden" });
  await firstHidden.getByRole("button", { name: "Restore account to everyday lists" }).click();

  await expect(accounts.locator(".record strong")).toContainText(["account-1 · Active", "account-2 · Saved", "account-3 · Hidden"]);
  await expect(accounts.locator(".record strong").filter({ hasText: / · Hidden$/ })).toHaveCount(1);
});

gate("explains active, saved, and hidden accounts before offering local Hide or Restore", async ({ panel }) => {
  await open(panel);
  await connect(panel);
  await panel.page.getByRole("tab", { name: "Accounts" }).click();
  const accounts = accountsPanel(panel);
  await expect(accounts).toContainText("Active — selected for use now.");
  await expect(accounts).toContainText("Saved — available, but not selected now.");
  await expect(accounts).toContainText("Hidden — out of everyday lists, but still available.");
  await expect(accounts).toContainText("Hide removes an account from everyday lists. Restore shows it there again.");
  await expect(accounts.getByRole("button", { name: "Hide account locally; credentials stay connected and routing stays unchanged", exact: true }).first()).toBeVisible();
  await accounts.getByRole("button", { name: "Hide account locally; credentials stay connected" }).first().click();
  await expect(accounts.getByRole("button", { name: "Restore account to everyday lists; routing and credentials stay unchanged" })).toHaveCount(1);
  await expect(accounts).toContainText("It stays connected locally; routing changes remain capability-gated.");
});

gate("names the exact selected scope protected by local Hide and Restore", async ({ panel }) => {
  await open(panel);
  await connect(panel);
  await panel.page.getByLabel("Runtime & scope").selectOption("openclaw|default");
  await expect(panel.page.getByRole("status")).toContainText("Observed scoped runtime data refreshed.");
  await panel.page.getByRole("tab", { name: "Accounts" }).click();
  const visibility = accountsPanel(panel).locator("#account-visibility-state");
  await expect(visibility).toContainText("Changes stay in Openclaw / default. Other runtimes and scopes are unchanged.");
});

gate("fails closed on ambiguous or malformed account-visibility capability declarations", async ({ panel }) => {
  let alterCapabilities;
  const preferencePosts = [];
  panel.page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/account-ui-preferences") preferencePosts.push(request.url());
  });
  await panel.page.route("**/api/capabilities", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (alterCapabilities) alterCapabilities(body);
    await route.fulfill({ response, json: body });
  });
  const unavailable = (body) => { body.actions = body.actions.filter((action) => action.id !== "account_ui_preferences.mutate"); };
  const valid = (body) => body.actions.find((action) => action.id === "account_ui_preferences.mutate");
  const cases = [
    ["missing", unavailable],
    ["duplicate", (body) => { const action = valid(body); body.actions.push({ ...action }); }],
    ["conflicting duplicate", (body) => { const action = valid(body); body.actions.push({ ...action, endpoint: { ...action.endpoint, path: "/api/wrong" } }); }],
    ["malformed", (body) => { const action = valid(body); action.requires = ["bearer_token"]; }],
    ["blocked", (body) => { const action = valid(body); action.state = "blocked"; action.reason = "unavailable"; }]
  ];
  for (const [label, alter] of cases) {
    alterCapabilities = alter;
    await open(panel);
    await connect(panel);
    await panel.page.getByRole("tab", { name: "Accounts" }).click();
    const visibility = accountsPanel(panel).locator("#account-visibility-state");
    await expect(visibility, label).toContainText("Account visibility controls unavailable");
    await expect(visibility, label).toContainText("No account was hidden or restored.");
    await expect(visibility.getByRole("button", { name: /Hide account locally|Restore account to everyday lists/ }), label).toHaveCount(0);
  }
  expect(preferencePosts).toEqual([]);
});

gate("hides then restores a fixture account without requesting credential deletion", async ({ panel }) => {
  await open(panel);
  await connect(panel);
  await panel.page.getByRole("tab", { name: "Accounts" }).click();
  const accounts = accountsPanel(panel);
  await expect(accounts).not.toContainText("undefined");
  const row = accounts.locator("#account-visibility-state .record").filter({
    has: panel.page.getByRole("button", { name: "Hide account locally; credentials stay connected" })
  }).first();
  const initialTitle = await row.locator("strong").textContent();
  const accountRef = initialTitle?.split(" · ")[0];
  expect(accountRef).toMatch(/^account-[1-9][0-9]*$/);
  // Hide and Restore are local preference changes only. Record every mutation
  // request after the workspace is loaded so this flow cannot quietly grow a
  // route or credential side effect alongside the selected account change.
  const mutationTargets = [];
  panel.page.on("request", (request) => {
    if (request.method() !== "POST") return;
    const url = new URL(request.url());
    mutationTargets.push({
      origin: url.origin,
      path: url.pathname,
      runtime: url.searchParams.get("runtime"),
      scope: url.searchParams.get("scope")
    });
  });

  const hiddenResponse = panel.page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/account-ui-preferences" && response.request().method() === "POST"
  );
  await row.getByRole("button", { name: "Hide account locally; credentials stay connected" }).click();
  expect((await hiddenResponse).request().postDataJSON()).toEqual({ accountRef, state: "hidden" });
  await expect(accounts.locator("#account-visibility-state")).toContainText(`${accountRef} · Hidden`);
  await expect(homePanel(panel).locator("#accounts")).not.toContainText(accountRef || "");
  await expect(panel.page.locator("#notice")).toContainText("Account hidden locally. Credentials and runtime state were preserved; routing was not changed.");

  const restoredResponse = panel.page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/account-ui-preferences" && response.request().method() === "POST"
  );
  await accounts.getByRole("button", { name: "Restore account to everyday lists" }).first().click();
  expect((await restoredResponse).request().postDataJSON()).toEqual({ accountRef, state: "active" });
  await expect(accounts.locator("#account-visibility-state")).toContainText(initialTitle || "");
  await expect(homePanel(panel).locator("#accounts")).toContainText(accountRef || "");
  await expect(panel.page.locator("#notice")).toContainText("Account restored locally to everyday lists. Credentials and runtime state were preserved; routing was not changed.");
  await expect(panel.page.locator("#notice")).not.toContainText("UNPROVEN");
  expect(mutationTargets).toEqual([
    { origin: new URL(panel.baseURL).origin, path: "/api/account-ui-preferences", runtime: "hermes", scope: "default" },
    { origin: new URL(panel.baseURL).origin, path: "/api/account-ui-preferences", runtime: "hermes", scope: "default" }
  ]);
});

gate("explains when some verified accounts are hidden only from everyday lists", async ({ panel }) => {
  await open(panel);
  await connect(panel);
  await panel.page.getByRole("tab", { name: "Accounts" }).click();
  const accounts = accountsPanel(panel);
  const initialVisibleCount = await accounts.getByRole("button", { name: "Hide account locally; credentials stay connected" }).count();
  expect(initialVisibleCount).toBeGreaterThan(1);
  await accounts.getByRole("button", { name: "Hide account locally; credentials stay connected" }).first().click();
  await expect(homePanel(panel).locator("#account-count")).toHaveText(`${initialVisibleCount - 1} accounts visible — 1 verified account is hidden locally`);
});

gate("uses plural local-hide wording while verified accounts remain visible", async ({ panel }) => {
  await open(panel);
  await connect(panel);
  await panel.page.getByRole("tab", { name: "Accounts" }).click();
  const accounts = accountsPanel(panel);
  const hideButtons = accounts.getByRole("button", { name: "Hide account locally; credentials stay connected" });
  const initialVisibleCount = await hideButtons.count();
  expect(initialVisibleCount).toBeGreaterThan(2);
  await hideButtons.first().click();
  await accounts.getByRole("button", { name: "Hide account locally; credentials stay connected" }).first().click();
  const remaining = initialVisibleCount - 2;
  await expect(homePanel(panel).locator("#account-count")).toHaveText(`${remaining} ${remaining === 1 ? "account" : "accounts"} visible — 2 verified accounts are hidden locally`);
});

gate("explains when every verified account is hidden only from everyday lists", async ({ panel }) => {
  await open(panel);
  await connect(panel);
  await panel.page.getByRole("tab", { name: "Accounts" }).click();
  const accounts = accountsPanel(panel);
  const hideButtons = accounts.getByRole("button", { name: "Hide account locally; credentials stay connected" });
  const count = await hideButtons.count();
  expect(count).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    await hideButtons.first().click();
    await expect(accounts.getByRole("button", { name: "Restore account to everyday lists" })).toHaveCount(index + 1);
  }
  await expect(homePanel(panel).locator("#account-count")).toHaveText("0 accounts visible — all verified accounts are hidden locally");
  await expect(homePanel(panel).locator("#accounts")).toContainText("Every verified account is hidden only from everyday lists. Restore an account in Accounts to show it here; credentials and routing are unchanged.");
});

gate("keeps an empty verified inventory distinct from locally hidden accounts", async ({ panel }) => {
  await panel.page.route("**/api/limits?runtime=hermes&scope=default", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "account-center.limits.v1",
        generatedAt: new Date().toISOString(),
        accounts: []
      })
    });
  });
  await open(panel);
  await connect(panel);
  const home = homePanel(panel);
  await expect(home.locator("#account-count")).toHaveText("0 accounts");
  await expect(home.locator("#accounts")).toContainText("No visible account limits were reported by the protected API.");
  await expect(home.locator("#accounts")).not.toContainText("Every verified account is hidden only from everyday lists.");
  await expect(home.locator("#accounts")).not.toContainText(/Restore an account/i);
  await expect(home.getByRole("button", { name: "Restore account to everyday lists" })).toHaveCount(0);
  await panel.page.getByRole("tab", { name: "Accounts" }).click();
  const visibility = accountsPanel(panel).locator("#account-visibility-state");
  await expect(visibility).toContainText("No connected accounts were reported by the protected selected-scope inventory.");
  await expect(visibility.getByRole("button", { name: "Hide account locally; credentials stay connected" })).toHaveCount(0);
  await expect(visibility.getByRole("button", { name: "Restore account to everyday lists" })).toHaveCount(0);
});

gate("keeps an unavailable account inventory UNPROVEN without Restore guidance", async ({ panel }) => {
  await panel.page.route("**/api/limits?runtime=hermes&scope=default", async (route) => {
    await route.abort("failed");
  });
  await open(panel);
  await connect(panel);
  const home = homePanel(panel);
  await expect(home.locator("#account-count")).toHaveText("UNPROVEN");
  await expect(home.locator("#accounts")).toContainText("Visible accounts could not be verified");
  await expect(home.locator("#accounts")).not.toContainText(/Restore an account/i);
  await expect(home.getByRole("button", { name: "Restore account to everyday lists" })).toHaveCount(0);
  await panel.page.getByRole("tab", { name: "Accounts" }).click();
  const visibility = accountsPanel(panel).locator("#account-visibility-state");
  await expect(visibility).toContainText("Account visibility could not be verified");
  await expect(visibility).toContainText("No account was hidden or removed.");
  await expect(visibility).not.toContainText(/account-[1-9][0-9]* · (Active|Saved|Hidden)/);
  await expect(visibility.getByRole("button", { name: "Hide account locally; credentials stay connected" })).toHaveCount(0);
  await expect(visibility.getByRole("button", { name: "Restore account to everyday lists" })).toHaveCount(0);
});

gate("keeps malformed hidden account preferences UNPROVEN without Hide or Restore controls", async ({ panel }) => {
  await panel.page.route("**/api/account-ui-preferences**", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "account-center.account-ui-preferences.v1",
        hiddenAccountRefs: ["not-an-account-reference"]
      })
    });
  });
  await open(panel);
  await connect(panel);
  await panel.page.getByRole("tab", { name: "Accounts" }).click();
  const visibility = accountsPanel(panel).locator("#account-visibility-state");
  await expect(visibility).toContainText("Account visibility could not be verified");
  await expect(visibility).not.toContainText(/account-[1-9][0-9]* · (Active|Saved|Hidden)/);
  await expect(visibility.getByRole("button", { name: "Hide account locally; credentials stay connected" })).toHaveCount(0);
  await expect(visibility.getByRole("button", { name: "Restore account to everyday lists" })).toHaveCount(0);
});

gate("keeps duplicate hidden account preferences UNPROVEN without Hide or Restore controls", async ({ panel }) => {
  await panel.page.route("**/api/account-ui-preferences**", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "account-center.account-ui-preferences.v1",
        hiddenAccountRefs: ["account-1", "account-1"]
      })
    });
  });
  await open(panel);
  await connect(panel);
  await panel.page.getByRole("tab", { name: "Accounts" }).click();
  const visibility = accountsPanel(panel).locator("#account-visibility-state");
  await expect(visibility).toContainText("Account visibility could not be verified");
  await expect(visibility).not.toContainText(/account-[1-9][0-9]* · (Active|Saved|Hidden)/);
  await expect(visibility.getByRole("button", { name: "Hide account locally; credentials stay connected" })).toHaveCount(0);
  await expect(visibility.getByRole("button", { name: "Restore account to everyday lists" })).toHaveCount(0);
});

gate("keeps a malformed selected-scope account inventory UNPROVEN without Hide or Restore controls", async ({ panel }) => {
  await panel.page.route("**/api/limits?runtime=hermes&scope=default", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "account-center.limits.v1",
        generatedAt: new Date().toISOString(),
        accounts: "not-an-account-inventory"
      })
    });
  });
  await open(panel);
  await connect(panel);
  await panel.page.getByRole("tab", { name: "Accounts" }).click();
  const visibility = accountsPanel(panel).locator("#account-visibility-state");
  await expect(visibility).toContainText("Account visibility could not be verified");
  await expect(visibility).not.toContainText(/account-[1-9][0-9]* · (Active|Saved|Hidden)/);
  await expect(visibility.getByRole("button", { name: "Hide account locally; credentials stay connected" })).toHaveCount(0);
  await expect(visibility.getByRole("button", { name: "Restore account to everyday lists" })).toHaveCount(0);
});

gate("keeps duplicate selected-scope account references UNPROVEN without Hide or Restore controls", async ({ panel }) => {
  await panel.page.route("**/api/limits?runtime=hermes&scope=default", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "account-center.limits.v1",
        generatedAt: new Date().toISOString(),
        accounts: [
          { accountRef: "account-1", provider: "openai", health: "ok", authState: "active", readable: true, windows: [] },
          { accountRef: "account-1", provider: "openai", health: "ok", authState: "active", readable: true, windows: [] }
        ]
      })
    });
  });
  await open(panel);
  await connect(panel);
  await panel.page.getByRole("tab", { name: "Accounts" }).click();
  const visibility = accountsPanel(panel).locator("#account-visibility-state");
  await expect(visibility).toContainText("Account visibility could not be verified");
  await expect(visibility).not.toContainText(/account-[1-9][0-9]* · (Active|Saved|Hidden)/);
  await expect(visibility.getByRole("button", { name: "Hide account locally; credentials stay connected" })).toHaveCount(0);
  await expect(visibility.getByRole("button", { name: "Restore account to everyday lists" })).toHaveCount(0);
});

gate("keeps an array-shaped selected-scope inventory with a malformed account UNPROVEN", async ({ panel }) => {
  await panel.page.route("**/api/limits?runtime=hermes&scope=default", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "account-center.limits.v1",
        generatedAt: new Date().toISOString(),
        accounts: [{
          accountRef: "account-1",
          provider: "openai",
          health: "ok",
          authState: 42,
          readable: true,
          windows: []
        }]
      })
    });
  });
  await open(panel);
  await connect(panel);
  await panel.page.getByRole("tab", { name: "Accounts" }).click();
  const visibility = accountsPanel(panel).locator("#account-visibility-state");
  await expect(visibility).toContainText("Account visibility could not be verified");
  await expect(visibility).not.toContainText(/account-[1-9][0-9]* · (Active|Saved|Hidden)/);
  await expect(visibility.getByRole("button", { name: "Hide account locally; credentials stay connected" })).toHaveCount(0);
  await expect(visibility.getByRole("button", { name: "Restore account to everyday lists" })).toHaveCount(0);
});

gate("keeps a malformed nested weekly window UNPROVEN without Hide or Restore controls", async ({ panel }) => {
  await panel.page.route("**/api/limits?runtime=hermes&scope=default", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "account-center.limits.v1",
        generatedAt: new Date().toISOString(),
        accounts: [{
          accountRef: "account-1",
          provider: "openai",
          health: "ok",
          authState: "active",
          readable: true,
          windows: [{ name: "weekly", remainingPct: 75, resetsAt: "not-a-timestamp" }]
        }]
      })
    });
  });
  await open(panel);
  await connect(panel);
  await panel.page.getByRole("tab", { name: "Accounts" }).click();
  const visibility = accountsPanel(panel).locator("#account-visibility-state");
  await expect(visibility).toContainText("Account visibility could not be verified");
  await expect(visibility).not.toContainText(/account-[1-9][0-9]* · (Active|Saved|Hidden)/);
  await expect(visibility.getByRole("button", { name: "Hide account locally; credentials stay connected" })).toHaveCount(0);
  await expect(visibility.getByRole("button", { name: "Restore account to everyday lists" })).toHaveCount(0);
});

gate("keeps an out-of-range nested weekly percentage UNPROVEN without Hide or Restore controls", async ({ panel }) => {
  await panel.page.route("**/api/limits?runtime=hermes&scope=default", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "account-center.limits.v1",
        generatedAt: new Date().toISOString(),
        accounts: [{
          accountRef: "account-1",
          provider: "openai",
          health: "ok",
          authState: "active",
          readable: true,
          windows: [{ name: "weekly", remainingPct: 101, resetsAt: "2026-08-10T00:00:00.000Z" }]
        }]
      })
    });
  });
  await open(panel);
  await connect(panel);
  await panel.page.getByRole("tab", { name: "Accounts" }).click();
  const visibility = accountsPanel(panel).locator("#account-visibility-state");
  await expect(visibility).toContainText("Account visibility could not be verified");
  await expect(visibility).not.toContainText(/account-[1-9][0-9]* · (Active|Saved|Hidden)/);
  await expect(visibility.getByRole("button", { name: "Hide account locally; credentials stay connected" })).toHaveCount(0);
  await expect(visibility.getByRole("button", { name: "Restore account to everyday lists" })).toHaveCount(0);
});

gate("keeps a negative nested weekly percentage UNPROVEN without Hide or Restore controls", async ({ panel }) => {
  await panel.page.route("**/api/limits?runtime=hermes&scope=default", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "account-center.limits.v1",
        generatedAt: new Date().toISOString(),
        accounts: [{
          accountRef: "account-1",
          provider: "openai",
          health: "ok",
          authState: "active",
          readable: true,
          windows: [{ name: "weekly", remainingPct: -1, resetsAt: "2026-08-10T00:00:00.000Z" }]
        }]
      })
    });
  });
  await open(panel);
  await connect(panel);
  await panel.page.getByRole("tab", { name: "Accounts" }).click();
  const visibility = accountsPanel(panel).locator("#account-visibility-state");
  await expect(visibility).toContainText("Account visibility could not be verified");
  await expect(visibility).not.toContainText(/account-[1-9][0-9]* · (Active|Saved|Hidden)/);
  await expect(visibility.getByRole("button", { name: "Hide account locally; credentials stay connected" })).toHaveCount(0);
  await expect(visibility.getByRole("button", { name: "Restore account to everyday lists" })).toHaveCount(0);
});

gate("keeps a weekly window with an unrecognized property UNPROVEN without Hide or Restore controls", async ({ panel }) => {
  await panel.page.route("**/api/limits?runtime=hermes&scope=default", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "account-center.limits.v1",
        generatedAt: new Date().toISOString(),
        accounts: [{
          accountRef: "account-1",
          provider: "openai",
          health: "ok",
          authState: "active",
          readable: true,
          windows: [{ name: "weekly", remainingPct: 75, resetsAt: "2026-08-10T00:00:00.000Z", unrecognized: true }]
        }]
      })
    });
  });
  await open(panel);
  await connect(panel);
  await panel.page.getByRole("tab", { name: "Accounts" }).click();
  const visibility = accountsPanel(panel).locator("#account-visibility-state");
  await expect(visibility).toContainText("Account visibility could not be verified");
  await expect(visibility).not.toContainText(/account-[1-9][0-9]* · (Active|Saved|Hidden)/);
  await expect(visibility.getByRole("button", { name: "Hide account locally; credentials stay connected" })).toHaveCount(0);
  await expect(visibility.getByRole("button", { name: "Restore account to everyday lists" })).toHaveCount(0);
});

gate("keeps otherwise valid accounts with duplicate weekly window names UNPROVEN without Hide or Restore controls", async ({ panel }) => {
  await panel.page.route("**/api/limits?runtime=hermes&scope=default", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "account-center.limits.v1",
        generatedAt: new Date().toISOString(),
        accounts: [{
          accountRef: "account-1",
          provider: "openai",
          health: "ok",
          authState: "active",
          readable: true,
          windows: [
            { name: "weekly", remainingPct: 75, resetsAt: "2026-08-10T00:00:00.000Z" },
            { name: "weekly", remainingPct: 50, resetsAt: "2026-08-11T00:00:00.000Z" }
          ]
        }]
      })
    });
  });
  await open(panel);
  await connect(panel);
  await panel.page.getByRole("tab", { name: "Accounts" }).click();
  const visibility = accountsPanel(panel).locator("#account-visibility-state");
  await expect(visibility).toContainText("Account visibility could not be verified");
  await expect(visibility).not.toContainText(/account-[1-9][0-9]* · (Active|Saved|Hidden)/);
  await expect(visibility.getByRole("button", { name: "Hide account locally; credentials stay connected" })).toHaveCount(0);
  await expect(visibility.getByRole("button", { name: "Restore account to everyday lists" })).toHaveCount(0);
});

gate("keeps otherwise valid accounts with duplicate weekly window reset timestamps UNPROVEN without Hide or Restore controls", async ({ panel }) => {
  await panel.page.route("**/api/limits?runtime=hermes&scope=default", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "account-center.limits.v1",
        generatedAt: new Date().toISOString(),
        accounts: [{
          accountRef: "account-1",
          provider: "openai",
          health: "ok",
          authState: "active",
          readable: true,
          windows: [
            { name: "weekly", remainingPct: 75, resetsAt: "2026-08-10T00:00:00.000Z" },
            { name: "monthly", remainingPct: 50, resetsAt: "2026-08-10T00:00:00.000Z" }
          ]
        }]
      })
    });
  });
  await open(panel);
  await connect(panel);
  await panel.page.getByRole("tab", { name: "Accounts" }).click();
  const visibility = accountsPanel(panel).locator("#account-visibility-state");
  await expect(visibility).toContainText("Account visibility could not be verified");
  await expect(visibility).not.toContainText(/account-[1-9][0-9]* · (Active|Saved|Hidden)/);
  await expect(visibility.getByRole("button", { name: "Hide account locally; credentials stay connected" })).toHaveCount(0);
  await expect(visibility.getByRole("button", { name: "Restore account to everyday lists" })).toHaveCount(0);
});

gate("keeps a non-canonical weekly window reset timestamp UNPROVEN without Hide or Restore controls", async ({ panel }) => {
  await panel.page.route("**/api/limits?runtime=hermes&scope=default", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "account-center.limits.v1",
        generatedAt: new Date().toISOString(),
        accounts: [{
          accountRef: "account-1",
          provider: "openai",
          health: "ok",
          authState: "active",
          readable: true,
          windows: [{ name: "weekly", remainingPct: 75, resetsAt: "2026-08-10T00:00:00Z" }]
        }]
      })
    });
  });
  await open(panel);
  await connect(panel);
  await panel.page.getByRole("tab", { name: "Accounts" }).click();
  const visibility = accountsPanel(panel).locator("#account-visibility-state");
  await expect(visibility).toContainText("Account visibility could not be verified");
  await expect(visibility).not.toContainText(/account-[1-9][0-9]* · (Active|Saved|Hidden)/);
  await expect(visibility.getByRole("button", { name: "Hide account locally; credentials stay connected" })).toHaveCount(0);
  await expect(visibility.getByRole("button", { name: "Restore account to everyday lists" })).toHaveCount(0);
});

gate("keeps a non-canonical selected-scope generated-at timestamp UNPROVEN without Hide or Restore controls", async ({ panel }) => {
  await panel.page.route("**/api/limits?runtime=hermes&scope=default", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "account-center.limits.v1",
        generatedAt: "2026-08-10T00:00:00Z",
        accounts: [{
          accountRef: "account-1",
          provider: "openai",
          health: "ok",
          authState: "active",
          readable: true,
          windows: []
        }]
      })
    });
  });
  await open(panel);
  await connect(panel);
  await panel.page.getByRole("tab", { name: "Accounts" }).click();
  const visibility = accountsPanel(panel).locator("#account-visibility-state");
  await expect(visibility).toContainText("Account visibility could not be verified");
  await expect(visibility).not.toContainText(/account-[1-9][0-9]* · (Active|Saved|Hidden)/);
  await expect(visibility.getByRole("button", { name: "Hide account locally; credentials stay connected" })).toHaveCount(0);
  await expect(visibility.getByRole("button", { name: "Restore account to everyday lists" })).toHaveCount(0);
});

gate("keeps an account with an unrecognized property UNPROVEN without Hide or Restore controls", async ({ panel }) => {
  await panel.page.route("**/api/limits?runtime=hermes&scope=default", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "account-center.limits.v1",
        generatedAt: new Date().toISOString(),
        accounts: [{
          accountRef: "account-1",
          provider: "openai",
          health: "ok",
          authState: "active",
          readable: true,
          windows: [],
          unrecognized: true
        }]
      })
    });
  });
  await open(panel);
  await connect(panel);
  await panel.page.getByRole("tab", { name: "Accounts" }).click();
  const visibility = accountsPanel(panel).locator("#account-visibility-state");
  await expect(visibility).toContainText("Account visibility could not be verified");
  await expect(visibility).not.toContainText(/account-[1-9][0-9]* · (Active|Saved|Hidden)/);
  await expect(visibility.getByRole("button", { name: "Hide account locally; credentials stay connected" })).toHaveCount(0);
  await expect(visibility.getByRole("button", { name: "Restore account to everyday lists" })).toHaveCount(0);
});

gate("keeps a limits response with an unrecognized root property UNPROVEN without Hide or Restore controls", async ({ panel }) => {
  await panel.page.route("**/api/limits?runtime=hermes&scope=default", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "account-center.limits.v1",
        generatedAt: new Date().toISOString(),
        accounts: [{
          accountRef: "account-1",
          provider: "openai",
          health: "ok",
          authState: "active",
          readable: true,
          windows: []
        }],
        unrecognized: true
      })
    });
  });
  await open(panel);
  await connect(panel);
  await panel.page.getByRole("tab", { name: "Accounts" }).click();
  const visibility = accountsPanel(panel).locator("#account-visibility-state");
  await expect(visibility).toContainText("Account visibility could not be verified");
  await expect(visibility).not.toContainText(/account-[1-9][0-9]* · (Active|Saved|Hidden)/);
  await expect(visibility.getByRole("button", { name: "Hide account locally; credentials stay connected" })).toHaveCount(0);
  await expect(visibility.getByRole("button", { name: "Restore account to everyday lists" })).toHaveCount(0);
});

gate("keeps unavailable local visibility preferences UNPROVEN without Restore guidance", async ({ panel }) => {
  await panel.page.route("**/api/account-ui-preferences**", async (route) => {
    if (route.request().method() === "GET") await route.abort("failed");
    else await route.continue();
  });
  await open(panel);
  await connect(panel);
  const home = homePanel(panel);
  await expect(home.locator("#account-count")).toHaveText("UNPROVEN");
  await expect(home.locator("#accounts")).toContainText("Visible accounts could not be verified");
  await expect(home.locator("#accounts")).not.toContainText(/Restore an account/i);
  await expect(home.getByRole("button", { name: "Restore account to everyday lists" })).toHaveCount(0);
});

gate("keeps malformed local visibility preferences UNPROVEN without Restore guidance", async ({ panel }) => {
  await panel.page.route("**/api/account-ui-preferences**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ schemaVersion: "account-center.account-ui-preferences.v1", hiddenAccountRefs: "not-an-account-list" }) });
    } else {
      await route.continue();
    }
  });
  const preferencesRequest = panel.page.waitForRequest((request) =>
    new URL(request.url()).pathname === "/api/account-ui-preferences" && request.method() === "GET"
  );
  await open(panel);
  await connect(panel);
  await preferencesRequest;
  const home = homePanel(panel);
  await expect(home.locator("#account-count")).toHaveText("UNPROVEN");
  await expect(home.locator("#accounts")).toContainText("Visible accounts could not be verified");
  await expect(home.locator("#accounts")).not.toContainText("0 accounts");
  await expect(home.locator("#accounts")).not.toContainText(/Restore an account/i);
  await expect(home.getByRole("button", { name: "Restore account to everyday lists" })).toHaveCount(0);
  await panel.page.getByRole("tab", { name: "Accounts" }).click();
  const visibility = accountsPanel(panel).locator("#account-visibility-state");
  await expect(visibility).toContainText("Account visibility could not be verified");
  await expect(visibility).not.toContainText(/account-[1-9][0-9]* · (Active|Saved|Hidden)/);
  await expect(visibility.locator(".record:not(.state)")).toHaveCount(0);
  await expect(visibility.getByRole("button", { name: "Hide account locally; credentials stay connected" })).toHaveCount(0);
  await expect(visibility.getByRole("button", { name: "Restore account to everyday lists" })).toHaveCount(0);
});

gate("keeps otherwise valid local visibility preferences with an unrecognized root property UNPROVEN", async ({ panel }) => {
  await panel.page.route("**/api/account-ui-preferences**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          schemaVersion: "account-center.account-ui-preferences.v1",
          hiddenAccountRefs: [],
          unrecognized: true
        })
      });
    } else {
      await route.continue();
    }
  });
  await open(panel);
  await connect(panel);
  const home = homePanel(panel);
  await expect(home.locator("#account-count")).toHaveText("UNPROVEN");
  await expect(home.locator("#accounts")).toContainText("Visible accounts could not be verified");
  await expect(home.locator("#accounts")).not.toContainText(/Restore an account/i);
  await expect(home.getByRole("button", { name: "Restore account to everyday lists" })).toHaveCount(0);
  await panel.page.getByRole("tab", { name: "Accounts" }).click();
  const visibility = accountsPanel(panel).locator("#account-visibility-state");
  await expect(visibility).toContainText("Account visibility could not be verified");
  await expect(visibility).not.toContainText(/account-[1-9][0-9]* · (Active|Saved|Hidden)/);
  await expect(visibility.locator(".record:not(.state)")).toHaveCount(0);
  await expect(visibility.getByRole("button", { name: "Hide account locally; credentials stay connected" })).toHaveCount(0);
  await expect(visibility.getByRole("button", { name: "Restore account to everyday lists" })).toHaveCount(0);
});

gate("confirms guided-auth cancellation and restores focus when cancellation is dismissed", async ({ panel }) => {
  await open(panel);
  await connect(panel);
  await openMore(panel);
  const trigger = panel.page.getByRole("button", { name: "Cancel pending challenge" });
  await trigger.click();
  const dialog = panel.page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(panel.page.getByRole("heading", { name: /Cancel guided-auth challenge/i })).toBeFocused();
  await panel.page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  const cancelRequest = panel.page.waitForRequest((request) => request.method() === "POST" && /\/api\/auth-challenges\/auth_[a-f0-9-]{36}\/cancel\?runtime=hermes&scope=default$/.test(request.url()));
  await panel.page.getByRole("button", { name: "Cancel local challenge" }).click();
  await cancelRequest;
  await expect(dialog).toBeHidden();
  await expect(panel.page.locator("#notice")).toContainText(/challenge cancelled/i);
  await expect(morePanel(panel)).toContainText(/cancelled/i);
});

gate("fails closed on ambiguous or incomplete guided-auth cancellation capability declarations", async ({ panel }) => {
  let alterCapabilities;
  const cancellationPosts = [];
  panel.page.on("request", (request) => {
    if (request.method() === "POST" && /\/api\/auth-challenges\/auth_[a-f0-9-]{36}\/cancel$/.test(new URL(request.url()).pathname)) cancellationPosts.push(request.url());
  });
  await panel.page.route("**/api/capabilities", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (alterCapabilities) alterCapabilities(body);
    await route.fulfill({ response, json: body });
  });
  const cancellation = (body) => body.actions.find((action) => action.id === "auth_challenges.cancel");
  const cases = [
    ["missing", (body) => { body.actions = body.actions.filter((action) => action.id !== "auth_challenges.cancel"); }],
    ["duplicate", (body) => { body.actions.push({ ...cancellation(body) }); }],
    ["conflicting duplicate", (body) => { body.actions.push({ ...cancellation(body), endpoint: { ...cancellation(body).endpoint, path: "/api/wrong" } }); }],
    ["extra key", (body) => { cancellation(body).unexpected = true; }],
    ["wrong method", (body) => { cancellation(body).endpoint.method = "GET"; }],
    ["wrong endpoint", (body) => { cancellation(body).endpoint.path = "/api/auth-challenges/:id"; }],
    ["wrong requirements", (body) => { cancellation(body).requires = [...cancellation(body).requires].reverse(); }],
    ["incomplete requirements", (body) => { cancellation(body).requires = ["bearer_token"]; }],
    ["blocked", (body) => { cancellation(body).state = "blocked"; cancellation(body).reason = "unavailable"; }]
  ];
  for (const [label, alter] of cases) {
    alterCapabilities = alter;
    await open(panel);
    await connect(panel);
    await openMore(panel);
    const guided = morePanel(panel);
    await expect(guided, label).toContainText("Cancellation is UNPROVEN: protected capability discovery is unavailable.");
    await expect(guided.getByRole("button", { name: "Cancel pending challenge" }), label).toHaveCount(0);
  }
  expect(cancellationPosts).toEqual([]);
});

gate("renders malformed guided-auth inventory evidence as UNPROVEN instead of current lifecycle state", async ({ panel }) => {
  await panel.page.route("**/api/auth-challenges?runtime=hermes&scope=default", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "account-center.auth-challenges.v1",
        generatedAt: new Date().toISOString(),
        challenges: [{
          id: "auth_00000000-0000-4000-8000-000000000000",
          mode: "reauth",
          provider: "openai",
          runtime: "hermes",
          scope: "default",
          status: "invented_success_state",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }]
      })
    });
  });
  await open(panel);
  await connect(panel);
  await openMore(panel);
  const guided = morePanel(panel);
  await expect(guided).toContainText("UNPROVEN — data unavailable");
  await expect(guided).not.toContainText("invented_success_state");
});

gate("keeps a non-canonical guided-auth inventory timestamp UNPROVEN without exposing challenges", async ({ panel }) => {
  await panel.page.route("**/api/auth-challenges?runtime=hermes&scope=default", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "account-center.auth-challenges.v1",
        generatedAt: "2026-08-10T00:00:00Z",
        challenges: [{
          id: "auth_00000000-0000-4000-8000-000000000000",
          mode: "reauth",
          provider: "openai",
          runtime: "hermes",
          scope: "default",
          status: "pending",
          createdAt: "2026-08-10T00:00:00.000Z",
          updatedAt: "2026-08-10T00:00:00.000Z"
        }]
      })
    });
  });
  await open(panel);
  await connect(panel);
  await openMore(panel);
  const guided = morePanel(panel);
  await expect(guided).toContainText("UNPROVEN — data unavailable");
  await expect(guided).not.toContainText("reauth · openai");
});

gate("rejects a malformed runtime scope catalog before it can select an invented context", async ({ panel }) => {
  await panel.page.route("**/api/scopes", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "account-center.runtime-scopes.v1",
        generatedAt: new Date().toISOString(),
        scopes: [{
          runtime: "invented-runtime",
          scope: { kind: "default", id: "default" },
          capabilities: { readStatus: true, mutateRoutes: false, startReauth: false, mutateModels: false }
        }]
      })
    });
  });
  await open(panel);
  await connect(panel);
  const selector = panel.page.locator("#context-selector");
  await expect(selector).toContainText("UNPROVEN");
  await expect(selector).toContainText("could not be verified");
  await expect(selector).not.toContainText("invented-runtime");
});

gate("keeps a non-canonical runtime scope catalog timestamp UNPROVEN without selecting a context", async ({ panel }) => {
  await panel.page.route("**/api/scopes", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "account-center.runtime-scopes.v1",
        generatedAt: "2026-08-10T00:00:00Z",
        scopes: [{
          runtime: "hermes",
          scope: { kind: "default", id: "default" },
          capabilities: { readStatus: true, mutateRoutes: false, startReauth: false, mutateModels: false }
        }]
      })
    });
  });
  await open(panel);
  await connect(panel);
  const selector = panel.page.locator("#context-selector");
  await expect(selector).toContainText("UNPROVEN");
  await expect(selector).toContainText("could not be verified");
  await expect(selector).not.toContainText("hermes / default");
});

gate("keeps a non-canonical agent-connection inventory timestamp UNPROVEN without exposing connections", async ({ panel }) => {
  await panel.page.route("**/api/agent-connections", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "account-center.agent-connections.v1",
        generatedAt: "2026-08-10T00:00:00Z",
        inventory: [{
          connectionRef: "connection-1",
          runtime: "hermes",
          scope: "default",
          state: "connected",
          onboarding: { action: "connect-local-adapter", command: "connect locally" },
          accounts: []
        }]
      })
    });
  });
  await open(panel);
  await connect(panel);
  const connections = panel.page.locator("#agent-connection-state");
  await expect(connections).toContainText("Agent connection inventory unavailable");
  await expect(connections).toContainText("could not be verified");
  await expect(connections).not.toContainText("hermes / default");
});

gate("fails closed when an otherwise valid agent-connection record includes an unexpected property", async ({ panel }) => {
  await panel.page.route("**/api/agent-connections", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "account-center.agent-connections.v1",
        generatedAt: "2026-08-10T00:00:00.000Z",
        inventory: [{
          connectionRef: "connection-4e2ad5d32de1db5932cf9708",
          runtime: "hermes",
          state: "connected",
          onboarding: { action: "connect-local-adapter" },
          accounts: [],
          unexpected: true
        }]
      })
    });
  });
  await open(panel);
  await connect(panel);
  const connections = panel.page.locator("#agent-connection-state");
  await expect(connections).toContainText("Agent connection inventory unavailable");
  await expect(connections).toContainText("could not be verified");
  await expect(connections).not.toContainText("hermes · connected");
});

gate("keeps a malformed scoped account lease UNPROVEN instead of claiming it verified", async ({ panel }) => {
  await panel.page.route("**/api/agent-connections", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "account-center.agent-connections.v1",
        generatedAt: "2026-08-10T00:00:00.000Z",
        inventory: [{
          connectionRef: "connection-4e2ad5d32de1db5932cf9708",
          runtime: "hermes",
          state: "connected",
          onboarding: { action: "connect-local-adapter" },
          accounts: [{
            accountRef: "account-1",
            state: "usable",
            pairing: "paired-verified",
            weeklyRemainingPct: 68,
            routeState: "selected",
            lease: {
              schemaVersion: "account-center.scoped-account-lease.v1",
              leaseRef: "lease-connection-4e2ad5d32de1db5932cf9708-account-1",
              connectionRef: "connection-4e2ad5d32de1db5932cf9708",
              accountRef: "account-1",
              runtime: "openclaw",
              state: "verified"
            }
          }]
        }]
      })
    });
  });
  await open(panel);
  await connect(panel);
  const connections = panel.page.locator("#agent-connection-state");
  await expect(connections).toContainText("Agent connection inventory unavailable");
  await expect(connections).not.toContainText("scoped lease verified");
});

gate("renders the verified label only for a fully matching scoped account lease", async ({ panel }) => {
  await panel.page.route("**/api/agent-connections", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "account-center.agent-connections.v1",
        generatedAt: "2026-08-10T00:00:00.000Z",
        inventory: [{
          connectionRef: "connection-4e2ad5d32de1db5932cf9708",
          runtime: "hermes",
          state: "connected",
          onboarding: { action: "connect-local-adapter" },
          accounts: [{
            accountRef: "account-1",
            state: "usable",
            pairing: "paired-verified",
            weeklyRemainingPct: 68,
            routeState: "selected",
            lease: {
              schemaVersion: "account-center.scoped-account-lease.v1",
              leaseRef: "lease-connection-4e2ad5d32de1db5932cf9708-account-1",
              connectionRef: "connection-4e2ad5d32de1db5932cf9708",
              accountRef: "account-1",
              runtime: "hermes",
              state: "verified"
            }
          }]
        }]
      })
    });
  });
  await open(panel);
  await connect(panel);
  const connections = panel.page.locator("#agent-connection-state");
  await expect(connections).toContainText("scoped lease verified");
  await expect(connections).not.toContainText("Agent connection inventory unavailable");
});

gate("fails closed when a scoped account lease includes an unexpected property", async ({ panel }) => {
  await panel.page.route("**/api/agent-connections", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "account-center.agent-connections.v1",
        generatedAt: "2026-08-10T00:00:00.000Z",
        inventory: [{
          connectionRef: "connection-4e2ad5d32de1db5932cf9708",
          runtime: "hermes",
          state: "connected",
          onboarding: { action: "connect-local-adapter" },
          accounts: [{
            accountRef: "account-1",
            state: "usable",
            pairing: "paired-verified",
            weeklyRemainingPct: 68,
            routeState: "selected",
            lease: {
              schemaVersion: "account-center.scoped-account-lease.v1",
              leaseRef: "lease-connection-4e2ad5d32de1db5932cf9708-account-1",
              connectionRef: "connection-4e2ad5d32de1db5932cf9708",
              accountRef: "account-1",
              runtime: "hermes",
              state: "verified",
              unexpected: true
            }
          }]
        }]
      })
    });
  });
  await open(panel);
  await connect(panel);
  const connections = panel.page.locator("#agent-connection-state");
  await expect(connections).toContainText("Agent connection inventory unavailable");
  await expect(connections).not.toContainText("scoped lease verified");
});

gate("renders malformed protected-operation history as UNPROVEN instead of a claimed outcome", async ({ panel }) => {
  await panel.page.route("**/api/mutation-operations?runtime=hermes&scopeKind=default", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "account-center.mutation-operations.v1",
        generatedAt: new Date().toISOString(),
        operations: [{
          operationId: "op_malformed",
          state: "completed",
          outcome: "invented_success_state",
          createdAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          audit: {
            action: "route.use",
            provider: "openai",
            runtime: "hermes",
            scopeKind: "default",
            warningCodes: []
          }
        }]
      })
    });
  });
  await open(panel);
  await connect(panel);
  await openMore(panel);
  const audit = morePanel(panel);
  await expect(audit).toContainText("UNPROVEN — data unavailable");
  await expect(audit).not.toContainText("invented_success_state");
});

gate("keeps a non-canonical protected-operation timestamp UNPROVEN without exposing operation records", async ({ panel }) => {
  await panel.page.route("**/api/mutation-operations?runtime=hermes&scopeKind=default", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "account-center.mutation-operations.v1",
        generatedAt: "2026-08-05T07:00:00Z",
        operations: [{
          operationId: "op_timestamp_must_not_be_exposed",
          state: "completed",
          outcome: "applied",
          createdAt: "2026-08-05T07:00:00.000Z",
          completedAt: "2026-08-05T07:01:00.000Z",
          audit: {
            action: "route.use",
            provider: "openai",
            runtime: "hermes",
            scopeKind: "default",
            warningCodes: []
          }
        }]
      })
    });
  });
  await open(panel);
  await connect(panel);
  await openMore(panel);
  const audit = morePanel(panel);
  await expect(audit).toContainText("UNPROVEN — data unavailable");
  await expect(audit).not.toContainText("op_timestamp_must_not_be_exposed");
});

gate("keeps a protected operation with a non-canonical created-at timestamp UNPROVEN without exposing operation records", async ({ panel }) => {
  await panel.page.route("**/api/mutation-operations?runtime=hermes&scopeKind=default", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "account-center.mutation-operations.v1",
        generatedAt: "2026-08-05T07:00:00.000Z",
        operations: [{
          operationId: "op_noncanonical_created_at_must_not_be_exposed",
          state: "completed",
          outcome: "applied",
          createdAt: "2026-08-05T07:00:00Z",
          completedAt: "2026-08-05T07:01:00.000Z",
          audit: {
            action: "route.use",
            provider: "openai",
            runtime: "hermes",
            scopeKind: "default",
            warningCodes: []
          }
        }]
      })
    });
  });
  await open(panel);
  await connect(panel);
  await openMore(panel);
  const audit = morePanel(panel);
  await expect(audit).toContainText("UNPROVEN — data unavailable");
  await expect(audit).not.toContainText("op_noncanonical_created_at_must_not_be_exposed");
});

gate("keeps a completed protected operation with a non-canonical completed-at timestamp UNPROVEN without exposing operation records", async ({ panel }) => {
  await panel.page.route("**/api/mutation-operations?runtime=hermes&scopeKind=default", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "account-center.mutation-operations.v1",
        generatedAt: "2026-08-05T07:00:00.000Z",
        operations: [{
          operationId: "op_noncanonical_completed_at_must_not_be_exposed",
          state: "completed",
          outcome: "applied",
          createdAt: "2026-08-05T07:00:00.000Z",
          completedAt: "2026-08-05T07:01:00Z",
          audit: {
            action: "route.use",
            provider: "openai",
            runtime: "hermes",
            scopeKind: "default",
            warningCodes: []
          }
        }]
      })
    });
  });
  await open(panel);
  await connect(panel);
  await openMore(panel);
  const audit = morePanel(panel);
  await expect(audit).toContainText("UNPROVEN — data unavailable");
  await expect(audit).not.toContainText("op_noncanonical_completed_at_must_not_be_exposed");
});

gate("keeps a pending protected operation with a non-canonical created-at timestamp UNPROVEN without exposing operation records", async ({ panel }) => {
  await panel.page.route("**/api/mutation-operations?runtime=hermes&scopeKind=default", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "account-center.mutation-operations.v1",
        generatedAt: "2026-08-05T07:00:00.000Z",
        operations: [{
          operationId: "op_pending_noncanonical_created_at_must_not_be_exposed",
          state: "pending",
          createdAt: "2026-08-05T07:00:00Z",
          audit: {
            action: "route.use",
            provider: "openai",
            runtime: "hermes",
            scopeKind: "default",
            warningCodes: []
          }
        }]
      })
    });
  });
  await open(panel);
  await connect(panel);
  await openMore(panel);
  const audit = morePanel(panel);
  await expect(audit).toContainText("UNPROVEN — data unavailable");
  await expect(audit).not.toContainText("op_pending_noncanonical_created_at_must_not_be_exposed");
});

gate("keeps a pending protected operation with a forged outcome UNPROVEN without exposing operation records", async ({ panel }) => {
  await panel.page.route("**/api/mutation-operations?runtime=hermes&scopeKind=default", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "account-center.mutation-operations.v1",
        generatedAt: "2026-08-05T07:00:00.000Z",
        operations: [{
          operationId: "op_pending_forged_outcome_must_not_be_exposed",
          state: "pending",
          outcome: "applied",
          createdAt: "2026-08-05T07:00:00.000Z",
          audit: {
            action: "route.use",
            provider: "openai",
            runtime: "hermes",
            scopeKind: "default",
            warningCodes: []
          }
        }]
      })
    });
  });
  await open(panel);
  await connect(panel);
  await openMore(panel);
  const audit = morePanel(panel);
  await expect(audit).toContainText("UNPROVEN — data unavailable");
  await expect(audit).not.toContainText("op_pending_forged_outcome_must_not_be_exposed");
});

gate("keeps a pending protected operation with a forged completed-at timestamp UNPROVEN without exposing operation records", async ({ panel }) => {
  await panel.page.route("**/api/mutation-operations?runtime=hermes&scopeKind=default", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "account-center.mutation-operations.v1",
        generatedAt: "2026-08-05T07:00:00.000Z",
        operations: [{
          operationId: "op_pending_forged_completed_at_must_not_be_exposed",
          state: "pending",
          createdAt: "2026-08-05T07:00:00.000Z",
          completedAt: "2026-08-05T07:01:00.000Z",
          audit: {
            action: "route.use",
            provider: "openai",
            runtime: "hermes",
            scopeKind: "default",
            warningCodes: []
          }
        }]
      })
    });
  });
  await open(panel);
  await connect(panel);
  await openMore(panel);
  const audit = morePanel(panel);
  await expect(audit).toContainText("UNPROVEN — data unavailable");
  await expect(audit).not.toContainText("op_pending_forged_completed_at_must_not_be_exposed");
});

gate("keeps a pending protected operation with a forged warning code UNPROVEN without exposing operation records", async ({ panel }) => {
  await panel.page.route("**/api/mutation-operations?runtime=hermes&scopeKind=default", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "account-center.mutation-operations.v1",
        generatedAt: "2026-08-05T07:00:00.000Z",
        operations: [{
          operationId: "op_pending_forged_warning_code_must_not_be_exposed",
          state: "pending",
          createdAt: "2026-08-05T07:00:00.000Z",
          audit: {
            action: "route.use",
            provider: "openai",
            runtime: "hermes",
            scopeKind: "default",
            warningCodes: ["route-applied"]
          }
        }]
      })
    });
  });
  await open(panel);
  await connect(panel);
  await openMore(panel);
  const audit = morePanel(panel);
  await expect(audit).toContainText("UNPROVEN — data unavailable");
  await expect(audit).not.toContainText("op_pending_forged_warning_code_must_not_be_exposed");
});

gate("keeps a pending protected operation with an unrecognized audit property UNPROVEN without exposing operation records", async ({ panel }) => {
  await panel.page.route("**/api/mutation-operations?runtime=hermes&scopeKind=default", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "account-center.mutation-operations.v1",
        generatedAt: "2026-08-05T07:00:00.000Z",
        operations: [{
          operationId: "op_pending_unrecognized_audit_property_must_not_be_exposed",
          state: "pending",
          createdAt: "2026-08-05T07:00:00.000Z",
          audit: {
            action: "route.use",
            provider: "openai",
            runtime: "hermes",
            scopeKind: "default",
            warningCodes: [],
            unrecognized: true
          }
        }]
      })
    });
  });
  await open(panel);
  await connect(panel);
  await openMore(panel);
  const audit = morePanel(panel);
  await expect(audit).toContainText("UNPROVEN — data unavailable");
  await expect(audit).not.toContainText("op_pending_unrecognized_audit_property_must_not_be_exposed");
});

gate("keeps a completed protected operation with an unrecognized audit property UNPROVEN without exposing operation records", async ({ panel }) => {
  await panel.page.route("**/api/mutation-operations?runtime=hermes&scopeKind=default", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "account-center.mutation-operations.v1",
        generatedAt: "2026-08-05T07:00:00.000Z",
        operations: [{
          operationId: "op_completed_unrecognized_audit_property_must_not_be_exposed",
          state: "completed",
          outcome: "applied",
          createdAt: "2026-08-05T07:00:00.000Z",
          completedAt: "2026-08-05T07:01:00.000Z",
          audit: {
            action: "route.use",
            provider: "openai",
            runtime: "hermes",
            scopeKind: "default",
            warningCodes: [],
            unrecognized: true
          }
        }]
      })
    });
  });
  await open(panel);
  await connect(panel);
  await openMore(panel);
  const audit = morePanel(panel);
  await expect(audit).toContainText("UNPROVEN — data unavailable");
  await expect(audit).not.toContainText("op_completed_unrecognized_audit_property_must_not_be_exposed");
});

gate("keeps a completed protected operation with an unrecognized top-level property UNPROVEN without exposing operation records", async ({ panel }) => {
  await panel.page.route("**/api/mutation-operations?runtime=hermes&scopeKind=default", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "account-center.mutation-operations.v1",
        generatedAt: "2026-08-05T07:00:00.000Z",
        operations: [{
          operationId: "op_completed_unrecognized_top_level_property_must_not_be_exposed",
          state: "completed",
          outcome: "applied",
          createdAt: "2026-08-05T07:00:00.000Z",
          completedAt: "2026-08-05T07:01:00.000Z",
          audit: {
            action: "route.use",
            provider: "openai",
            runtime: "hermes",
            scopeKind: "default",
            warningCodes: []
          },
          unrecognized: true
        }]
      })
    });
  });
  await open(panel);
  await connect(panel);
  await openMore(panel);
  const audit = morePanel(panel);
  await expect(audit).toContainText("UNPROVEN — data unavailable");
  await expect(audit).not.toContainText("op_completed_unrecognized_top_level_property_must_not_be_exposed");
});

gate("keeps a pending protected operation with an unrecognized top-level property UNPROVEN without exposing operation records", async ({ panel }) => {
  await panel.page.route("**/api/mutation-operations?runtime=hermes&scopeKind=default", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "account-center.mutation-operations.v1",
        generatedAt: "2026-08-05T07:00:00.000Z",
        operations: [{
          operationId: "op_pending_unrecognized_top_level_property_must_not_be_exposed",
          state: "pending",
          createdAt: "2026-08-05T07:00:00.000Z",
          audit: {
            action: "route.use",
            provider: "openai",
            runtime: "hermes",
            scopeKind: "default",
            warningCodes: []
          },
          unrecognized: true
        }]
      })
    });
  });
  await open(panel);
  await connect(panel);
  await openMore(panel);
  const audit = morePanel(panel);
  await expect(audit).toContainText("UNPROVEN — data unavailable");
  await expect(audit).not.toContainText("op_pending_unrecognized_top_level_property_must_not_be_exposed");
});

gate("keeps a protected-operation history response with an unrecognized root property UNPROVEN without exposing operation records", async ({ panel }) => {
  await panel.page.route("**/api/mutation-operations?runtime=hermes&scopeKind=default", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "account-center.mutation-operations.v1",
        generatedAt: "2026-08-05T07:00:00.000Z",
        operations: [{
          operationId: "op_history_unrecognized_root_property_must_not_be_exposed",
          state: "completed",
          outcome: "applied",
          createdAt: "2026-08-05T07:00:00.000Z",
          completedAt: "2026-08-05T07:01:00.000Z",
          audit: {
            action: "route.use",
            provider: "openai",
            runtime: "hermes",
            scopeKind: "default",
            warningCodes: []
          }
        }],
        unrecognized: true
      })
    });
  });
  await open(panel);
  await connect(panel);
  await openMore(panel);
  const audit = morePanel(panel);
  await expect(audit).toContainText("UNPROVEN — data unavailable");
  await expect(audit).not.toContainText("op_history_unrecognized_root_property_must_not_be_exposed");
});

gate("keeps a protected-operation history response with a malformed next cursor UNPROVEN without exposing operation records", async ({ panel }) => {
  await panel.page.route("**/api/mutation-operations?runtime=hermes&scopeKind=default", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "account-center.mutation-operations.v1",
        generatedAt: "2026-08-05T07:00:00.000Z",
        operations: [{
          operationId: "op_history_malformed_next_cursor_must_not_be_exposed",
          state: "completed",
          outcome: "applied",
          createdAt: "2026-08-05T07:00:00.000Z",
          completedAt: "2026-08-05T07:01:00.000Z",
          audit: {
            action: "route.use",
            provider: "openai",
            runtime: "hermes",
            scopeKind: "default",
            warningCodes: []
          }
        }],
        nextCursor: "malformed_cursor"
      })
    });
  });
  await open(panel);
  await connect(panel);
  await openMore(panel);
  const audit = morePanel(panel);
  await expect(audit).toContainText("UNPROVEN — data unavailable");
  await expect(audit).not.toContainText("op_history_malformed_next_cursor_must_not_be_exposed");
});

gate("keeps a protected-operation history response with an oversized next cursor UNPROVEN without exposing operation records", async ({ panel }) => {
  await panel.page.route("**/api/mutation-operations?runtime=hermes&scopeKind=default", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "account-center.mutation-operations.v1",
        generatedAt: "2026-08-05T07:00:00.000Z",
        operations: [{
          operationId: "op_history_oversized_next_cursor_must_not_be_exposed",
          state: "completed",
          outcome: "applied",
          createdAt: "2026-08-05T07:00:00.000Z",
          completedAt: "2026-08-05T07:01:00.000Z",
          audit: {
            action: "route.use",
            provider: "openai",
            runtime: "hermes",
            scopeKind: "default",
            warningCodes: []
          }
        }],
        nextCursor: `op_${"a".repeat(4_096)}`
      })
    });
  });
  await open(panel);
  await connect(panel);
  await openMore(panel);
  const audit = morePanel(panel);
  await expect(audit).toContainText("UNPROVEN — data unavailable");
  await expect(audit).not.toContainText("op_history_oversized_next_cursor_must_not_be_exposed");
});

gate("accepts an explicit terminal protected-operation cursor", async ({ panel }) => {
  await panel.page.route("**/api/mutation-operations?runtime=hermes&scopeKind=default", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "account-center.mutation-operations.v1",
        generatedAt: "2026-08-05T07:00:00.000Z",
        operations: [{
          operationId: "op_history_null_next_cursor_must_not_be_exposed",
          state: "completed",
          outcome: "applied",
          createdAt: "2026-08-05T07:00:00.000Z",
          completedAt: "2026-08-05T07:01:00.000Z",
          audit: {
            action: "route.use",
            provider: "openai",
            runtime: "hermes",
            scopeKind: "default",
            warningCodes: []
          }
        }],
        nextCursor: null
      })
    });
  });
  await open(panel);
  await connect(panel);
  await openMore(panel);
  const audit = morePanel(panel);
  await expect(audit).toContainText("op_history_null_next_cursor_must_not_be_exposed");
  await expect(audit.getByRole("button", { name: "Load older protected operations" })).toBeHidden();
});

gate("keeps a protected-operation history response without an explicit terminal cursor UNPROVEN without exposing operation records", async ({ panel }) => {
  await panel.page.route("**/api/mutation-operations?runtime=hermes&scopeKind=default", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "account-center.mutation-operations.v1",
        generatedAt: "2026-08-05T07:00:00.000Z",
        operations: [{
          operationId: "op_history_missing_next_cursor_must_not_be_exposed",
          state: "completed",
          outcome: "applied",
          createdAt: "2026-08-05T07:00:00.000Z",
          completedAt: "2026-08-05T07:01:00.000Z",
          audit: {
            action: "route.use",
            provider: "openai",
            runtime: "hermes",
            scopeKind: "default",
            warningCodes: []
          }
        }]
      })
    });
  });
  await open(panel);
  await connect(panel);
  await openMore(panel);
  const audit = morePanel(panel);
  await expect(audit).toContainText("UNPROVEN — data unavailable");
  await expect(audit).not.toContainText("op_history_missing_next_cursor_must_not_be_exposed");
});

gate("keeps a protected-operation history response with an empty next cursor UNPROVEN without exposing operation records", async ({ panel }) => {
  await panel.page.route("**/api/mutation-operations?runtime=hermes&scopeKind=default", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "account-center.mutation-operations.v1",
        generatedAt: "2026-08-05T07:00:00.000Z",
        operations: [{
          operationId: "op_history_empty_next_cursor_must_not_be_exposed",
          state: "completed",
          outcome: "applied",
          createdAt: "2026-08-05T07:00:00.000Z",
          completedAt: "2026-08-05T07:01:00.000Z",
          audit: {
            action: "route.use",
            provider: "openai",
            runtime: "hermes",
            scopeKind: "default",
            warningCodes: []
          }
        }],
        nextCursor: ""
      })
    });
  });
  await open(panel);
  await connect(panel);
  await openMore(panel);
  const audit = morePanel(panel);
  await expect(audit).toContainText("UNPROVEN — data unavailable");
  await expect(audit).not.toContainText("op_history_empty_next_cursor_must_not_be_exposed");
});

gate("keeps a protected-operation history response with a numeric next cursor UNPROVEN without exposing operation records", async ({ panel }) => {
  await panel.page.route("**/api/mutation-operations?runtime=hermes&scopeKind=default", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "account-center.mutation-operations.v1",
        generatedAt: "2026-08-05T07:00:00.000Z",
        operations: [{
          operationId: "op_history_numeric_next_cursor_must_not_be_exposed",
          state: "completed",
          outcome: "applied",
          createdAt: "2026-08-05T07:00:00.000Z",
          completedAt: "2026-08-05T07:01:00.000Z",
          audit: {
            action: "route.use",
            provider: "openai",
            runtime: "hermes",
            scopeKind: "default",
            warningCodes: []
          }
        }],
        nextCursor: 1
      })
    });
  });
  await open(panel);
  await connect(panel);
  await openMore(panel);
  const audit = morePanel(panel);
  await expect(audit).toContainText("UNPROVEN — data unavailable");
  await expect(audit).not.toContainText("op_history_numeric_next_cursor_must_not_be_exposed");
});

gate("keeps a protected-operation history response with a boolean next cursor UNPROVEN without exposing operation records", async ({ panel }) => {
  await panel.page.route("**/api/mutation-operations?runtime=hermes&scopeKind=default", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "account-center.mutation-operations.v1",
        generatedAt: "2026-08-05T07:00:00.000Z",
        operations: [{
          operationId: "op_history_boolean_next_cursor_must_not_be_exposed",
          state: "completed",
          outcome: "applied",
          createdAt: "2026-08-05T07:00:00.000Z",
          completedAt: "2026-08-05T07:01:00.000Z",
          audit: {
            action: "route.use",
            provider: "openai",
            runtime: "hermes",
            scopeKind: "default",
            warningCodes: []
          }
        }],
        nextCursor: true
      })
    });
  });
  await open(panel);
  await connect(panel);
  await openMore(panel);
  const audit = morePanel(panel);
  await expect(audit).toContainText("UNPROVEN — data unavailable");
  await expect(audit).not.toContainText("op_history_boolean_next_cursor_must_not_be_exposed");
});

gate("keeps a protected-operation history response with an array next cursor UNPROVEN without exposing operation records", async ({ panel }) => {
  await panel.page.route("**/api/mutation-operations?runtime=hermes&scopeKind=default", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "account-center.mutation-operations.v1",
        generatedAt: "2026-08-05T07:00:00.000Z",
        operations: [{
          operationId: "op_history_array_next_cursor_must_not_be_exposed",
          state: "completed",
          outcome: "applied",
          createdAt: "2026-08-05T07:00:00.000Z",
          completedAt: "2026-08-05T07:01:00.000Z",
          audit: {
            action: "route.use",
            provider: "openai",
            runtime: "hermes",
            scopeKind: "default",
            warningCodes: []
          }
        }],
        nextCursor: ["op_not_a_cursor"]
      })
    });
  });
  await open(panel);
  await connect(panel);
  await openMore(panel);
  const audit = morePanel(panel);
  await expect(audit).toContainText("UNPROVEN — data unavailable");
  await expect(audit).not.toContainText("op_history_array_next_cursor_must_not_be_exposed");
});

gate("keeps a protected-operation history response with an object next cursor UNPROVEN without exposing operation records", async ({ panel }) => {
  await panel.page.route("**/api/mutation-operations?runtime=hermes&scopeKind=default", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "account-center.mutation-operations.v1",
        generatedAt: "2026-08-05T07:00:00.000Z",
        operations: [{
          operationId: "op_history_object_next_cursor_must_not_be_exposed",
          state: "completed",
          outcome: "applied",
          createdAt: "2026-08-05T07:00:00.000Z",
          completedAt: "2026-08-05T07:01:00.000Z",
          audit: {
            action: "route.use",
            provider: "openai",
            runtime: "hermes",
            scopeKind: "default",
            warningCodes: []
          }
        }],
        nextCursor: { cursor: "op_not_a_cursor" }
      })
    });
  });
  await open(panel);
  await connect(panel);
  await openMore(panel);
  const audit = morePanel(panel);
  await expect(audit).toContainText("UNPROVEN — data unavailable");
  await expect(audit).not.toContainText("op_history_object_next_cursor_must_not_be_exposed");
});

gate("renders malformed audit history as UNPROVEN instead of a claimed outcome", async ({ panel }) => {
  await panel.page.route("**/api/audit?runtime=hermes&scopeKind=default", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "account-center.audit-history.v1",
        generatedAt: new Date().toISOString(),
        records: [{
          id: "audit_00000000-0000-4000-8000-000000000000",
          createdAt: new Date().toISOString(),
          action: "route.use",
          outcome: "invented_success_state",
          proofState: "verified",
          summary: "Invented audit result.",
          warnings: []
        }]
      })
    });
  });
  await open(panel);
  await connect(panel);
  await openMore(panel);
  const audit = morePanel(panel);
  await expect(audit).toContainText("UNPROVEN — data unavailable");
  await expect(audit).not.toContainText("invented_success_state");
});

gate("keeps a non-canonical audit-history timestamp UNPROVEN without exposing audit records", async ({ panel }) => {
  await panel.page.route("**/api/audit?runtime=hermes&scopeKind=default", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "account-center.audit-history.v1",
        generatedAt: "2026-08-05T07:00:00Z",
        records: [{
          id: "audit_00000000-0000-4000-8000-000000000000",
          createdAt: "2026-08-05T07:00:00.000Z",
          action: "route.use",
          outcome: "applied",
          proofState: "verified",
          summary: "Audit record that must not be exposed.",
          warnings: []
        }]
      })
    });
  });
  await open(panel);
  await connect(panel);
  await openMore(panel);
  const audit = morePanel(panel);
  await expect(audit).toContainText("UNPROVEN — data unavailable");
  await expect(audit).not.toContainText("Audit record that must not be exposed.");
});

gate("renders malformed selected-scope limits and model catalogs as UNPROVEN instead of inventory", async ({ panel }) => {
  await panel.page.route("**/api/limits?runtime=hermes&scope=default", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "account-center.limits.v1",
        generatedAt: new Date().toISOString(),
        accounts: [{
          accountRef: "account-9",
          provider: "openai",
          health: "ok",
          authState: "ok",
          readable: true,
          windows: "not-an-inventory-array"
        }]
      })
    });
  });
  await panel.page.route("**/api/models?runtime=hermes&scope=default", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "account-center.models.v1",
        generatedAt: new Date().toISOString(),
        selection: {
          requestedPolicy: { state: "not_reported" },
          effectiveRuntimeModel: { state: "not_reported" },
          fallbackChain: { state: "not_reported" },
          verificationState: "UNPROVEN"
        },
        models: [{
          id: "openai/invented-model",
          selectable: true,
          observedProfileCount: "not-a-number",
          readableProfileCount: 1,
          runtimeCompatibility: ["hermes"],
          verificationState: "UNPROVEN"
        }]
      })
    });
  });
  await open(panel);
  await connect(panel);
  const home = homePanel(panel);
  await expect(home.locator("#account-count")).toHaveText("UNPROVEN");
  await expect(home.locator("#accounts")).toContainText("Visible accounts could not be verified");
  await expect(home.locator("#accounts")).not.toContainText(/Restore an account/i);
  await expect(home.getByRole("button", { name: "Restore account to everyday lists" })).toHaveCount(0);
  await panel.page.getByRole("tab", { name: "Accounts" }).click();
  const accountsRouting = accountsPanel(panel);
  await expect(accountsRouting).toContainText("Selected-scope limit inventory unavailable");
  await expect(accountsRouting).toContainText("UNPROVEN");
  await expect(accountsRouting).not.toContainText("account-9");
  await openMore(panel);
  const models = morePanel(panel);
  await expect(models).toContainText("UNPROVEN — data unavailable");
  await expect(models).not.toContainText("openai/invented-model");
});

gate("keeps a non-canonical selected-scope model generated-at timestamp UNPROVEN without catalog inventory", async ({ panel }) => {
  await panel.page.route("**/api/models?runtime=hermes&scope=default", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        schemaVersion: "account-center.models.v1",
        generatedAt: "2026-08-10T00:00:00Z",
        selection: {
          requestedPolicy: { state: "not_reported" },
          effectiveRuntimeModel: { state: "not_reported" },
          fallbackChain: { state: "not_reported" },
          verificationState: "UNPROVEN"
        },
        models: [{
          id: "openai/non-canonical-model",
          selectable: true,
          observedProfileCount: 1,
          readableProfileCount: 1,
          runtimeCompatibility: ["hermes"],
          verificationState: "UNPROVEN"
        }]
      })
    });
  });
  await open(panel);
  await connect(panel);
  await openMore(panel);
  const models = morePanel(panel);
  await expect(models).toContainText("UNPROVEN — data unavailable");
  await expect(models).not.toContainText("openai/non-canonical-model");
});

gate("loads a redacted protected-operation detail through the bearer-protected API", async ({ panel }) => {
  await open(panel);
  await connect(panel);
  await openMore(panel);
  await openAdvancedDiagnostics(panel);
  const audit = morePanel(panel);
  await audit.getByRole("button", { name: "View protected operation details" }).click();
  const detail = panel.page.getByRole("region", { name: "Protected operation detail" });
  await expect(detail).toContainText("Protected operation detail");
  await expect(detail).toContainText("route.use");
  await expect(detail).toContainText("runtime_unavailable");
  await expect(detail).not.toContainText(/fixture-operation-detail-key|a{64}|b{64}|c{64}/i);
});

gate("clears protected-operation detail when the selected runtime context changes", async ({ panel }) => {
  await open(panel);
  await connect(panel);
  await openMore(panel);
  await openAdvancedDiagnostics(panel);
  const audit = morePanel(panel);
  await audit.getByRole("button", { name: "View protected operation details" }).click();
  const detail = panel.page.getByRole("region", { name: "Protected operation detail" });
  await expect(detail).toContainText("route.use");
  const context = panel.page.getByLabel("Runtime & scope");
  await context.selectOption({ label: "openclaw / default" });
  await expect(detail).toContainText("No protected operation detail selected");
  await expect(detail).not.toContainText("route.use");
});

gate("clears guided-auth challenge detail when the selected runtime context changes", async ({ panel }) => {
  await open(panel);
  await connect(panel);
  await openMore(panel);
  const guided = morePanel(panel);
  await guided.getByRole("button", { name: "View challenge details" }).click();
  const detail = panel.page.getByRole("region", { name: "Guided-auth challenge detail" });
  await expect(detail).toContainText("Challenge detail");
  await expect(detail).toContainText("hermes");
  await panel.page.getByLabel("Runtime & scope").selectOption({ label: "openclaw / default" });
  await expect(detail).toContainText("No guided-auth challenge detail selected");
  await expect(detail).not.toContainText("hermes");
});

gate("clears protected-operation detail before replacing its filtered history", async ({ panel }) => {
  await open(panel);
  await connect(panel);
  await openMore(panel);
  await openAdvancedDiagnostics(panel);
  const audit = morePanel(panel);
  await audit.getByRole("button", { name: "View protected operation details" }).click();
  const detail = panel.page.getByRole("region", { name: "Protected operation detail" });
  await expect(detail).toContainText("route.use");
  await audit.getByLabel("Action category").nth(1).fill("model.use");
  await audit.getByRole("button", { name: "Filter operation history" }).click();
  await expect(detail).toContainText("No protected operation detail selected");
  await expect(detail).not.toContainText("route.use");
});

gate("has no serious or critical axe violations and reports lower severities", async ({ panel }, testInfo) => {
  await open(panel);
  await connect(panel);
  await assertNoSeriousOrCriticalAxeViolations(panel.page, testInfo);
});

gate("does not horizontally overflow at desktop, 760px, 430px, or 320px", async ({ panel }) => {
  for (const width of [1440, 760, 430, 320]) {
    await panel.page.setViewportSize({ width, height: 900 });
    await open(panel);
    await connect(panel);
    const overflow = await panel.page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth
    }));
    expect(overflow.documentWidth, `${width}px viewport must not horizontally overflow`).toBeLessThanOrEqual(overflow.viewportWidth);
  }
});
