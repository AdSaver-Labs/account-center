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
}

async function connect(panel) {
  await panel.page.getByLabel("Launch token").fill(panel.token);
  await panel.page.getByRole("button", { name: "Refresh status" }).click();
  await expect(panel.page.getByRole("status")).toContainText("workspace refreshed", { ignoreCase: true });
}

async function openMore(panel) {
  await panel.page.getByRole("tab", { name: "More" }).click();
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

gate("explains active, saved, and hidden accounts before offering local Hide or Restore", async ({ panel }) => {
  await open(panel);
  await connect(panel);
  await panel.page.getByRole("tab", { name: "Accounts" }).click();
  const accounts = accountsPanel(panel);
  await expect(accounts).toContainText("Active — used by the selected route now.");
  await expect(accounts).toContainText("Saved — available locally, but not used by this route");
  await expect(accounts).toContainText("Hidden — out of everyday lists only; it stays connected locally and can be restored.");
  await expect(accounts).toContainText("Restore puts it back in everyday lists; it does not change routing or delete credentials.");
  await expect(accounts.getByRole("button", { name: "Hide account locally; credentials stay connected and routing stays unchanged", exact: true }).first()).toBeVisible();
  await accounts.getByRole("button", { name: "Hide account locally; credentials stay connected" }).first().click();
  await expect(accounts.getByRole("button", { name: "Restore account to everyday lists; routing and credentials stay unchanged" })).toHaveCount(1);
  await expect(accounts).toContainText("It stays connected locally; routing changes remain capability-gated.");
});

gate("hides then restores a fixture account without requesting credential deletion", async ({ panel }) => {
  await open(panel);
  await connect(panel);
  await panel.page.getByRole("tab", { name: "Accounts" }).click();
  const accounts = accountsPanel(panel);
  const row = accounts.locator("#account-visibility-state .record").filter({
    has: panel.page.getByRole("button", { name: "Hide account locally; credentials stay connected" })
  }).first();
  const initialTitle = await row.locator("strong").textContent();
  const accountRef = initialTitle?.split(" · ")[0];
  expect(accountRef).toMatch(/^account-[1-9][0-9]*$/);

  const hiddenResponse = panel.page.waitForResponse((response) =>
    response.url().endsWith("/api/account-ui-preferences") && response.request().method() === "POST"
  );
  await row.getByRole("button", { name: "Hide account locally; credentials stay connected" }).click();
  expect((await hiddenResponse).request().postDataJSON()).toEqual({ accountRef, state: "hidden" });
  await expect(accounts.locator("#account-visibility-state")).toContainText(`${accountRef} · Hidden`);
  await expect(homePanel(panel).locator("#accounts")).not.toContainText(accountRef || "");
  await expect(panel.page.locator("#notice")).toContainText("Account hidden locally. Credentials and runtime state were preserved; routing was not changed. Some other workspace evidence is UNPROVEN.");

  const restoredResponse = panel.page.waitForResponse((response) =>
    response.url().endsWith("/api/account-ui-preferences") && response.request().method() === "POST"
  );
  await accounts.getByRole("button", { name: "Restore account to everyday lists" }).first().click();
  expect((await restoredResponse).request().postDataJSON()).toEqual({ accountRef, state: "active" });
  await expect(accounts.locator("#account-visibility-state")).toContainText(initialTitle || "");
  await expect(homePanel(panel).locator("#accounts")).toContainText(accountRef || "");
  await expect(panel.page.locator("#notice")).toContainText("Account restored to everyday lists. Credentials and runtime state were preserved; routing was not changed. Some other workspace evidence is UNPROVEN.");
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
  await panel.page.route("**/api/account-ui-preferences", async (route) => {
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
  await panel.page.route("**/api/account-ui-preferences", async (route) => {
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
  await panel.page.route("**/api/account-ui-preferences", async (route) => {
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
  await panel.page.route("**/api/account-ui-preferences", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ schemaVersion: "account-center.account-ui-preferences.v1", hiddenAccountRefs: "not-an-account-list" }) });
    } else {
      await route.continue();
    }
  });
  const preferencesRequest = panel.page.waitForRequest((request) =>
    request.url() === `${panel.baseURL}/api/account-ui-preferences` && request.method() === "GET"
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
  await panel.page.route("**/api/account-ui-preferences", async (route) => {
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
  await panel.page.getByRole("button", { name: "Cancel local challenge" }).click();
  await expect(dialog).toBeHidden();
  await expect(panel.page.locator("#notice")).toContainText(/challenge cancelled/i);
  await expect(morePanel(panel)).toContainText(/cancelled/i);
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
