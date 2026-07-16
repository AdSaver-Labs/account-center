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
      // Match the fixture adapter's protected runtime-context identifier.
      scope: "default:default",
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
