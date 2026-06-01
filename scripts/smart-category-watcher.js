const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const Parser = require("rss-parser");
const entities = require("entities");
const admin = require("firebase-admin");
const {archiveExpiredNewsForVietnamDay} = require("./daily-news-archive");
const {isLikelyEnglishText, translateNewsTextLite} = require("../public/js/localTranslator");

const ROOT_DIR = path.resolve(__dirname, "..");
const NEWS_SOURCES_PATH = path.join(ROOT_DIR, "js", "core", "newsSources.js");
const SERVICE_ACCOUNT_PATH = path.join(ROOT_DIR, "serviceAccountKey.json");
const FIREBASERC_PATH = path.join(ROOT_DIR, ".firebaserc");
const STATE_PATH = path.join(__dirname, ".watcher-state.json");

const MAX_ITEMS_PER_CHECK = Number(process.env.WATCHER_MAX_ITEMS || 20);
const FETCH_TIMEOUT_MS = Number(process.env.WATCHER_FETCH_TIMEOUT_MS || 8000);
const SOURCE_REFRESH_MS = Number(process.env.WATCHER_SOURCE_REFRESH_MS || 5 * 60 * 1000);
const SKIP_ARCHIVE = process.env.WATCHER_SKIP_ARCHIVE === "true";
const SOURCE_MODE = String(process.env.WATCHER_SOURCE_MODE || "local").toLowerCase();
const DEDUPE_FIRESTORE = process.env.WATCHER_DEDUPE_FIRESTORE === "true";
const WRITE_SOURCE_STATE_TO_FIRESTORE = process.env.WATCHER_WRITE_SOURCE_STATE === "true";
const WRITE_WATCHER_LOGS = process.env.WATCHER_WRITE_LOGS === "true";
const LEGAL_SUMMARY_LIMIT = 300;
const RUN_ONCE = process.argv.includes("--once");
const RUN_ONCE_ROUNDS = process.env.WATCHER_ONCE_ROUNDS
  ? Math.max(1, Number(process.env.WATCHER_ONCE_ROUNDS))
  : Number.POSITIVE_INFINITY;
const RUN_ONCE_TIME_BUDGET_MS = Math.max(30 * 1000, Number(process.env.WATCHER_ONCE_TIME_BUDGET_MS || 8 * 60 * 1000));
const RUN_ONCE_ROUND_DELAY_MS = Math.max(0, Number(process.env.WATCHER_ONCE_ROUND_DELAY_MS || 1500));
const CATEGORY_BASE_INTERVAL_MINUTES = Number(process.env.WATCHER_CATEGORY_BASE_MINUTES || 6);
const DOMAIN_COOLDOWN_MIN_MS = Number(process.env.WATCHER_DOMAIN_COOLDOWN_MIN_MS || 60 * 1000);
const DOMAIN_COOLDOWN_MAX_MS = Number(process.env.WATCHER_DOMAIN_COOLDOWN_MAX_MS || 120 * 1000);
const RSS_FETCH_HEADERS = {
  "user-agent": "new24h-news-monitor/1.0",
  "accept": "application/rss+xml, application/xml, text/xml, text/html, */*",
};
const INSECURE_TLS_FALLBACK_HOSTS = new Set(["hnx.vn", "www.hnx.vn"]);

const parser = new Parser({
  timeout: FETCH_TIMEOUT_MS,
  customFields: {
    item: [
      ["media:thumbnail", "mediaThumbnail"],
      ["media:content", "mediaContent"],
      ["content:encoded", "contentEncoded"],
      ["updated", "updated"],
    ],
  },
});
const robotsCache = new Map();
let firestoreQuotaExhausted = false;

function isFirestoreQuotaError(error) {
  return String(error?.message || error || "").includes("RESOURCE_EXHAUSTED")
    || String(error?.code || "") === "8";
}

function isFirestoreAlreadyExistsError(error) {
  return String(error?.message || error || "").includes("ALREADY_EXISTS")
    || String(error?.code || "") === "6";
}

function readProjectId() {
  if (process.env.FIREBASE_PROJECT_ID) return process.env.FIREBASE_PROJECT_ID;
  if (!fs.existsSync(FIREBASERC_PATH)) return undefined;
  const config = JSON.parse(fs.readFileSync(FIREBASERC_PATH, "utf8"));
  return config.projects && (config.projects.default || Object.values(config.projects)[0]);
}

function initializeFirebase() {
  const projectId = readProjectId();
  const config = projectId ? {projectId} : {};
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      config.credential = admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON));
    } catch (error) {
      throw new Error(`Invalid FIREBASE_SERVICE_ACCOUNT_JSON: ${error.message}`);
    }
  } else if (fs.existsSync(SERVICE_ACCOUNT_PATH)) {
    config.credential = admin.credential.cert(require("../serviceAccountKey.json"));
  } else {
    throw new Error("Missing Firebase credentials. Set FIREBASE_SERVICE_ACCOUNT_JSON or provide serviceAccountKey.json locally.");
  }
  admin.initializeApp(config);
  return admin.firestore();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function randomBetween(min, max) {
  return min + Math.floor(Math.random() * Math.max(1, max - min + 1));
}

function toMillis(value) {
  if (!value) return 0;
  if (typeof value === "number") return value;
  if (typeof value.toDate === "function") return value.toDate().getTime();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch (error) {
    return "unknown";
  }
}

function fixMojibake(value) {
  let text = String(value || "");
  text = text
    .replace(/Thá»‹ trÆ°á»ng/g, "Thị trường")
    .replace(/thá»‹ trÆ°á»ng/g, "thị trường")
    .replace(/tÃ i nguyÃªn/g, "tài nguyên")
    .replace(/khÃ­ háº­u/g, "khí hậu")
    .replace(/ngÆ°á»i dÃ¢n/g, "người dân");
  const map = [
    ["ThÃ´ng bÃ¡o", "Thông báo"],
    ["CÃ´ng bá»‘", "Công bố"],
    ["cá»• Ä‘Ã´ng", "cổ đông"],
    ["Ä‘áº¡i há»™i", "đại hội"],
    ["nghÃª quyáº¿t", "nghị quyết"],
    ["Nghá»‹ quyáº¿t", "Nghị quyết"],
    ["HÄQT", "HĐQT"],
    ["ÄHÄCÄ", "ĐHĐCĐ"],
    ["Ã½ kiáº¿n", "ý kiến"],
    ["vÄƒn báº£n", "văn bản"],
    ["chá»‘t", "chốt"],
    ["danh sÃ¡ch", "danh sách"],
    ["há»£p Ä‘á»“ng", "hợp đồng"],
    ["cÃ´ng ty", "công ty"],
    ["hÃª sinh thÃ¡i", "hệ sinh thái"],
    ["há»‡ sinh thÃ¡i", "hệ sinh thái"],
  ];
  for (const [bad, good] of map) text = text.split(bad).join(good);
  return text;
}

function stripHtml(value) {
  const clean = String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);?/g, (match, code) => {
      const codePoint = Number(code);
      if (!Number.isFinite(codePoint)) return match;
      try {
        return String.fromCodePoint(codePoint);
      } catch (error) {
        return match;
      }
    })
    .replace(/#(\d{2,7});?/g, (match, code) => {
      const codePoint = Number(code);
      if (!Number.isFinite(codePoint)) return match;
      try {
        return String.fromCodePoint(codePoint);
      } catch (error) {
        return match;
      }
    })
    .replace(/\s+/g, " ")
    .trim();
  return fixMojibake(entities.decodeHTML(clean));
}

function cleanHeadline(value) {
  return stripHtml(value)
    .replace(/\b(Image|Video|Advertisement|APP 24h)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isMarketWidgetText(title) {
  const lower = String(title || "").toLowerCase();
  const numberParts = (String(title || "").match(/\d[\d.,%]*/g) || []).length;
  return numberParts >= 5
    || /vn-?index|vn30|upcom|hastc|gia vang|giá vàng|ty gia|tỷ giá|usd mua|usd ban|usd bán|mua\s+\d|ban\s+\d|bán\s+\d|xang|xăng|dang nhap|đăng nhập/i.test(lower);
}

function isNavigationText(title) {
  const normalized = String(title || "").trim().toLowerCase();
  const navWords = new Set([
    "tin tức", "tin tuc", "bóng đá", "bong da", "kinh doanh", "giải trí", "giai tri",
    "sức khỏe", "suc khoe", "hi-tech", "thế giới", "the gioi", "thể thao", "the thao",
    "ô tô", "o to", "phong thủy", "phong thuy", "xem thêm", "xem them", "facebook",
    "zalo", "copy link", "gửi góp ý", "gui gop y", "liên hệ quảng cáo", "lien he quang cao",
    "chính sách bảo mật", "chinh sach bao mat", "tuyển dụng", "tuyen dung",
  ]);
  return navWords.has(normalized);
}

function parserTypeForSource(source) {
  const value = String(source.parserType || "").toLowerCase();
  try {
    const host = new URL(source.url).hostname.replace(/^www\./, "");
    if (/24h\.com\.vn$/i.test(host)) return "parser_24h";
    if (/vietstock\.vn$/i.test(host) && /moi-cap-nhat/i.test(source.url || "")) return "vietstock_moi_cap_nhat";
  } catch (error) {
    return value || "generic";
  }
  return value || "generic_scored_category";
}

function isLikelyArticleUrl(rawUrl, baseUrl, parserType = "generic") {
  let parsed;
  let base;
  try {
    parsed = new URL(rawUrl, baseUrl || undefined);
    base = new URL(baseUrl || rawUrl);
  } catch (error) {
    return false;
  }
  if (!/^https?:$/.test(parsed.protocol)) return false;
  if (base.hostname && parsed.hostname !== base.hostname && !parsed.hostname.endsWith(`.${base.hostname}`)) return false;
  const pathname = parsed.pathname.toLowerCase();
  if (/\.(jpg|jpeg|png|gif|webp|svg|css|js|pdf)$/i.test(pathname)) return false;
  if (/\/(tag|tags|video|photo|login|dang-nhap|lien-he|gioi-thieu|chinh-sach|tuyen-dung)(\/|$)/i.test(pathname)) return false;
  if (parserType === "parser_24h") {
    return /(?:-c\d+a\d+|-d\d+)\.html$/i.test(pathname) || (/\.html$/i.test(pathname) && !/-c\d+\.html$/i.test(pathname));
  }
  return /\.html?$/i.test(pathname) || /\/\d{4}\/\d{1,2}\//.test(pathname) || /\/(news|tin|bai-viet|article)\//i.test(pathname);
}

function isCategoryUrl(rawUrl, baseUrl) {
  try {
    const url = new URL(rawUrl, baseUrl);
    const path = url.pathname.toLowerCase();
    return /\/(tag|tags|search|category|cate|page|video|photo)(\/|$)/i.test(path)
      || /-c\d+\.html$/i.test(path)
      || /[?&](q|keyword|page)=/i.test(url.search);
  } catch (error) {
    return true;
  }
}

function isOffTopicTitle(title, source) {
  const text = String(title || "").toLowerCase();
  if (!/(ngan hang|ngân hàng|tai chinh|tài chính|kinh doanh|chung khoan|chứng khoán|market|stocks|bank)/i.test(`${source.category || ""} ${source.sector || ""} ${source.url || ""}`)) {
    return false;
  }
  return /\b(bóng đá|bong da|phong thủy|phong thuy|giải trí|giai tri|hoa hậu|showbiz|bikini|mỹ nhân|my nhan|xổ số|xo so)\b/i.test(text);
}

function normalizedTitleKey(title) {
  return stripHtml(title).toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function sourceKeyText(source = {}) {
  return [
    source.id,
    source.sourceId,
    source.name,
    source.sourceName,
    source.category,
    source.url,
    source.rssUrl,
  ].filter(Boolean).join(" ").toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function sourceCategorySector(source = {}) {
  const category = String(source.category || "").toLowerCase();
  if (category === "stocks") return "Chứng khoán";
  if (category === "macro") return "Vĩ mô";
  if (category === "research") return "Phân tích";
  return "";
}

function usefulSector(value) {
  const text = stripHtml(value || "").trim();
  const key = normalizedTitleKey(text);
  if (!text || ["other", "nhom khac", "tin khac"].includes(key)) return "";
  return text;
}

function extractLeadingTicker(title) {
  const match = String(title || "").trim().match(/^([A-Z][A-Z0-9]{2,11})(?=\s*:)/);
  return match ? match[1].toUpperCase() : "";
}

function extractWarrantTicker(title) {
  const raw = String(title || "");
  const key = normalizedTitleKey(raw);
  if (!/\bchung quyen\b/.test(key)) return "";
  const dotted = raw.match(/\b([A-Z]{2,5})\.[A-Z0-9]{2,}(?:\.|$)/);
  if (dotted) return dotted[1].toUpperCase();
  const afterPhrase = raw.match(/ch(?:ứ|u)ng\s+quy(?:ề|e)n[^A-Z0-9]{0,40}\b([A-Z]{2,5})\b/i);
  return afterPhrase ? afterPhrase[1].toUpperCase() : "";
}

function sourceAllowsStockTickers(source = {}) {
  const keyText = sourceKeyText(source);
  if (/\b(coindesk|cryptoslate|cryptonews|cointelegraph|bitcoin news|bitcoin_news|crypto|fx|gold)\b/.test(keyText)) {
    return false;
  }
  return source.group === "domestic"
    || /\b(hose|hsx|hnx|vietstock|chung khoan|stocks?|co phieu)\b/.test(keyText);
}

function scoreCandidate(candidate, source, seen, seenTitles) {
  const title = cleanHeadline(candidate.title);
  const url = candidate.canonicalUrl || candidate.absoluteUrl || candidate.href;
  const parserType = parserTypeForSource(source);
  let score = 0;
  const reasons = [];

  if (url && isLikelyArticleUrl(url, source.url, parserType)) score += 30;
  else {
    score -= 30;
    reasons.push("url");
  }

  if (title.length >= 20 && title.length <= 160) score += 25;
  else if (title.length < 10) {
    score -= 40;
    reasons.push("short");
  } else if (title.length < 20) {
    score -= 12;
    reasons.push("short");
  }

  if (/[-/][a-z0-9-]{10,}\.html?$/i.test(url) || /(?:-c\d+a\d+|-d\d+)\.html$/i.test(url)) score += 20;
  if (/(h1|h2|h3|article|news-item|story|post|media|item|list-news)/i.test(candidate.selectorHint || "")) score += 15;
  if (candidate.positionIndex < 12) score += 10;
  if (/\b(\d{1,2}\/\d{1,2}\/\d{4}|\d{1,2}:\d{2}|phút trước|giờ trước)\b/i.test(candidate.containerText || "")) score += 10;
  if (/\b(ngân hàng|ngan hang|lãi suất|lai suat|tín dụng|tin dung|doanh nghiệp|doanh nghiep|cổ phiếu|co phieu|thị trường|thi truong|lợi nhuận|loi nhuan|dự án|du an|đầu tư|dau tu|trái phiếu|trai phieu|tỷ đồng|ty dong)\b/i.test(title)) score += 10;

  if (/nav|menu|footer|sidebar|right|header/i.test(candidate.selectorHint || "")) {
    score -= 50;
    reasons.push("menu");
  }
  if (isNavigationText(title)) {
    score -= 40;
    reasons.push("menu");
  }
  if (isMarketWidgetText(title)) {
    score -= 35;
    reasons.push("widget");
  }
  if (isCategoryUrl(url, source.url)) {
    score -= 30;
    reasons.push("url");
  }
  const titleKey = normalizedTitleKey(title);
  if (seen.has(url) || seenTitles.has(titleKey)) {
    score -= 25;
    reasons.push("duplicate");
  }
  if (isOffTopicTitle(title, source)) {
    score -= 20;
    reasons.push("off_topic");
  }

  return {score: Math.max(0, Math.min(100, score)), reasons, title, titleKey, url};
}

function headlineScore(title, url, baseUrl, parserType) {
  const clean = cleanHeadline(title);
  if (!clean || clean.length < 20 || clean.length > 220) return 0;
  if (!isLikelyArticleUrl(url, baseUrl, parserType)) return 0;
  if (isNavigationText(clean) || isMarketWidgetText(clean)) return 0;
  let score = 45;
  if (/[?!.:]$/.test(clean) || clean.split(/\s+/).length >= 7) score += 15;
  if (/\b(ngân hàng|ngan hang|lãi suất|lai suat|tín dụng|tin dung|doanh nghiệp|doanh nghiep|cổ phiếu|co phieu|thị trường|thi truong|lợi nhuận|loi nhuan|dự án|du an|đầu tư|dau tu|trái phiếu|trai phieu|tỷ đồng|ty dong)\b/i.test(clean)) score += 10;
  if ((clean.match(/\d/g) || []).length > clean.length * 0.28) score -= 25;
  return Math.max(0, Math.min(100, score));
}

function removeNoisyHtmlSections(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<aside[\s\S]*?<\/aside>/gi, " ")
    .replace(/<section[^>]+class=["'][^"']*(?:sidebar|right|menu|nav|footer|header|ads|banner|ticker|stock|gold)[^"']*["'][\s\S]*?<\/section>/gi, " ")
    .replace(/<div[^>]+class=["'][^"']*(?:sidebar|right|menu|nav|footer|header|ads|banner|ticker|stock|gold)[^"']*["'][\s\S]*?<\/div>/gi, " ");
}

function limitSummary(value) {
  const clean = stripHtml(value).replace(/\s+/g, " ").trim();
  if (clean.length <= LEGAL_SUMMARY_LIMIT) return clean;
  return `${clean.slice(0, LEGAL_SUMMARY_LIMIT - 3).trimEnd()}...`;
}

function normalizeUrl(rawUrl, baseUrl = "") {
  if (!rawUrl) return "";
  try {
    const url = new URL(rawUrl, baseUrl || undefined);
    [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "fbclid",
      "gclid",
      "mc_cid",
      "mc_eid",
    ].forEach((param) => url.searchParams.delete(param));

    url.hash = "";
    url.hostname = url.hostname
      .replace(/^m\./i, "")
      .replace(/^mobile\./i, "")
      .toLowerCase();

    url.pathname = url.pathname
      .replace(/\/amp\/?$/i, "")
      .replace(/\/amp$/i, "")
      .replace(/\/+$/g, "");

    return url.href.replace(/\/$/, "");
  } catch (error) {
    return String(rawUrl || "").trim().replace(/\/$/, "");
  }
}

function isBrokenPublicArticleUrl(url) {
  return /^https?:\/\/(?:www\.)?hnx\.vn:7978\//i.test(String(url || ""));
}

function publicArticleUrl(url) {
  const value = String(url || "").trim();
  if (/^https?:\/\/api\.hsx\.vn\/tin-tuc\//i.test(value)) {
    return value.replace(/^https?:\/\/api\.hsx\.vn/i, "https://www.hsx.vn");
  }
  if (isBrokenPublicArticleUrl(value)) {
    return value.replace(/^https?:\/\/(?:www\.)?hnx\.vn:7978/i, "https://www.hnx.vn");
  }
  return value;
}

function publicSourceName(source, fallback = "") {
  const text = stripHtml([
    source?.id,
    source?.sourceId,
    source?.url,
    source?.name,
    source?.sourceName,
    fallback,
  ].filter(Boolean).join(" ")).toLowerCase();
  if (/\bhnx\b|hnx\.vn|hnx_/.test(text)) return "HNX";
  if (/\bhose\b|\bhsx\b|api\.hsx\.vn|hsx\.vn|hose_/.test(text)) return "HOSE";
  return fallback || source?.name || source?.sourceName || "Unknown";
}

function uniqueKey(source, canonicalUrl) {
  return crypto
    .createHash("sha256")
    .update(`${source.name || source.sourceId || source.url}|${canonicalUrl}`.toLowerCase())
    .digest("hex");
}

function readJsonIfExists(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sourceIdFromUrl(url) {
  return crypto.createHash("sha1").update(String(url || "")).digest("hex").slice(0, 12);
}

function normalizeSource(raw, origin = "file") {
  const url = raw.url || raw.rssUrl;
  const type = raw.type || (raw.fetchMode === "rss" ? "rss" : raw.fetchMode === "html" ? "category" : "rss");
  return {
    id: raw.id || raw.sourceId || sourceIdFromUrl(url),
    firestoreCollection: raw.firestoreCollection || null,
    firestoreId: raw.firestoreId || null,
    origin,
    name: raw.name || raw.sourceName || raw.sourceId || url,
    url,
    type,
      category: raw.category || "market",
      sector: raw.sector || "",
      eventType: raw.eventType || null,
      marketScope: raw.marketScope || null,
      active: raw.active !== false && raw.enabled !== false,
    status: raw.status || (raw.active === false ? "DISABLED" : "OK"),
    priority: raw.priority || (raw.category === "market" || raw.category === "stocks" ? "normal" : "low"),
    intervalSeconds: Number(raw.intervalSeconds || 0) || null,
    parserType: raw.parserType || "generic",
    allowCrawl: raw.allowCrawl !== false,
    lastSeenUrl: raw.lastSeenUrl || "",
    lastSeenTitle: raw.lastSeenTitle || "",
    lastSeenUrls: Array.isArray(raw.lastSeenUrls) ? raw.lastSeenUrls : [],
    lastSeenTitles: Array.isArray(raw.lastSeenTitles) ? raw.lastSeenTitles : [],
    lastTopFingerprint: raw.lastTopFingerprint || "",
    lastCheckedAt: raw.lastCheckedAt || null,
    lastNewAt: raw.lastNewAt || null,
    nextFetchAt: raw.forceRefreshAt ? 0 : (raw.nextFetchAt || raw.nextCheckAt || null),
    consecutiveErrors: Number(raw.consecutiveErrors || 0),
    totalErrors: Number(raw.totalErrors || raw.errorCount || 0),
    lastHttpStatus: raw.lastHttpStatus || null,
    domainStatus: raw.domainStatus || (raw.active === false ? "DISABLED" : "OK"),
    blockedReason: raw.blockedReason || null,
    parserQuality: raw.parserQuality ?? null,
  };
}

function loadFileSources() {
  const configured = readJsonIfExists(path.join(__dirname, "watcher-sources.json"), null);
  if (Array.isArray(configured)) {
    return configured.map((source) => normalizeSource(source, "watcher-sources.json"));
  }

  if (!fs.existsSync(NEWS_SOURCES_PATH)) return [];
  const code = fs.readFileSync(NEWS_SOURCES_PATH, "utf8");
  const sandbox = {window: {}};
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, {filename: NEWS_SOURCES_PATH});
  return (sandbox.window.newsSources || []).map((source) => normalizeSource(source, "newsSources.js"));
}

async function loadFirestoreSources(db, collectionName) {
  const snapshot = await db.collection(collectionName).where("active", "==", true).get();
  return snapshot.docs
    .map((doc) => normalizeSource({
      ...doc.data(),
      id: doc.id,
      firestoreId: doc.id,
      firestoreCollection: collectionName,
    }, collectionName))
    .filter((source) => source.url);
}

async function loadSources(db, state) {
  let sources = [];
  if (SOURCE_MODE === "local") {
    sources = loadFileSources();
  }

  if (!sources.length && SOURCE_MODE !== "local" && !firestoreQuotaExhausted) {
    try {
      sources = await loadFirestoreSources(db, "watch_sources");
    } catch (error) {
      if (isFirestoreQuotaError(error)) firestoreQuotaExhausted = true;
      console.log(`[WARN] watch_sources unavailable: ${error.message}`);
    }
  }

  if (!sources.length && SOURCE_MODE !== "local" && !firestoreQuotaExhausted) {
    try {
      sources = await loadFirestoreSources(db, "rss_sources");
    } catch (error) {
      if (isFirestoreQuotaError(error)) firestoreQuotaExhausted = true;
      console.log(`[WARN] rss_sources unavailable: ${error.message}`);
    }
  }

  if (!sources.length) {
    if (firestoreQuotaExhausted) console.log("[WARN] Firestore quota exhausted; using local file sources only for this run.");
    sources = loadFileSources();
  }

  return sources
    .filter((source) => source.active && source.allowCrawl !== false && source.status !== "DISABLED" && source.url)
    .map((source) => ({
      ...source,
      ...(state.sources?.[source.id] || {}),
      nextFetchAt: state.sources?.[source.id]?.nextFetchAt || toMillis(source.nextFetchAt),
      nextCheckAt: state.sources?.[source.id]?.nextCheckAt || toMillis(source.nextFetchAt),
      quietStreak: state.sources?.[source.id]?.quietStreak || 0,
      domain: domainOf(source.url),
    }));
}

class FetchStatusError extends Error {
  constructor(message, status = null, code = "fetch_failed") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function allowsInsecureTlsFallback(url) {
  try {
    return INSECURE_TLS_FALLBACK_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch (error) {
    return false;
  }
}

function isTlsCertificateError(error) {
  const code = String(error?.cause?.code || error?.code || "");
  const message = String(error?.message || error || "");
  return code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
    || code === "SELF_SIGNED_CERT_IN_CHAIN"
    || code === "CERT_HAS_EXPIRED"
    || message.includes("unable to verify the first certificate");
}

function fetchTextWithInsecureTls(url, redirectCount = 0) {
  if (redirectCount > 3) {
    return Promise.reject(new FetchStatusError("too_many_redirects", null, "fetch_failed"));
  }
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === "http:" ? http : https;
    const request = client.get(parsed, {
      headers: RSS_FETCH_HEADERS,
      rejectUnauthorized: false,
      timeout: FETCH_TIMEOUT_MS,
    }, (response) => {
      const status = response.statusCode || 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location) {
        response.resume();
        const nextUrl = new URL(location, parsed).toString();
        fetchTextWithInsecureTls(nextUrl, redirectCount + 1).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        const code = status === 403 ? "blocked_403" : status === 429 ? "rate_limited_429" : "fetch_failed";
        reject(new FetchStatusError(`HTTP ${status} ${response.statusMessage || ""}`.trim(), status, code));
        return;
      }
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    request.on("timeout", () => request.destroy(new FetchStatusError("timeout", null, "timeout")));
    request.on("error", reject);
  });
}

async function fetchText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: RSS_FETCH_HEADERS,
      signal: controller.signal,
    });
    if (!response.ok) {
      const code = response.status === 403 ? "blocked_403" : response.status === 429 ? "rate_limited_429" : "fetch_failed";
      throw new FetchStatusError(`HTTP ${response.status} ${response.statusText}`, response.status, code);
    }
    return await response.text();
  } catch (error) {
    if (error.name === "AbortError") throw new FetchStatusError("timeout", null, "timeout");
    if (error instanceof FetchStatusError) throw error;
    if (isTlsCertificateError(error) && allowsInsecureTlsFallback(url)) {
      return await fetchTextWithInsecureTls(url);
    }
    throw new FetchStatusError(error.message || "network_error", null, "network_error");
  } finally {
    clearTimeout(timeout);
  }
}

async function isAllowedByRobots(url) {
  try {
    const parsed = new URL(url);
    const robotsUrl = `${parsed.origin}/robots.txt`;
    if (!robotsCache.has(robotsUrl)) {
      const text = await fetchText(robotsUrl).catch(() => "");
      robotsCache.set(robotsUrl, text);
    }

    const robotsText = robotsCache.get(robotsUrl);
    if (!robotsText) return true;

    let applies = false;
    const disallows = [];
    robotsText.split(/\r?\n/).forEach((line) => {
      const clean = line.split("#")[0].trim();
      if (!clean) return;
      const [rawKey, ...rawValue] = clean.split(":");
      const key = rawKey.trim().toLowerCase();
      const value = rawValue.join(":").trim();
      if (key === "user-agent") {
        applies = value === "*";
        return;
      }
      if (applies && key === "disallow" && value) {
        disallows.push(value);
      }
    });

    return !disallows.some((rule) => rule !== "/" && parsed.pathname.startsWith(rule));
  } catch (error) {
    return true;
  }
}

function thumbnailFromItem(item) {
  const candidates = [
    item.enclosure?.url,
    item.mediaThumbnail?.$?.url,
    item.mediaContent?.$?.url,
  ];
  return candidates.find((value) => /^https?:\/\//i.test(String(value || ""))) || "";
}

function validPublishedIso(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const year = date.getUTCFullYear();
  const nextYear = new Date().getUTCFullYear() + 1;
  if (year < 2000 || year > nextYear) return null;
  return date.toISOString();
}

function vietstockDotNetDate(value) {
  const match = String(value || "").match(/\/Date\((\d+)\)\//);
  if (!match) return null;
  const date = new Date(Number(match[1]));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function publishedAtFromArticleUrl(value) {
  const match = String(value || "").match(/185(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
  if (!match) return null;
  const [, yy, mm, dd, hh, min, sec] = match.map(Number);
  const year = 2000 + yy;
  const date = new Date(Date.UTC(year, mm - 1, dd, hh - 7, min, sec));
  const localDate = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  if (
    localDate.getUTCFullYear() !== year
    || localDate.getUTCMonth() !== mm - 1
    || localDate.getUTCDate() !== dd
  ) {
    return null;
  }
  return date.toISOString();
}

function rssPublishedAt(item, canonicalUrl) {
  return validPublishedIso(item.isoDate)
    || validPublishedIso(item.pubDate)
    || validPublishedIso(item.updated)
    || publishedAtFromArticleUrl(canonicalUrl)
    || null;
}

async function parseRssSource(source) {
  const xml = await fetchText(source.url);
  const feed = await parser.parseString(xml);
  return (feed.items || []).slice(0, MAX_ITEMS_PER_CHECK).map((item) => {
    const canonicalUrl = normalizeUrl(item.link || item.guid || item.url || "", source.url);
    return {
      title: stripHtml(item.title || "Untitled"),
      url: canonicalUrl,
      canonicalUrl,
      summary: limitSummary(item.contentSnippet || item.summary || item.description || ""),
      thumbnail: thumbnailFromItem(item),
      publishedAt: rssPublishedAt(item, canonicalUrl),
      source: source.name,
      category: source.category,
    };
  }).filter((item) => item.title && item.canonicalUrl);
}

function extractMeta(html, property) {
  const pattern = new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i");
  return stripHtml((html.match(pattern) || [])[1] || "");
}

function parseCategorySourceFromHtml(source, html) {
  const parserType = parserTypeForSource(source);
  const cleanedHtml = removeNoisyHtmlSections(html);
  const blocks = Array.from(cleanedHtml.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi));
  const seen = new Set();
  const seenTitles = new Set();
  const candidates = [];
  const rejected = {menu: 0, short: 0, widget: 0, url: 0, duplicate: 0, off_topic: 0, low_quality: 0};
  const selectorCounts = new Map();

  blocks.forEach((match, positionIndex) => {
    const href = match[1];
    const rawAnchor = match[0];
    const title = cleanHeadline(match[2]);
    const canonicalUrl = normalizeUrl(href, source.url);
    if (!canonicalUrl) {
      rejected.url += 1;
      return;
    }

    const classHint = (rawAnchor.match(/\bclass=["']([^"']+)["']/i) || [])[1] || "";
    const selectorHint = `${parserType} a[href] ${classHint}`.trim();
    const scored = scoreCandidate({
      title,
      href,
      absoluteUrl: canonicalUrl,
      canonicalUrl,
      containerText: stripHtml(match[0]).slice(0, 260),
      positionIndex,
      selectorHint,
    }, source, seen, seenTitles);

    if (scored.score < 40) {
      const reason = scored.reasons[0] || "low_quality";
      rejected[reason] = (rejected[reason] || 0) + 1;
      candidates.push({
        score: scored.score,
        rejected: true,
        title: scored.title,
        url: canonicalUrl,
        canonicalUrl,
        selectorHint,
        positionIndex,
      });
      return;
    }
    seen.add(canonicalUrl);
    seenTitles.add(scored.titleKey);
    selectorCounts.set(selectorHint, (selectorCounts.get(selectorHint) || 0) + 1);
    candidates.push({
      score: scored.score,
      title: scored.title,
      url: canonicalUrl,
      canonicalUrl,
      summary: "",
      publishedAt: null,
      source: source.name,
      category: source.category,
      sector: source.sector || "",
      selectorHint,
      positionIndex,
    });
  });

  let accepted = candidates
    .filter((candidate) => !candidate.rejected)
    .sort((left, right) => right.score - left.score)
    .slice(0, MAX_ITEMS_PER_CHECK);

  if (!accepted.length) {
    accepted = candidates
      .filter((candidate) => !isNavigationText(candidate.title) && !isMarketWidgetText(candidate.title) && candidate.score >= 20)
      .sort((left, right) => right.score - left.score)
      .slice(0, Math.min(5, MAX_ITEMS_PER_CHECK));
  }

  const items = accepted.map(({rejected: _rejected, ...item}) => item);
  const rejectedCount = Object.values(rejected).reduce((sum, value) => sum + Number(value || 0), 0);
  const tested = items.length + rejectedCount;
  const avgScore = accepted.length ? Math.round(accepted.reduce((sum, item) => sum + item.score, 0) / accepted.length) : 0;
  const qualityPercent = tested ? Math.round((items.length / Math.max(1, tested)) * 100) : 0;
  const parserQuality = {
    acceptedCount: items.length,
    rejectedCount,
    avgScore,
    noiseRatio: tested ? Number((rejectedCount / tested).toFixed(2)) : 0,
    qualityPercent,
    rejectReasons: rejected,
  };
  const recentAcceptedSelectors = Array.from(selectorCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([selector, count]) => ({selector, count}));
  if (items.length) {
    console.log(`[PARSE] ${source.name} category parser=${parserType} items=${items.length} quality=${qualityPercent}% avgScore=${avgScore} rejected=${JSON.stringify(rejected)}`);
  }

  items.parserQuality = parserQuality;
  items.parserRejected = rejected;
  items.parserPattern = parserType;
  items.recentAcceptedSelectors = recentAcceptedSelectors;
  return items;
}

async function parseVietstockLatestSource(source) {
  const endpoint = new URL("/_Partials/NewsNewUpdatePaging", source.url).href;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let payload;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        ...RSS_FETCH_HEADERS,
        accept: "application/json, text/javascript, */*; q=0.01",
        "content-type": "application/json; charset=utf-8",
        referer: source.url,
        "x-requested-with": "XMLHttpRequest",
      },
      body: JSON.stringify({item: MAX_ITEMS_PER_CHECK, row: 1}),
      signal: controller.signal,
    });
    if (!response.ok) {
      const code = response.status === 403 ? "blocked_403" : response.status === 429 ? "rate_limited_429" : "fetch_failed";
      throw new FetchStatusError(`HTTP ${response.status} ${response.statusText}`, response.status, code);
    }
    payload = await response.json();
  } catch (error) {
    if (error.name === "AbortError") throw new FetchStatusError("timeout", null, "timeout");
    if (error instanceof FetchStatusError) throw error;
    throw new FetchStatusError(error.message || "network_error", null, "network_error");
  } finally {
    clearTimeout(timeout);
  }

  const rows = Array.isArray(payload?.Data) ? payload.Data : [];
  const items = rows.slice(0, MAX_ITEMS_PER_CHECK).map((row, positionIndex) => {
    const canonicalUrl = normalizeUrl(row.URL || "", source.url);
    const title = cleanHeadline(row.Title || "");
    return {
      title,
      url: canonicalUrl,
      canonicalUrl,
      summary: limitSummary(row.Head || ""),
      thumbnail: row.ThumbImageUrl || row.HeadImageUrl || "",
      publishedAt: vietstockDotNetDate(row.PublishTime),
      source: source.name,
      category: source.category || "stocks",
      sector: usefulSector(source.sector) || defaultSectorForSource(source) || "Chá»©ng khoÃ¡n",
      selectorHint: "vietstock_moi_cap_nhat",
      score: 100,
      positionIndex,
    };
  }).filter((item) => item.title && item.canonicalUrl);

  items.parserQuality = {
    acceptedCount: items.length,
    rejectedCount: Math.max(0, rows.length - items.length),
    avgScore: items.length ? 100 : 0,
    noiseRatio: rows.length ? Number(((rows.length - items.length) / rows.length).toFixed(2)) : 0,
    qualityPercent: rows.length ? Math.round((items.length / rows.length) * 100) : 0,
    rejectReasons: {},
  };
  items.parserRejected = {};
  items.parserPattern = "vietstock_moi_cap_nhat";
  items.recentAcceptedSelectors = [{selector: "vietstock_moi_cap_nhat", count: items.length}];
  if (items.length) {
    console.log(`[PARSE] ${source.name} category parser=vietstock_moi_cap_nhat items=${items.length} quality=${items.parserQuality.qualityPercent}% avgScore=100 rejected={}`);
  }
  return items;
}

async function parseCategorySource(source) {
  const allowed = await isAllowedByRobots(source.url);
  if (!allowed) {
    console.log(`[SKIP] ${source.name} - robots.txt disallows category path`);
    return [];
  }
  if (parserTypeForSource(source) === "vietstock_moi_cap_nhat") {
    return await parseVietstockLatestSource(source);
  }
  const html = await fetchText(source.url);
  if (/captcha|recaptcha|cloudflare|cf-challenge|verify you are human|xác minh/i.test(html)) {
    throw new FetchStatusError("captcha_detected", null, "captcha_detected");
  }
  return parseCategorySourceFromHtml(source, html);
}

async function fetchTopItems(source) {
  if (source.type === "category") return await parseCategorySource(source);
  return await parseRssSource(source);
}

function topUnchanged(source, items) {
  const first = items[0];
  return Boolean(first && source.lastSeenUrl === first.canonicalUrl && source.lastSeenTitle === first.title);
}

function toFirestoreTimestamp(value) {
  const date = value ? new Date(value) : new Date();
  return admin.firestore.Timestamp.fromDate(Number.isNaN(date.getTime()) ? new Date() : date);
}

function defaultSectorForSource(source = {}) {
  const keyText = sourceKeyText(source);
  const rules = [
    {pattern: /\b(chung khoan|stocks?|hose|hsx|hnx|thi truong chung khoan|cong bo tu so)\b/, sector: "Chứng khoán"},
    {pattern: /\b(tai chinh|finance|financial)\b/, sector: "Tài chính"},
    {pattern: /\b(dia oc|bat dong san|real estate)\b/, sector: "Bất động sản"},
    {pattern: /\b(kinh te the gioi|the gioi|macro|world economy)\b/, sector: "Vĩ mô"},
    {pattern: /\b(nhip cau doanh nghiep|doanh nghiep|company|cong ty)\b/, sector: "Doanh nghiệp"},
    {pattern: /\b(dau tu|thi truong|market|tin moi)\b/, sector: "Thị trường"},
    {pattern: /\b(su kien dao tao|research|phan tich)\b/, sector: "Phân tích"},
  ];
  const matched = rules.find((rule) => rule.pattern.test(keyText));
  if (matched) return matched.sector;
  const categorySector = sourceCategorySector(source);
  if (categorySector) return categorySector;
  const sourceText = [
    source.id,
    source.name,
    source.sourceName,
    source.url,
    source.rssUrl,
  ].filter(Boolean).join(" ").toLowerCase();
  if (/\bhnx\b|hnx\.vn/.test(sourceText)) return "Chứng khoán";
  return "";
}

function shouldTranslateSourceItem(source, item) {
  const sourceText = [
    source.id,
    source.name,
    source.sourceName,
    source.url,
    source.rssUrl,
    item.source,
  ].filter(Boolean).join(" ").toLowerCase();
  if (/coindesk|cryptoslate|cryptonews|cointelegraph|news\.bitcoin\.com|bitcoin_news|reuters|finviz/.test(sourceText)) return true;
  return source.group === "international" && isLikelyEnglishText(item.title || item.summary || "");
}

async function saveNewItems(db, source, items) {
  let saved = 0;
  let duplicates = 0;
  const seenUrls = new Set((source.lastSeenUrls || []).map((url) => normalizeUrl(url, source.url)));
  const seenTitles = new Set((source.lastSeenTitles || []).map(normalizedTitleKey));
  const freshItems = items.filter((item) => {
    const url = item.canonicalUrl || item.url;
    const titleKey = normalizedTitleKey(item.title);
    if (seenUrls.has(url) || seenTitles.has(titleKey)) {
      duplicates += 1;
      return false;
    }
    if (url) seenUrls.add(url);
    if (titleKey) seenTitles.add(titleKey);
    return true;
  });
  if (!freshItems.length) return {saved, duplicates};

  const refs = freshItems.map((item) => db.collection("news").doc(uniqueKey(source, item.canonicalUrl)));
  let existingDocs = [];
  if (DEDUPE_FIRESTORE) {
    try {
      existingDocs = await db.getAll(...refs);
    } catch (error) {
      if (isFirestoreQuotaError(error)) {
        firestoreQuotaExhausted = true;
        console.log(`[WARN] Firestore quota exhausted; skip saving ${freshItems.length} new items for ${source.name}.`);
        return {saved: 0, duplicates, firestoreSkipped: true};
      }
      throw error;
    }
  }
  const pendingWrites = [];

  for (const [index, item] of freshItems.entries()) {
    const key = uniqueKey(source, item.canonicalUrl);
    const ref = refs[index];
    if (DEDUPE_FIRESTORE && existingDocs[index]?.exists) {
      duplicates += 1;
      continue;
    }

    const summary = limitSummary(item.summary || item.shortDescription || "");
    const titleOriginal = item.title || "";
    const translateItem = shouldTranslateSourceItem(source, item);
    const titleVi = translateItem ? translateNewsTextLite(titleOriginal) : "";
    const summaryVi = translateItem ? limitSummary(translateNewsTextLite(summary)) : "";
    const allowStockTickers = sourceAllowsStockTickers(source);
    const warrantTicker = allowStockTickers ? extractWarrantTicker(item.title) : "";
    const defaultSector = defaultSectorForSource(source);
    const sector = warrantTicker ? "Chứng khoán" : usefulSector(item.sector) || usefulSector(source.sector) || defaultSector || "";
    const finalSector = warrantTicker ? "Chứng khoán" : usefulSector(item.finalSector) || usefulSector(source.finalSector) || sector || defaultSector || "";
    const leadingTicker = allowStockTickers ? (extractLeadingTicker(item.title) || warrantTicker) : "";
    const primaryTickers = leadingTicker ? [leadingTicker] : [];
    const relatedStocks = Array.from(new Set([
      ...(leadingTicker ? [leadingTicker] : []),
      ...(allowStockTickers && Array.isArray(item.relatedStocks) ? item.relatedStocks : []),
    ].filter(Boolean)));
    const tickers = Array.from(new Set([...primaryTickers, ...relatedStocks]));
    pendingWrites.push({
      ref,
      data: {
      title: item.title,
      titleOriginal,
      titleVi: titleVi || null,
      summary,
      summaryOriginal: summary,
      summaryVi: summaryVi || null,
      shortDescription: summary,
      shortDescriptionVi: summaryVi || null,
      source: publicSourceName(source, item.source),
      sourceId: source.id,
      language: translateItem ? "en" : null,
      translated: Boolean(titleVi || summaryVi),
      translatedBy: titleVi || summaryVi ? "local_rule" : null,
      category: item.category,
      sector,
      finalSector,
      eventType: item.eventType || source.eventType || null,
      marketScope: item.marketScope || source.marketScope || null,
      url: publicArticleUrl(item.url),
      originalUrl: item.url,
      canonicalUrl: item.canonicalUrl,
      publicUrl: publicArticleUrl(item.url),
      publishedAt: toFirestoreTimestamp(item.publishedAt),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      analyzed: false,
      impactScore: null,
      tickers,
      primaryTicker: primaryTickers[0] || null,
      primaryTickers,
      relatedStocks,
      finalTickers: tickers,
      status: "new",
      legalMode: true,
      contentType: "link_preview",
      originalSource: item.source,
      sourceUrl: source.url,
      summaryGeneratedBy: item.summary ? "rss" : null,
      uniqueKey: key,
      titleKey: normalizedTitleKey(item.title),
      parserScore: item.score || null,
      parserPattern: item.selectorHint || null,
      },
    });
  }

  for (const write of pendingWrites) {
    try {
      await write.ref.create(write.data);
      saved += 1;
    } catch (error) {
      if (isFirestoreAlreadyExistsError(error)) {
        duplicates += 1;
        continue;
      }
      if (isFirestoreQuotaError(error)) {
        firestoreQuotaExhausted = true;
        console.log(`[WARN] Firestore quota exhausted during create; stop saving remaining items for ${source.name}.`);
        return {saved: 0, duplicates, firestoreSkipped: true};
      }
      throw error;
    }
  }
  return {saved, duplicates};
}

function baseIntervalSeconds(source) {
  if (source.intervalSeconds) return source.intervalSeconds;
  if (source.priority === "high") return 45;
  if (source.priority === "low") return 300;
  return 120;
}

function categoryIntervalMs(source) {
  const errors = Number(source.consecutiveErrors || 0);
  if (errors >= 3) return randomBetween(45 * 60 * 1000, 60 * 60 * 1000);
  if (errors === 2) return randomBetween(25 * 60 * 1000, 35 * 60 * 1000);
  if (errors === 1) return randomBetween(15 * 60 * 1000, 20 * 60 * 1000);

  const quiet = Number(source.quietStreak || 0);
  const hot = Number(source.newItemsFound || 0) >= 3 || source.fingerprintChanged === true;
  let minuteOffset = randomBetween(-2, 2);
  if (hot) minuteOffset -= 1;
  if (quiet >= 6) minuteOffset += 4;
  else if (quiet >= 3) minuteOffset += 2;

  const minutes = Math.max(
    hot ? 3 : 4,
    Math.min(quiet >= 3 ? 10 : 8, CATEGORY_BASE_INTERVAL_MINUTES + minuteOffset),
  );
  const seconds = randomBetween(0, 59);
  return (minutes * 60 + seconds) * 1000;
}

function nextIntervalMs(source, saved) {
  if (source.type === "category") return categoryIntervalMs({...source, newItemsFound: saved});
  const base = baseIntervalSeconds(source);
  if (saved > 0) return Math.max(30, Math.floor(base / 2));
  const quiet = (source.quietStreak || 0) + 1;
  if (quiet >= 8) return Math.min(600, base * 3) * 1000;
  if (quiet >= 4) return Math.min(600, base * 2) * 1000;
  return base * 1000;
}

function sourceStatus(source, parserQuality = source.parserQuality) {
  if (source.active === false || source.allowCrawl === false) return "DISABLED";
  const errors = Number(source.consecutiveErrors || 0);
  if (errors >= 3) return "FAIL";
  if (errors > 0) return "WARNING";
  const qualityPercent = parserQualityPercent(parserQuality);
  if (parserQuality !== null && parserQuality !== undefined && qualityPercent < 15) return "WARNING";
  return "OK";
}

function parserQualityPercent(parserQuality) {
  if (parserQuality === null || parserQuality === undefined) return null;
  if (typeof parserQuality === "object") return Number(parserQuality.qualityPercent || 0);
  return Number(parserQuality);
}

function blockedReasonFromError(error) {
  if (error.code) return error.code;
  const message = String(error.message || "").toLowerCase();
  if (message.includes("403")) return "blocked_403";
  if (message.includes("429")) return "rate_limited_429";
  if (message.includes("timeout")) return "timeout";
  if (message.includes("captcha")) return "captcha_detected";
  if (message.includes("network")) return "network_error";
  return "fetch_failed";
}

function topFingerprint(items) {
  return crypto.createHash("sha1")
    .update((items || []).slice(0, 10).map((item) => `${item.canonicalUrl || item.url}|${item.title}`).join("\n"))
    .digest("hex");
}

async function updateSourceState(db, source, update, state) {
  const checkedDelta = Number(update.checkedDelta || 0);
  const savedDelta = Number(update.savedDelta || 0);
  const duplicateDelta = Number(update.duplicateDelta || 0);
  const sourceState = {
    ...(state.sources[source.id] || {}),
    ...update,
  };
  sourceState.totalChecked = Number(sourceState.totalChecked || 0) + checkedDelta;
  sourceState.totalSaved = Number(sourceState.totalSaved || 0) + savedDelta;
  sourceState.totalDuplicate = Number(sourceState.totalDuplicate || 0) + duplicateDelta;
  const errorDelta = Number(update.errorDelta || 0);
  sourceState.totalErrors = Number(sourceState.totalErrors || 0) + errorDelta;
  delete sourceState.checkedDelta;
  delete sourceState.savedDelta;
  delete sourceState.duplicateDelta;
  delete sourceState.errorDelta;
  state.sources[source.id] = sourceState;
  Object.assign(source, sourceState);

  if (WRITE_SOURCE_STATE_TO_FIRESTORE && source.firestoreCollection && source.firestoreId) {
    const nextFetchAtMs = sourceState.nextFetchAt || sourceState.nextCheckAt || 0;
    const firestoreUpdate = {
      lastSeenUrl: sourceState.lastSeenUrl || "",
      lastSeenTitle: sourceState.lastSeenTitle || "",
      lastSeenUrls: sourceState.lastSeenUrls || [],
      lastSeenTitles: sourceState.lastSeenTitles || [],
      lastTopFingerprint: sourceState.lastTopFingerprint || "",
      parserPattern: sourceState.parserPattern || "",
      recentAcceptedSelectors: (sourceState.recentAcceptedSelectors || []).slice(0, 10),
      lastCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastNewAt: sourceState.lastNewAt ? admin.firestore.Timestamp.fromDate(new Date(sourceState.lastNewAt)) : null,
      nextFetchAt: nextFetchAtMs ? admin.firestore.Timestamp.fromMillis(nextFetchAtMs) : null,
      lastIntervalMs: Number(sourceState.lastIntervalMs || 0),
      fingerprintChanged: sourceState.fingerprintChanged ?? null,
      newItemsFound: Number(sourceState.newItemsFound || 0),
      consecutiveErrors: Number(sourceState.consecutiveErrors || 0),
      errorCount: Number(sourceState.consecutiveErrors || 0),
      totalErrors: Number(sourceState.totalErrors || 0),
      lastHttpStatus: sourceState.lastHttpStatus || null,
      status: sourceState.status || sourceStatus(sourceState),
      domainStatus: sourceState.domainStatus || sourceStatus(sourceState),
      blockedReason: sourceState.blockedReason || null,
      parserQuality: sourceState.parserQuality ?? null,
      lowParserQualityCount: Number(sourceState.lowParserQualityCount || 0),
      lastError: sourceState.lastError || null,
    };
    if (checkedDelta) firestoreUpdate.totalChecked = admin.firestore.FieldValue.increment(checkedDelta);
    if (savedDelta) firestoreUpdate.totalSaved = admin.firestore.FieldValue.increment(savedDelta);
    if (duplicateDelta) firestoreUpdate.totalDuplicate = admin.firestore.FieldValue.increment(duplicateDelta);
    if (errorDelta) firestoreUpdate.totalErrors = admin.firestore.FieldValue.increment(errorDelta);
    try {
      await db.collection(source.firestoreCollection).doc(source.firestoreId).set(firestoreUpdate, {merge: true});
    } catch (error) {
      if (isFirestoreQuotaError(error)) {
        firestoreQuotaExhausted = true;
        console.log(`[WARN] source state update skipped by Firestore quota: ${source.name}`);
      } else {
        throw error;
      }
    }
  }
}

async function writeWatcherLog(db, source, log) {
  if (!WRITE_WATCHER_LOGS) return;
  try {
    await db.collection("watcher_logs").add({
      sourceId: source.id,
      sourceName: source.name,
      domain: source.domain || domainOf(source.url),
      checkedAt: admin.firestore.FieldValue.serverTimestamp(),
      ...log,
    });
  } catch (error) {
    console.log(`[WARN] watcher log skipped: ${error.message}`);
  }
}

async function archiveOldNews(db) {
  const result = await archiveExpiredNewsForVietnamDay(db, {
    onBatch: ({collection, count, files}) => {
      const relativeFiles = files.map((file) => path.relative(ROOT_DIR, file)).join(",");
      console.log(`[ARCHIVE] collection=${collection} count=${count} files=${relativeFiles}`);
    },
  });
  if (result.email?.sent) console.log("[ARCHIVE] email sent");
  else if (result.email?.reason && result.email.reason !== "email_disabled") console.log(`[ARCHIVE] email skipped reason=${result.email.reason}`);
  return result.deleted;
}

async function checkSource(db, source, state) {
  const startedAt = Date.now();
  let checked = 0;
  let saved = 0;
  let duplicates = 0;
  let errors = 0;

  try {
    const items = await fetchTopItems(source);
    checked = items.length;
    if (source.type === "category" && !items.length) {
      throw new FetchStatusError("no_items_found", null, "no_items_found");
    }
    const fingerprint = topFingerprint(items);
    const parserQuality = source.type === "category" ? (items.parserQuality ?? null) : null;
    const parserPattern = source.type === "category" ? (items.parserPattern || parserTypeForSource(source)) : "";
    const recentAcceptedSelectors = source.type === "category" ? (items.recentAcceptedSelectors || []) : [];
    const lowParserQuality = parserQuality !== null && parserQualityPercent(parserQuality) < 15;
    const lowParserQualityCount = lowParserQuality ? Number(source.lowParserQualityCount || 0) + 1 : 0;

    if (source.lastTopFingerprint && fingerprint && source.lastTopFingerprint === fingerprint) {
      const status = sourceStatus({...source, consecutiveErrors: 0}, parserQuality);
      const nextInterval = nextIntervalMs({
        ...source,
        consecutiveErrors: 0,
        parserQuality,
        quietStreak: (source.quietStreak || 0) + 1,
        fingerprintChanged: false,
        newItemsFound: 0,
      }, 0);
      const nextFetchAt = Date.now() + nextInterval;
      await updateSourceState(db, source, {
        lastCheckedAt: nowIso(),
        nextFetchAt,
        nextCheckAt: nextFetchAt,
        lastIntervalMs: nextInterval,
        fingerprintChanged: false,
        newItemsFound: 0,
        quietStreak: (source.quietStreak || 0) + 1,
        consecutiveErrors: 0,
        lastHttpStatus: null,
        status,
        domainStatus: status,
        blockedReason: null,
        parserQuality,
        parserPattern,
        recentAcceptedSelectors,
        lowParserQualityCount,
        lastError: lowParserQuality ? "low_parser_quality" : null,
        checkedDelta: checked,
      }, state);
      await writeWatcherLog(db, source, {
        fetched: true,
        acceptedCount: checked,
        savedCount: 0,
        duplicateCount: 0,
        rejectedCount: parserQuality?.rejectedCount || 0,
        parserQuality,
        lastIntervalMs: nextInterval,
        nextFetchAt: admin.firestore.Timestamp.fromMillis(nextFetchAt),
        fingerprintChanged: false,
        newItemsFound: 0,
        durationMs: Date.now() - startedAt,
        error: null,
      });
      console.log(`[OK] ${source.name} checked=${checked} saved=0 duplicate=0 error=0 unchanged next=${new Date(nextFetchAt).toISOString()}`);
      return;
    }

    const result = await saveNewItems(db, source, items);
    saved = result.saved;
    duplicates = result.duplicates;

    const first = items[0];
    const fingerprintChanged = true;
    const newItemsFound = saved;
    const nextInterval = nextIntervalMs({
      ...source,
      consecutiveErrors: 0,
      parserQuality,
      quietStreak: saved > 0 ? 0 : (source.quietStreak || 0) + 1,
      fingerprintChanged,
      newItemsFound,
    }, saved);
    const nextAt = Date.now() + nextInterval;
    const status = sourceStatus({...source, consecutiveErrors: 0}, parserQuality);
    await updateSourceState(db, source, {
      lastSeenUrl: first?.canonicalUrl || source.lastSeenUrl || "",
      lastSeenTitle: first?.title || source.lastSeenTitle || "",
      lastSeenUrls: [...items.map((item) => item.canonicalUrl || item.url).filter(Boolean), ...(source.lastSeenUrls || [])].slice(0, 100),
      lastSeenTitles: [...items.map((item) => item.title).filter(Boolean), ...(source.lastSeenTitles || [])].slice(0, 100),
      lastTopFingerprint: fingerprint,
      lastCheckedAt: nowIso(),
      lastNewAt: saved > 0 ? nowIso() : source.lastNewAt || null,
      nextFetchAt: nextAt,
      nextCheckAt: nextAt,
      lastIntervalMs: nextInterval,
      fingerprintChanged,
      newItemsFound,
      quietStreak: saved > 0 ? 0 : (source.quietStreak || 0) + 1,
      consecutiveErrors: 0,
      lastHttpStatus: null,
      status,
      domainStatus: status,
      blockedReason: null,
      parserQuality,
      parserPattern,
      recentAcceptedSelectors,
      lowParserQualityCount,
      lastError: lowParserQuality ? "low_parser_quality" : null,
      checkedDelta: checked,
      savedDelta: saved,
      duplicateDelta: duplicates,
    }, state);
    await writeWatcherLog(db, source, {
      fetched: true,
      acceptedCount: checked,
      savedCount: saved,
      duplicateCount: duplicates,
      rejectedCount: parserQuality?.rejectedCount || 0,
      parserQuality,
      lastIntervalMs: nextInterval,
      nextFetchAt: admin.firestore.Timestamp.fromMillis(nextAt),
      fingerprintChanged,
      newItemsFound,
      durationMs: Date.now() - startedAt,
      error: null,
    });

    console.log(`[OK] ${source.name} checked=${checked} saved=${saved} duplicate=${duplicates} error=0 elapsed=${Date.now() - startedAt}ms next=${new Date(nextAt).toISOString()}`);
  } catch (error) {
    errors = 1;
    const consecutiveErrors = Number(source.consecutiveErrors || 0) + 1;
    const nextInterval = nextIntervalMs({...source, consecutiveErrors, fingerprintChanged: false, newItemsFound: 0}, 0);
    const nextAt = Date.now() + nextInterval;
    const blockedReason = blockedReasonFromError(error);
    const status = sourceStatus({...source, consecutiveErrors});
    await updateSourceState(db, source, {
      lastCheckedAt: nowIso(),
      nextFetchAt: nextAt,
      nextCheckAt: nextAt,
      lastIntervalMs: nextInterval,
      fingerprintChanged: false,
      newItemsFound: 0,
      quietStreak: (source.quietStreak || 0) + 1,
      consecutiveErrors,
      lastHttpStatus: error.status || null,
      status,
      domainStatus: status,
      blockedReason,
      lastError: error.message,
      checkedDelta: checked,
      errorDelta: 1,
    }, state);
    await writeWatcherLog(db, source, {
      fetched: false,
      acceptedCount: checked,
      savedCount: saved,
      duplicateCount: duplicates,
      rejectedCount: 0,
      parserQuality: source.parserQuality || null,
      lastIntervalMs: nextInterval,
      nextFetchAt: admin.firestore.Timestamp.fromMillis(nextAt),
      fingerprintChanged: false,
      newItemsFound: 0,
      durationMs: Date.now() - startedAt,
      error: error.message,
      blockedReason,
    });
    console.log(`[ERROR] ${source.name} checked=${checked} saved=${saved} duplicate=${duplicates} error=${errors} reason=${blockedReason} next=${new Date(nextAt).toISOString()} message=${error.message}`);
  }
}

async function main() {
  const db = initializeFirebase();
  const state = readJsonIfExists(STATE_PATH, {sources: {}});
  state.sources ||= {};
  state.domains ||= {};
  let sources = await loadSources(db, state);
  let lastSourceRefresh = Date.now();
  let lastArchiveRun = 0;
  const runStartedAt = Date.now();
  const processedOnceSourceIds = new Set();
  let onceRound = 0;

  const runOnceRoundsLabel = Number.isFinite(RUN_ONCE_ROUNDS) ? RUN_ONCE_ROUNDS : "until_done";
  console.log(`[START] smart watcher sources=${sources.length} maxItems=${MAX_ITEMS_PER_CHECK} once=${RUN_ONCE} rounds=${RUN_ONCE ? runOnceRoundsLabel : "loop"} sourceMode=${SOURCE_MODE} dedupeFirestore=${DEDUPE_FIRESTORE} writeSourceState=${WRITE_SOURCE_STATE_TO_FIRESTORE} writeLogs=${WRITE_WATCHER_LOGS}`);

  while (true) {
    const now = Date.now();
    if (now - lastSourceRefresh > SOURCE_REFRESH_MS) {
      sources = await loadSources(db, state);
      lastSourceRefresh = now;
      console.log(`[SOURCES] refreshed count=${sources.length}`);
    }

    if (!SKIP_ARCHIVE && now - lastArchiveRun > 60 * 60 * 1000) {
      try {
        const archived = await archiveOldNews(db);
        if (archived) console.log(`[ARCHIVE] count=${archived} mode=text_then_delete`);
      } catch (error) {
        console.log(`[WARN] archive skipped: ${error.message}`);
      }
      lastArchiveRun = now;
    } else if (SKIP_ARCHIVE && !lastArchiveRun) {
      console.log("[ARCHIVE] skipped for this watcher run");
      lastArchiveRun = now;
    }

    if (RUN_ONCE) {
      onceRound += 1;
      if (!firestoreQuotaExhausted) {
        sources = await loadSources(db, state);
      }
      console.log(`[ROUND] ${onceRound}/${runOnceRoundsLabel} remaining=${Math.max(0, sources.length - processedOnceSourceIds.size)}`);
    }

    const due = sources
      .filter((source) => RUN_ONCE ? !processedOnceSourceIds.has(source.id) : (!source.nextFetchAt || source.nextFetchAt <= now))
      .sort((a, b) => (a.nextFetchAt || 0) - (b.nextFetchAt || 0));

    const domainQueue = new Map();
    due.forEach((source) => {
      const domain = source.domain || domainOf(source.url);
      if (!domainQueue.has(domain)) domainQueue.set(domain, source);
    });

    for (const source of domainQueue.values()) {
      const domain = source.domain || domainOf(source.url);
      const domainState = state.domains[domain] || {};
      if (!RUN_ONCE && domainState.nextAllowedFetchAt && domainState.nextAllowedFetchAt > Date.now()) {
        continue;
      }
      await checkSource(db, source, state);
      processedOnceSourceIds.add(source.id);
      const cooldown = randomBetween(DOMAIN_COOLDOWN_MIN_MS, DOMAIN_COOLDOWN_MAX_MS);
      state.domains[domain] = {
        domain,
        lastFetchAt: Date.now(),
        nextAllowedFetchAt: Date.now() + cooldown,
        consecutiveErrors: Number(source.consecutiveErrors || 0),
        lastHttpStatus: source.lastHttpStatus || null,
        domainStatus: source.domainStatus || sourceStatus(source),
        blockedReason: source.blockedReason || null,
      };
      writeJson(STATE_PATH, state);
    }

    if (RUN_ONCE) {
      const timeUsed = Date.now() - runStartedAt;
      const allProcessed = processedOnceSourceIds.size >= sources.length;
      if (onceRound >= RUN_ONCE_ROUNDS || allProcessed || timeUsed >= RUN_ONCE_TIME_BUDGET_MS) {
        console.log(`[DONE] one-shot watcher run completed rounds=${onceRound} processed=${processedOnceSourceIds.size}/${sources.length} timeMs=${timeUsed}`);
        await admin.app().delete();
        return;
      }
      if (RUN_ONCE_ROUND_DELAY_MS) await sleep(RUN_ONCE_ROUND_DELAY_MS);
      continue;
    }

    const nextSourceAt = Math.min(...sources.map((source) => source.nextFetchAt || now + 5000));
    const nextDomainAt = Math.min(...Object.values(state.domains).map((domain) => domain.nextAllowedFetchAt || now + 5000));
    const nextAt = Math.min(nextSourceAt, nextDomainAt);
    await sleep(Math.max(1000, Math.min(5000, nextAt - Date.now())));
  }
}

main().catch(async (error) => {
  console.error(`[FATAL] ${error.stack || error.message}`);
  try {
    await admin.app().delete();
  } catch (_) {
    // ignore shutdown errors
  }
  process.exit(1);
});
