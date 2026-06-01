const http = require("http");
const https = require("https");
const {spawn} = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PORT = Number(process.env.TELEGRAM_LOCAL_PORT || 8787);
const ENV_PATH = path.join(__dirname, ".env");
const DEFAULT_STATE_DIR = path.join(os.homedir(), ".new24h");
const AUTO_LOG_PATH = process.env.TELEGRAM_AUTO_LOG_PATH
  || path.join(DEFAULT_STATE_DIR, "telegram-auto-push-log.json");
const WATCHER_STATE_PATH = path.join(DEFAULT_STATE_DIR, "watcher-control.json");
const AUTO_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;
const AUTO_GROUP_COOLDOWN_MS = 2 * 60 * 1000;
let lastAutoRequestAt = 0;
let watcherProcess = null;
let watcherEnabled = false;
let watcherStopping = false;
const AUTO_GROUPS = {
  vietnamStocks: {
    name: "Chung khoan Viet Nam - Vo Vu Hoang",
    chatId: "-4733650492",
    label: "Chung khoan Viet Nam",
  },
  goldFx: {
    name: "Grab Gold - Vo Hoang Stocks",
    chatId: "-5203406907",
    label: "Gold-FX-The gioi",
  },
};

function loadEnvFile() {
  if (!fs.existsSync(ENV_PATH)) return;
  const lines = fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 2 * 1024 * 1024) {
        req.destroy();
        reject(new Error("Request body too large."));
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(new Error("Invalid JSON body."));
      }
    });
    req.on("error", reject);
  });
}

function allowedOrigin(req) {
  const origin = req.headers.origin || "";
  if (!origin) return "*";
  try {
    const host = new URL(origin).hostname;
    if (host === "localhost" || host === "127.0.0.1") return origin;
  } catch (error) {
    return "";
  }
  return "";
}

function sendJson(req, res, statusCode, payload) {
  const origin = allowedOrigin(req);
  if (!origin) {
    res.writeHead(403, {"content-type": "application/json; charset=utf-8"});
    res.end(JSON.stringify({ok: false, error: "Only localhost origins are allowed."}));
    return;
  }
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  res.end(JSON.stringify(payload));
}

function textValue(value, fallback = "") {
  return String(value || fallback).trim();
}

function normalizeText(value) {
  return textValue(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u0111/g, "d")
    .replace(/\u0110/g, "D")
    .toLowerCase();
}

function escapeTelegramHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
  })[char]);
}

function buildMessage(body) {
  const title = textValue(body.title, "Tin moi");
  const summary = textValue(body.summary);
  const source = textValue(body.source);
  const publishedAt = textValue(body.publishedAt);
  const link = textValue(body.link);
  const lines = [
    `\uD83D\uDCF0 <b>${escapeTelegramHtml(title)}</b>`,
    "",
  ];
  if (summary) lines.push(`Tom tat: ${escapeTelegramHtml(summary.slice(0, 1200))}`);
  if (source || publishedAt) {
    lines.push(`Nguon: ${escapeTelegramHtml([source, publishedAt].filter(Boolean).join(" - "))}`);
  }
  if (link) lines.push(`Link: ${escapeTelegramHtml(link)}`);
  return lines.join("\n");
}

function buildAutoMessage(item, target) {
  const title = textValue(item.title, "Tin moi");
  const summary = textValue(item.summary);
  const link = textValue(item.link);
  const lines = [
    `\uD83D\uDCF0 <b>${escapeTelegramHtml(title)}</b>`,
    "",
  ];
  if (summary) {
    lines.push("\uD83D\uDCCC <b>Tom tat:</b>");
    lines.push(escapeTelegramHtml(summary.slice(0, 1200)));
    lines.push("");
  }
  lines.push(`\uD83C\uDFF7 Nhom: ${escapeTelegramHtml(target.label)}`);
  if (link) {
    lines.push("\uD83D\uDD17 Link:");
    lines.push(escapeTelegramHtml(link));
  }
  return lines.join("\n");
}

function postTelegram(token, group, text) {
  const payload = JSON.stringify({
    chat_id: group.chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: false,
  });
  const options = {
    method: "POST",
    hostname: "api.telegram.org",
    path: `/bot${token}/sendMessage`,
    headers: {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
    },
    timeout: 15000,
  };
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let raw = "";
      res.on("data", (chunk) => {
        raw += chunk;
      });
      res.on("end", () => {
        let data = {};
        try {
          data = raw ? JSON.parse(raw) : {};
        } catch (error) {
          reject(new Error(`Telegram returned invalid JSON: ${raw.slice(0, 160)}`));
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300 || data.ok === false) {
          reject(new Error(data.description || `Telegram HTTP ${res.statusCode}`));
          return;
        }
        resolve({
          group: group.name || group.chatId,
          chatId: group.chatId,
          messageId: data.result && data.result.message_id,
          status: "success",
        });
      });
    });
    req.on("timeout", () => req.destroy(new Error("Telegram request timed out.")));
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function validateBody(body) {
  const groups = Array.isArray(body.groups) ? body.groups : [];
  const validGroups = groups
    .map((group) => ({
      name: textValue(group && group.name),
      chatId: textValue(group && group.chatId),
    }))
    .filter((group) => group.chatId);
  if (!textValue(body.title) && !textValue(body.link)) {
    throw new Error("Missing title or link.");
  }
  if (!validGroups.length) {
    throw new Error("Missing Telegram groups.");
  }
  return validGroups.slice(0, 20);
}

function readAutoLog() {
  try {
    if (!fs.existsSync(AUTO_LOG_PATH)) return [];
    const parsed = JSON.parse(fs.readFileSync(AUTO_LOG_PATH, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function readWatcherState() {
  try {
    if (!fs.existsSync(WATCHER_STATE_PATH)) return {enabled: false};
    const parsed = JSON.parse(fs.readFileSync(WATCHER_STATE_PATH, "utf8"));
    return {enabled: parsed.enabled === true};
  } catch (error) {
    return {enabled: false};
  }
}

function writeWatcherState(enabled) {
  fs.mkdirSync(path.dirname(WATCHER_STATE_PATH), {recursive: true});
  fs.writeFileSync(WATCHER_STATE_PATH, JSON.stringify({
    enabled,
    updatedAt: new Date().toISOString(),
  }, null, 2));
}

function watcherStatus() {
  return {
    enabled: watcherEnabled,
    running: Boolean(watcherProcess && watcherProcess.exitCode === null),
    pid: watcherProcess ? watcherProcess.pid : null,
  };
}

function startWatcher() {
  if (watcherProcess && watcherProcess.exitCode === null) return;
  watcherStopping = false;
  watcherProcess = spawn(process.execPath, [path.join(__dirname, "scripts", "smart-category-watcher.js")], {
    cwd: __dirname,
    stdio: "inherit",
    shell: false,
    windowsHide: false,
  });
  console.log(`[WATCHER] started pid=${watcherProcess.pid}`);
  watcherProcess.on("exit", (code, signal) => {
    console.log(`[WATCHER] exited code=${code} signal=${signal || ""}`);
    watcherProcess = null;
    if (watcherEnabled && !watcherStopping) {
      setTimeout(startWatcher, 5000);
    }
  });
}

function stopWatcher() {
  watcherStopping = true;
  if (watcherProcess && watcherProcess.exitCode === null) {
    watcherProcess.kill();
  }
  watcherProcess = null;
}

function setWatcherEnabled(enabled) {
  watcherEnabled = enabled === true;
  writeWatcherState(watcherEnabled);
  if (watcherEnabled) startWatcher();
  else stopWatcher();
  return watcherStatus();
}

function writeAutoLog(rows) {
  const cutoff = Date.now() - AUTO_DEDUPE_WINDOW_MS;
  const fresh = rows
    .filter((row) => new Date(row.pushedAt || 0).getTime() >= cutoff)
    .slice(-2000);
  fs.mkdirSync(path.dirname(AUTO_LOG_PATH), {recursive: true});
  fs.writeFileSync(AUTO_LOG_PATH, JSON.stringify(fresh, null, 2));
}

function dedupeKey(item, target) {
  const titleKey = normalizeText(item.title).replace(/[^a-z0-9]+/g, " ").trim();
  return [
    target.chatId,
    textValue(item.newsId),
    textValue(item.link).toLowerCase(),
    titleKey,
  ].filter(Boolean).join("|");
}

function hasRecentAutoPush(logs, key) {
  const cutoff = Date.now() - AUTO_DEDUPE_WINDOW_MS;
  return logs.some((row) => row.key === key
    && new Date(row.pushedAt || 0).getTime() >= cutoff
    && row.status === "success");
}

function hasRecentGroupPush(logs, target) {
  const cutoff = Date.now() - AUTO_GROUP_COOLDOWN_MS;
  return logs.some((row) => row.targetChatId === target.chatId
    && new Date(row.pushedAt || 0).getTime() >= cutoff
    && row.status === "success");
}

function listValues(item, fields) {
  const values = [];
  for (const field of fields) {
    const value = item[field];
    if (Array.isArray(value)) values.push(...value);
    else if (value) values.push(value);
  }
  return values.map((value) => textValue(value)).filter(Boolean);
}

function hasAnyText(text, keywords) {
  const normalized = normalizeText(text);
  return keywords.some((keyword) => normalized.includes(normalizeText(keyword)));
}

function classifyAutoTargets(item) {
  const text = [
    item.title,
    item.summary,
    item.source,
    item.sourceName,
    item.sector,
    item.finalSector,
    item.category,
    item.eventType,
  ].filter(Boolean).join(" ");
  const sectors = listValues(item, ["sector", "finalSector", "sectors", "category", "categoryGroup"]).map(normalizeText);
  const eventType = normalizeText(item.eventType || item.newsType);
  const relatedStocks = listValues(item, ["relatedStocks", "primaryTickers", "tickers", "watchlistStocks"]);
  const targets = [];

  const vietnamSectorSlugs = [
    "banking", "securities", "real_estate", "steel", "oil_gas",
    "public_investment", "retail", "industrial_park", "power",
    "fertilizer_chemical", "seafood", "textile", "logistics",
  ];
  const vietnamSectorWords = [
    "ngan hang", "chung khoan", "bat dong san", "thep", "dau khi",
    "dau tu cong", "ban le", "khu cong nghiep", "dien", "phan bon",
    "hoa chat", "thuy san", "det may", "logistics",
  ];
  const vietnamEvents = [
    "earnings", "dividend", "ex_right", "capital_raise", "bond", "mna",
    "leadership", "project", "legal", "policy",
  ];
  const vietnamKeywords = [
    "VN-Index", "co phieu", "chung khoan", "HOSE", "HNX", "UPCOM",
    "khoi ngoai", "tu doanh", "ngan hang", "bat dong san", "dau tu cong",
    "loi nhuan", "co tuc", "phat hanh", "trai phieu",
  ];
  const vietnamMatch = relatedStocks.length > 0
    || sectors.some((sector) => vietnamSectorSlugs.includes(sector)
      || vietnamSectorWords.some((word) => sector.includes(word)))
    || vietnamEvents.includes(eventType)
    || hasAnyText(text, vietnamKeywords);
  if (vietnamMatch) {
    targets.push({
      ...AUTO_GROUPS.vietnamStocks,
      reason: "Tin Viet Nam/co phieu phu hop rule auto push",
    });
  }

  const goldFxSectors = ["gold_fx_crypto", "macro_global", "fx", "crypto", "vang", "ty gia", "quoc te"];
  const goldFxEvents = ["fx", "gold_price", "crypto", "commodity_price", "government", "policy", "macro"];
  const goldFxKeywords = [
    "vang", "ty gia", "USD", "DXY", "Fed", "Powell", "CPI", "PCE", "NFP",
    "lai suat My", "trai phieu My", "dau Brent", "WTI", "Bitcoin", "crypto",
    "chung khoan My", "Dow Jones", "Nasdaq", "S&P 500", "Nikkei",
    "Hang Seng", "Trung Quoc", "Ukraine", "chien tranh", "dia chinh tri",
  ];
  const goldFxMatch = sectors.some((sector) => goldFxSectors.some((word) => sector.includes(normalizeText(word))))
    || goldFxEvents.includes(eventType)
    || hasAnyText(text, goldFxKeywords);
  if (goldFxMatch) {
    targets.push({
      ...AUTO_GROUPS.goldFx,
      reason: "Tin Gold/FX/the gioi phu hop rule auto push",
    });
  }

  return targets;
}

function normalizeAutoItem(item) {
  return {
    ...item,
    newsId: textValue(item.newsId || item.id),
    title: textValue(item.title),
    link: textValue(item.link),
    summary: textValue(item.summary),
  };
}

async function handleSendTelegram(req, res) {
  const token = textValue(process.env.TELEGRAM_BOT_TOKEN);
  if (!token) {
    sendJson(req, res, 500, {ok: false, error: "Missing TELEGRAM_BOT_TOKEN in .env"});
    return;
  }
  try {
    const body = await readJson(req);
    const groups = validateBody(body);
    const message = buildMessage(body);
    const results = [];
    for (const group of groups) {
      try {
        results.push(await postTelegram(token, group, message));
      } catch (error) {
        results.push({
          group: group.name || group.chatId,
          chatId: group.chatId,
          status: "error",
          error: error.message || String(error),
        });
      }
    }
    const failures = results.filter((result) => result.status !== "success");
    sendJson(req, res, failures.length ? 207 : 200, {
      ok: failures.length === 0,
      status: failures.length ? "partial_or_error" : "success",
      results,
    });
  } catch (error) {
    sendJson(req, res, 400, {ok: false, error: error.message || String(error)});
  }
}

async function handleAutoPushTelegram(req, res) {
  const token = textValue(process.env.TELEGRAM_BOT_TOKEN);
  if (!token) {
    sendJson(req, res, 500, {ok: false, error: "Missing TELEGRAM_BOT_TOKEN in .env"});
    return;
  }
  try {
    const body = await readJson(req);
    if (body.enabled !== true) {
      sendJson(req, res, 200, {ok: true, enabled: false, pushed: [], skipped: []});
      return;
    }
    const now = Date.now();
    if (now - lastAutoRequestAt < AUTO_GROUP_COOLDOWN_MS) {
      sendJson(req, res, 200, {
        ok: true,
        enabled: true,
        throttled: true,
        pushed: [],
        skipped: [{reason: "auto_request_cooldown_2m"}],
      });
      return;
    }
    lastAutoRequestAt = now;
    const items = Array.isArray(body.items) ? body.items.slice(0, 500).map(normalizeAutoItem) : [];
    const logs = readAutoLog();
    const initialLogLength = logs.length;
    const pushed = [];
    const skipped = [];
    const pushedGroups = new Set();
    for (const item of items) {
      const targets = classifyAutoTargets(item);
      if (!targets.length) {
        skipped.push({newsId: item.newsId, reason: "no_matching_group"});
        continue;
      }
      for (const target of targets) {
        if (pushedGroups.has(target.chatId) || hasRecentGroupPush(logs, target)) {
          skipped.push({newsId: item.newsId, targetGroup: target.name, reason: "group_cooldown_2m"});
          continue;
        }
        const key = dedupeKey(item, target);
        if (hasRecentAutoPush(logs, key)) {
          skipped.push({newsId: item.newsId, targetGroup: target.name, reason: "duplicate_24h"});
          continue;
        }
        const logRow = {
          key,
          newsId: item.newsId,
          title: item.title,
          link: item.link,
          targetGroup: target.name,
          targetChatId: target.chatId,
          reason: target.reason,
          pushedAt: new Date().toISOString(),
          status: "queued",
        };
        try {
          const result = await postTelegram(token, target, buildAutoMessage(item, target));
          logRow.status = "success";
          logRow.messageId = result.messageId || null;
          pushed.push(logRow);
          pushedGroups.add(target.chatId);
        } catch (error) {
          logRow.status = "error";
          logRow.errorMessage = error.message || String(error);
          skipped.push({newsId: item.newsId, targetGroup: target.name, reason: logRow.errorMessage});
        }
        logs.push(logRow);
      }
    }
    if (logs.length !== initialLogLength) writeAutoLog(logs);
    console.log(`[AUTO] scanned=${items.length} pushed=${pushed.length} skipped=${skipped.length}`);
    sendJson(req, res, 200, {ok: true, enabled: true, pushed, skipped});
  } catch (error) {
    sendJson(req, res, 400, {ok: false, error: error.message || String(error)});
  }
}

async function handleWatcherControl(req, res) {
  try {
    const body = await readJson(req);
    if (typeof body.enabled === "boolean") {
      sendJson(req, res, 200, {ok: true, watcher: setWatcherEnabled(body.enabled)});
      return;
    }
    sendJson(req, res, 200, {ok: true, watcher: watcherStatus()});
  } catch (error) {
    sendJson(req, res, 400, {ok: false, error: error.message || String(error)});
  }
}

loadEnvFile();
watcherEnabled = readWatcherState().enabled;
if (watcherEnabled) startWatcher();

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    sendJson(req, res, 204, {});
    return;
  }
  if (req.method === "POST" && req.url === "/send-telegram") {
    handleSendTelegram(req, res);
    return;
  }
  if (req.method === "POST" && req.url === "/auto-push-telegram") {
    handleAutoPushTelegram(req, res);
    return;
  }
  if (req.method === "POST" && req.url === "/watcher-control") {
    handleWatcherControl(req, res);
    return;
  }
  sendJson(req, res, 404, {ok: false, error: "Not found."});
});

server.listen(PORT, () => {
  console.log(`Telegram local server listening on http://localhost:${PORT}`);
});
