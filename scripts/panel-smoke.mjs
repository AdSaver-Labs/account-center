#!/usr/bin/env node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPersistentControlPanel } from "../packages/cli/dist/index.js";

const root = await mkdtemp(join(tmpdir(), "account-center-panel-smoke-"));
const token = "panel-smoke-local-token";
const app = createPersistentControlPanel({ token, source: "fixture", stateRoot: root });
try {
  const { port } = await app.listen();
  const base = `http://127.0.0.1:${port}`;
  const headers = { authorization: `Bearer ${token}` };
  const [page, status, preferences] = await Promise.all([
    fetch(`${base}/`),
    fetch(`${base}/api/status`, { headers }),
    fetch(`${base}/api/account-ui-preferences`, { headers })
  ]);
  const html = await page.text();
  const statusBody = await status.json();
  const preferenceBody = await preferences.json();
  if (page.status !== 200 || !html.includes("Sentinel runtime overview") || !html.includes("Account visibility") || status.status !== 200 || !Array.isArray(statusBody.runtimes) || preferences.status !== 200 || !Array.isArray(preferenceBody.hiddenAccountRefs)) throw new Error("panel_smoke_failed");
  process.stdout.write("Account Center panel smoke: passed\n");
} finally {
  await app.close();
  await rm(root, { recursive: true, force: true });
}
