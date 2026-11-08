#!/usr/bin/env node
// mausbridge: add (or update) one engine instance per project in ~/.openmausbot/config.json.
// ACP drivers (DeepSeek) take their session folder from the instance's `workspace`, not from the
// bot, and dsh refuses to resume a session from another folder — so each project gets its own instance.
//
//   node scripts/mausbridge/add-project-instance.mjs <instanceId> <driver> <workspace> [displayName] [cli]
//   e.g. ... ds-default deepseekAgent ~/Documents/deepseek-harness/default-workspace "DeepSeek·默认工作区"
//
// Run it while the server is stopped: the server rewrites config.json and would drop an edit made under it.
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [instanceId, driver, workspaceArg, displayName, cliArg] = process.argv.slice(2);
if (!instanceId || !driver || !workspaceArg || !/^[\w.-]+$/.test(instanceId)) {
  console.error("usage: add-project-instance.mjs <instanceId> <driver> <workspace> [displayName] [cli]");
  process.exit(64);
}
const dataDir = process.env.OMB_DATA_DIR || join(homedir(), ".openmausbot");
const file = join(dataDir, "config.json");
let listening = false;
try { execFileSync("lsof", ["-nP", "-iTCP:8799", "-sTCP:LISTEN"], { stdio: "ignore" }); listening = true; } catch {}
if (listening) {
  console.error("OpenMausBot is running on 8799; stop it first so this edit is not overwritten.");
  process.exit(75);
}
const workspace = resolve(workspaceArg.replace(/^~(?=\/|$)/, homedir()));
if (!existsSync(workspace)) {
  console.error(`workspace does not exist: ${workspace}`);
  process.exit(66);
}
const defaultCli = {
  // dsh plus the desktop's agent presets, so desktop-made sessions keep their toolset.
  deepseekAgent: fileURLToPath(new URL("./dsh-acp", import.meta.url)),
};
const cli = cliArg ?? process.env.MAUSBRIDGE_CLI ?? defaultCli[driver];

const config = JSON.parse(readFileSync(file, "utf8"));
config.instances ??= {};
const previous = config.instances[instanceId];
config.instances[instanceId] = {
  ...previous,
  driver,
  ...(displayName ? { displayName } : {}),
  config: { ...previous?.config, ...(cli ? { cli } : {}), workspace },
};
const backup = `${file}.mausbridge-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
copyFileSync(file, backup);
writeFileSync(`${file}.tmp`, JSON.stringify(config, null, 2) + "\n");
renameSync(`${file}.tmp`, file);
console.log(`${previous ? "updated" : "added"} instance ${instanceId} (${driver}) -> ${workspace}`);
console.log(`backup: ${backup}`);
