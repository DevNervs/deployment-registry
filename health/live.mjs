/**
 * The Sunday livestream check for emmanuil.cv.ua.
 *
 * The interesting failure is a disagreement: the service is being streamed on
 * YouTube but the site does not show it (or the site shows a stream that is
 * already over). So this asks both sides — the church's own
 * `/api/youtube-live`, which is what every visitor's browser polls, and
 * YouTube itself — and reports the mismatch rather than either answer alone.
 *
 * Two lessons are baked into the YouTube reading, both learned the hard way:
 *
 *  1. Only `liveBroadcastDetails.isLiveNow` means «идёт прямо сейчас». The
 *     looser `"isLive":true` / `isLiveContent` markers also sit on finished and
 *     merely scheduled broadcasts, and reading those turns every Sunday
 *     recording into a false alarm.
 *  2. YouTube does not always answer a Cloudflare Worker with the player JSON
 *     at all (consent wall, bot check, a stripped page for datacenter IPs).
 *     «Не удалось прочитать» is therefore its own state — never folded into
 *     «эфира нет», because that would raise a red alert every week.
 *
 * The «Дивитися онлайн» button and the player are rendered client-side
 * (`"use client"` + a fetch to /api/youtube-live), so they are absent from the
 * server HTML whatever the stream is doing. The API answer is the real signal;
 * the HTML is only checked for the shell being served at all.
 */

const SITE = "https://emmanuil.cv.ua";
const CHANNEL_LIVE = "https://www.youtube.com/@EmmanuilCV/live";
const TIMEOUT_MS = 20_000;
// Without a browser-ish UA and a settled consent cookie YouTube tends to hand
// back a page with no player data at all.
const YT_HEADERS = {
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  "accept-language": "uk,en;q=0.8",
  cookie: "CONSENT=YES+cb; SOCS=CAI",
};

async function get(doFetch, url, init = {}) {
  const started = Date.now();
  try {
    const response = await doFetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      ...init,
      headers: { "user-agent": "devnervs-health/1.0 (+livestream check)", ...(init.headers || {}) },
    });
    const body = await response.text();
    return { ok: true, status: response.status, ms: Date.now() - started, body };
  } catch (error) {
    return { ok: false, status: 0, ms: Date.now() - started, error: String(error.message || error).slice(0, 160) };
  }
}

/**
 * Reads YouTube's embedded player JSON. Returns `live: true | false | null`,
 * where null means «страницу прочитать не удалось» — see the note above.
 */
function readYouTube(html) {
  const markers = {
    bytes: html ? html.length : 0,
    player: /ytInitialPlayerResponse/.test(html || ""),
    details: /"liveBroadcastDetails"/.test(html || ""),
    isLiveNowTrue: /"isLiveNow"\s*:\s*true/.test(html || ""),
    isLiveNowFalse: /"isLiveNow"\s*:\s*false/.test(html || ""),
    hls: /hlsManifestUrl/.test(html || ""),
    ended: /"endTimestamp"/.test(html || ""),
    upcoming: /"isUpcoming"\s*:\s*true/.test(html || "") || /"scheduledStartTime"/.test(html || ""),
  };
  const videoId = (html || "").match(/"videoId"\s*:\s*"([\w-]{11})"/)?.[1] ?? null;

  if (markers.isLiveNowTrue || (markers.hls && !markers.ended)) return { live: true, videoId, markers };
  // «Не идёт» only counts when YouTube actually said so.
  if (markers.details && (markers.isLiveNowFalse || markers.ended)) return { live: false, videoId, markers };
  return { live: null, videoId, markers };
}

export async function checkLive({ fetch: doFetch, now = new Date() } = {}) {
  const [api, online, home, channel] = await Promise.all([
    get(doFetch, `${SITE}/api/youtube-live`, { headers: { "cache-control": "no-store" } }),
    get(doFetch, `${SITE}/online`),
    get(doFetch, `${SITE}/`),
    get(doFetch, CHANNEL_LIVE, { headers: YT_HEADERS }),
  ]);

  const findings = [];
  let apiJson = null;
  if (!api.ok || api.status >= 400) {
    findings.push({ level: 2, text: `/api/youtube-live не отвечает: ${api.error || `HTTP ${api.status}`}` });
  } else {
    try {
      apiJson = JSON.parse(api.body);
    } catch {
      findings.push({ level: 2, text: `/api/youtube-live вернул не JSON: ${String(api.body).slice(0, 120)}` });
    }
  }
  const siteLive = Boolean(apiJson?.live && apiJson?.videoId);
  if (apiJson && apiJson.available === false) {
    findings.push({ level: 1, text: "сайт сообщает available:false — похоже, не задан ключ YouTube API или исчерпана квота" });
  }

  const ytChannel = readYouTube(channel.ok ? channel.body : "");
  // When the site names a video, that exact video is the thing to verify —
  // the channel page can lag or show a different broadcast.
  let ytVideo = { live: null, markers: null };
  if (siteLive) {
    const watch = await get(doFetch, `https://www.youtube.com/watch?v=${apiJson.videoId}`, { headers: YT_HEADERS });
    ytVideo = watch.ok ? readYouTube(watch.body) : { live: null, markers: { error: watch.error } };
  }

  if (!channel.ok) findings.push({ level: 1, text: `YouTube-канал не открылся из воркера: ${channel.error}` });

  if (ytChannel.live === true && !siteLive) {
    findings.push({
      level: 2,
      text: `на YouTube эфир идёт${ytChannel.videoId ? ` (видео ${ytChannel.videoId})` : ""}, а сайт его не показывает — /api/youtube-live отвечает «не в эфире»`,
    });
  }
  if (siteLive && ytVideo.live === false) {
    findings.push({ level: 2, text: `сайт показывает видео ${apiJson.videoId}, но на YouTube эта трансляция уже не идёт — на /online крутится запись` });
  }
  if (siteLive && ytVideo.live === null) {
    findings.push({ level: 0, text: `сверить видео ${apiJson.videoId} с YouTube не удалось (страница без плеерных данных) — сайт считает, что эфир идёт` });
  }
  if (!siteLive && ytChannel.live === null) {
    findings.push({ level: 0, text: "YouTube не отдал плеерные данные — проверить наличие эфира со стороны YouTube не удалось" });
  }
  if (!siteLive && ytChannel.upcoming && ytChannel.live !== true) {
    findings.push({ level: 0, text: `на YouTube трансляция запланирована, но ещё не началась${ytChannel.videoId ? ` (видео ${ytChannel.videoId})` : ""}` });
  }

  for (const [name, page] of [["/", home], ["/online", online]]) {
    if (!page.ok) findings.push({ level: 2, text: `страница ${name} не открылась: ${page.error}` });
    else if (page.status !== 200) findings.push({ level: 2, text: `страница ${name} отвечает ${page.status}` });
    else if (/Application error|Щось зламалося/i.test(page.body)) findings.push({ level: 2, text: `страница ${name} отдаёт ошибку приложения` });
  }
  if (online.ok && online.status === 200 && !/tv-frame|tv-player/.test(online.body)) {
    findings.push({ level: 1, text: "на /online нет разметки телевизора (tv-frame) — страница отдалась, но не тем содержимым" });
  }

  const severity = findings.reduce((max, f) => Math.max(max, f.level), 0);
  const verdict = severity === 0 ? "🟢" : severity === 1 ? "🟡" : "🔴";
  const siteState = siteLive ? `сайт: эфир (${apiJson.videoId})` : "сайт: эфира нет";
  const ytState =
    (siteLive ? ytVideo.live : ytChannel.live) === true
      ? "YouTube: эфир идёт"
      : (siteLive ? ytVideo.live : ytChannel.live) === false
        ? "YouTube: эфира нет"
        : "YouTube: прочитать не удалось";

  const markdown = [
    `# Трансляція · ${now.toISOString().slice(0, 16).replace("T", " ")} UTC`,
    "",
    `**${verdict}** · ${siteState} · ${ytState} · /online ${online.status} (${online.ms} мс) · / ${home.status} (${home.ms} мс)`,
    "",
    ...(findings.length ? findings.map((f) => `- ${f.level === 2 ? "🔴" : f.level === 1 ? "🟡" : "ℹ️"} ${f.text}`) : ["Расхождений нет: сайт и YouTube говорят одно и то же."]),
    "",
    `_Диагностика YouTube: канал ${JSON.stringify(ytChannel.markers)}${ytVideo.markers ? `, видео ${JSON.stringify(ytVideo.markers)}` : ""}._`,
    "",
    "_Кнопка «Дивитися онлайн» и плеер рисуются в браузере по ответу /api/youtube-live, в серверном HTML их нет никогда — поэтому проверяется сам API, а не разметка._",
  ].join("\n");

  return {
    ranAt: now.toISOString(),
    severity,
    markdown,
    siteLive,
    youtubeLive: siteLive ? ytVideo.live : ytChannel.live,
    videoId: apiJson?.videoId ?? ytChannel.videoId ?? null,
    findings,
  };
}
