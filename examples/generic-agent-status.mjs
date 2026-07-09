#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const fixture = resolve(process.cwd(), "tests/fixtures/status.fixture.json");
const status = JSON.parse(await readFile(fixture, "utf8"));
status.source = "generic-command";
status.runtimes = [{
  key: "generic-command",
  displayName: "Example generic agent adapter",
  capabilities: {
    readStatus: true,
    mutateRoutes: false,
    startReauth: false,
    mutateModels: false
  }
}];
status.routes = status.routes.map((route) => ({ ...route, runtime: "generic-command" }));
status.profiles = status.profiles.map((profile) => ({ ...profile, runtimeCompatibility: ["generic-command"] }));
status.warnings = [...status.warnings, "example_generic_adapter"];
process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
