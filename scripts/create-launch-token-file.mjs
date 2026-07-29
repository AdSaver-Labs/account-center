#!/usr/bin/env node
import { chmod, mkdtemp, open } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The bearer value is generated here for this launch and exists only in the
// owner-only file. Stdout intentionally reports the path, never the token.
const token = randomBytes(32).toString("base64url");
let handle;
try {
  const directory = await mkdtemp(join(tmpdir(), "account-center-launch-token-"));
  await chmod(directory, 0o700);
  const path = join(directory, "token");
  handle = await open(path, "wx", 0o600);
  await handle.writeFile(`${token}\n`, "utf8");
  await handle.chmod(0o600);
  await handle.close();
  handle = undefined;
  process.stdout.write(`${path}\n`);
} catch {
  if (handle) await handle.close().catch(() => undefined);
  process.stderr.write("Launch token was not written.\n");
  process.exitCode = 1;
}
