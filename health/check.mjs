#!/usr/bin/env node
/**
 * Runs the same scan the `devnervs-health` Worker runs on its cron, from a
 * laptop: `node health/check.mjs`. Adds the one thing a Worker cannot see —
 * the days left on each TLS certificate — and prints the Markdown report.
 *
 * Environment (all optional): CLOUDFLARE_API_TOKEN, HEALTH_TELEGRAM_BOT_TOKEN,
 * HEALTH_TELEGRAM_CHAT_ID, HEALTH_ALWAYS_NOTIFY=1. Exit code: 0 green,
 * 1 warnings, 2 critical. Writes health/last-run.json (git-ignored).
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { formatAlert, notifyTelegram, runHealth } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const configPath = resolve(args.includes("--config") ? args[args.indexOf("--config") + 1] : resolve(here, "sites.json"));
const config = JSON.parse(await readFile(configPath, "utf8"));

function certDays(hostname) {
  return new Promise((resolveDays) => {
    const socket = tls.connect({ host: hostname, port: 443, servername: hostname, timeout: 10_000 }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      resolveDays(cert?.valid_to ? Math.floor((new Date(cert.valid_to).getTime() - Date.now()) / 86_400_000) : null);
    });
    socket.on("error", () => resolveDays(null));
    socket.on("timeout", () => {
      socket.destroy();
      resolveDays(null);
    });
  });
}

const run = await runHealth(config, { token: process.env.CLOUDFLARE_API_TOKEN, fetch: (url, init) => fetch(url, init), certDays });
await writeFile(resolve(here, "last-run.json"), JSON.stringify(run, null, 2));
console.log(args.includes("--json") ? JSON.stringify({ severity: run.severity, findings: run.findings }, null, 2) : run.markdown);

if (run.severity >= 1 || process.env.HEALTH_ALWAYS_NOTIFY === "1") {
  await notifyTelegram((url, init) => fetch(url, init), process.env.HEALTH_TELEGRAM_BOT_TOKEN, process.env.HEALTH_TELEGRAM_CHAT_ID, formatAlert(run)).catch(() => false);
}
process.exit(run.severity);
