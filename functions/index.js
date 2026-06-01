/* eslint-disable require-jsdoc, max-len, operator-linebreak, indent */
const admin = require("firebase-admin");
const {defineSecret} = require("firebase-functions/params");
const {HttpsError, onCall, onRequest} = require("firebase-functions/v2/https");

admin.initializeApp();

const telegramBotToken = defineSecret("TELEGRAM_BOT_TOKEN");
const ADMIN_EMAILS = new Set(["vvhoangvn@gmail.com"]);

exports.healthCheck = onRequest((req, res) => {
  res.send("RSS Firebase Functions is running");
});

function assertAdmin(request) {
  const email = request.auth && request.auth.token ? request.auth.token.email || "" : "";
  if (!request.auth || !ADMIN_EMAILS.has(email)) {
    throw new HttpsError("permission-denied", "Admin permission is required.");
  }
  return email;
}

function textValue(value, fallback = "") {
  return String(value || fallback).trim();
}

function timestampToText(value) {
  if (!value) return "";
  const date = typeof value.toDate === "function" ? value.toDate() : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("vi-VN", {timeZone: "Asia/Bangkok", hour12: false});
}

function escapeTelegramHtml(value) {
  return String(value === null || value === undefined ? "" : value).replace(/[&<>]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
  })[char]);
}

function newsLink(item) {
  return textValue(item.publicUrl || item.displayUrl || item.link || item.url || item.originalUrl || item.canonicalUrl);
}

function buildTelegramMessage(item) {
  const title = textValue(item.titleVi || item.translatedTitle || item.title || item.titleOriginal, "Tin mới");
  const summary = textValue(item.summaryVi || item.translatedSummary || item.summary || item.shortDescription || item.description);
  const source = textValue(item.source || item.sourceName || item.originalSource);
  const time = timestampToText(item.publishedAt || item.createdAt);
  const link = newsLink(item);
  const lines = [
    `📰 <b>${escapeTelegramHtml(title)}</b>`,
    "",
  ];
  if (summary) lines.push(`Tóm tắt: ${escapeTelegramHtml(summary.slice(0, 1200))}`);
  if (source || time) lines.push(`Nguồn: ${escapeTelegramHtml([source, time].filter(Boolean).join(" - "))}`);
  if (link) lines.push(`Link: ${escapeTelegramHtml(link)}`);
  return lines.join("\n");
}

async function loadNews(newsId) {
  const db = admin.firestore();
  const candidates = [
    db.collection("news").doc(newsId),
    db.collection("manual_news").doc(newsId),
  ];
  for (const ref of candidates) {
    const snap = await ref.get();
    if (snap.exists) return {id: snap.id, collectionName: ref.parent.id, ...snap.data()};
  }
  throw new HttpsError("not-found", "News item was not found.");
}

async function sendTelegramMessage(token, chatId, text) {
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: false,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) {
    throw new Error(body.description || `Telegram HTTP ${response.status}`);
  }
  return body.result && body.result.message_id ? body.result.message_id : null;
}

exports.pushTelegram = onCall({secrets: [telegramBotToken]}, async (request) => {
  const pushedBy = assertAdmin(request);
  const data = request.data || {};
  const newsId = textValue(data.newsId);
  const groupIds = Array.isArray(data.groupIds)
    ? [...new Set(data.groupIds.map(textValue).filter(Boolean))].slice(0, 20)
    : [];
  if (!newsId || !groupIds.length) {
    throw new HttpsError("invalid-argument", "newsId and groupIds are required.");
  }

  const token = telegramBotToken.value();
  if (!token) {
    throw new HttpsError("failed-precondition", "TELEGRAM_BOT_TOKEN is not configured.");
  }

  const db = admin.firestore();
  const [item, groupSnaps] = await Promise.all([
    loadNews(newsId),
    Promise.all(groupIds.map((id) => db.collection("telegram_groups").doc(id).get())),
  ]);
  const groups = groupSnaps
    .filter((snap) => {
      const data = snap.data() || {};
      return snap.exists && data.active !== false && textValue(data.chatId);
    })
    .map((snap) => ({id: snap.id, ...snap.data()}));
  if (!groups.length) {
    throw new HttpsError("failed-precondition", "No active Telegram groups found.");
  }

  const message = buildTelegramMessage(item);
  const results = [];
  for (const group of groups) {
    try {
      const messageId = await sendTelegramMessage(token, group.chatId, message);
      results.push({groupId: group.id, status: "success", messageId});
    } catch (error) {
      results.push({groupId: group.id, status: "error", errorMessage: error.message || String(error)});
    }
  }

  const failed = results.filter((row) => row.status !== "success");
  const status = failed.length === 0 ? "success" : failed.length === results.length ? "error" : "partial";
  const log = {
    newsId,
    title: textValue(item.titleVi || item.translatedTitle || item.title || item.titleOriginal, "Tin mới"),
    link: newsLink(item),
    groupIds: groups.map((group) => group.id),
    pushedBy,
    pushedAt: admin.firestore.FieldValue.serverTimestamp(),
    status,
    errorMessage: failed.map((row) => `${row.groupId}: ${row.errorMessage}`).join("; "),
    results,
  };
  const logRef = await db.collection("telegram_push_logs").add(log);
  if (status === "error") {
    throw new HttpsError("internal", log.errorMessage || "Telegram push failed.", {logId: logRef.id, results});
  }
  return {logId: logRef.id, status, results};
});
