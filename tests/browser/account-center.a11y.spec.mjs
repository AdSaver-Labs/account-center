import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { AuditStore, AuthChallengeStore, MutationRepository } from "../../packages/core/dist/index.js";
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
      mutationRepository
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
      await rm(root, { recursive: true, force: true });
    }
  }
});

async function open(panel) {
  await panel.page.goto(panel.baseURL, { waitUntil: "domcontentloaded" });
}

async function connect(panel) {
  await panel.page.getByLabel("Launch token").fill(panel.token);
  await panel.page.getByRole("button", { name: "Refresh status" }).click();
  await expect(panel.page.getByRole("status")).toContainText("workspace refreshed", { ignoreCase: true });
}

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
  const dashboard = panel.page.getByRole("tab", { name: "Dashboard" });
  await dashboard.focus();
  await dashboard.press("ArrowRight");
  await expect(panel.page.getByRole("tab", { name: /Accounts & routing/i })).toBeFocused();
  await panel.page.keyboard.press("ArrowLeft");
  await expect(dashboard).toBeFocused();
  await panel.page.keyboard.press("End");
  await expect(panel.page.getByRole("tab", { name: "Settings" })).toBeFocused();
  await panel.page.keyboard.press("Home");
  await expect(dashboard).toBeFocused();
  await expect(dashboard).toHaveAttribute("aria-selected", "true");
});

gate("renders accounts/routing and settings as truthful protected states", async ({ panel }) => {
  await open(panel);
  await connect(panel);
  await panel.page.getByRole("tab", { name: /Accounts & routing/i }).click();
  const accountsRouting = panel.page.getByRole("tabpanel", { name: /Accounts & routing/i });
  await expect(accountsRouting).toContainText(/No route reported|Active:/i);
  await expect(accountsRouting).toContainText(/Route changes unavailable/i);
  await expect(accountsRouting).toContainText(/UNPROVEN/i);
  await panel.page.getByRole("tab", { name: "Settings" }).click();
  const settings = panel.page.getByRole("tabpanel", { name: "Settings" });
  await expect(settings).toContainText(/No verified release status reported/i);
  await expect(settings).toContainText(/Update Center is unavailable/i);
  await expect(settings).toContainText(/blocked/i);
});

gate("confirms guided-auth cancellation and restores focus when cancellation is dismissed", async ({ panel }) => {
  await open(panel);
  await connect(panel);
  await panel.page.getByRole("tab", { name: /Guided auth/i }).click();
  const trigger = panel.page.getByRole("button", { name: "Cancel pending challenge" });
  await trigger.click();
  const dialog = panel.page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(panel.page.getByRole("heading", { name: /Cancel guided-auth challenge/i })).toBeFocused();
  await panel.page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await panel.page.getByRole("button", { name: "Cancel local challenge" }).click();
  await expect(dialog).toBeHidden();
  await expect(panel.page.getByRole("status")).toContainText(/challenge cancelled/i);
  await expect(panel.page.getByRole("tabpanel", { name: /Guided auth/i })).toContainText(/cancelled/i);
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
  await panel.page.getByRole("tab", { name: /Guided auth/i }).click();
  const guided = panel.page.getByRole("tabpanel", { name: /Guided auth/i });
  await expect(guided).toContainText("UNPROVEN — data unavailable");
  await expect(guided).not.toContainText("invented_success_state");
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
  await panel.page.getByRole("tab", { name: /Receipts & audit/i }).click();
  const audit = panel.page.getByRole("tabpanel", { name: /Receipts & audit/i });
  await expect(audit).toContainText("UNPROVEN — data unavailable");
  await expect(audit).not.toContainText("invented_success_state");
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
  await panel.page.getByRole("tab", { name: /Receipts & audit/i }).click();
  const audit = panel.page.getByRole("tabpanel", { name: /Receipts & audit/i });
  await expect(audit).toContainText("UNPROVEN — data unavailable");
  await expect(audit).not.toContainText("invented_success_state");
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
  await panel.page.getByRole("tab", { name: /Accounts & routing/i }).click();
  const accountsRouting = panel.page.getByRole("tabpanel", { name: /Accounts & routing/i });
  await expect(accountsRouting).toContainText("Selected-scope limit inventory unavailable");
  await expect(accountsRouting).toContainText("UNPROVEN");
  await expect(accountsRouting).not.toContainText("account-9");
  await panel.page.getByRole("tab", { name: /Models & fallbacks/i }).click();
  const models = panel.page.getByRole("tabpanel", { name: /Models & fallbacks/i });
  await expect(models).toContainText("UNPROVEN — data unavailable");
  await expect(models).not.toContainText("openai/invented-model");
});

gate("loads a redacted protected-operation detail through the bearer-protected API", async ({ panel }) => {
  await open(panel);
  await connect(panel);
  await panel.page.getByRole("tab", { name: /Receipts & audit/i }).click();
  const audit = panel.page.getByRole("tabpanel", { name: /Receipts & audit/i });
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
  await panel.page.getByRole("tab", { name: /Receipts & audit/i }).click();
  const audit = panel.page.getByRole("tabpanel", { name: /Receipts & audit/i });
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
  await panel.page.getByRole("tab", { name: /Guided auth/i }).click();
  const guided = panel.page.getByRole("tabpanel", { name: /Guided auth/i });
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
  await panel.page.getByRole("tab", { name: /Receipts & audit/i }).click();
  const audit = panel.page.getByRole("tabpanel", { name: /Receipts & audit/i });
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
