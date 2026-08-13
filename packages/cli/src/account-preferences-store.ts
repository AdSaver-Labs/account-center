import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export type AccountUiState = "hidden";
export interface AccountUiPreferencesView {
  schemaVersion: "account-center.account-ui-preferences.v1";
  hiddenAccountRefs: string[];
}
interface AccountUiPreferencesState {
  schemaVersion: "account-center.account-ui-preferences.v2";
  hiddenAccountRefsByScope: Record<string, string[]>;
}
interface LegacyAccountUiPreferencesState {
  schemaVersion: "account-center.account-ui-preferences.v1";
  hiddenAccountRefs: string[];
}

/**
 * Owner-only, token-free local UI preferences. These are deliberately not an
 * account or credential store: a hidden account can always be restored.
 */
export class AccountUiPreferencesStore {
  private readonly path: string;
  private readonly lockPath: string;
  constructor(private readonly root: string) {
    this.path = join(root, "account-ui-preferences.v1.json");
    this.lockPath = join(root, "account-ui-preferences.lock");
  }

  async view(scopeKey: string): Promise<AccountUiPreferencesView> {
    assertScopeKey(scopeKey);
    return this.withLock(async () => this.project(await this.read(), scopeKey));
  }

  async setAccountState(scopeKey: string, accountRef: string, state: AccountUiState | "active"): Promise<AccountUiPreferencesView> {
    assertScopeKey(scopeKey);
    if (!/^account-[1-9][0-9]*$/.test(accountRef)) throw new Error("invalid_account_ref");
    return this.withLock(async () => {
      const current = await this.read();
      const hidden = new Set(current.hiddenAccountRefsByScope[scopeKey] ?? []);
      if (state === "hidden") hidden.add(accountRef); else hidden.delete(accountRef);
      const hiddenAccountRefsByScope = { ...current.hiddenAccountRefsByScope };
      if (hidden.size) hiddenAccountRefsByScope[scopeKey] = sortAccountRefs([...hidden]); else delete hiddenAccountRefsByScope[scopeKey];
      const next: AccountUiPreferencesState = { schemaVersion: "account-center.account-ui-preferences.v2", hiddenAccountRefsByScope };
      await this.write(next);
      return this.project(next, scopeKey);
    });
  }

  private project(state: AccountUiPreferencesState, scopeKey: string): AccountUiPreferencesView {
    return { schemaVersion: "account-center.account-ui-preferences.v1", hiddenAccountRefs: [...(state.hiddenAccountRefsByScope[scopeKey] ?? [])] };
  }
  private async withLock<T>(work: () => Promise<T>): Promise<T> {
    await mkdir(this.root, { recursive: true, mode: 0o700 }); await chmod(this.root, 0o700);
    const info = await lstat(this.root); if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error("unsafe_preferences_directory");
    try { await mkdir(this.lockPath, { mode: 0o700 }); } catch (error) { if (isCode(error, "EEXIST")) throw new Error("preferences_locked"); throw error; }
    try { return await work(); } finally { await rm(this.lockPath, { recursive: true, force: true }); }
  }
  private async read(): Promise<AccountUiPreferencesState> {
    try {
      const info = await lstat(this.path); if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error("unsafe_preferences_state");
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (isState(parsed)) return parsed;
      // v1 was global even though the panel's initial selected context was
      // Hermes/default. Preserve its reversible records only there; never
      // replay a legacy global hide into another runtime by accident.
      if (isLegacyState(parsed)) {
        const hiddenAccountRefs = sortAccountRefs([...new Set(parsed.hiddenAccountRefs)]);
        return { schemaVersion: "account-center.account-ui-preferences.v2", hiddenAccountRefsByScope: hiddenAccountRefs.length ? { "hermes|default": hiddenAccountRefs } : {} };
      }
      throw new Error("preferences_corrupt");
    } catch (error) { if (isCode(error, "ENOENT")) return { schemaVersion: "account-center.account-ui-preferences.v2", hiddenAccountRefsByScope: {} }; throw error; }
  }
  private async write(state: AccountUiPreferencesState): Promise<void> {
    const temporary = join(this.root, `.account-ui-preferences.${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try { handle = await open(temporary, "wx", 0o600); await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8"); await handle.sync(); await handle.close(); handle = undefined; await rename(temporary, this.path); await chmod(this.path, 0o600); }
    finally { await handle?.close(); await rm(temporary, { force: true }); }
  }
}
function isCode(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === code; }
function sortAccountRefs(accountRefs: string[]): string[] { return accountRefs.sort((a, b) => Number(a.slice(8)) - Number(b.slice(8))); }
function assertScopeKey(scopeKey: string): void { if (!/^(codex|hermes|openclaw)\|default$/.test(scopeKey)) throw new Error("invalid_scope_key"); }
function isState(value: unknown): value is AccountUiPreferencesState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as AccountUiPreferencesState;
  return state.schemaVersion === "account-center.account-ui-preferences.v2" && !!state.hiddenAccountRefsByScope && typeof state.hiddenAccountRefsByScope === "object" && !Array.isArray(state.hiddenAccountRefsByScope) && Object.entries(state.hiddenAccountRefsByScope).every(([scopeKey, accountRefs]) => {
    try { assertScopeKey(scopeKey); } catch { return false; }
    return Array.isArray(accountRefs) && new Set(accountRefs).size === accountRefs.length && accountRefs.every((accountRef) => typeof accountRef === "string" && /^account-[1-9][0-9]*$/.test(accountRef));
  });
}
function isLegacyState(value: unknown): value is LegacyAccountUiPreferencesState {
  return !!value && typeof value === "object" && !Array.isArray(value) && (value as LegacyAccountUiPreferencesState).schemaVersion === "account-center.account-ui-preferences.v1" && Array.isArray((value as LegacyAccountUiPreferencesState).hiddenAccountRefs) && (value as LegacyAccountUiPreferencesState).hiddenAccountRefs.every((accountRef) => typeof accountRef === "string" && /^account-[1-9][0-9]*$/.test(accountRef));
}
