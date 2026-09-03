# Health check

`node health/check.mjs` проверяет все сайты из `health/sites.json` и печатает Markdown-отчёт. Без зависимостей, Node ≥ 20.

Запускается ежедневно облачной рутиной Claude Code («DevNervs health check»), результат виден на https://claude.ai/code/routines. Можно запускать и руками.

## Что проверяет

**Снаружи, без токенов:** статус и время ответа каждой страницы из `paths`, текст-маркер на главной (`expectText`), срок TLS-сертификата, заголовки безопасности (`securityHeaders: true`), индексируемость (`expectIndexable`), поведение API-эндпоинтов на неправильный ввод (`endpoints`: например, `POST /api/lead` с пустым телом обязан отвечать 400, а не 500).

**Со стороны Cloudflare, если задан `CLOUDFLARE_API_TOKEN`:**
- Worker: запросы, ошибки выполнения, 4xx/5xx и CPU за сутки против предыдущих суток (сплеск трафика ×4, рост 4xx ×3 — сигнал сканирования или атаки);
- Workers Logs: строки уровня `error` за сутки, сгруппированные по сообщению;
- зона (домен в Cloudflare): WAF/firewall-события с топом по действию, источнику, стране и пути; доля 5xx с edge; сплески трафика;
- D1: размер базы и число запросов за сутки.

Cloudflare сам режет атаки на edge, но не говорит об этом, пока не зайдёшь в дашборд. Этот отчёт собирает всё в одно место и добавляет то, чего у Cloudflare нет: реальные ответы страниц, маркеры контента, TLS, API-контракты.

## Токен Cloudflare (только чтение)

Dashboard → My Profile → API Tokens → Create Token → Custom. Права:

| Область | Право |
|---|---|
| Account · Account Analytics | Read |
| Account · Workers Scripts | Read |
| Account · Workers Observability | Read |
| Account · D1 | Read |
| Zone · Zone | Read |
| Zone · Analytics | Read |
| Zone · Firewall Services | Read |

Токен задаётся переменной окружения `CLOUDFLARE_API_TOKEN` в облачном окружении рутины (https://claude.ai/code/environments → окружение → переменные), никогда в репозитории.

## Уведомления в Telegram (необязательно)

`HEALTH_TELEGRAM_BOT_TOKEN` и `HEALTH_TELEGRAM_CHAT_ID` — краткая сводка приходит в чат при предупреждениях и критических проблемах; `HEALTH_ALWAYS_NOTIFY=1` — каждый день.

## Как добавить или поменять сайт

Правится только `health/sites.json`. Поля:

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

Переезд сайта на новый домен = поменять `url`, добавить `zone`, поставить `expectIndexable: true`.

## Коды выхода

`0` — всё зелёное, `1` — есть предупреждения, `2` — есть критичное. `health/last-run.json` — полный результат последнего запуска (в git не попадает).
