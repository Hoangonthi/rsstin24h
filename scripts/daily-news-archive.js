const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

const ROOT_DIR = path.resolve(__dirname, "..");
const SERVICE_ACCOUNT_PATH = path.join(ROOT_DIR, "serviceAccountKey.json");
const FIREBASERC_PATH = path.join(ROOT_DIR, ".firebaserc");
const ARCHIVE_DIR = path.join(ROOT_DIR, "archives");
const TZ_OFFSET_MS = 7 * 60 * 60 * 1000;
const RETENTION_HOURS = Math.max(1, Number(process.env.ARCHIVE_RETENTION_HOURS || 48));
const DEFAULT_MAIL_TO = "vvhoangvn@gmail.com";

function readProjectId() {
  if (process.env.FIREBASE_PROJECT_ID) return process.env.FIREBASE_PROJECT_ID;
  if (!fs.existsSync(FIREBASERC_PATH)) return undefined;
  const config = JSON.parse(fs.readFileSync(FIREBASERC_PATH, "utf8"));
  return config.projects && (config.projects.default || Object.values(config.projects)[0]);
}

function initializeFirebase() {
  if (admin.apps.length) return admin.firestore();
  const projectId = readProjectId();
  const config = projectId ? {projectId} : {};
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)),
      ...config,
    });
    return admin.firestore();
  }
  if (fs.existsSync(SERVICE_ACCOUNT_PATH)) {
    admin.initializeApp({
      credential: admin.credential.cert(require(SERVICE_ACCOUNT_PATH)),
      ...config,
    });
    return admin.firestore();
  }
  admin.initializeApp(config);
  return admin.firestore();
}

function vietnamDateParts(date = new Date()) {
  const shifted = new Date(date.getTime() + TZ_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function vietnamDateKey(date = new Date()) {
  const parts = vietnamDateParts(date);
  return [
    String(parts.year).padStart(4, "0"),
    String(parts.month).padStart(2, "0"),
    String(parts.day).padStart(2, "0"),
  ].join("-");
}

function startOfVietnamDayUtc(date = new Date()) {
  const parts = vietnamDateParts(date);
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day) - TZ_OFFSET_MS);
}

function retentionCutoffDate(date = new Date(), hours = RETENTION_HOURS) {
  return new Date(date.getTime() - hours * 60 * 60 * 1000);
}

function timestampToDate(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function itemDate(item) {
  return timestampToDate(item.publishedAt) || timestampToDate(item.createdAt) || new Date(0);
}

function formatArchiveItem(entry, index) {
  const item = entry.data;
  const publishedAt = itemDate(item);
  const tickers = Array.isArray(item.tickers) ? item.tickers : (Array.isArray(item.relatedStocks) ? item.relatedStocks : []);
  const sectors = Array.isArray(item.sectors) ? item.sectors : [item.finalSector || item.sector].filter(Boolean);
  return [
    `${index + 1}. ${cleanText(item.title) || "(Không tiêu đề)"}`,
    `Nguồn: ${cleanText(item.source || item.sourceName || item.originalSource || entry.collection)}`,
    `Thời gian: ${publishedAt.toISOString()}`,
    `URL: ${cleanText(item.url || item.canonicalUrl || item.originalUrl)}`,
    `Nhóm ngành: ${sectors.map(cleanText).filter(Boolean).join(", ") || "-"}`,
    `Mã liên quan: ${tickers.map(cleanText).filter(Boolean).join(", ") || "-"}`,
    `Sentiment: ${cleanText(item.sentiment || item.marketSentiment) || "-"}`,
    `Impact: ${cleanText(item.impactLevel || item.priorityLabel) || "-"}`,
    `Tóm tắt: ${cleanText(item.summary || item.shortDescription || item.contentText || item.content) || "-"}`,
  ].join("\n");
}

async function fetchExpiredDocs(db, collection, cutoffDate, limit = 400) {
  const snap = await db.collection(collection)
    .where("publishedAt", "<", admin.firestore.Timestamp.fromDate(cutoffDate))
    .orderBy("publishedAt", "asc")
    .limit(limit)
    .get();
  return snap.docs.map((doc) => ({collection, doc, data: doc.data()}));
}

function appendArchiveFiles(entries) {
  if (!entries.length) return [];
  fs.mkdirSync(ARCHIVE_DIR, {recursive: true});
  const groups = new Map();
  entries.forEach((entry) => {
    const key = vietnamDateKey(itemDate(entry.data));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  });

  const writtenFiles = [];
  for (const [dateKey, dateEntries] of groups.entries()) {
    dateEntries.sort((left, right) => itemDate(left.data) - itemDate(right.data));
    const filePath = path.join(ARCHIVE_DIR, `news-${dateKey}.txt`);
    const existed = fs.existsSync(filePath);
    const header = existed ? "" : [
      `24hnew daily archive - ${dateKey}`,
      `Xuất lúc: ${new Date().toISOString()}`,
      `Timezone: Asia/Bangkok (UTC+7)`,
      "",
    ].join("\n");
    const body = dateEntries.map(formatArchiveItem).join("\n\n---\n\n");
    fs.appendFileSync(filePath, `${header}${existed ? "\n\n" : ""}${body}\n\n`, "utf8");
    writtenFiles.push(filePath);
  }
  return writtenFiles;
}

async function deleteDocs(db, entries) {
  let deleted = 0;
  for (let i = 0; i < entries.length; i += 450) {
    const batch = db.batch();
    entries.slice(i, i + 450).forEach((entry) => batch.delete(entry.doc.ref));
    await batch.commit();
    deleted += Math.min(450, entries.length - i);
  }
  return deleted;
}

async function sendArchiveEmail(files, stats) {
  const shouldSend = process.env.ARCHIVE_SEND_EMAIL === "true" || process.argv.includes("--email");
  if (!shouldSend || !files.length) return {sent: false, reason: "email_disabled"};
  let nodemailer;
  try {
    nodemailer = require("nodemailer");
  } catch (error) {
    return {sent: false, reason: "nodemailer_not_installed"};
  }
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return {sent: false, reason: "smtp_env_missing"};

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: {user, pass},
  });
  await transporter.sendMail({
    from: process.env.ARCHIVE_MAIL_FROM || user,
    to: process.env.ARCHIVE_MAIL_TO || DEFAULT_MAIL_TO,
    subject: `24hnew archive ${vietnamDateKey(new Date())}`,
    text: `Đã xuất archive 24hnew.\nDocs: ${stats.deleted}\nFiles:\n${files.join("\n")}`,
    attachments: files.map((filePath) => ({filename: path.basename(filePath), path: filePath})),
  });
  return {sent: true};
}

async function archiveExpiredNewsForVietnamDay(db, options = {}) {
  const cutoffDate = options.cutoffDate || retentionCutoffDate(new Date(), options.retentionHours || RETENTION_HOURS);
  const collections = options.collections || ["news", "manual_news"];
  const allEntries = [];
  for (const collection of collections) {
    let entries;
    do {
      entries = await fetchExpiredDocs(db, collection, cutoffDate, options.limit || 400);
      allEntries.push(...entries);
      if (!options.dryRun && entries.length) {
        const files = appendArchiveFiles(entries);
        await deleteDocs(db, entries);
        if (options.onBatch) options.onBatch({collection, count: entries.length, files});
      }
    } while (!options.dryRun && entries.length === (options.limit || 400));
  }
  const files = options.dryRun ? appendArchiveFiles([]) : Array.from(new Set(allEntries.flatMap((entry) => {
    const key = vietnamDateKey(itemDate(entry.data));
    return [path.join(ARCHIVE_DIR, `news-${key}.txt`)];
  }))).filter((filePath) => fs.existsSync(filePath));
  const email = await sendArchiveEmail(files, {deleted: allEntries.length});
  return {
    cutoffDate,
    archived: allEntries.length,
    deleted: options.dryRun ? 0 : allEntries.length,
    files,
    email,
  };
}

async function main() {
  const db = initializeFirebase();
  const result = await archiveExpiredNewsForVietnamDay(db, {
    dryRun: process.argv.includes("--dry-run"),
    onBatch: ({collection, count, files}) => {
      console.log(`[ARCHIVE] collection=${collection} count=${count} files=${files.map((file) => path.relative(ROOT_DIR, file)).join(",")}`);
    },
  });
  console.log(`[DONE] cutoff=${result.cutoffDate.toISOString()} archived=${result.archived} deleted=${result.deleted} email=${result.email.sent ? "sent" : result.email.reason}`);
  await admin.app().delete();
}

if (require.main === module) {
  main().catch(async (error) => {
    console.error(error.stack || error.message);
    try {
      if (admin.apps.length) await admin.app().delete();
    } catch (_) {}
    process.exit(1);
  });
}

module.exports = {
  archiveExpiredNewsForVietnamDay,
  startOfVietnamDayUtc,
  retentionCutoffDate,
  vietnamDateKey,
};
