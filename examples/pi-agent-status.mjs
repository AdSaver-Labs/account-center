#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const fixture = resolve(process.cwd(), "tests/fixtures/status.fixture.json");
const status = JSON.parse(await readFile(fixture, "utf8"));
status.source = "generic-command";
status.runtimes = [{
  key: "pi-agent",
  displayName: "PI agent via Account Center generic-command adapter",
  capabilities: {
    readStatus: true,
    mutateRoutes: true,
    startReauth: false,
    mutateModels: false
  }
}];
status.routes = status.routes.map((route) => ({ ...route, runtime: "pi-agent" }));
status.profiles = status.profiles.map((profile) => ({ ...profile, runtimeCompatibility: ["pi-agent", "generic-command"] }));
status.warnings = [...status.warnings, "pi_agent_example_fixture", "replace_with_real_pi_status_command"];
process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
