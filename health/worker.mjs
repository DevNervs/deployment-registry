/**
 * The `devnervs-health` Cloudflare Worker: runs the scan on a cron, keeps
 * the last runs in its own D1 (`devnervs-health`) so the daily Claude routine
 * can read them through the Cloudflare connector, and serves the latest
 * report to anyone holding HEALTH_KEY.
 *
 * Secrets: HEALTH_KEY (required for the HTTP endpoints), CLOUDFLARE_API_TOKEN
 * (read-only; unlocks logs, WAF, analytics, D1), HEALTH_TELEGRAM_BOT_TOKEN +
 * HEALTH_TELEGRAM_CHAT_ID (optional alerts). See health/README.md.
 */

import config from "./sites.json";
import { formatAlert, notifyTelegram, runHealth } from "./lib.mjs";
import { checkLive } from "./live.mjs";

const KEEP_RUNS = 60;

async function ensureTable(db) {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS runs (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         ran_at TEXT NOT NULL,
         severity INTEGER NOT NULL,
         report_md TEXT NOT NULL,
         findings TEXT NOT NULL,
         results TEXT NOT NULL
       )`,
    )
    .run();
}

async function ensureLiveTable(db) {
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS live_runs (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         ran_at TEXT NOT NULL,
         severity INTEGER NOT NULL,
         site_live INTEGER,
         youtube_live INTEGER,
         video_id TEXT,
         report_md TEXT NOT NULL,
         findings TEXT NOT NULL
       )`,
    )
    .run();
}

/** The Sunday livestream check, stored next to the health runs in the same D1. */
async function runLiveAndStore(env, trigger) {
  const run = await checkLive({ fetch: (url, init) => fetch(url, init) });
  await ensureLiveTable(env.HEALTH_DB);
  await env.HEALTH_DB.prepare(
    "INSERT INTO live_runs (ran_at, severity, site_live, youtube_live, video_id, report_md, findings) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      run.ranAt,
      run.severity,
      run.siteLive ? 1 : 0,
      run.youtubeLive === null ? null : run.youtubeLive ? 1 : 0,
      run.videoId,
      run.markdown,
      JSON.stringify(run.findings),
    )
    .run();
  await env.HEALTH_DB.prepare(`DELETE FROM live_runs WHERE id NOT IN (SELECT id FROM live_runs ORDER BY id DESC LIMIT 40)`).run();
  console.log(`live check (${trigger}): severity ${run.severity}, site ${run.siteLive}, youtube ${run.youtubeLive}`);
  return run;
}

async function runAndStore(env, trigger) {
  const fetchFor = (site) => {
    const binding = site.service ? env[`SVC_${site.service.toUpperCase().replace(/-/g, "_")}`] : null;
    // A service binding follows no redirects itself, so "follow" is honoured
    // by hand for the one hop a canonical-host redirect needs.
    return binding
      ? async (url, init) => {
          const response = await binding.fetch(url, init);
          if (init?.redirect === "follow" && response.status >= 300 && response.status < 400 && response.headers.get("location")) {
            return fetch(new URL(response.headers.get("location"), url).toString(), { ...init, redirect: "follow" });
          }
          return response;
        }
      : null;
  };
  const run = await runHealth(config, { token: env.CLOUDFLARE_API_TOKEN, fetch: (url, init) => fetch(url, init), fetchFor });
  await ensureTable(env.HEALTH_DB);
  await env.HEALTH_DB.prepare("INSERT INTO runs (ran_at, severity, report_md, findings, results) VALUES (?, ?, ?, ?, ?)")
    .bind(run.ranAt, run.severity, run.markdown, JSON.stringify(run.findings), JSON.stringify(run.results))
    .run();
  await env.HEALTH_DB.prepare(`DELETE FROM runs WHERE id NOT IN (SELECT id FROM runs ORDER BY id DESC LIMIT ${KEEP_RUNS})`).run();
  console.log(`health run (${trigger}): severity ${run.severity}, ${run.findings.length} findings`);
  if (run.severity >= 1 || env.HEALTH_ALWAYS_NOTIFY === "1") {
    await notifyTelegram((url, init) => fetch(url, init), env.HEALTH_TELEGRAM_BOT_TOKEN, env.HEALTH_TELEGRAM_CHAT_ID, formatAlert(run)).catch((error) => console.error("telegram alert failed", error));
  }
  return run;
}

/** Constant-time compare, so the key cannot be guessed character by character. */
function sameKey(given, expected) {
  if (!given || !expected || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i += 1) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export default {
  async scheduled(event, env, ctx) {
    // Два расписания в одном воркере: ежедневный health в 04:40 UTC и проверка
    // воскресной трансляции в слотах вокруг служений (10:00 и 17:00 по Киеву).
    const isLiveSlot = String(event?.cron || "") !== "40 4 * * *";
    ctx.waitUntil(isLiveSlot ? runLiveAndStore(env, "cron") : runAndStore(env, "cron"));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const given = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? url.searchParams.get("key");
    // LIVE_KEY opens only the /live/* endpoints, so the livestream check can be
    // run and read without handing out HEALTH_KEY.
    const isLivePath = url.pathname.startsWith("/live/");
    const authorized = sameKey(given, env.HEALTH_KEY) || (isLivePath && sameKey(given, env.LIVE_KEY));
    if (!authorized) return new Response("not found", { status: 404 });

    if (url.pathname === "/live/run" && request.method === "POST") {
      const run = await runLiveAndStore(env, "manual");
      return new Response(run.markdown, { headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store" } });
    }
    if (url.pathname === "/live/latest") {
      await ensureLiveTable(env.HEALTH_DB);
      const row = await env.HEALTH_DB.prepare("SELECT report_md FROM live_runs ORDER BY id DESC LIMIT 1").first();
      if (!row) return new Response("Ще жодної перевірки трансляції.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
      return new Response(row.report_md, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
    }
    if (url.pathname === "/run" && request.method === "POST") {
      const run = await runAndStore(env, "manual");
      return new Response(run.markdown, { headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store" } });
    }
    if (url.pathname === "/latest" || url.pathname === "/latest.json") {
      await ensureTable(env.HEALTH_DB);
      const row = await env.HEALTH_DB.prepare("SELECT ran_at, severity, report_md, findings, results FROM runs ORDER BY id DESC LIMIT 1").first();
      if (!row) return new Response("Ще жодного запуску.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
      if (url.pathname === "/latest.json") {
        return new Response(JSON.stringify({ ranAt: row.ran_at, severity: row.severity, findings: JSON.parse(row.findings), results: JSON.parse(row.results) }), {
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
        });
      }
      return new Response(row.report_md, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
    }
    return new Response("not found", { status: 404 });
  },
};
