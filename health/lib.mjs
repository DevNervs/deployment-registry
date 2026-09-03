/**
 * The health scan itself, with nothing platform-specific in it: the same code
 * runs inside the `devnervs-health` Cloudflare Worker on a cron and from
 * `node health/check.mjs` on a laptop. Callers hand in `fetch` and, when they
 * can inspect certificates (Node), a `certDays(hostname)` function.
 *
 * Two layers:
 *   1. From the outside, no credentials: does each page answer, how fast, with
 *      what status, are the security headers there, is the noindex state what
 *      it should be, do the API endpoints refuse bad input the way they should.
 *   2. From Cloudflare's side, when a read-only API token is given: requests
 *      and error rates per Worker for the last 24 h against the 24 h before,
 *      error-level log lines, WAF / firewall events per zone (attacks, bots,
 *      rate limiting), D1 size and query counts.
 */

export const SEVERITY = { info: 0, warning: 1, critical: 2 };

const API = "https://api.cloudflare.com/client/v4";
const HTTP_TIMEOUT_MS = 20_000;
const SECURITY_HEADERS = ["strict-transport-security", "x-content-type-options", "content-security-policy", "x-frame-options", "referrer-policy"];

function ratio(a, b) {
  return b === 0 ? (a === 0 ? 1 : Infinity) : a / b;
}

function sumStatus(byStatus, prefix) {
  return Object.entries(byStatus)
    .filter(([status]) => status.startsWith(prefix))
    .reduce((n, [, count]) => n + count, 0);
}

/**
 * Runs every check for every enabled site and returns the findings, the raw
 * results and a Markdown report. Never throws for a site that misbehaves —
 * that is a finding, not a crash.
 */
export async function runHealth(config, { token, fetch: doFetch, fetchFor = null, certDays = null, now = new Date() } = {}) {
  const accountId = config.cloudflare?.accountId;
  const dayAgo = new Date(now.getTime() - 24 * 3600 * 1000);
  const twoDaysAgo = new Date(now.getTime() - 48 * 3600 * 1000);
  const findings = [];
  const note = (severity, site, text) => findings.push({ severity, site, text });

  // ------------------------------------------------------------- layer 1

  async function timedFetch(url, init = {}, site = null) {
    const started = Date.now();
    // A same-account Worker is reached through its service binding when the
    // caller has one (see worker.mjs); everything else goes over the network.
    const via = (site && fetchFor?.(site)) || doFetch;
    try {
      const response = await via(url, {
        redirect: "manual",
        ...init,
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        headers: { "user-agent": "DevNervs-HealthCheck/1.0", ...(init.headers ?? {}) },
      });
      const body = init.method === "HEAD" ? "" : await response.text();
      return { ok: true, status: response.status, ms: Date.now() - started, headers: response.headers, body };
    } catch (error) {
      const name = error?.name === "TimeoutError" || error?.name === "AbortError" ? "timeout" : String(error?.message ?? error);
      return { ok: false, status: 0, ms: Date.now() - started, error: name, headers: new Headers(), body: "" };
    }
  }

  async function checkSite(site) {
    const result = { name: site.name, url: site.url, pages: [], endpoints: [], cert: null, missingHeaders: [] };
    const origin = new URL(site.url);

    if (certDays) {
      result.cert = await certDays(origin.hostname);
      if (result.cert !== null && result.cert < 14) note("critical", site.name, `TLS-сертифікат спливає через ${result.cert} дн.`);
    }

    for (const path of site.paths ?? ["/"]) {
      const url = new URL(path, site.url).toString();
      const expectStatus = site.expectStatus?.[path] ?? 200;
      // A page is followed to where it lands; only a path that is *expected*
      // to redirect (an admin route, a canonical-host hop) is read as-is.
      const r = await timedFetch(url, { redirect: expectStatus >= 300 && expectStatus < 400 ? "manual" : "follow" }, site);
      result.pages.push({ path, status: r.status, ms: r.ms, bytes: r.body.length, error: r.error ?? null });
      if (!r.ok) note("critical", site.name, `${path}: не відповідає (${r.error})`);
      else if (r.status !== expectStatus && !(expectStatus === 200 && r.status >= 200 && r.status < 400)) note("critical", site.name, `${path}: HTTP ${r.status}, очікували ${expectStatus}`);
      else if (r.ms > (site.slowMs ?? 3000)) note("warning", site.name, `${path}: повільно, ${r.ms} мс`);
      if (path === "/" && r.ok) {
        if (site.expectText && !r.body.includes(site.expectText)) note("critical", site.name, `на головній немає тексту «${site.expectText}» — інша сторінка чи зламана верстка`);
        result.missingHeaders = SECURITY_HEADERS.filter((h) => !r.headers.get(h));
        if (site.securityHeaders && result.missingHeaders.length) note("warning", site.name, `немає заголовків: ${result.missingHeaders.join(", ")}`);
        const noindex = Boolean(r.headers.get("x-robots-tag")?.includes("noindex")) || /<meta name="robots" content="noindex/.test(r.body);
        if (site.expectIndexable === true && noindex) note("warning", site.name, "сайт закритий від індексації (noindex), а має бути відкритий");
        if (site.expectIndexable === false && !noindex) note("warning", site.name, "превʼю без noindex — може потрапити в пошук");
        for (const marker of ["Application error", "Internal Server Error", "Щось зламалося", "Сайт тимчасово недоступний"]) {
          if (r.body.includes(marker)) note("critical", site.name, `на головній текст «${marker}»`);
        }
      }
    }

    for (const endpoint of site.endpoints ?? []) {
      const url = new URL(endpoint.path, site.url).toString();
      const method = endpoint.method ?? "GET";
      const r = await timedFetch(url, { method, headers: endpoint.body ? { "content-type": "application/json" } : {}, body: endpoint.body ? JSON.stringify(endpoint.body) : undefined }, site);
      result.endpoints.push({ path: endpoint.path, method, status: r.status, ms: r.ms });
      if (!r.ok) note("critical", site.name, `${method} ${endpoint.path}: не відповідає (${r.error})`);
      else if (r.status !== endpoint.expectStatus) note("critical", site.name, `${method} ${endpoint.path}: HTTP ${r.status}, очікували ${endpoint.expectStatus} — ${endpoint.why ?? ""}`.trim());
    }
    return result;
  }

  // ------------------------------------------------------------- layer 2

  async function cf(path, init = {}) {
    const response = await doFetch(`${API}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) throw new Error(`${path}: ${response.status} ${JSON.stringify(data.errors ?? data).slice(0, 300)}`);
    return data;
  }

  async function graphql(query, variables) {
    const response = await doFetch(`${API}/graphql`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ query, variables }) });
    const data = await response.json().catch(() => ({}));
    if (data.errors?.length) throw new Error(data.errors.map((e) => e.message).join("; ").slice(0, 400));
    return data.data;
  }

  async function workerWindow(scriptName, from, to) {
    const data = await graphql(
      `query($account: String!, $script: String!, $from: Time!, $to: Time!) {
        viewer { accounts(filter: { accountTag: $account }) {
          workersInvocationsAdaptive(limit: 1000, filter: { scriptName: $script, datetime_geq: $from, datetime_leq: $to }) {
            sum { requests errors subrequests }
            quantiles { cpuTimeP50 cpuTimeP99 wallTimeP99 }
            dimensions { status }
          }
        } }
      }`,
      { account: accountId, script: scriptName, from: from.toISOString(), to: to.toISOString() },
    );
    const rows = data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
    const out = { requests: 0, errors: 0, subrequests: 0, byStatus: {}, cpuP50: 0, cpuP99: 0, wallP99: 0 };
    for (const row of rows) {
      out.requests += row.sum.requests;
      out.errors += row.sum.errors;
      out.subrequests += row.sum.subrequests;
      out.byStatus[row.dimensions.status] = (out.byStatus[row.dimensions.status] ?? 0) + row.sum.requests;
      out.cpuP50 = Math.max(out.cpuP50, row.quantiles.cpuTimeP50 ?? 0);
      out.cpuP99 = Math.max(out.cpuP99, row.quantiles.cpuTimeP99 ?? 0);
      out.wallP99 = Math.max(out.wallP99, row.quantiles.wallTimeP99 ?? 0);
    }
    return out;
  }

  async function workerErrorLogs(scriptName) {
    const body = {
      queryId: `health-${scriptName}-${Date.now()}`,
      timeframe: { from: dayAgo.getTime(), to: now.getTime() },
      parameters: {
        datasets: ["cloudflare-workers"],
        filters: [
          { key: "$metadata.service", operation: "eq", value: scriptName, type: "string" },
          { key: "$metadata.level", operation: "eq", value: "error", type: "string" },
        ],
        calculations: [{ operator: "count", alias: "n" }],
        groupBys: [{ type: "string", value: "$metadata.message" }],
        limit: 15,
      },
      view: "calculations",
      limit: 15,
    };
    const data = await cf(`/accounts/${accountId}/workers/observability/telemetry/query`, { method: "POST", body: JSON.stringify(body) });
    const groups = data?.result?.calculations?.[0]?.aggregates ?? data?.result?.calculations ?? [];
    return groups.map((g) => ({ message: g.groups?.[0]?.value ?? g.key ?? "?", count: g.value ?? g.count ?? 0 })).filter((g) => g.count > 0);
  }

  async function zoneId(zoneName) {
    const data = await cf(`/zones?name=${encodeURIComponent(zoneName)}`);
    return data.result?.[0]?.id ?? null;
  }

  async function zoneWindow(zoneTag, from, to) {
    const data = await graphql(
      `query($zone: String!, $from: Time!, $to: Time!) {
        viewer { zones(filter: { zoneTag: $zone }) {
          http: httpRequestsAdaptiveGroups(limit: 50, filter: { datetime_geq: $from, datetime_leq: $to }) {
            count dimensions { edgeResponseStatus }
          }
          firewall: firewallEventsAdaptiveGroups(limit: 25, orderBy: [count_DESC], filter: { datetime_geq: $from, datetime_leq: $to }) {
            count dimensions { action source clientCountryName clientRequestPath }
          }
        } }
      }`,
      { zone: zoneTag, from: from.toISOString(), to: to.toISOString() },
    );
    const zone = data?.viewer?.zones?.[0] ?? { http: [], firewall: [] };
    const out = { requests: 0, byClass: {}, firewall: 0, firewallTop: [] };
    for (const row of zone.http ?? []) {
      out.requests += row.count;
      const cls = `${String(row.dimensions.edgeResponseStatus)[0]}xx`;
      out.byClass[cls] = (out.byClass[cls] ?? 0) + row.count;
    }
    for (const row of zone.firewall ?? []) {
      out.firewall += row.count;
      out.firewallTop.push({ count: row.count, ...row.dimensions });
    }
    return out;
  }

  async function d1Info(databaseId) {
    const [meta, analytics] = await Promise.all([
      cf(`/accounts/${accountId}/d1/database/${databaseId}`),
      graphql(
        `query($account: String!, $db: String!, $from: Date!) {
          viewer { accounts(filter: { accountTag: $account }) {
            d1AnalyticsAdaptiveGroups(limit: 10, filter: { databaseId: $db, date_geq: $from }) { sum { readQueries writeQueries rowsRead rowsWritten } }
          } }
        }`,
        { account: accountId, db: databaseId, from: dayAgo.toISOString().slice(0, 10) },
      ).catch(() => null),
    ]);
    const sums = analytics?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups ?? [];
    const totals = sums.reduce(
      (acc, row) => ({ reads: acc.reads + row.sum.readQueries, writes: acc.writes + row.sum.writeQueries, rowsRead: acc.rowsRead + row.sum.rowsRead, rowsWritten: acc.rowsWritten + row.sum.rowsWritten }),
      { reads: 0, writes: 0, rowsRead: 0, rowsWritten: 0 },
    );
    return { name: meta.result?.name, sizeMb: Math.round(((meta.result?.file_size ?? 0) / 1_048_576) * 100) / 100, ...totals };
  }

  async function checkCloudflare(site, result) {
    result.cloudflare = {};
    if (site.worker) {
      try {
        const [today, yesterday] = await Promise.all([workerWindow(site.worker, dayAgo, now), workerWindow(site.worker, twoDaysAgo, dayAgo)]);
        result.cloudflare.worker = { today, yesterday };
        const fiveXx = sumStatus(today.byStatus, "5");
        const fourXx = sumStatus(today.byStatus, "4");
        const fourXxBefore = sumStatus(yesterday.byStatus, "4");
        if (today.errors > 0 || fiveXx > 0) note(today.errors + fiveXx > 20 ? "critical" : "warning", site.name, `Worker ${site.worker}: ${today.errors} помилок виконання, ${fiveXx} відповідей 5xx за добу (запитів ${today.requests})`);
        if (today.requests > 200 && ratio(today.requests, yesterday.requests) > 4) note("warning", site.name, `Worker ${site.worker}: трафік ×${ratio(today.requests, yesterday.requests).toFixed(1)} проти вчора (${today.requests} проти ${yesterday.requests}) — сплеск, перевірте джерело`);
        if (fourXx > 100 && ratio(fourXx, fourXxBefore) > 3) note("warning", site.name, `Worker ${site.worker}: 4xx ×${ratio(fourXx, fourXxBefore).toFixed(1)} проти вчора (${fourXx}) — схоже на сканування або биті посилання`);
        if (today.cpuP99 > 200_000) note("warning", site.name, `Worker ${site.worker}: CPU p99 ${Math.round(today.cpuP99 / 1000)} мс`);
      } catch (error) {
        result.cloudflare.workerError = String(error.message);
        note("info", site.name, `аналітика Worker недоступна: ${String(error.message).slice(0, 160)}`);
      }
      try {
        const logs = await workerErrorLogs(site.worker);
        result.cloudflare.errorLogs = logs;
        if (logs.length) note("warning", site.name, `у логах ${logs.reduce((n, l) => n + l.count, 0)} помилок за добу: ${logs.slice(0, 3).map((l) => `«${String(l.message).slice(0, 80)}» ×${l.count}`).join("; ")}`);
      } catch (error) {
        result.cloudflare.logsError = String(error.message);
        note("info", site.name, `Workers Logs недоступні: ${String(error.message).slice(0, 160)}`);
      }
    }
    if (site.zone) {
      try {
        const tag = await zoneId(site.zone);
        if (!tag) throw new Error(`зона ${site.zone} не знайдена в акаунті`);
        const [today, yesterday] = await Promise.all([zoneWindow(tag, dayAgo, now), zoneWindow(tag, twoDaysAgo, dayAgo)]);
        result.cloudflare.zone = { name: site.zone, today, yesterday };
        if (today.firewall > 0) {
          const severity = today.firewall > 500 || ratio(today.firewall, yesterday.firewall) > 3 ? "warning" : "info";
          const top = today.firewallTop.slice(0, 3).map((t) => `${t.action} ${t.source} ${t.clientCountryName} ${t.clientRequestPath} ×${t.count}`).join("; ");
          note(severity, site.name, `WAF/firewall: ${today.firewall} подій за добу (вчора ${yesterday.firewall}). Топ: ${top}`);
        }
        const five = today.byClass["5xx"] ?? 0;
        if (five > 0) note(five > 20 ? "critical" : "warning", site.name, `зона ${site.zone}: ${five} відповідей 5xx з edge за добу`);
        if (today.requests > 500 && ratio(today.requests, yesterday.requests) > 4) note("warning", site.name, `зона ${site.zone}: трафік ×${ratio(today.requests, yesterday.requests).toFixed(1)} проти вчора`);
      } catch (error) {
        result.cloudflare.zoneError = String(error.message);
        note("info", site.name, `аналітика зони недоступна: ${String(error.message).slice(0, 160)}`);
      }
    }
    if (site.d1) {
      try {
        result.cloudflare.d1 = await d1Info(site.d1);
        if (result.cloudflare.d1.sizeMb > 400) note("warning", site.name, `D1 ${result.cloudflare.d1.name}: ${result.cloudflare.d1.sizeMb} МБ — наближається до ліміту 500 МБ безкоштовного плану`);
      } catch (error) {
        result.cloudflare.d1Error = String(error.message);
        note("info", site.name, `D1 недоступна через API: ${String(error.message).slice(0, 160)}`);
      }
    }
  }

  // ----------------------------------------------------------------- run

  const results = [];
  for (const site of config.sites) {
    if (site.enabled === false) continue;
    const result = await checkSite(site);
    if (token && accountId) await checkCloudflare(site, result);
    results.push(result);
  }
  if (!token) note("info", "Cloudflare", "CLOUDFLARE_API_TOKEN не заданий — аналітика, логи, WAF і D1 не перевірялися. Як задати: health/README.md");

  const severity = findings.reduce((max, f) => Math.max(max, SEVERITY[f.severity]), 0);
  return { ranAt: now.toISOString(), severity, findings, results, markdown: renderMarkdown({ now, severity, findings, results, cloudflare: Boolean(token) }) };
}

export function renderMarkdown({ now, severity, findings, results, cloudflare }) {
  const badge = severity === 2 ? "🔴 Є критичні проблеми" : severity === 1 ? "🟡 Є попередження" : "🟢 Усе працює";
  const lines = [`# Health check · ${now.toISOString().slice(0, 16).replace("T", " ")} UTC`, "", `**${badge}** · перевірено сайтів: ${results.length} · Cloudflare: ${cloudflare ? "підключено" : "без токена, тільки зовнішні перевірки"}`, ""];

  for (const sev of ["critical", "warning", "info"]) {
    const list = findings.filter((f) => f.severity === sev);
    if (!list.length) continue;
    lines.push(`## ${sev === "critical" ? "Критично" : sev === "warning" ? "Попередження" : "Довідково"}`, "");
    for (const f of list) lines.push(`- **${f.site}:** ${f.text}`);
    lines.push("");
  }

  lines.push("## По сайтах", "", "| Сайт | Головна | мс | Запитів за добу | Помилок | Firewall | D1, МБ |", "|---|---|---|---|---|---|---|");
  for (const r of results) {
    const home = r.pages.find((p) => p.path === "/") ?? r.pages[0];
    const w = r.cloudflare?.worker?.today;
    const z = r.cloudflare?.zone?.today;
    const errors = w ? w.errors + sumStatus(w.byStatus, "5") : (z?.byClass?.["5xx"] ?? "—");
    lines.push(`| ${r.name} | ${home ? (home.error ? `✗ ${home.error}` : home.status) : "—"} | ${home?.ms ?? "—"} | ${w?.requests ?? z?.requests ?? "—"} | ${errors} | ${z?.firewall ?? "—"} | ${r.cloudflare?.d1?.sizeMb ?? "—"} |`);
  }
  lines.push("");
  for (const r of results) {
    const extra = [...r.pages.filter((p) => p.path !== "/").map((p) => `${p.path} → ${p.error ? p.error : p.status} (${p.ms} мс)`), ...r.endpoints.map((e) => `${e.method} ${e.path} → ${e.status}`)];
    if (r.cert !== null && r.cert !== undefined) extra.unshift(`TLS ${r.cert} дн.`);
    if (extra.length) lines.push(`- **${r.name}:** ${extra.join(" · ")}`);
  }
  return lines.join("\n");
}

/** The short version for a chat: the badge and the findings that matter. */
export function formatAlert(run) {
  const head = run.severity === 2 ? "🔴 DevNervs health: критично" : run.severity === 1 ? "🟡 DevNervs health: попередження" : "🟢 DevNervs health: усе працює";
  const lines = run.findings.filter((f) => f.severity !== "info").slice(0, 12).map((f) => `• ${f.site}: ${f.text}`);
  return [head, "", ...lines].join("\n").slice(0, 3900);
}

export async function notifyTelegram(doFetch, botToken, chatId, text) {
  if (!botToken || !chatId) return false;
  const response = await doFetch(`https://api.telegram.org/bot${botToken}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }) });
  return response.ok;
}
