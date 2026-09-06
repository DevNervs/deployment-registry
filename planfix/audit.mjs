/**
 * The Planfix audit itself, with nothing platform-specific in it: the same code
 * runs inside the `startime-planfix-audit` Cloudflare Worker on a cron and from
 * `node planfix/audit-cli.mjs` on a laptop. Callers hand in `fetch` and a store.
 *
 * READ ONLY. Every call this module makes is a query: `POST /task/list` (Planfix
 * spells its search endpoint as a POST) and `GET /contact/{id}`. Nothing here
 * writes to Planfix — repairing links stays a human decision, see README.
 *
 * The audit answers one question the CRM cannot answer itself: does the
 * «Остання заявка» link (field 93720) on a client chat (template 22) still point
 * at that client's newest deal (template 24)? Automessages read the amount to
 * pay through that link, so a stale link quotes the client a stranger's sum.
 */

export const TPL_CHAT = 22;
export const TPL_DEAL = 24;
export const F_LINK = 93720; // «Остання заявка» on the chat
export const F_CONTACT_LAST = 92962; // «Остання заявка» mirrored on the contact

export const SEVERITY = { ok: 0, warning: 1, critical: 2 };

/** Planfix wants DD-MM-YYYY for date filters. */
export function dmy(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${p(date.getDate())}-${p(date.getMonth() + 1)}-${date.getFullYear()}`;
}

/**
 * A thin Planfix REST client that counts its own requests, so the caller can
 * stop before it hits the Worker subrequest budget.
 */
export function createClient({ account, host = "planfix.ua", token, fetch: doFetch, timeoutMs = 25_000 }) {
  const base = `https://${account}.${host}/rest`;
  const state = { requests: 0, errors: [] };

  async function call(path, body, method = body === undefined ? "GET" : "POST") {
    for (let attempt = 0; ; attempt += 1) {
      state.requests += 1;
      try {
        const response = await doFetch(`${base}${path}`, {
          method,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await response.text();
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          throw new Error(`HTTP ${response.status}: ${text.slice(0, 120)}`);
        }
        if (json.result !== "success") throw new Error(json.error || `result=${json.result}`);
        return json;
      } catch (error) {
        if (attempt >= 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1200 * (attempt + 1)));
      }
    }
  }

  return {
    state,
    /** One page of tasks of a template. `since` (DD-MM-YYYY) filters by creation date. */
    async page(template, { fields, offset = 0, pageSize = 100, since = null, contact = null }) {
      const filters = [{ type: 51, operator: "equal", value: template }];
      if (since) filters.push({ type: 12, operator: "gt", value: { dateType: "otherDate", dateValue: since } });
      if (contact) filters.push({ type: 7, operator: "equal", value: contact });
      const json = await call("/task/list", { offset, pageSize, fields, filters });
      return json.tasks || [];
    },
    /** Every chat of one contact — the per-contact path used by the daily window pass. */
    async chatsOfContact(contactId) {
      return this.page(TPL_CHAT, { fields: `id,name,counterparty,${F_LINK}`, pageSize: 20, contact: contactId });
    },
    async contact(id, fields = `id,${F_CONTACT_LAST}`) {
      const json = await call(`/contact/${String(id).replace("contact:", "")}?fields=${fields}`);
      return json.contact;
    },
  };
}

export const customField = (task, id) => (task.customFieldData || []).find((f) => f.field.id === id)?.value;

export const contactOf = (task) => {
  const id = task.counterparty?.id;
  return id && String(id).startsWith("contact:") ? String(id) : null;
};

/**
 * Compares one chat against the newest deal known for its contact and returns a
 * finding, or null when the chat is healthy. `newest` is a row of the deal index
 * ({ deal_id, deal_name }) or undefined when the contact has no deal in scope.
 */
export function classifyChat(chat, newest) {
  const contact = contactOf(chat);
  const link = customField(chat, F_LINK);
  const chatName = (chat.name || "").slice(0, 70);
  if (!newest) return null; // no deal in the scanned window — nothing to compare against
  if (!link) {
    return { kind: "missing", chat: chat.id, chatName, contact, should: newest.deal_id, shouldName: newest.deal_name };
  }
  if (link.id === newest.deal_id) return null;
  return {
    kind: "stale",
    chat: chat.id,
    chatName,
    contact,
    old: link.id,
    oldName: (link.name || "").slice(0, 60),
    should: newest.deal_id,
    shouldName: newest.deal_name,
  };
}

const KIND_TITLE = {
  stale: "Протухшие ссылки «Остання заявка»",
  missing: "Чаты со сделкой, но с пустой ссылкой",
  no_chat: "Контакты со свежей сделкой, но без чата",
  multi_chat: "Контакты, у которых чаты ссылаются на разные сделки",
  orphan_deal: "Сделки без контакта",
  api_error: "Ошибки Planfix API",
};

const KIND_WHY = {
  stale: "клиенту в автосообщение подставится сумма доплаты из чужой или прошлогодней сделки (кейс 343436)",
  missing: "переменные в автосообщениях останутся пустыми — клиент получит письмо без суммы",
  no_chat: "автосообщения по этой сделке слать некуда",
  multi_chat: "у контакта несколько чатов, и они ведут на разные сделки — кому-то уйдёт чужая сумма",
  orphan_deal: "сделка не привязана к контакту, сценарий её не увидит",
  api_error: "часть базы не проверена, цифры ниже неполные",
};

/**
 * Builds the Markdown report the cloud routine reads out of D1. `previous` is
 * the stats object of the last finished run of the same kind, or null.
 */
export function buildReport({ kind, windowDays, ranAt, stats, findings, previous = null, truncated = false }) {
  const byKind = new Map();
  for (const f of findings) {
    if (!byKind.has(f.kind)) byKind.set(f.kind, []);
    byKind.get(f.kind).push(f);
  }
  const count = (k) => (byKind.get(k) || []).length;
  const stale = count("stale");
  const apiErrors = count("api_error");

  // A handful of stale links is the normal daily drip of scenario 95544 missing
  // an update; dozens mean the scenario is broken again, which is a different
  // conversation than «почини эти пять чатов».
  let severity = SEVERITY.ok;
  if (stale > 0 || count("missing") > 0 || count("multi_chat") > 0) severity = SEVERITY.warning;
  // (multi_chat здесь — уже только конфликтующие чаты, см. worker.mjs)
  if (stale >= 50 || apiErrors > 20 || stats.scanned === 0) severity = SEVERITY.critical;

  const scope = windowDays ? `сделки за ${windowDays} дн.` : "вся база";
  const head =
    severity === SEVERITY.ok ? "🟢 Чисто" : severity === SEVERITY.warning ? "🟡 Есть находки" : "🔴 Требует внимания";

  const lines = [];
  lines.push(`# Planfix · аудит ссылок «Остання заявка» · ${ranAt.slice(0, 16).replace("T", " ")} UTC`);
  lines.push("");
  lines.push(
    `**${head}** · режим: ${kind === "weekly" ? "недельный полный" : "ежедневный"} (${scope}) · ` +
      `чатов просмотрено: ${stats.scanned} · контактов со сделками: ${stats.contacts} · запросов к API: ${stats.requests}`,
  );
  if (truncated) {
    lines.push("");
    lines.push("> ⚠️ Проход оборван по лимиту времени: часть базы не просмотрена, цифры ниже неполные.");
  }
  lines.push("");

  lines.push("## Сводка");
  lines.push("");
  lines.push("| Находка | Сейчас | Прошлый раз |");
  lines.push("|---|---:|---:|");
  for (const k of ["stale", "missing", "no_chat", "multi_chat", "orphan_deal", "api_error"]) {
    const prev = previous?.byKind?.[k];
    lines.push(`| ${KIND_TITLE[k]} | ${count(k)} | ${prev === undefined ? "—" : prev} |`);
  }
  lines.push(`| Ссылка актуальна | ${stats.ok} | ${previous?.ok ?? "—"} |`);
  lines.push(
    `| _справочно:_ контакты с 2+ чатами | ${stats.multiChat ?? "—"} | ${previous?.multiChat ?? "—"} |`,
  );
  lines.push("");

  // Whether scenario 95544 is doing its job: of the deals created in the last
  // 24 h, how many already have their chat pointing at them.
  if (stats.fresh?.total) {
    const share = Math.round((stats.fresh.linked / stats.fresh.total) * 100);
    lines.push(
      `**Сценарий 95544 за сутки:** новых сделок ${stats.fresh.total}, ссылка обновлена у ${stats.fresh.linked} (${share}%).` +
        (share < 80 ? " Похоже, сценарий снова не отрабатывает — см. KB.md, раздел «Кейс»." : ""),
    );
    lines.push("");
  }

  for (const [k, items] of byKind) {
    if (!items.length) continue;
    lines.push(`## ${KIND_TITLE[k]} — ${items.length}`);
    lines.push("");
    lines.push(`_Почему важно: ${KIND_WHY[k]}._`);
    lines.push("");
    for (const f of items.slice(0, 25)) {
      if (k === "stale") {
        lines.push(`- чат ${f.chat} «${f.chatName}» → сейчас ${f.old} «${f.oldName}», должен ${f.should} «${f.shouldName}»`);
      } else if (k === "missing") {
        lines.push(`- чат ${f.chat} «${f.chatName}» → ссылка пустая, должна вести на ${f.should} «${f.shouldName}»`);
      } else if (k === "no_chat") {
        lines.push(`- контакт ${f.contact} → сделка ${f.should} «${f.shouldName}», чата нет`);
      } else if (k === "multi_chat") {
        lines.push(`- контакт ${f.contact} → чаты ${f.chats.join(", ")}`);
      } else if (k === "orphan_deal") {
        lines.push(`- сделка ${f.deal} «${f.dealName}»`);
      } else {
        lines.push(`- ${f.detail}`);
      }
    }
    if (items.length > 25) lines.push(`- …и ещё ${items.length - 25} (полный список в таблице findings этой D1)`);
    lines.push("");
  }

  if (severity === SEVERITY.ok) {
    lines.push("Расхождений нет: у каждого просмотренного чата ссылка ведёт на самую свежую сделку контакта.");
    lines.push("");
  }

  return { severity, markdown: lines.join("\n"), byKind: Object.fromEntries([...byKind].map(([k, v]) => [k, v.length])) };
}
