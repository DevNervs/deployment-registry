/**
 * The `startime-planfix-audit` Cloudflare Worker: audits the «Остання заявка»
 * links in the Star Time Planfix account on a cron and keeps the results in its
 * own D1 (`startime-planfix-audit`), so the daily Claude routine can read them
 * through the Cloudflare connector. The cloud sandbox a routine runs in cannot
 * reach planfix.ua at all (the egress proxy refuses the CONNECT), which is the
 * whole reason this Worker exists.
 *
 * READ ONLY against Planfix — see planfix/audit.mjs. Repairs stay manual.
 *
 * A full pass over the base is far more work than one Worker invocation may do,
 * so a run is a *job* that survives across invocations: every cron tick picks up
 * the job where the last tick left it (phase + cursor in D1) and spends a fixed
 * budget of Planfix requests. The daily job covers a short window of deals; the
 * Sunday job covers the whole base.
 *
 * Secrets: PLANFIX_TOKEN, PLANFIX_ACCOUNT, PLANFIX_HOST (optional, default
 * planfix.ua), AUDIT_KEY (guards the HTTP endpoints). See planfix/README.md.
 */

import {
  TPL_CHAT,
  TPL_DEAL,
  F_LINK,
  buildReport,
  classifyChat,
  contactOf,
  createClient,
  customField,
  dmy,
} from "./audit.mjs";

const KEEP_RUNS = 60;
const PAGE = 100;

/** How much Planfix work one cron tick may do. Deliberately small by default so
 *  the Worker stays inside the free plan's per-invocation limits; raise via vars
 *  once the account is known to be on the paid plan. */
const budgets = (env) => ({
  dealPages: Number(env.CHUNK_DEAL_PAGES || 6),
  chatPages: Number(env.CHUNK_CHAT_PAGES || 6),
  contacts: Number(env.CHUNK_CONTACTS || 30),
});

async function ensureSchema(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL, window_days INTEGER,
      started_at TEXT NOT NULL, finished_at TEXT,
      phase TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0,
      ticks INTEGER NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0,
      stats TEXT NOT NULL DEFAULT '{}', error TEXT)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS deal_index (
      job_id INTEGER NOT NULL, contact TEXT NOT NULL,
      deal_id INTEGER NOT NULL, deal_name TEXT, fresh INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (job_id, contact))`),
    db.prepare(`CREATE TABLE IF NOT EXISTS chat_seen (
      job_id INTEGER NOT NULL, contact TEXT NOT NULL, chat_id INTEGER NOT NULL,
      link_id INTEGER,
      PRIMARY KEY (job_id, chat_id))`),
    db.prepare(`CREATE TABLE IF NOT EXISTS findings (
      job_id INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, job_id INTEGER, kind TEXT NOT NULL,
      ran_at TEXT NOT NULL, severity INTEGER NOT NULL, report_md TEXT NOT NULL,
      stats TEXT NOT NULL, findings TEXT NOT NULL)`),
  ]);
}

const client = (env) =>
  createClient({
    account: env.PLANFIX_ACCOUNT,
    host: env.PLANFIX_HOST || "planfix.ua",
    token: env.PLANFIX_TOKEN,
    fetch: (url, init) => fetch(url, init),
  });

const readStats = (job) => JSON.parse(job.stats || "{}");
const writeStats = (db, job, stats) =>
  db.prepare("UPDATE jobs SET stats = ? WHERE id = ?").bind(JSON.stringify(stats), job.id).run();

async function addFindings(db, jobId, items) {
  if (!items.length) return;
  await db.batch(
    items.map((item) =>
      db.prepare("INSERT INTO findings (job_id, kind, detail) VALUES (?, ?, ?)").bind(jobId, item.kind, JSON.stringify(item)),
    ),
  );
}

/** Starts a job unless one of that kind already ran within `sinceHours`. */
async function startJob(db, kind, windowDays, sinceHours) {
  // started_at is an ISO string, so the cutoff has to be one too: SQLite's own
  // datetime() renders "YYYY-MM-DD HH:MM:SS" and would compare wrong against the
  // "T" in ISO — every same-day job looked recent and nothing ever started.
  const cutoff = new Date(Date.now() - sinceHours * 3_600_000).toISOString();
  const recent = await db
    .prepare("SELECT id FROM jobs WHERE kind = ? AND started_at > ? LIMIT 1")
    .bind(kind, cutoff)
    .first();
  if (recent) return null;
  const row = await db
    .prepare("INSERT INTO jobs (kind, window_days, started_at, phase) VALUES (?, ?, ?, 'deals') RETURNING *")
    .bind(kind, windowDays, new Date().toISOString())
    .first();
  return row;
}

/**
 * Phase «deals»: pages through the deals in scope and keeps, per contact, the
 * newest one. That map is what every chat is later compared against.
 */
async function stepDeals(env, db, job, api) {
  const { dealPages } = budgets(env);
  const stats = readStats(job);
  const since = job.window_days ? dmy(new Date(Date.now() - job.window_days * 86_400_000)) : null;
  const dayAgo = Date.now() - 86_400_000;
  let offset = job.cursor;
  let done = false;
  const orphans = [];

  for (let i = 0; i < dealPages; i += 1) {
    const tasks = await api.page(TPL_DEAL, { fields: "id,name,counterparty,dateTime", offset, pageSize: PAGE, since });
    const rows = new Map();
    for (const task of tasks) {
      const contact = contactOf(task);
      if (!contact) {
        if (orphans.length < 200) orphans.push({ kind: "orphan_deal", deal: task.id, dealName: (task.name || "").slice(0, 60) });
        continue;
      }
      const created = Date.parse(task.dateTime?.dateTimeUtcSeconds || task.dateTime?.datetime || "") || 0;
      const prev = rows.get(contact);
      if (!prev || task.id > prev.id) rows.set(contact, { id: task.id, name: (task.name || "").slice(0, 60), fresh: created > dayAgo ? 1 : 0 });
    }
    if (rows.size) {
      // «keep the newest» has to hold across pages too, hence the max() upsert.
      await db.batch(
        [...rows].map(([contact, deal]) =>
          db
            .prepare(
              `INSERT INTO deal_index (job_id, contact, deal_id, deal_name, fresh) VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(job_id, contact) DO UPDATE SET
                 deal_name = CASE WHEN excluded.deal_id > deal_index.deal_id THEN excluded.deal_name ELSE deal_index.deal_name END,
                 fresh = CASE WHEN excluded.deal_id > deal_index.deal_id THEN excluded.fresh ELSE deal_index.fresh END,
                 deal_id = MAX(deal_index.deal_id, excluded.deal_id)`,
            )
            .bind(job.id, contact, deal.id, deal.name, deal.fresh),
        ),
      );
    }
    stats.deals = (stats.deals || 0) + tasks.length;
    offset += PAGE;
    if (tasks.length < PAGE) {
      done = true;
      break;
    }
  }

  await addFindings(db, job.id, orphans);
  stats.orphanDeals = (stats.orphanDeals || 0) + orphans.length;
  await writeStats(db, job, stats);
  await db
    .prepare("UPDATE jobs SET phase = ?, cursor = ?, requests = requests + ? WHERE id = ?")
    .bind(done ? "chats" : "deals", done ? 0 : offset, api.state.requests, job.id)
    .run();
}

/**
 * Phase «chats», windowed variant: only the contacts that got a deal inside the
 * window can have gone stale, so ask Planfix for their chats one contact at a
 * time. Fewer requests than pulling every chat in the account.
 */
async function stepChatsByContact(env, db, job, api) {
  const { contacts: budget } = budgets(env);
  const stats = readStats(job);
  const rows = (
    await db
      .prepare("SELECT contact, deal_id, deal_name FROM deal_index WHERE job_id = ? ORDER BY contact LIMIT ? OFFSET ?")
      .bind(job.id, budget, job.cursor)
      .all()
  ).results;

  const findings = [];
  const seen = [];
  for (const row of rows) {
    let chats;
    try {
      chats = await api.chatsOfContact(row.contact);
    } catch (error) {
      findings.push({ kind: "api_error", detail: `контакт ${row.contact}: ${String(error.message).slice(0, 120)}` });
      continue;
    }
    if (!chats.length) {
      findings.push({ kind: "no_chat", contact: row.contact, should: row.deal_id, shouldName: row.deal_name });
      continue;
    }
    if (chats.length > 1) {
      stats.multiChat = (stats.multiChat || 0) + 1;
      // Несколько чатов у контакта — обычное дело за годы переписки. Опасно
      // другое: когда два чата ведут на РАЗНЫЕ сделки, тогда одному из клиентов
      // уйдёт чужая сумма. Дубли без расхождения остаются справочной цифрой.
      const linked = chats.map((c) => customField(c, F_LINK)?.id).filter(Boolean);
      if (new Set(linked).size > 1) {
        findings.push({ kind: "multi_chat", contact: row.contact, chats: chats.map((c) => c.id) });
      }
    }
    for (const chat of chats) {
      seen.push(chat.id);
      stats.scanned = (stats.scanned || 0) + 1;
      const finding = classifyChat(chat, row);
      if (finding) findings.push(finding);
      else if (customField(chat, F_LINK)) stats.ok = (stats.ok || 0) + 1;
    }
  }

  await addFindings(db, job.id, findings);
  await writeStats(db, job, stats);
  const done = rows.length < budget;
  await db
    .prepare("UPDATE jobs SET phase = ?, cursor = ?, requests = requests + ? WHERE id = ?")
    .bind(done ? "report" : "chats", done ? 0 : job.cursor + rows.length, api.state.requests, job.id)
    .run();
}

/**
 * Phase «chats», full variant: for the weekly pass every chat in the account is
 * cheaper to page through in hundreds than to ask for contact by contact.
 */
async function stepChatsFull(env, db, job, api) {
  const { chatPages } = budgets(env);
  const stats = readStats(job);
  let offset = job.cursor;
  let done = false;
  const findings = [];

  for (let i = 0; i < chatPages; i += 1) {
    const chats = await api.page(TPL_CHAT, { fields: `id,name,counterparty,${F_LINK}`, offset, pageSize: PAGE });
    const wanted = [...new Set(chats.map((c) => contactOf(c)).filter(Boolean))];
    const index = new Map();
    if (wanted.length) {
      const placeholders = wanted.map(() => "?").join(",");
      const rows = (
        await db
          .prepare(`SELECT contact, deal_id, deal_name FROM deal_index WHERE job_id = ? AND contact IN (${placeholders})`)
          .bind(job.id, ...wanted)
          .all()
      ).results;
      for (const row of rows) index.set(row.contact, row);
    }
    const seenRows = [];
    for (const chat of chats) {
      const contact = contactOf(chat);
      stats.scanned = (stats.scanned || 0) + 1;
      if (contact) seenRows.push({ contact, id: chat.id, link: customField(chat, F_LINK)?.id ?? null });
      const finding = classifyChat(chat, contact ? index.get(contact) : undefined);
      if (finding) findings.push(finding);
      else if (contact && index.get(contact) && customField(chat, F_LINK)) stats.ok = (stats.ok || 0) + 1;
    }
    if (seenRows.length) {
      await db.batch(
        seenRows.map((row) =>
          db
            .prepare("INSERT OR IGNORE INTO chat_seen (job_id, contact, chat_id, link_id) VALUES (?, ?, ?, ?)")
            .bind(job.id, row.contact, row.id, row.link),
        ),
      );
    }
    offset += PAGE;
    if (chats.length < PAGE) {
      done = true;
      break;
    }
  }

  await addFindings(db, job.id, findings);
  await writeStats(db, job, stats);
  await db
    .prepare("UPDATE jobs SET phase = ?, cursor = ?, requests = requests + ? WHERE id = ?")
    .bind(done ? "report" : "chats", done ? 0 : offset, api.state.requests, job.id)
    .run();
}

/** Phase «report»: turns the rows this job collected into one stored run. */
async function stepReport(db, job) {
  const stats = readStats(job);
  const jobRow = await db.prepare("SELECT * FROM jobs WHERE id = ?").bind(job.id).first();
  stats.requests = jobRow.requests;
  stats.contacts = (await db.prepare("SELECT COUNT(*) AS n FROM deal_index WHERE job_id = ?").bind(job.id).first()).n;
  stats.scanned = stats.scanned || 0;
  stats.ok = stats.ok || 0;

  const findings = (await db.prepare("SELECT kind, detail FROM findings WHERE job_id = ?").bind(job.id).all()).results.map(
    (row) => ({ ...JSON.parse(row.detail), kind: row.kind }),
  );

  // The full pass sees every chat, so contacts without one and contacts with
  // several only fall out at the end, once all chats are in.
  if (!job.window_days) {
    const orphanContacts = (
      await db
        .prepare(
          `SELECT d.contact, d.deal_id, d.deal_name FROM deal_index d
           LEFT JOIN chat_seen s ON s.job_id = d.job_id AND s.contact = d.contact
           WHERE d.job_id = ? AND s.chat_id IS NULL AND d.fresh = 1 LIMIT 300`,
        )
        .bind(job.id)
        .all()
    ).results;
    for (const row of orphanContacts) findings.push({ kind: "no_chat", contact: row.contact, should: row.deal_id, shouldName: row.deal_name });
    stats.multiChat = (
      await db
        .prepare("SELECT COUNT(*) AS n FROM (SELECT contact FROM chat_seen WHERE job_id = ? GROUP BY contact HAVING COUNT(*) > 1)")
        .bind(job.id)
        .first()
    ).n;
    const multi = (
      await db
        .prepare(
          `SELECT contact, GROUP_CONCAT(chat_id) AS ids FROM chat_seen WHERE job_id = ?
           GROUP BY contact HAVING COUNT(DISTINCT link_id) > 1 LIMIT 300`,
        )
        .bind(job.id)
        .all()
    ).results;
    for (const row of multi) findings.push({ kind: "multi_chat", contact: row.contact, chats: String(row.ids).split(",") });
  }

  // Is scenario 95544 keeping up? Of the deals created in the last 24 h, how
  // many already have their chat pointing at them.
  const freshTotal = (await db.prepare("SELECT COUNT(*) AS n FROM deal_index WHERE job_id = ? AND fresh = 1").bind(job.id).first()).n;
  if (freshTotal) {
    const freshContacts = new Set(
      (await db.prepare("SELECT contact FROM deal_index WHERE job_id = ? AND fresh = 1").bind(job.id).all()).results.map((r) => r.contact),
    );
    const broken = new Set(findings.filter((f) => ["stale", "missing", "no_chat"].includes(f.kind) && freshContacts.has(f.contact)).map((f) => f.contact));
    stats.fresh = { total: freshTotal, linked: freshTotal - broken.size };
  }

  const previousRow = await db
    .prepare("SELECT stats FROM runs WHERE kind = ? ORDER BY id DESC LIMIT 1")
    .bind(job.kind)
    .first();
  const previous = previousRow ? JSON.parse(previousRow.stats) : null;

  const ranAt = new Date().toISOString();
  const report = buildReport({ kind: job.kind, windowDays: job.window_days, ranAt, stats, findings, previous });
  stats.byKind = report.byKind;

  await db
    .prepare("INSERT INTO runs (job_id, kind, ran_at, severity, report_md, stats, findings) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(job.id, job.kind, ranAt, report.severity, report.markdown, JSON.stringify(stats), JSON.stringify(findings.slice(0, 500)))
    .run();
  await db.prepare("UPDATE jobs SET phase = 'done', finished_at = ?, stats = ? WHERE id = ?").bind(ranAt, JSON.stringify(stats), job.id).run();

  // Keep the run history, drop the bulky per-job scratch of finished jobs.
  await db.batch([
    db.prepare(`DELETE FROM runs WHERE id NOT IN (SELECT id FROM runs ORDER BY id DESC LIMIT ${KEEP_RUNS})`),
    db.prepare("DELETE FROM deal_index WHERE job_id IN (SELECT id FROM jobs WHERE finished_at IS NOT NULL AND id <> ?)").bind(job.id),
    db.prepare("DELETE FROM chat_seen WHERE job_id IN (SELECT id FROM jobs WHERE finished_at IS NOT NULL AND id <> ?)").bind(job.id),
    db.prepare("DELETE FROM findings WHERE job_id IN (SELECT id FROM jobs WHERE finished_at IS NOT NULL AND id <> ?)").bind(job.id),
    db.prepare("DELETE FROM jobs WHERE finished_at IS NOT NULL AND id NOT IN (SELECT id FROM jobs ORDER BY id DESC LIMIT 20)"),
  ]);
  return report;
}

/** One cron tick: continue the job in flight, or start the one that is due. */
async function tick(env, { force = null } = {}) {
  const db = env.AUDIT_DB;
  await ensureSchema(db);

  let job = await db.prepare("SELECT * FROM jobs WHERE finished_at IS NULL AND phase <> 'failed' ORDER BY id DESC LIMIT 1").first();

  if (!job) {
    const now = new Date();
    if (force) {
      job = await startJob(db, force.kind, force.windowDays, 0);
    } else if (now.getUTCDay() === 0) {
      // Sunday: the full pass first, and the daily one after it, if there is
      // still time. Both are «start unless one already started recently»
      // rather than «start at exactly this hour», so a long weekly pass
      // spilling past 03:00 does not swallow that day's daily report.
      job = (await startJob(db, "weekly", null, 144)) || (now.getUTCHours() >= 3 ? await startJob(db, "daily", Number(env.DAILY_WINDOW_DAYS || 14), 20) : null);
    } else if (now.getUTCHours() >= 3) {
      job = await startJob(db, "daily", Number(env.DAILY_WINDOW_DAYS || 14), 20);
    }
    if (!job) return { idle: true };
  }

  // A job that cannot finish must not block tomorrow's; give it a hard deadline.
  const ageHours = (Date.now() - Date.parse(job.started_at)) / 3_600_000;
  if (ageHours > Number(env.JOB_DEADLINE_HOURS || 14)) {
    await db.prepare("UPDATE jobs SET phase = 'failed', finished_at = ?, error = ? WHERE id = ?")
      .bind(new Date().toISOString(), `не уложился в ${env.JOB_DEADLINE_HOURS || 14} ч, оборван на фазе ${job.phase}`, job.id)
      .run();
    return { failed: job.id };
  }

  const api = client(env);
  try {
    if (job.phase === "deals") await stepDeals(env, db, job, api);
    else if (job.phase === "chats") {
      if (job.window_days) await stepChatsByContact(env, db, job, api);
      else await stepChatsFull(env, db, job, api);
    }
    const after = await db.prepare("SELECT * FROM jobs WHERE id = ?").bind(job.id).first();
    if (after.phase === "report") {
      const report = await stepReport(db, after);
      return { finished: job.id, severity: report.severity };
    }
    await db.prepare("UPDATE jobs SET ticks = ticks + 1 WHERE id = ?").bind(job.id).run();
    return { job: job.id, phase: after.phase, cursor: after.cursor };
  } catch (error) {
    await addFindings(db, job.id, [{ kind: "api_error", detail: String(error.message).slice(0, 200) }]);
    await db.prepare("UPDATE jobs SET ticks = ticks + 1 WHERE id = ?").bind(job.id).run();
    console.error("planfix audit tick failed", error);
    return { job: job.id, error: String(error.message).slice(0, 200) };
  }
}

/** Constant-time compare, so the key cannot be guessed character by character. */
function sameKey(given, expected) {
  if (!given || !expected || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i += 1) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      tick(env).then((result) => console.log("planfix audit tick", JSON.stringify(result))),
    );
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const given = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? url.searchParams.get("key");
    if (!sameKey(given, env.AUDIT_KEY)) return new Response("not found", { status: 404 });
    const db = env.AUDIT_DB;
    await ensureSchema(db);

    if (url.pathname === "/tick" && request.method === "POST") {
      const kind = url.searchParams.get("kind");
      const force = kind ? { kind, windowDays: kind === "weekly" ? null : Number(url.searchParams.get("days") || env.DAILY_WINDOW_DAYS || 14) } : null;
      return Response.json(await tick(env, { force }));
    }
    if (url.pathname === "/status") {
      const job = await db.prepare("SELECT * FROM jobs ORDER BY id DESC LIMIT 1").first();
      const run = await db.prepare("SELECT id, kind, ran_at, severity FROM runs ORDER BY id DESC LIMIT 1").first();
      return Response.json({ job, lastRun: run });
    }
    if (url.pathname === "/latest" || url.pathname === "/latest.json") {
      const kind = url.searchParams.get("kind");
      const row = kind
        ? await db.prepare("SELECT * FROM runs WHERE kind = ? ORDER BY id DESC LIMIT 1").bind(kind).first()
        : await db.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT 1").first();
      if (!row) return new Response("Ещё ни одного запуска.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
      if (url.pathname === "/latest.json") {
        return Response.json({ ranAt: row.ran_at, kind: row.kind, severity: row.severity, stats: JSON.parse(row.stats), findings: JSON.parse(row.findings) });
      }
      return new Response(row.report_md, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
    }
    return new Response("not found", { status: 404 });
  },
};
