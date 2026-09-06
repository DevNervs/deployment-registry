# Health check

Ежедневная проверка здоровья всех сайтов DevNervs. Три части:

1. **Worker `devnervs-health`** (Cloudflare, cron `40 4 * * *` UTC, то есть 07:40 по Киеву летом). Обходит сайты из `health/sites.json`, при наличии токена читает аналитику, логи и WAF Cloudflare, пишет отчёт в свою D1 `devnervs-health` (таблица `runs`, хранится 60 последних) и при проблемах шлёт сводку в Telegram. Бесплатно: cron-триггеры и D1 входят в бесплатный план Workers.
2. **Облачная рутина Claude «DevNervs health check»** (08:00 по Киеву). Читает последний запуск из D1 через Cloudflare-коннектор, добирает воркеры и заявки в базах BUDni, сравнивает с прошлыми днями, объясняет находки и пишет, что делать. Результат: https://claude.ai/code/routines
3. **`node health/check.mjs`** — тот же скрипт руками с ноутбука, плюс срок TLS-сертификатов.
4. **Проверка воскресной трансляции** (тот же воркер, cron `15 7 * * SUN` и `15 14 * * SUN` — служения в 10:00 и 17:00 по Киеву). Спрашивает обе стороны: `/api/youtube-live` самого сайта (именно его опрашивает браузер каждого посетителя) и живую страницу YouTube-канала, и ищет расхождение — эфир идёт, а сайт его не показывает, или наоборот. Пишет в ту же D1, таблица `live_runs` (40 последних). Читает результат облачная рутина Claude «Єммануїл: воскресная трансляция» в 10:40 по Киеву.

   Важно: кнопка «Дивитися онлайн» и плеер рисуются в браузере (`"use client"` + опрос `/api/youtube-live`), в серверном HTML их нет никогда — поэтому проверяется ответ API, а не разметка. И «эфир идёт» на YouTube определяется только по `liveBroadcastDetails.isLiveNow`: более общие маркеры вроде `"isLive":true` есть и у завершённой, и у запланированной трансляции.

   Посмотреть руками: `https://devnervs-health.boris-reminder.workers.dev/live/latest?key=HEALTH_KEY`, запустить сейчас — `POST /live/run`.

## Что проверяется

**Снаружи (без токенов):** статус и время ответа страниц из `paths`, текст-маркер на главной, заголовки безопасности, ожидаемый `noindex`, тексты ошибок («Application error», «Щось зламалося»), поведение API на неправильный ввод (`POST /api/lead` с пустым телом обязан дать 400, а не 500).

**Со стороны Cloudflare (`CLOUDFLARE_API_TOKEN`):** запросы, ошибки, 4xx/5xx и CPU каждого Worker за сутки против прошлых суток (сплеск ×4, рост 4xx ×3 — признак сканирования или атаки); строки уровня `error` из Workers Logs; WAF/firewall-события зоны с топом по действию, источнику, стране и пути; доля 5xx с edge; размер и нагрузка D1. Cloudflare режет атаки сам, но молча — отчёт собирает это в одно место и добавляет то, чего у Cloudflare нет: реальные ответы страниц, контент, контракты API.

## Деплой и секреты

```bash
npx wrangler deploy --config health/wrangler.jsonc
npx wrangler secret put HEALTH_KEY --config health/wrangler.jsonc              # любая длинная строка; открывает /latest и /run
npx wrangler secret put CLOUDFLARE_API_TOKEN --config health/wrangler.jsonc   # см. ниже
npx wrangler secret put HEALTH_TELEGRAM_BOT_TOKEN --config health/wrangler.jsonc   # необязательно
npx wrangler secret put HEALTH_TELEGRAM_CHAT_ID --config health/wrangler.jsonc     # необязательно
```

Посмотреть последний отчёт: `https://devnervs-health.boris-reminder.workers.dev/latest?key=HEALTH_KEY` (или `/latest.json`). Запустить проверку сейчас: `curl -X POST -H "Authorization: Bearer HEALTH_KEY" https://devnervs-health.boris-reminder.workers.dev/run`.

Токен Cloudflare (только чтение): Dashboard → My Profile → API Tokens → Create Token → Custom:

| Область | Право |
|---|---|
| Account · Account Analytics | Read |
| Account · Workers Scripts | Read |
| Account · Workers Observability | Read |
| Account · D1 | Read |
| Zone · Zone | Read |
| Zone · Analytics | Read |
| Zone · Firewall Services | Read |

Без токена работает только внешний слой; в отчёте так и написано.

## Как добавить или поменять сайт

Правится только `health/sites.json`, потом `npx wrangler deploy --config health/wrangler.jsonc`. Поля:

```jsonc
{
  "name": "BUDni",                     // как называть в отчёте
  "url": "https://budni.example",      // origin
  "paths": ["/", "/sitemap.xml"],      // страницы, которые должны отвечать
  "expectStatus": { "/admin": 307 },  // если для пути ожидается не 200
  "expectText": "BUDni",               // маркер на главной
  "expectIndexable": true,             // true = должен индексироваться, false = должен быть noindex
  "securityHeaders": true,             // требовать HSTS/CSP/X-Frame-Options/nosniff/Referrer-Policy
  "slowMs": 3000,                      // порог «повільно»
  "endpoints": [{ "method": "POST", "path": "/api/lead", "body": {}, "expectStatus": 400, "why": "валидация формы" }],
  "worker": "budni-preview",           // имя Worker в Cloudflare (для аналитики и логов)
  "zone": "budni.example",             // домен-зона в Cloudflare (для WAF и edge-статистики)
  "d1": "724d4e5a-…",                  // id базы D1
  "enabled": true
}
```

Переезд сайта на новый домен = поменять `url`, добавить `zone`, поставить `expectIndexable: true`, задеплоить воркер. Бесплатный план Workers даёт 50 подзапросов на один запуск — держите сумму `paths` + `endpoints` + Cloudflare-запросов ниже этого (сейчас ~18 внешних + до 30 к API при токене).

## Где лежит история

D1 `devnervs-health` (id `92f0291a-e004-4ceb-891e-c17cad2582d2`), таблица `runs`: `ran_at`, `severity` (0/1/2), `report_md`, `findings` (JSON), `results` (JSON). Рутина читает: `SELECT ran_at, severity, findings FROM runs ORDER BY id DESC LIMIT 2`.
