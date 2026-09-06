# Planfix · аудит ссылок «Остання заявка»

Ежедневная и недельная проверка CRM Star Time (`startime.planfix.ua`) на расхождения между чатами клиентов и их сделками. **Только чтение** — починку делает человек.

## Зачем

В чат-задачах клиентов (шаблон 22) поле **93720 «Остання заявка»** ссылается на актуальную сделку клиента (шаблон 24). Автосообщения тянут через эту ссылку «Суму доплати». Если сценарий 95544 не обновил ссылку при появлении новой сделки — клиенту уходит чужая сумма. Так уже была реальная жалоба (кейс 343436).

## Три части

1. **Worker `startime-planfix-audit`** (Cloudflare, cron `*/2 * * * *`). Один тик = продолжение текущего задания на фиксированный бюджет запросов к Planfix. Так полный проход по базе (40 000+ сделок и столько же чатов) размазывается по многим вызовам и не упирается в лимиты воркера. Результат — в своей D1 `startime-planfix-audit` (`b3e76997-eae3-40c0-85c2-91fab696dba7`).
   - **daily** — старт после 03:00 UTC, окно `DAILY_WINDOW_DAYS` (по умолчанию 14 дней сделок), ~450 запросов, ~15 минут.
   - **weekly** — старт в воскресенье, вся база, ~800+ запросов, ~2–3 часа.
2. **Облачная рутина Claude «Planfix: аудит ссылок «Остання заявка»»** (9:00 по Киеву, модель Opus 5). Читает последний запуск из D1 через Cloudflare-коннектор, сравнивает с предыдущим днём, объясняет находки и пишет, что делать. Прямого доступа к planfix.ua у облачной песочницы нет — прокси режет `CONNECT`, поэтому проверку и делает воркер.
3. **`node scripts/planfix-link-doctor.mjs` в «Star Time работа»** — тот же разбор руками с ноутбука, и единственное место, где есть флаг `--fix`.

## Что проверяется

| Находка | Что значит |
|---|---|
| `stale` | ссылка ведёт не на самую свежую сделку контакта — клиенту уйдёт чужая сумма |
| `missing` | ссылка пустая, хотя сделка есть — в письме не будет суммы |
| `no_chat` | у контакта свежая сделка, но чата нет — автосообщения слать некуда |
| `multi_chat` | у контакта несколько чатов, и они ведут на **разные** сделки |
| `orphan_deal` | сделка без контакта-контрагента |
| `api_error` | Planfix не ответил, часть базы не просмотрена |

Плюс здоровье сценария 95544: доля сделок за сутки, у которых ссылка уже актуальна (`stats.fresh`).

## Таблицы D1

`jobs` — состояние заданий (фаза, курсор, счётчики). `deal_index` — самая свежая сделка каждого контакта в рамках задания. `chat_seen` — какие чаты видели и куда они ссылались. `findings` — находки. `runs` — готовые отчёты (`report_md`), хранится 60 последних.

## Деплой и секреты

```bash
npx wrangler deploy --config planfix/wrangler.jsonc
npx wrangler secret put PLANFIX_TOKEN --config planfix/wrangler.jsonc    # Planfix → Управление аккаунтом → Доступ к API → REST API
npx wrangler secret put PLANFIX_ACCOUNT --config planfix/wrangler.jsonc  # startime
npx wrangler secret put PLANFIX_HOST --config planfix/wrangler.jsonc     # planfix.ua
npx wrangler secret put AUDIT_KEY --config planfix/wrangler.jsonc        # любая длинная строка; открывает HTTP-эндпоинты
```

`AUDIT_KEY` лежит в `«Star Time работа»/.secrets/env` как `STARTIME_AUDIT_KEY` (файл в `.gitignore`).

## Ручное управление

```bash
curl -H "Authorization: Bearer $KEY" https://startime-planfix-audit.boris-reminder.workers.dev/latest         # последний отчёт
curl -H "Authorization: Bearer $KEY" .../latest?kind=weekly                                                   # последний полный проход
curl -H "Authorization: Bearer $KEY" .../status                                                               # что сейчас делает воркер
curl -X POST -H "Authorization: Bearer $KEY" ".../tick?kind=daily&days=14"                                    # запустить задание сейчас
curl -X POST -H "Authorization: Bearer $KEY" .../tick                                                         # прокрутить один тик вручную
```

## Бюджеты

`CHUNK_DEAL_PAGES` / `CHUNK_CHAT_PAGES` (страниц по 100 задач за тик) и `CHUNK_CONTACTS` (запросов чатов по контактам за тик) в `wrangler.jsonc`. Сейчас 25/25/60 — проверено, что укладывается. Если полный проход станет слишком долгим, эти числа можно поднимать, пока воркер не начнёт упираться в лимит подзапросов.

## Чего эта проверка НЕ делает

Не чинит. Никаких записей в Planfix — только `POST /task/list` (это поисковый запрос) и `GET /contact/{id}`. Починка — вручную:

```bash
cd "/Users/boris/Documents/Star Time работа"
node scripts/planfix-link-doctor.mjs --since DD-MM-YYYY --fix
```
