#!/usr/bin/env node
import { chmod, mkdtemp, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_TOKEN_BYTES = 8 * 1024;
let input = "";
let inputBytes = 0;
let tooLarge = false;

process.stdin.setEncoding("utf8");
process.stderr.write("Paste the launch token, then press Ctrl+D: ");
process.stdin.on("data", (chunk) => {
  inputBytes += Buffer.byteLength(chunk);
  if (inputBytes > MAX_TOKEN_BYTES) {
    tooLarge = true;
    return;
  }
  input += chunk;
});
process.stdin.once("end", async () => {
  const token = input.trim();
  if (tooLarge || !/^[^\s]+$/.test(token)) {
    process.stderr.write("Launch token was not written.\n");
    process.exitCode = 1;
    return;
  }

  let directory;
  let handle;
  try {
    directory = await mkdtemp(join(tmpdir(), "account-center-launch-token-"));
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
});
