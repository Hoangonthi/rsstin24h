const https = require("https");
const admin = require("firebase-admin");

const MAX_NEWS_ITEMS = Math.max(1, Number(process.env.TELEGRAM_AUTO_MAX_NEWS || 120));
const MAX_PUSHES_PER_RUN = Math.min(10, Math.max(5, Number(process.env.TELEGRAM_AUTO_MAX_PUSHES || 10)));
const MAX_PUSHES_PER_GROUP = Math.min(10, Math.max(1, Number(process.env.TELEGRAM_AUTO_MAX_PUSHES_PER_GROUP || 5)));
const PUSH_DELAY_MIN_MS = Math.max(0, Number(process.env.TELEGRAM_AUTO_DELAY_MIN_MS || 10 * 1000));
const PUSH_DELAY_MAX_MS = Math.max(PUSH_DELAY_MIN_MS, Number(process.env.TELEGRAM_AUTO_DELAY_MAX_MS || 30 * 1000));
const DRY_RUN = process.env.TELEGRAM_AUTO_DRY_RUN === "true";
const RESPECT_FIRESTORE_SETTING = process.env.TELEGRAM_AUTO_RESPECT_SETTING !== "false";

const AUTO_GROUPS = {
  vietnamStocks: {
    name: process.env.TELEGRAM_VIETNAM_STOCKS_NAME || "Chung khoan Viet Nam - Vo Vu Hoang",
    chatId: process.env.TELEGRAM_VIETNAM_STOCKS_CHAT_ID || "-4733650492",
    label: process.env.TELEGRAM_VIETNAM_STOCKS_LABEL || "Chung khoan Viet Nam",
  },
  goldFx: {
    name: process.env.TELEGRAM_GOLD_FX_NAME || "Grab Gold - Vo Hoang Stocks",
    chatId: process.env.TELEGRAM_GOLD_FX_CHAT_ID || "-5203406907",
    label: process.env.TELEGRAM_GOLD_FX_LABEL || "Gold-FX-The gioi",
  },
};

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelayMs() {
  return PUSH_DELAY_MIN_MS + Math.floor(Math.random() * (PUSH_DELAY_MAX_MS - PUSH_DELAY_MIN_MS + 1));
}

function dateFromFirestore(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatPublishedAt(value) {
  const date = dateFromFirestore(value);
  if (!date) return "";
  return date.toLocaleString("vi-VN", {timeZone: "Asia/Bangkok", hour12: false});
}

function newsLink(item) {
  return textValue(item.publicUrl || item.displayUrl || item.link || item.url || item.originalUrl || item.canonicalUrl);
}

function normalizeAutoItem(id, item) {
  return {
    ...item,
    newsId: id,
    title: textValue(item.titleVi || item.translatedTitle || item.title || item.titleOriginal, "Tin moi"),
    link: newsLink(item),
    summary: textValue(item.summaryVi || item.translatedSummary || item.summary || item.shortDescription || item.description),
    source: textValue(item.source || item.sourceName || item.originalSource),
    sourceName: textValue(item.sourceName || item.source || item.originalSource),
    publishedAtText: formatPublishedAt(item.publishedAt || item.createdAt),
  };
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

  return targets.filter((target) => textValue(target.chatId));
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

function buildAutoMessage(item, target) {
  const lines = [
    `\uD83D\uDCF0 <b>${escapeTelegramHtml(item.title)}</b>`,
    "",
  ];
  if (item.summary) {
    lines.push("\uD83D\uDCCC <b>Tom tat:</b>");
    lines.push(escapeTelegramHtml(item.summary.slice(0, 1200)));
    lines.push("");
  }
  if (item.source || item.publishedAtText) {
    lines.push(`Nguon: ${escapeTelegramHtml([item.source, item.publishedAtText].filter(Boolean).join(" - "))}`);
  }
  lines.push(`\uD83C\uDFF7 Nhom: ${escapeTelegramHtml(target.label)}`);
  if (item.link) {
    lines.push("\uD83D\uDD17 Link:");
    lines.push(escapeTelegramHtml(item.link));
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
        resolve(data.result && data.result.message_id ? data.result.message_id : null);
      });
    });
    req.on("timeout", () => req.destroy(new Error("Telegram request timed out.")));
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function initializeFirebase() {
  const projectId = textValue(process.env.FIREBASE_PROJECT_ID);
  const serviceAccountJson = textValue(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  if (!projectId) throw new Error("Missing FIREBASE_PROJECT_ID.");
  if (!serviceAccountJson) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_JSON.");
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(serviceAccountJson)),
    projectId,
  });
  return admin.firestore();
}

async function isAutoPushEnabled(db) {
  if (process.env.TELEGRAM_AUTO_PUSH_ENABLED === "true") return true;
  if (process.env.TELEGRAM_AUTO_PUSH_ENABLED === "false") return false;
  if (!RESPECT_FIRESTORE_SETTING) return true;
  const snap = await db.collection("telegram_settings").doc("auto_push").get();
  return snap.exists && snap.data().enabled === true;
}

async function loadRecentNews(db) {
  const snapshot = await db.collection("news")
    .orderBy("createdAt", "desc")
    .limit(MAX_NEWS_ITEMS)
    .get();
  return snapshot.docs.map((doc) => ({
    ref: doc.ref,
    ...normalizeAutoItem(doc.id, doc.data()),
  }));
}

async function writeLog(db, logRow) {
  await db.collection("telegram_auto_push_logs").add({
    ...logRow,
    pushedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

function sentTargetChatIds(item) {
  const targets = item.telegramAutoPush && Array.isArray(item.telegramAutoPush.targets)
    ? item.telegramAutoPush.targets
    : [];
  return new Set(targets.map((target) => textValue(target.chatId)).filter(Boolean));
}

async function markSentToTelegram(item, rows) {
  if (DRY_RUN || !rows.length) return;
  const existingTargets = item.telegramAutoPush && Array.isArray(item.telegramAutoPush.targets)
    ? item.telegramAutoPush.targets
    : [];
  const targetMap = new Map();
  for (const target of existingTargets) {
    const chatId = textValue(target && target.chatId);
    if (chatId) targetMap.set(chatId, target);
  }
  for (const row of rows) {
    targetMap.set(row.targetChatId, {
      group: row.targetGroup,
      chatId: row.targetChatId,
      messageId: row.messageId || null,
    });
  }
  await item.ref.set({
    sentToTelegram: true,
    sentAt: admin.firestore.FieldValue.serverTimestamp(),
    telegramAutoPush: {
      runner: "github_actions",
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      targets: Array.from(targetMap.values()),
    },
  }, {merge: true});
}

async function main() {
  const token = textValue(process.env.TELEGRAM_BOT_TOKEN);
  if (!token && !DRY_RUN) throw new Error("Missing TELEGRAM_BOT_TOKEN.");

  const db = initializeFirebase();
  const enabled = await isAutoPushEnabled(db);
  if (!enabled) {
    console.log("[AUTO] Telegram auto push disabled.");
    return;
  }

  const items = await loadRecentNews(db);
  const pushed = [];
  const skipped = [];
  const pushedByGroup = new Map();

  for (const item of items) {
    if (pushed.length >= MAX_PUSHES_PER_RUN) break;
    const targets = classifyAutoTargets(item);
    if (!targets.length) {
      skipped.push({newsId: item.newsId, reason: "no_matching_group"});
      continue;
    }
    const sentTargets = sentTargetChatIds(item);
    if (item.sentToTelegram === true && !sentTargets.size) {
      skipped.push({newsId: item.newsId, reason: "already_sent_to_telegram_legacy"});
      continue;
    }
    const pushedForItem = [];
    for (const target of targets) {
      if (pushed.length >= MAX_PUSHES_PER_RUN) break;
      if (sentTargets.has(target.chatId)) {
        skipped.push({newsId: item.newsId, targetGroup: target.name, reason: "already_sent_to_group"});
        continue;
      }
      const groupPushCount = pushedByGroup.get(target.chatId) || 0;
      if (groupPushCount >= MAX_PUSHES_PER_GROUP) {
        skipped.push({newsId: item.newsId, targetGroup: target.name, reason: "group_quota_reached"});
        continue;
      }
      if (pushed.length > 0 && !DRY_RUN) {
        const delayMs = randomDelayMs();
        console.log(`[AUTO] delaying ${Math.round(delayMs / 1000)}s before next Telegram message`);
        await sleep(delayMs);
      }

      const logRow = {
        key: dedupeKey(item, target),
        newsId: item.newsId,
        title: item.title,
        link: item.link,
        targetGroup: target.name,
        targetChatId: target.chatId,
        reason: target.reason,
        source: item.source,
        status: "queued",
        runner: "github_actions",
      };
      try {
        const messageId = DRY_RUN ? null : await postTelegram(token, target, buildAutoMessage(item, target));
        logRow.status = DRY_RUN ? "dry_run" : "success";
        logRow.messageId = messageId;
        pushed.push(logRow);
        pushedForItem.push(logRow);
        pushedByGroup.set(target.chatId, groupPushCount + 1);
      } catch (error) {
        logRow.status = "error";
        logRow.errorMessage = error.message || String(error);
        skipped.push({newsId: item.newsId, targetGroup: target.name, reason: logRow.errorMessage});
      }
      await writeLog(db, logRow);
    }
    await markSentToTelegram(item, pushedForItem);
  }

  console.log(`[AUTO] scanned=${items.length} pushed=${pushed.length} skipped=${skipped.length} maxPushes=${MAX_PUSHES_PER_RUN} maxPerGroup=${MAX_PUSHES_PER_GROUP} dryRun=${DRY_RUN}`);
  for (const row of pushed) {
    console.log(`[AUTO] pushed ${row.targetGroup}: ${row.title}`);
  }
  for (const row of skipped) {
    const targetText = row.targetGroup ? ` target=${row.targetGroup}` : "";
    console.log(`[AUTO] skipped newsId=${row.newsId || ""}${targetText} reason=${row.reason}`);
  }
}

main()
  .catch((error) => {
    console.error(`[AUTO] ${error.stack || error.message || error}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (admin.apps.length) await admin.app().delete().catch(() => {});
  });
