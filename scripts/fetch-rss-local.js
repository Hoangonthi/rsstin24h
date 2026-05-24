const fs = require("fs");
const path = require("path");
const vm = require("vm");
const Parser = require("rss-parser");
const CryptoJS = require("crypto-js");
const admin = require("firebase-admin");

const ROOT_DIR = path.resolve(__dirname, "..");
const NEWS_SOURCES_PATH = path.join(ROOT_DIR, "js", "core", "newsSources.js");
const FIREBASERC_PATH = path.join(ROOT_DIR, ".firebaserc");
const SERVICE_ACCOUNT_PATH = path.join(ROOT_DIR, "serviceAccountKey.json");
const SERVICE_ACCOUNT_REQUIRE_PATH = "../serviceAccountKey.json";
const RSS_FETCH_TIMEOUT_MS = 8000;
const MAX_ITEMS_PER_FEED = 20;
const MAX_TOTAL_ITEMS = 200;
const FIRESTORE_BATCH_LIMIT = 500;
const FIRESTORE_DUPLICATE_CHECK_CHUNK_SIZE = 50;
const FIRESTORE_OPERATION_TIMEOUT_MS = 20000;
const HSX_PUBLIC_URL = "https://www.hsx.vn/";
const LEGAL_MODE = true;
const MAX_LEGAL_SUMMARY_LENGTH = 300;

const fallbackSources = [
  {
    sourceId: "vneconomy_tin_moi",
    sourceName: "VnEconomy - Tin moi",
    rssUrl: "https://vneconomy.vn/tin-moi.rss",
    enabled: true,
    fetchMode: "rss",
  },
  {
    sourceId: "vneconomy_chung_khoan",
    sourceName: "VnEconomy - Chung khoan",
    rssUrl: "https://vneconomy.vn/chung-khoan.rss",
    enabled: true,
    fetchMode: "rss",
  },
  {
    sourceId: "hnx_cong_bo_tu_so",
    sourceName: "HNX - Cong bo tu so",
    rssUrl: "https://www.hnx.vn/vi-vn/1/vi_vn/thong-tin-cong-bo-tu-so.rss",
    enabled: true,
    fetchMode: "rss",
  },
];

const tickerDictionary = [
  "AAA", "ACB", "BCM", "BID", "BMP", "BSI", "BVH", "BWE", "CII", "CMG",
  "CTD", "CTG", "DGC", "DIG", "DPM", "DXG", "EIB", "FPT", "GAS", "GEX",
  "GMD", "HAG", "HCM", "HDB", "HPG", "HSG", "KBC", "KDH", "MBB", "MSB",
  "MSN", "MWG", "NLG", "NVL", "OCB", "PDR", "PLX", "PNJ", "POW", "PVD",
  "PVS", "SAB", "SHB", "SSI", "STB", "TCB", "TPB", "VCB", "VCG", "VHM",
  "VIB", "VIC", "VJC", "VND", "VNM", "VPB", "VPI", "VRE",
];

const sectorDictionary = {
  banking: ["ngan hang", "tin dung", "no xau", "bien lai lai", "casa"],
  securities: ["cong ty chung khoan", "moi gioi chung khoan", "tu doanh", "margin"],
  realEstate: ["bat dong san", "dia oc", "nha o", "khu cong nghiep", "du an nha o"],
  energy: ["dau khi", "khi dot", "dien", "nang luong", "xang dau"],
  retail: ["ban le", "sieu thi", "chuoi cua hang", "hang tieu dung"],
  materials: ["thep", "phan bon", "hoa chat", "xi mang", "vat lieu xay dung"],
  technology: ["cong nghe thong tin", "phan mem", "ban dan", "du lieu lon", "trung tam du lieu"],
  macro: ["gdp", "lam phat", "ty gia", "lai suat", "xuat khau", "nhap khau", "fdi", "cpi", "ppi"],
};

const keywordDictionary = {
  macro: ["gdp", "cpi", "lam phat", "lai suat", "ty gia", "fed", "ngan hang nha nuoc", "trai phieu chinh phu"],
  company: ["loi nhuan", "doanh thu", "co tuc", "phat hanh", "tang von", "mua ban sap nhap", "m&a", "dhcd"],
  risk: ["rui ro", "no", "trai phieu", "vi pham", "phap ly", "khoi to", "huy niem yet", "canh bao", "kiem soat", "dinh chi", "cham thanh toan", "lo", "kiem toan ngoai tru"],
  marketMovement: ["vn-index", "vnindex", "khoi ngoai", "ban rong", "mua rong", "thanh khoan", "co phieu tru", "lao doc", "but pha", "lap dinh"],
  strongMovement: ["lao doc", "ban rong ky luc", "but pha", "lap dinh", "tang manh", "giam manh"],
  technicalNotice: ["ket noi giao dich truc tuyen", "thay doi nav", "danh muc hoan doi", "cong bo thong tin ky thuat", "gia tri tai san rong"],
  internalTrading: ["nguoi noi bo", "co dong lon", "giao dich co phieu"],
  etfNotice: ["gia tri tai san rong", "nav", "danh muc chung khoan co cau", "danh muc co cau", "hoan doi", "lo etf", "quy etf"],
  macroStrong: ["fed", "lai suat", "ty gia", "cpi", "ppi", "lam phat", "gia dau", "dau tho", "brent", "wti", "vang"],
  positive: ["tang truong", "lai lon", "vuot ke hoach", "ky luc", "duoc chap thuan", "hoan thanh"],
  negative: ["thua lo", "suy giam", "giam manh", "dinh chi", "canh bao", "no xau", "vi pham", "huy niem yet", "cham thanh toan", "kiem toan ngoai tru"],
};

const brokerKeywords = {
  strongRisk: [
    "dinh chi", "canh bao", "kiem soat", "huy niem yet", "cham thanh toan",
    "mat kha nang thanh toan", "kiem toan ngoai tru", "vi pham cong bo thong tin",
    "trai phieu cham tra", "lo lon", "bi phat", "bi dieu tra",
  ],
  marketMovement: [
    "vn-index", "vnindex", "hnx-index", "upcom", "khoi ngoai", "tu doanh",
    "thanh khoan", "co phieu tru", "nhom von hoa lon", "lao doc", "but pha",
    "lap dinh", "ban rong", "mua rong", "phan hoa", "giang co", "di ngang",
  ],
  strongMovement: ["lao doc", "but pha", "lap dinh", "ban rong ky luc", "mua rong ky luc", "tang soc", "giam soc", "giam manh", "tang manh", "ban thao", "hoi phuc tot", "thanh khoan tang"],
  macro: ["fed", "fomc", "cpi", "ppi", "lam phat", "ty gia", "lai suat", "trai phieu chinh phu", "vang", "gia dau", "dau tho", "brent", "wti", "usd", "dxy", "gdp", "tin dung", "omo", "nhnn"],
  corporateAction: ["co tuc", "phat hanh", "tang von", "chia thuong", "mua lai co phieu", "dhcd", "esop", "niem yet", "chuyen san"],
  earningsBusiness: ["loi nhuan", "doanh thu", "lai rong", "lo", "bien loi nhuan", "don hang", "hop dong", "du an", "san luong"],
  internalTrading: ["nguoi noi bo", "co dong lon", "bao cao ket qua giao dich co phieu", "dang ky giao dich co phieu"],
  technicalNotice: ["ket noi giao dich truc tuyen", "thay doi gia tri tai san rong", "gia tri tai san rong", "danh muc chung khoan co cau", "danh muc hoan doi", "hoan doi", "thong bao ky thuat", "thay doi thong tin niem yet"],
  promotional: ["nhip cau doanh nghiep", "thuong hieu", "ra mat san pham", "hop tac chien luoc"],
};

const majorRiskKeywords = [
  "dinh chi",
  "huy niem yet",
  "cham thanh toan",
  "mat kha nang thanh toan",
  "kiem toan ngoai tru",
  "trai phieu cham tra",
  "lo lon",
  "bi dieu tra",
];

const strongSectorDictionary = {
  securities: ["cong ty chung khoan", "moi gioi", "tu doanh", "giao dich ky quy", "margin"],
  banking: ["ngan hang", "tin dung", "casa", "nim", "no xau"],
  real_estate: ["bat dong san", "phap ly du an", "nha o", "khu do thi"],
  public_investment: ["dau tu cong", "cao toc", "san bay", "ha tang"],
  oil_gas: ["dau khi", "khi dot", "xang dau", "brent", "wti", "loc dau"],
  power: ["thuy dien", "nhiet dien", "dien khi", "dien gio", "dien mat troi"],
  logistics: ["cang", "van tai bien", "container", "logistics"],
  retail: ["ban le", "tieu dung", "sieu thi"],
  industrial_park: ["khu cong nghiep", "dat kcn", "fdi"],
  construction_materials: ["thep", "xi mang", "da xay dung", "nhua xay dung", "vat lieu xay dung"],
  macro: ["fed", "fomc", "cpi", "ppi", "lam phat", "ty gia", "lai suat", "trai phieu chinh phu", "vang", "gia dau", "dau tho", "brent", "wti", "usd", "dxy", "gdp", "tin dung", "omo", "nhnn"],
  market: ["vn-index", "vnindex", "hnx-index", "upcom", "khoi ngoai", "tu doanh", "thanh khoan", "co phieu tru", "ban rong", "mua rong"],
};

const technologySectorKeywords = ["tri tue nhan tao", "ban dan", "phan mem", "du lieu", "trung tam du lieu", "cloud", "chip", "chuyen doi so"];
const fundSectorKeywords = ["quy co phieu", "quy etf", "chung chi quy", "dong tien quy", "giai ngan quy", "rut rong quy", "gia tri tai san rong"];

const STANDARD_SECTORS = new Set([
  "banking", "securities", "real_estate", "public_investment", "oil_gas", "steel",
  "port_logistics", "fertilizer_chemical", "power", "water", "textile", "seafood",
  "retail", "aviation", "industrial_park", "technology_telecom", "auto",
  "construction_materials", "healthcare", "insurance", "consumer", "agriculture",
  "macro", "international", "gold_fx_crypto", "other",
]);

const stockSectorGroups = {
  banking: "VCB BID CTG MBB TCB VPB ACB HDB SHB EIB STB LPB OCB MSB SSB ABB BAB NVB PGB VAB NAB KLB SGB",
  securities: "SSI VND HCM VCI SHS MBS VIX FTS CTS AGR BSI ORS APG PSI TVS TVB DSC SBS EVS WSS",
  real_estate: "VIC VHM VRE NVL PDR DIG DXG KDH NLG AGG CEO CII HDC IJC KHG QCG SCR TCH TIG DXS LDG SZL BCM",
  industrial_park: "KBC IDC SZC SIP BCM VGC LHG TIP ITA KOS NTC PHR DPR GVR",
  steel: "HPG HSG NKG VGS SMC TLH POM VIS TVN HMC",
  oil_gas: "GAS BSR PVD PVS PVT PLX POW OIL PVC PVB PXS PET PGD CNG",
  fertilizer_chemical: "DPM DCM DGC CSV LAS DDV BFC AAA APH BMP NTP DPR DRI",
  port_logistics: "GMD HAH VSC SGP PHP DXP TCL ILB PDN TMS STG VOS VIP SKG",
  power: "REE PC1 GEG HDG NT2 QTP PPC POW BCG TV2 VSH TMP CHP SJD SEB",
  water: "BWE TDM NDN DNW THW",
  seafood: "VHC ANV IDI FMC MPC CMX ACL ABT",
  textile: "TCM STK MSH GIL ADS TNG VGT",
  retail: "MWG FRT DGW PET PNJ",
  consumer: "MSN SAB BHN QNS KDC VNM SBT MCH",
  aviation: "VJC HVN ACV AST SCS NCT",
  technology_telecom: "FPT CMG CTR VGI FOX ELC ITD SAM",
  public_investment: "VCG C4G HHV CTD HBC FCN LCG PLC",
  construction_materials: "KSB DHA HT1 BCC BTS HOM CVT VCS BMP NTP",
  healthcare: "DHG DBD DHT IMP PME TRA DVN FIT JVC",
  insurance: "BVH BMI MIG PVI BIC ABI",
  agriculture: "HAG HNG PAN NSC TAR LTG VFG",
  auto: "HAX SVC TMT CTF VEA",
};

const STOCK_TO_SECTOR = Object.entries(stockSectorGroups).reduce((map, [sector, tickers]) => {
  tickers.split(/\s+/).filter(Boolean).forEach((ticker) => {
    if (!map[ticker]) map[ticker] = sector;
  });
  return map;
}, {});

const KNOWN_TICKERS = new Set([...tickerDictionary, ...Object.keys(STOCK_TO_SECTOR)]);

const EVENT_RULES = [
  ["analyst_report", ["bao cao", "khuyen nghi", "dinh gia", "gia muc tieu", "cap nhat", "kqkd"]],
  ["ex_right", ["dkcc", "chot quyen", "ngay giao dich khong huong quyen", "ngay dang ky cuoi cung"]],
  ["dividend", ["co tuc", "tam ung", "tra co tuc", "chia co tuc"]],
  ["earnings", ["loi nhuan", "doanh thu", "bctc", "bao cao tai chinh", "ket qua kinh doanh", "lai rong"]],
  ["capital_raise", ["phat hanh co phieu", "chao ban co phieu", "tang von", "quyen mua", "esop"]],
  ["bond", ["trai phieu", "dao han", "cham thanh toan", "gia han trai phieu", "no qua han"]],
  ["fx_interest_rate", ["lai suat", "ty gia", "fed", "nhnn", "omo", "tin phieu", "usd/vnd", "usd vnd"]],
  ["export", ["xuat khau", "don hang", "thi truong my", "thi truong eu"]],
  ["tax_tariff", ["thue quan", "anti-dumping", "chong ban pha gia"]],
  ["contract_order", ["trung thau", "goi thau", "ky hop dong", "don hang lon"]],
  ["project", ["du an", "khoi cong", "dau tu", "nha may", "khu cong nghiep"]],
  ["public_investment", ["dau tu cong", "cao toc", "san bay", "ha tang"]],
  ["legal", ["xu phat", "thanh tra", "dieu tra", "kiem toan ngoai tru", "vi pham"]],
  ["delisting", ["huy niem yet", "dinh chi giao dich", "bi dinh chi"]],
  ["etf", ["etf", "nav", "hoan doi", "chung chi quy"]],
  ["index_rebalance", ["co cau chi so", "review chi so", "vn30", "vndiamond", "ftse", "msci"]],
  ["ownership", ["co dong lon", "mua vao", "ban ra", "dang ky giao dich"]],
  ["insider_transaction", ["nguoi noi bo", "lanh dao mua", "lanh dao ban"]],
  ["leadership", ["bo nhiem", "mien nhiem", "chu tich", "tong giam doc", "ban lanh dao"]],
  ["policy", ["chinh sach", "du thao", "nghi dinh", "thong tu"]],
  ["government", ["chinh phu", "thu tuong", "quoc hoi", "bo tai chinh", "ubck"]],
  ["bank_credit", ["tin dung", "room tin dung", "no xau", "casa", "nim"]],
  ["real_estate_legal", ["phap ly du an", "so hong", "tien su dung dat"]],
  ["mna", ["m&a", "sap nhap", "mua lai", "thoai von"]],
  ["listing", ["niem yet", "chuyen san", "dang ky giao dich upcom"]],
  ["credit_rating", ["xep hang tin nhiem", "tin nhiem"]],
  ["production_business", ["san luong", "kinh doanh", "mo rong san xuat"]],
  ["court_dispute", ["toa an", "kien", "tranh chap", "khoi kien"]],
  ["commodity_price", ["gia dau", "brent", "wti", "hang hoa", "gia thep"]],
  ["gold_price", ["gia vang", "vang sjc", "xauusd", "doji"]],
  ["crypto", ["bitcoin", "btc", "eth", "crypto", "stablecoin", "ethereum"]],
  ["fx", ["usd", "dxy", "usd/vnd", "usd vnd", "ty gia"]],
];

const SECTOR_KEYWORD_RULES = {
  banking: ["ngan hang", "tin dung", "no xau", "casa", "nim"],
  securities: ["chung khoan", "cong ty chung khoan", "moi gioi", "tu doanh", "margin"],
  real_estate: ["bat dong san", "dia oc", "nha o", "du an nha o"],
  public_investment: ["dau tu cong", "cao toc", "san bay", "ha tang", "giai ngan"],
  oil_gas: ["dau khi", "xang dau", "brent", "wti", "loc dau"],
  steel: ["thep", "ton ma"],
  port_logistics: ["cang", "logistics", "container", "van tai bien"],
  fertilizer_chemical: ["phan bon", "hoa chat"],
  power: ["dien", "thuy dien", "nhiet dien", "dien gio", "dien mat troi"],
  water: ["cap nuoc", "nuoc sach"],
  textile: ["det may", "xuat khau may", "soi"],
  seafood: ["thuy san", "ca tra", "tom"],
  retail: ["ban le", "sieu thi"],
  aviation: ["hang khong", "san bay"],
  industrial_park: ["khu cong nghiep", "kcn", "fdi"],
  technology_telecom: ["cong nghe", "vien thong", "ai", "data center", "trung tam du lieu", "chip"],
  auto: ["o to", "xe dien", "vinfast", "phu tung"],
  construction_materials: ["xi mang", "da xay dung", "vat lieu xay dung", "nhua xay dung"],
  healthcare: ["duoc", "benh vien", "y te"],
  insurance: ["bao hiem"],
  consumer: ["tieu dung", "sua", "bia", "thuc pham"],
  agriculture: ["nong nghiep", "gao", "cao su", "chan nuoi"],
  gold_fx_crypto: ["gia vang", "vang sjc", "xauusd", "usd", "dxy", "ty gia", "bitcoin", "crypto", "btc", "eth"],
  macro: ["fed", "cpi", "gdp", "lam phat", "lai suat", "nhnn", "trai phieu chinh phu"],
  international: ["trump", "ecb", "boj", "trung quoc", "my", "eu", "wto", "opec", "msci", "ftse"],
};

const STRONG_POSITIVE_WORDS = ["tang manh", "vuot ke hoach", "ky luc", "lai lon", "trung thau lon", "hop dong lon", "duoc chap thuan", "lap dinh"];
const STRONG_NEGATIVE_WORDS = ["lo lon", "vo no", "cham thanh toan", "bi dieu tra", "huy niem yet", "dinh chi", "kiem toan nghi ngo", "no qua han", "giam manh"];
const ADMIN_LOW_IMPACT_WORDS = ["tai lieu hop", "hop dhdcd thuong nien", "thong bao moi hop", "nghi quyet hdqt", "cong bo thong tin dinh ky"];
const MARKET_MOVING_KEYWORDS = [
  "dot bien", "ky luc", "vo no", "margin", "call margin", "giai chap", "room tin dung",
  "thoai von", "nang hang", "etf review", "msci", "ftse", "khoi to", "thanh tra",
  "kiem toan", "lo lon", "lo luy ke", "ngung hoat dong", "pha san", "cham thanh toan",
  "bi dinh chi", "huy niem yet", "trung thau lon", "ky hop dong lon",
];
const TIER_1_TICKERS = new Set("VIC VHM VCB BID CTG TCB MBB VPB HPG GAS FPT SSI VNM MSN MWG VRE PLX SAB ACB STB VND".split(" "));
const TIER_2_TICKERS = new Set("HDB SHB EIB MSB OCB GEX POW PVD PVS DGC FRT PNJ KBC IDC BCM VGC DXG KDH NLG DIG PDR VJC HVN ACV GMD HSG NKG".split(" "));

const parser = new Parser({
  timeout: RSS_FETCH_TIMEOUT_MS,
  customFields: {
    item: [
      ["content:encoded", "contentEncoded"],
      ["atom:updated", "atomUpdated"],
      ["updated", "updated"],
    ],
  },
});

function formatSeconds(startedAt) {
  return `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
}

function sourceLabel(source) {
  return source.sourceName || source.sourceId || source.rssUrl;
}

function createTimeoutError(url) {
  const error = new Error(`RSS timeout after ${RSS_FETCH_TIMEOUT_MS / 1000}s: ${url}`);
  error.code = "RSS_TIMEOUT";
  return error;
}

function createOperationTimeoutError(label) {
  const error = new Error(`${label} timed out after ${FIRESTORE_OPERATION_TIMEOUT_MS / 1000}s`);
  error.code = "OPERATION_TIMEOUT";
  return error;
}

function withTimeout(promise, timeoutMs, label) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(createOperationTimeoutError(label)), timeoutMs);
  });

  return Promise.race([promise, timeoutPromise])
    .finally(() => clearTimeout(timeoutId));
}

function removeVietnameseMarks(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u0111/g, "d")
    .replace(/\u0110/g, "D")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);?/g, (match, code) => decodeCodePoint(match, code))
    .replace(/#(\d{2,7});?/g, (match, code) => decodeCodePoint(match, code))
    .replace(/\s+/g, " ")
    .trim();
}

function limitSummary(value, maxLength = MAX_LEGAL_SUMMARY_LENGTH) {
  const clean = stripHtml(value).replace(/\s+/g, " ").trim();
  if (clean.length <= maxLength) {
    return clean;
  }
  const sliced = clean.slice(0, maxLength - 3).trimEnd();
  return `${sliced}...`;
}

function decodeCodePoint(match, code) {
  const codePoint = Number(code);
  if (!Number.isFinite(codePoint) || codePoint < 32 || codePoint > 1114111) {
    return match;
  }
  try {
    return String.fromCodePoint(codePoint);
  } catch (error) {
    return match;
  }
}

function readProjectId() {
  if (process.env.FIREBASE_PROJECT_ID) {
    return process.env.FIREBASE_PROJECT_ID;
  }
  if (!fs.existsSync(FIREBASERC_PATH)) {
    return undefined;
  }
  const config = JSON.parse(fs.readFileSync(FIREBASERC_PATH, "utf8"));
  return config.projects && (config.projects.default || Object.values(config.projects)[0]);
}

function initializeFirebase() {
  const projectId = readProjectId();
  const appConfig = projectId ? {projectId} : {};

  if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
    throw new Error("Missing serviceAccountKey.json. Download it from Firebase Console > Project settings > Service accounts > Generate new private key, rename it to serviceAccountKey.json, and place it in the project root.");
  }

  const serviceAccount = require(SERVICE_ACCOUNT_REQUIRE_PATH);
  appConfig.credential = admin.credential.cert(serviceAccount);

  admin.initializeApp(appConfig);
  return admin.firestore();
}

function loadSources() {
  if (!fs.existsSync(NEWS_SOURCES_PATH)) {
    return fallbackSources;
  }

  try {
    const code = fs.readFileSync(NEWS_SOURCES_PATH, "utf8");
    const sandbox = {window: {}};
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, {filename: NEWS_SOURCES_PATH});
    const sources = Array.isArray(sandbox.window.newsSources)
      ? sandbox.window.newsSources
      : fallbackSources;

    return sources.filter((source) => (
      source.enabled === true &&
      source.allowCrawl !== false &&
      source.fetchMode === "rss" &&
      source.rssUrl
    ));
  } catch (error) {
    console.warn(`Could not load newsSources.js, using fallback sources: ${error.message}`);
    return fallbackSources;
  }
}

async function loadCustomSources(db) {
  try {
    const snapshot = await db.collection("rss_sources")
      .where("active", "==", true)
      .get();

    return snapshot.docs
      .map((doc) => {
        const data = doc.data();
        return {
          sourceId: `custom_${doc.id}`,
          sourceName: data.name || data.url || `Custom RSS ${doc.id}`,
          rssUrl: data.url,
          category: data.category || "custom",
          allowCrawl: data.allowCrawl !== false,
          enabled: true,
          fetchMode: "rss",
        };
      })
      .filter((source) => source.allowCrawl !== false && source.rssUrl && /^https?:\/\//i.test(source.rssUrl));
  } catch (error) {
    console.warn(`Could not load custom RSS sources from Firestore: ${error.message}`);
    return [];
  }
}

function mergeSources(defaultSources, customSources) {
  const seenUrls = new Set();
  const merged = [];

  [...defaultSources, ...customSources].forEach((source) => {
    const normalizedUrl = String(source.rssUrl || "").trim().toLowerCase();
    if (!normalizedUrl || seenUrls.has(normalizedUrl)) return;
    seenUrls.add(normalizedUrl);
    merged.push(source);
  });

  return merged;
}

function createHash(item) {
  const rawSeed = item.originalUrl || item.url || "";
  const seed = (
    item.url === HSX_PUBLIC_URL ||
    isHsxApiUrl(rawSeed) ||
    isFeedUrl(rawSeed)
  )
    ? `${item.source}-${item.title}-${item.publishedAt}`
    : rawSeed || item.title || `${item.source}-${item.publishedAt}`;
  return CryptoJS.SHA256(seed.trim().toLowerCase()).toString(CryptoJS.enc.Hex);
}

function isHsxSource(source) {
  const sourceText = `${source?.sourceId || ""} ${source?.sourceName || ""} ${source?.source || ""}`.toLowerCase();
  return sourceText.includes("hose") || sourceText.includes("hsx");
}

function isHsxApiUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    return host === "api.hsx.vn" || (host.endsWith("hsx.vn") && path.includes("/api/"));
  } catch (error) {
    return false;
  }
}

function toPublicHsxUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || ""));
    if (parsed.hostname.toLowerCase() === "api.hsx.vn" && parsed.pathname.toLowerCase().startsWith("/tin-tuc/")) {
      parsed.hostname = "www.hsx.vn";
      return parsed.href;
    }
  } catch (error) {
    return "";
  }
  return "";
}

function isFeedUrl(url) {
  const value = String(url || "");
  return /\.rss(?:$|[?#])/i.test(value) || /\/News\/NewsByCateFeed\//i.test(value);
}

function sanitizeArticleUrl(rawUrl, source) {
  const url = String(rawUrl || "").trim();
  const publicHsxUrl = toPublicHsxUrl(url);
  if (publicHsxUrl) {
    return publicHsxUrl;
  }
  if (isHsxSource(source) && (!url || isFeedUrl(url))) {
    return HSX_PUBLIC_URL;
  }
  return url;
}

function findMatches(text, dictionary) {
  const normalized = removeVietnameseMarks(text);
  return Object.entries(dictionary)
    .filter(([, words]) => words.some((word) => normalized.includes(removeVietnameseMarks(word))))
    .map(([key]) => key);
}

function detectTickers(text) {
  const value = String(text || "");
  const prefixMatch = value.match(/^\s*([A-Z0-9]{2,10})\s*[:：-]/);
  const tickerStopWords = new Set(["THE", "TRA", "TIN", "BAN", "MUA", "NAM", "QUY", "VON", "LAI", "LOI", "USD", "EUR", "JPY", "BTC", "ETH"]);
  const prefix = prefixMatch ? prefixMatch[1].toUpperCase() : "";
  const prefixTickers = prefix && !tickerStopWords.has(prefix) ? [prefix] : [];
  const matches = value.match(/\b[A-Z]{3}\b/g) || [];
  return Array.from(new Set([
    ...prefixTickers,
    ...matches.filter((ticker) => KNOWN_TICKERS.has(ticker)),
  ]));
}

function hasAnyKeyword(text, words) {
  const normalized = removeVietnameseMarks(text);
  return words.some((word) => normalized.includes(removeVietnameseMarks(word)));
}

function matchedKeywords(text, words) {
  const normalized = removeVietnameseMarks(text);
  return words.filter((word) => normalized.includes(removeVietnameseMarks(word)));
}

function detectEtfNotice(text, tickers) {
  const hasEtfTicker = tickers.some((ticker) => ticker.startsWith("FUE") || ticker.startsWith("FU"));
  return hasEtfTicker && hasAnyKeyword(text, brokerKeywords.technicalNotice);
}

function detectTechnicalNotice(text, isEtfNotice) {
  return isEtfNotice || hasAnyKeyword(text, brokerKeywords.technicalNotice);
}

function detectMarketScope(text, tickers) {
  if (hasAnyKeyword(text, brokerKeywords.macro)) return "macro";
  if (hasAnyKeyword(text, brokerKeywords.marketMovement)) return "market";
  if (tickers.length) return "ticker";
  return "unknown";
}

function detectAssetType(tickers, text, marketScope) {
  if (tickers.some((ticker) => ticker.startsWith("FUE") || ticker.startsWith("FU"))) return "etf";
  if (hasAnyKeyword(text, ["vn-index", "vnindex", "hnx-index", "upcom"])) return "index";
  if (hasAnyKeyword(text, ["vang", "gia dau", "dau tho", "brent", "wti", "usd", "dxy", "lai suat", "ty gia"])) return "macro_asset";
  if (tickers.length) return "stock";
  if (marketScope === "market") return "market";
  return "unknown";
}

function detectSectors(text) {
  const normalized = removeVietnameseMarks(text);
  const rawLower = String(text || "").toLowerCase();
  const rawUpper = String(text || "").toUpperCase();
  const sectors = [];

  if (
    rawLower.includes("quỹ") ||
    /\b(ETF|NAV)\b/.test(rawUpper) ||
    hasAnyKeyword(text, fundSectorKeywords)
  ) {
    sectors.push("funds");
  }

  if (
    /\bAI\b/.test(rawUpper) ||
    hasAnyKeyword(text, technologySectorKeywords)
  ) {
    sectors.push("technology");
  }

  Object.entries(strongSectorDictionary).forEach(([sector, words]) => {
    const matches = words.filter((word) => normalized.includes(removeVietnameseMarks(word)));
    if (matches.length >= 1) {
      sectors.push(sector);
    }
  });

  return Array.from(new Set(sectors));
}

function classifyNewsType(text, isEtfNotice) {
  const hasInternalTrading = hasAnyKeyword(text, brokerKeywords.internalTrading);
  const hasStrongRisk = hasAnyKeyword(text, brokerKeywords.strongRisk);
  if (hasStrongRisk) return "risk_event";
  if (hasAnyKeyword(text, brokerKeywords.marketMovement)) return "market_movement";
  if (hasAnyKeyword(text, brokerKeywords.macro)) return "macro";
  if (hasAnyKeyword(text, brokerKeywords.earningsBusiness)) return "earnings_business";
  if (hasAnyKeyword(text, brokerKeywords.corporateAction)) return "corporate_action";
  if (hasInternalTrading) return "internal_trading";
  if (isEtfNotice || hasAnyKeyword(text, brokerKeywords.technicalNotice)) return "technical_notice";
  return "normal";
}

function detectMarketSentiment(text) {
  if (hasAnyKeyword(text, ["ban thao", "giam san hang loat", "hoang loan", "thao chay"])) return "panic";
  if (hasAnyKeyword(text, ["lao doc", "ban rong dot bien", "ban rong ky luc", "co phieu tru giam manh", "sac do lan rong", "thanh khoan yeu"])) return "risk_off";
  if (hasAnyKeyword(text, ["but pha", "lap dinh", "vuot khang cu", "lan toa", "thanh khoan tang manh"])) return "bullish";
  if (hasAnyKeyword(text, ["hoi phuc", "mua rong manh", "keo tru", "dong tien cai thien"])) return "risk_on";
  if (hasAnyKeyword(text, ["giang co", "phan hoa", "di ngang", "than trong"])) return "sideway";
  return "neutral";
}

function detectImpactHorizon(newsType, text, tickers, sectors) {
  if (newsType === "technical_notice") return "unknown";
  if (newsType === "market_movement") return hasAnyKeyword(text, ["vn-index", "vnindex", "hnx-index", "upcom", "khoi ngoai", "thanh khoan"]) ? "intraday" : "short_term";
  if (newsType === "risk_event" && tickers.length) return "short_term";
  if (newsType === "earnings_business" || newsType === "corporate_action") return hasAnyKeyword(text, ["dhcd", "co tuc", "phat hanh", "tang von", "du an"]) ? "medium_term" : "short_term";
  if (newsType === "macro") return "medium_term";
  if (hasAnyKeyword(text, ["dau tu cong", "ai", "tri tue nhan tao", "trung tam du lieu", "ha tang", "fdi"]) || sectors.includes("public_investment") || sectors.includes("technology")) return "long_term";
  return "unknown";
}

function detectSignalStrength({newsType, text, tickers, officialSource, strongRiskMatches, strongMovementMatches, macroMatches, confidenceScore, isNoise}) {
  if (isNoise || newsType === "technical_notice") return "noise";
  if (hasAnyKeyword(text, brokerKeywords.promotional)) return "weak";
  if (officialSource && tickers.length && strongRiskMatches.length) return "strong";
  if (newsType === "market_movement" && (strongMovementMatches.length || hasAnyKeyword(text, ["lao doc", "ban rong dot bien", "ban rong ky luc", "khoi ngoai", "ban rong", "mua rong", "thanh khoan", "vn-index", "vnindex"]))) return "strong";
  if (newsType === "macro" && macroMatches.length) {
    return strongMovementMatches.length || hasAnyKeyword(text, ["fed", "cpi", "ppi", "lai suat", "ty gia", "gia dau", "dau tho", "vang", "usd", "dxy"]) ? "strong" : "medium";
  }
  if (newsType === "risk_event" && strongRiskMatches.length) return "strong";
  if ((newsType === "earnings_business" || newsType === "corporate_action") && tickers.length) return "medium";
  if (newsType === "internal_trading") return "medium";
  if (confidenceScore >= 65 && (newsType === "macro" || newsType === "market_movement" || hasAnyKeyword(text, ["dau tu cong", "ha tang", "fdi", "trung tam du lieu", "ai"]))) return "medium";
  return "weak";
}

function detectKeywords(text) {
  const normalized = removeVietnameseMarks(text);
  const allWords = Object.values(keywordDictionary).flat();
  return Array.from(new Set(
    allWords.filter((word) => normalized.includes(removeVietnameseMarks(word)))
  ));
}

function classifySentiment(text) {
  const normalized = removeVietnameseMarks(text);
  const positive = keywordDictionary.positive.filter((word) => normalized.includes(removeVietnameseMarks(word))).length;
  const negative = keywordDictionary.negative.filter((word) => normalized.includes(removeVietnameseMarks(word))).length;
  if (negative > positive) return "negative";
  if (positive > negative) return "positive";
  return "neutral";
}

function scoreFreshness(publishedAt) {
  const publishedTime = publishedAt ? publishedAt.getTime() : Date.now();
  const hours = Math.max(0, (Date.now() - publishedTime) / 36e5);
  if (hours <= 6) return 8;
  if (hours <= 12) return 5;
  if (hours <= 24) return 3;
  return 0;
}

function isOfficialSource(source) {
  const normalized = removeVietnameseMarks(source);
  return ["hose", "hnx", "vsd", "ssc", "ubck", "so giao dich"].some((word) => normalized.includes(word));
}

function detectPriorityLabel(finalScore, signalStrength, isNoise, newsType, confidenceScore) {
  const canBeHot = signalStrength === "strong" && !isNoise && newsType !== "technical_notice" && confidenceScore >= 50;
  if (finalScore >= 75 && canBeHot) return "hot";
  if (finalScore >= 60) return "important";
  if (finalScore >= 40) return "watch";
  return "normal";
}

function detectBrokerDecision(newsType, priorityLabel, signalStrength, isNoise) {
  if (isNoise || newsType === "technical_notice") return "ignore";
  if (newsType === "risk_event" && signalStrength === "strong") return "urgent_alert";
  if ((newsType === "market_movement" || newsType === "macro") && signalStrength === "strong") return "daily_note";
  if ((newsType === "market_movement" || newsType === "macro") && (priorityLabel === "important" || priorityLabel === "hot")) return "daily_note";
  if (["earnings_business", "corporate_action"].includes(newsType) && signalStrength === "medium") return "watchlist_candidate";
  if (newsType === "internal_trading") return "check_later";
  return "check_later";
}

function detectAdvisoryAction(newsType, priorityLabel, signalStrength, isNoise) {
  if (isNoise || newsType === "technical_notice") return "ignore_noise";
  if (newsType === "risk_event") return signalStrength === "strong" && priorityLabel === "hot" ? "alert_client" : "risk_warning";
  if (newsType === "market_movement") return "prepare_commentary";
  if (newsType === "macro") return priorityLabel === "important" || priorityLabel === "hot" ? "prepare_commentary" : "watch_only";
  if (newsType === "earnings_business" || newsType === "corporate_action") return "check_price_chart";
  if (newsType === "internal_trading") return "watch_only";
  return "watch_only";
}

function createAdvisoryNote(newsType, tickers, marketSentiment, impactHorizon, signalStrength) {
  if (newsType === "risk_event" && tickers.length) {
    return "Tin rủi ro có nguồn chính thức, cần cảnh báo khách đang nắm giữ mã liên quan; ưu tiên kiểm tra tỷ trọng, thanh khoản và trạng thái kỹ thuật.";
  }
  if (newsType === "risk_event") {
    return "Tin rủi ro cần theo dõi thêm; ưu tiên kiểm tra tác động lan tỏa, thanh khoản và quản trị tỷ trọng.";
  }
  if (newsType === "market_movement") {
    return `Tin ảnh hưởng tâm lý thị trường chung (${marketSentiment}, ${impactHorizon}); theo dõi phản ứng VN-Index, nhóm trụ, thanh khoản và hành vi khối ngoại trước khi hành động.`;
  }
  if (newsType === "macro") {
    return "Tin vĩ mô có thể ảnh hưởng mặt bằng định giá và khẩu vị rủi ro; cần theo dõi tác động lên tỷ giá, lãi suất và dòng tiền thị trường.";
  }
  if (newsType === "internal_trading") {
    return "Tin giao dịch nội bộ cần theo dõi thêm, chưa đủ cơ sở hành động độc lập.";
  }
  if (newsType === "technical_notice") {
    return "Tin kỹ thuật, giá trị tư vấn thấp; chỉ lưu để tra cứu.";
  }
  if (newsType === "corporate_action" || newsType === "earnings_business") {
    return `Tin doanh nghiệp có tín hiệu ${signalStrength}; kiểm tra thêm định giá, phản ứng giá, thanh khoản và bối cảnh nắm giữ trước khi khuyến nghị.`;
  }
  return "Theo dõi thêm, chờ xác nhận từ giá, thanh khoản và bối cảnh thị trường trước khi hành động.";

  if (newsType === "risk_event" && tickers.length) {
    return "Tin rủi ro cần cảnh báo khách đang nắm giữ mã này; nên kiểm tra tỷ trọng, thanh khoản và trạng thái kỹ thuật trước khi hành động.";
  }
  if (newsType === "risk_event") {
    return "Tin rủi ro cần theo dõi thêm; ưu tiên kiểm tra tác động lan tỏa và quản trị tỷ trọng.";
  }
  if (newsType === "market_movement") {
    return "Tin ảnh hưởng tâm lý thị trường chung; ưu tiên quan sát phản ứng VN-Index, nhóm trụ và thanh khoản.";
  }
  if (newsType === "macro") {
    return "Tin vĩ mô có thể ảnh hưởng mặt bằng định giá và tâm lý dòng tiền; theo dõi tác động lên tỷ giá, lãi suất và nhóm ngành nhạy cảm.";
  }
  if (newsType === "internal_trading") {
    return "Tin cần theo dõi thêm, chưa đủ cơ sở hành động độc lập.";
  }
  if (newsType === "technical_notice") {
    return "Tin kỹ thuật, giá trị tư vấn thấp; chỉ lưu để tra cứu.";
  }
  if (newsType === "corporate_action" || newsType === "earnings_business") {
    return "Tin liên quan doanh nghiệp; cần kiểm tra thêm định giá, phản ứng giá và bối cảnh nắm giữ trước khi khuyến nghị.";
  }
  return "Theo dõi thêm, chờ xác nhận từ giá, thanh khoản và bối cảnh thị trường trước khi hành động.";
}

function createClientSuitability(newsType) {
  return {
    shortTerm: newsType === "market_movement",
    longTerm: ["macro", "corporate_action", "earnings_business"].includes(newsType),
    riskAverse: ["risk_event", "macro"].includes(newsType),
    marginUser: ["risk_event", "market_movement"].includes(newsType),
    holdingTicker: ["risk_event", "corporate_action", "earnings_business"].includes(newsType),
    watchlistRelevant: ["risk_event", "market_movement", "macro", "corporate_action", "earnings_business"].includes(newsType),
  };
}

function normalizeTextForRules(item) {
  return removeVietnameseMarks(`${item.title || ""} ${item.summary || ""} ${item.source || ""}`);
}

function detectStandardEventType(text) {
  const normalized = removeVietnameseMarks(text);
  if (/\b(bao cao|cap nhat|kqkd|khuyen nghi|dinh gia|gia muc tieu)\b/i.test(normalized)) return "analyst_report";
  if (normalized.includes("phat hanh trai phieu")) return "bond";
  if (normalized.includes("phat hanh bao cao tai chinh")) return "earnings";
  if (normalized.includes("dau tu chung khoan") || normalized.includes("tu doanh")) return "production_business";
  for (const [eventType, words] of EVENT_RULES) {
    if (words.some((word) => normalized.includes(removeVietnameseMarks(word)))) return eventType;
  }
  return null;
}

function detectStandardSector(text, tickers) {
  for (const ticker of tickers) {
    if (STOCK_TO_SECTOR[ticker]) return STOCK_TO_SECTOR[ticker];
  }
  const normalized = removeVietnameseMarks(text);
  for (const [sector, words] of Object.entries(SECTOR_KEYWORD_RULES)) {
    if (words.some((word) => normalized.includes(removeVietnameseMarks(word)))) {
      return STANDARD_SECTORS.has(sector) ? sector : "other";
    }
  }
  return "other";
}

function detectStandardSentiment(text, eventType) {
  const normalized = removeVietnameseMarks(text);
  const positiveHits = STRONG_POSITIVE_WORDS.filter((word) => normalized.includes(removeVietnameseMarks(word))).length;
  const negativeHits = STRONG_NEGATIVE_WORDS.filter((word) => normalized.includes(removeVietnameseMarks(word))).length;
  if (["delisting", "court_dispute"].includes(eventType)) return "negative";
  if (["bond", "legal"].includes(eventType) && hasAnyKeyword(text, ["cham thanh toan", "no qua han", "bi dieu tra", "dinh chi", "huy niem yet", "kiem toan ngoai tru"])) return "negative";
  if (eventType === "dividend" && hasAnyKeyword(text, ["bang tien", "tien mat", "ty le cao"])) return "positive";
  if (eventType === "capital_raise" && hasAnyKeyword(text, ["gia thap", "pha loang", "duoi thi gia"])) return "negative";
  if (negativeHits > positiveHits) return "negative";
  if (positiveHits > negativeHits) return "positive";
  return "neutral";
}

function baseScoreForEvent(eventType, text) {
  if (eventType === "analyst_report") return 58;
  if (["delisting", "court_dispute"].includes(eventType)) return 85;
  if (eventType === "bond" && hasAnyKeyword(text, ["cham thanh toan", "no qua han", "mat kha nang thanh toan"])) return 82;
  if (eventType === "legal" && hasAnyKeyword(text, ["dinh chi", "huy niem yet", "bi dieu tra", "kiem toan ngoai tru"])) return 78;
  if (["policy", "fx_interest_rate", "government", "bank_credit", "index_rebalance", "fx", "gold_price", "crypto"].includes(eventType)) return 65;
  if (["earnings", "capital_raise", "mna", "project", "contract_order", "public_investment", "commodity_price"].includes(eventType)) return 55;
  if (["dividend", "ex_right", "ownership", "insider_transaction", "leadership", "listing", "real_estate_legal"].includes(eventType)) return 35;
  if (["etf"].includes(eventType)) return 20;
  if (!eventType) return 25;
  return 35;
}

function freshnessBoostForStandardScore(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return 0;
  const ageMinutes = Math.max(0, (Date.now() - date.getTime()) / 60000);
  if (ageMinutes <= 15) return 15;
  if (ageMinutes <= 60) return 10;
  if (ageMinutes <= 180) return 5;
  if (ageMinutes > 1440) return -8;
  return 0;
}

function impactLevelFromScore(score) {
  if (score >= 75) return "hot";
  if (score >= 50) return "watch";
  if (score >= 25) return "normal";
  return "noise";
}

function decisionFromImpact(impactLevel, confidenceScore) {
  if (impactLevel === "hot") return confidenceScore >= 70 ? "actionable" : "watch_only";
  if (impactLevel === "watch") return "watch_only";
  if (impactLevel === "normal") return "check_later";
  return "ignore";
}

function sourceWeightFor(source, text) {
  const normalized = removeVietnameseMarks(`${source || ""} ${text || ""}`);
  if (hasAnyKeyword(normalized, ["nhnn", "ngan hang nha nuoc"])) return 20;
  if (hasAnyKeyword(normalized, ["chinh phu", "thu tuong", "bo tai chinh", "bo cong thuong", "ubck"])) return 18;
  if (hasAnyKeyword(normalized, ["hose", "hnx", "upcom", "vsd", "ssc"])) return 17;
  if (hasAnyKeyword(normalized, ["reuters", "bloomberg"])) return 20;
  if (hasAnyKeyword(normalized, ["cafef", "vietstock", "vneconomy"])) return 12;
  return 7;
}

function enterpriseTierFor(tickers) {
  if (tickers.some((ticker) => TIER_1_TICKERS.has(ticker))) return "tier_1";
  if (tickers.some((ticker) => TIER_2_TICKERS.has(ticker))) return "tier_2";
  if (tickers.length) return "tier_3";
  return null;
}

function marketScopeFor(source, text, eventType, sector, tickers) {
  const normalized = removeVietnameseMarks(`${source || ""} ${text || ""}`);
  if (hasAnyKeyword(normalized, ["nhnn", "ngan hang nha nuoc", "fed", "ecb", "boj"])) return "central_bank";
  if (hasAnyKeyword(normalized, ["chinh phu", "thu tuong", "bo tai chinh", "bo cong thuong", "quoc hoi"]) || ["policy", "government"].includes(eventType)) return "government";
  if (hasAnyKeyword(normalized, ["hose", "hnx", "upcom", "vsd", "ubck"])) return "exchange";
  if (sector === "international" || hasAnyKeyword(normalized, ["fed", "ecb", "boj", "trung quoc", "my", "eu", "opec", "msci", "ftse"])) return "international";
  if (tickers.length) return "enterprise";
  return "domestic";
}

function marketImpactWeightFor(scope, eventType, enterpriseTier, text) {
  let weight = 0;
  if (scope === "central_bank") weight += 22;
  else if (scope === "government") weight += 18;
  else if (scope === "exchange") weight += 16;
  else if (scope === "international") weight += 12;
  else if (scope === "enterprise") weight += enterpriseTier === "tier_1" ? 16 : enterpriseTier === "tier_2" ? 10 : 5;
  else weight += 4;

  if (["fx_interest_rate", "bank_credit", "policy", "government", "index_rebalance", "bond"].includes(eventType)) weight += 8;
  if (hasAnyKeyword(text, ["room tin dung", "nang hang", "msci", "ftse", "etf review", "call margin", "giai chap"])) weight += 8;
  return Math.max(0, Math.min(30, weight));
}

function noiseReasonFor({impactLevel, decision, eventType, relatedStocks, text, publishedAt}) {
  if (impactLevel !== "noise" && decision !== "ignore") return null;
  const date = publishedAt ? new Date(publishedAt) : null;
  if (eventType === "etf" || hasAnyKeyword(text, ["hoan doi", "nav", "danh muc co cau"])) return "repeated_notice";
  if (hasAnyKeyword(text, ADMIN_LOW_IMPACT_WORDS)) return "administrative_notice";
  if (!text || text.length < 40) return "unclear_content";
  if (date && !Number.isNaN(date.getTime()) && Date.now() - date.getTime() > 3 * 24 * 60 * 60 * 1000) return "stale_news";
  if (!relatedStocks.length) return "no_ticker";
  return "low_impact";
}

function clusterIdFor({eventType, sector, relatedStocks, text}) {
  const normalized = removeVietnameseMarks(text)
    .replace(/\b(thong bao|bao cao|nghi quyet|quyet dinh|cong bo thong tin|ctcp|cong ty)\b/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter((word) => word.length > 2)
    .slice(0, 9)
    .join(" ");
  const seed = `${relatedStocks[0] || "NO_TICKER"}|${eventType || "other"}|${sector}|${normalized}`;
  return CryptoJS.SHA256(seed).toString(CryptoJS.enc.Hex).slice(0, 20);
}

function clusterTitleFor({eventType, sector, relatedStocks, title}) {
  const ticker = relatedStocks[0];
  const eventLabel = eventType ? eventType.replace(/_/g, " ") : "tin mới";
  return ticker ? `${ticker}: ${eventLabel}` : `${sector}: ${eventLabel}`;
}

function isStockbizReport(item) {
  const source = removeVietnameseMarks(item.source || item.originalSource || "").toLowerCase();
  const text = removeVietnameseMarks(`${item.title || ""} ${item.summary || ""}`);
  return source.includes("stockbiz") && /\b(bao cao|cap nhat|kqkd|khuyen nghi|dinh gia)\b/i.test(text);
}

function tickerFromReportTitle(title) {
  const match = String(title || "").trim().match(/^([A-Z0-9]{2,10})\s*[-:–—]/);
  return match ? match[1].toUpperCase() : "";
}

function extractRecommendation(text) {
  const normalized = removeVietnameseMarks(text).toUpperCase();
  if (/\bMUA\b/.test(normalized)) return "MUA";
  if (/\bKHA QUAN\b/.test(normalized)) return "KHẢ QUAN";
  if (/\bTRUNG LAP\b/.test(normalized)) return "TRUNG LẬP";
  if (/\bBAN\b/.test(normalized)) return "BÁN";
  return "";
}

function extractTargetPriceText(text) {
  const match = String(text || "").match(/\b\d{1,3}(?:[.,]\d{3})+\s*(?:đồng|dong)\/cp\b/i);
  return match ? match[0] : "";
}

function reasonForAnalysis({eventType, sentiment, impactLevel, noiseReason}) {
  if (noiseReason === "administrative_notice") return "Tin hành chính, tác động thấp.";
  if (noiseReason) return "Tin nhiễu hoặc tác động thấp.";
  if (eventType === "earnings" && sentiment === "positive") return "Lợi nhuận tăng mạnh, tác động tích cực.";
  if (eventType === "bond" && sentiment === "negative") return "Chậm thanh toán trái phiếu, rủi ro cao.";
  if (["legal", "delisting", "court_dispute"].includes(eventType)) return "Rủi ro pháp lý, cần theo dõi sát.";
  if (["fx_interest_rate", "policy", "government", "bank_credit"].includes(eventType)) return "Chính sách vĩ mô, ảnh hưởng thị trường.";
  if (["project", "contract_order", "public_investment"].includes(eventType)) return "Dự án/hợp đồng lớn, có thể tác động giá.";
  if (eventType === "dividend") return "Cổ tức doanh nghiệp, theo dõi phản ứng giá.";
  if (impactLevel === "hot") return "Tín hiệu mạnh, ưu tiên theo dõi.";
  if (impactLevel === "watch") return "Tin đáng chú ý, cần theo dõi thêm.";
  return "Tin bình thường, tác động vừa.";
}

function buildStandardAnalysis(item, legacy = {}) {
  const text = `${item.title || ""} ${item.summary || ""}`;
  const normalized = normalizeTextForRules(item);
  const reportTicker = tickerFromReportTitle(item.title);
  const tickers = detectTickers(`${item.title || ""} ${item.summary || ""} ${(item.relatedStocks || []).join(" ")} ${(item.tickers || []).join(" ")}`);
  const reportLike = isStockbizReport(item) || item.eventType === "analyst_report";
  const recommendation = reportLike ? extractRecommendation(text) : "";
  const targetPriceText = reportLike ? extractTargetPriceText(text) : "";
  const relatedStocks = Array.from(new Set([
    ...(Array.isArray(item.relatedStocks) ? item.relatedStocks : []),
    ...(Array.isArray(item.tickers) ? item.tickers : []),
    ...(reportTicker ? [reportTicker] : []),
    ...tickers,
  ].map((ticker) => String(ticker || "").toUpperCase()).filter((ticker) => /^[A-Z0-9]{2,10}$/.test(ticker))));
  const eventType = reportLike ? "analyst_report" : (item.eventType || detectStandardEventType(text));
  const sector = detectStandardSector(text, relatedStocks);
  const sentiment = detectStandardSentiment(text, eventType);
  const sourceWeight = sourceWeightFor(item.source, text);
  const enterpriseTier = enterpriseTierFor(relatedStocks);
  const marketScope = marketScopeFor(item.source, text, eventType, sector, relatedStocks);
  const marketImpactWeight = marketImpactWeightFor(marketScope, eventType, enterpriseTier, text);
  const keywords = Array.from(new Set([
    ...detectKeywords(text),
    ...matchedKeywords(text, STRONG_POSITIVE_WORDS),
    ...matchedKeywords(text, STRONG_NEGATIVE_WORDS),
    ...matchedKeywords(text, MARKET_MOVING_KEYWORDS),
  ])).slice(0, 16);

  let impactScore = baseScoreForEvent(eventType, text);
  if (relatedStocks.length) impactScore += 8;
  if (sector !== "other") impactScore += 5;
  if (matchedKeywords(text, STRONG_POSITIVE_WORDS).length || matchedKeywords(text, STRONG_NEGATIVE_WORDS).length) impactScore += 12;
  if (matchedKeywords(text, MARKET_MOVING_KEYWORDS).length) impactScore += 14;
  impactScore += Math.round(sourceWeight * 0.45);
  impactScore += Math.round(marketImpactWeight * 0.7);
  if (enterpriseTier === "tier_1") impactScore += 8;
  else if (enterpriseTier === "tier_2") impactScore += 4;
  if (eventType === "analyst_report" && relatedStocks.length) impactScore += 14;
  impactScore += freshnessBoostForStandardScore(item.publishedAt);
  if (hasAnyKeyword(text, ADMIN_LOW_IMPACT_WORDS)) impactScore -= 18;
  if (!item.summary || String(item.summary).length < 40) impactScore -= 6;
  if (!relatedStocks.length && sector === "other") impactScore -= 8;
  if (eventType === "etf") impactScore = Math.min(impactScore, 24);
  if (!eventType && hasAnyKeyword(text, ADMIN_LOW_IMPACT_WORDS)) impactScore = Math.min(impactScore, 24);
  impactScore = Math.max(0, Math.min(100, Math.round(impactScore)));

  let confidenceScore = 30;
  if (relatedStocks.length) confidenceScore += 25;
  if (eventType) confidenceScore += 25;
  if (eventType === "analyst_report" && relatedStocks.length) confidenceScore += 12;
  if (sector !== "other") confidenceScore += 15;
  if (keywords.length) confidenceScore += Math.min(15, keywords.length * 3);
  if (!eventType && sector === "other") confidenceScore -= 10;
  if (!item.summary) confidenceScore -= 8;
  confidenceScore = Math.max(0, Math.min(100, Math.round(confidenceScore)));

  const impactLevel = impactLevelFromScore(impactScore);
  const decision = decisionFromImpact(impactLevel, confidenceScore);
  const noiseReason = noiseReasonFor({impactLevel, decision, eventType, relatedStocks, text, publishedAt: item.publishedAt});
  const clusterId = clusterIdFor({eventType, sector, relatedStocks, text});
  const clusterTitle = clusterTitleFor({eventType, sector, relatedStocks, title: item.title});
  const sourceUrl = item.canonicalUrl || item.url || item.originalUrl || "";

  return {
    ...legacy,
    impactScore,
    finalScore: impactScore,
    confidenceScore,
    impactLevel,
    sector,
    sectors: sector === "other" ? [] : [sector],
    sentiment,
    marketSentiment: sentiment,
    marketScope,
    marketImpactWeight,
    enterpriseTier,
    sourceWeight,
    eventType,
    relatedStocks,
    tickers: relatedStocks,
    decision,
    brokerDecision: decision === "actionable" ? "urgent_alert" : decision === "watch_only" ? "watchlist_candidate" : decision,
    reasonShort: reasonForAnalysis({eventType, sentiment, impactLevel, noiseReason}),
    noiseReason,
    clusterId,
    clusterTitle,
    duplicateCount: 1,
    sources: item.source ? [item.source] : [],
    sourceUrls: sourceUrl ? [sourceUrl] : [],
    keywords,
    isNoise: impactLevel === "noise",
    priorityLabel: impactLevel === "hot" ? "hot" : impactLevel === "watch" ? "watch" : "normal",
    signalStrength: impactLevel === "hot" ? "strong" : impactLevel === "watch" ? "medium" : impactLevel === "noise" ? "noise" : "weak",
    newsType: eventType || (sector === "macro" ? "macro" : "normal"),
    recommendation: recommendation || null,
    targetPriceText: targetPriceText || null,
    uiBadge: eventType === "analyst_report" ? "📄 Báo cáo" : (legacy.uiBadge || null),
    riskLevel: sentiment === "negative" && impactScore >= 70 ? "high" : sentiment === "negative" && impactScore >= 50 ? "medium" : "normal",
    reasonTags: Array.from(new Set([...(legacy.reasonTags || []), eventType, sector, sentiment].filter(Boolean))),
  };
}

function analyzeNews(item) {
  const text = `${item.title} ${item.summary}`;
  const tickers = detectTickers(text);
  const isEtfNotice = detectEtfNotice(text, tickers);
  const isTechnicalNotice = detectTechnicalNotice(text, isEtfNotice);
  const newsType = classifyNewsType(text, isEtfNotice);
  const marketScope = detectMarketScope(text, tickers);
  const assetType = detectAssetType(tickers, text, marketScope);
  const sectors = detectSectors(text);
  const marketSentiment = detectMarketSentiment(text);
  const impactHorizon = detectImpactHorizon(newsType, text, tickers, sectors);
  const keywords = detectKeywords(text);
  const sentiment = classifySentiment(text);
  const source = item.source || "";
  const officialSource = isOfficialSource(source);
  const strongRiskMatches = matchedKeywords(text, brokerKeywords.strongRisk);
  const majorRiskMatches = matchedKeywords(text, majorRiskKeywords);
  const strongMovementMatches = matchedKeywords(text, brokerKeywords.strongMovement);
  const macroMatches = matchedKeywords(text, brokerKeywords.macro);
  const reasonTags = Array.from(new Set([
    ...strongRiskMatches.map((word) => `risk:${word}`),
    ...majorRiskMatches.map((word) => `major_risk:${word}`),
    ...strongMovementMatches.map((word) => `movement:${word}`),
    ...macroMatches.slice(0, 3).map((word) => `macro:${word}`),
    ...(tickers.length ? ["ticker"] : []),
    ...(officialSource ? ["official_source"] : []),
    ...(isEtfNotice ? ["etf_notice"] : []),
  ]));

  let impactScore = 0;
  if (tickers.length) impactScore += 15;
  if (sectors.length) impactScore += 8;
  if (marketScope === "market") impactScore += 15;
  impactScore += scoreFreshness(item.publishedAt);
  if (officialSource) impactScore += 8;
  if (newsType === "risk_event") impactScore += 25;
  if (newsType === "risk_event" && tickers.length && majorRiskMatches.length) impactScore += 15;
  if (newsType === "market_movement" && strongMovementMatches.length) impactScore += 20;
  if (newsType === "macro" && macroMatches.length && strongMovementMatches.length) impactScore += 18;
  if (newsType === "earnings_business") impactScore += 18;
  if (newsType === "corporate_action") impactScore += 15;
  if (newsType === "internal_trading") impactScore += 12;
  if (newsType === "technical_notice") impactScore += 5;

  let confidenceScore = 35;
  if (/^\s*[A-Z0-9]{3,10}\s*:/.test(String(item.title || "").toUpperCase())) confidenceScore += 25;
  if (keywords.length) confidenceScore += Math.min(20, keywords.length * 4);
  if (officialSource) confidenceScore += 15;
  if (sectors.length) confidenceScore += 8;
  if (newsType === "normal") confidenceScore -= 10;
  if (isEtfNotice || isTechnicalNotice) confidenceScore += 8;
  confidenceScore = Math.max(0, Math.min(100, confidenceScore));

  impactScore = Math.max(10, Math.min(100, impactScore));
  let finalScore = Math.min(100, impactScore + scoreFreshness(item.publishedAt));
  const isNoise = isEtfNotice || isTechnicalNotice || (newsType === "technical_notice");
  const signalStrength = detectSignalStrength({
    newsType,
    text,
    tickers,
    officialSource,
    strongRiskMatches,
    strongMovementMatches,
    macroMatches,
    confidenceScore,
    isNoise,
  });
  if (isEtfNotice) finalScore = Math.min(finalScore, 35);
  if (newsType === "technical_notice") finalScore = Math.min(finalScore, 49);
  if (newsType === "internal_trading" && !strongRiskMatches.length) finalScore = Math.min(finalScore, 59);
  if (newsType === "normal" && confidenceScore < 65) finalScore = Math.min(finalScore, 45);
  if (hasAnyKeyword(text, brokerKeywords.promotional)) finalScore = Math.min(finalScore, 50);
  if (confidenceScore < 50) finalScore = Math.min(finalScore, 55);
  finalScore = Math.max(0, Math.min(100, finalScore));

  const priorityLabel = detectPriorityLabel(finalScore, signalStrength, isNoise, newsType, confidenceScore);
  const riskLevel = newsType === "risk_event"
    ? (finalScore >= 75 ? "high" : finalScore >= 60 ? "medium" : "low")
    : "normal";
  const advisoryAction = detectAdvisoryAction(newsType, priorityLabel, signalStrength, isNoise);
  const brokerDecision = detectBrokerDecision(newsType, priorityLabel, signalStrength, isNoise);

  const legacyAnalysis = {
    newsType,
    assetType,
    marketScope,
    marketSentiment,
    impactHorizon,
    signalStrength,
    tickers,
    sectors,
    keywords,
    sentiment,
    riskLevel,
    impactScore,
    finalScore,
    priorityLabel,
    confidenceScore,
    advisoryAction,
    brokerDecision,
    advisoryNote: createAdvisoryNote(newsType, tickers, marketSentiment, impactHorizon, signalStrength),
    clientSuitability: createClientSuitability(newsType),
    isNoise,
    isEtfNotice,
    isTechnicalNotice,
    reasonTags,
  };
  return buildStandardAnalysis(item, legacyAnalysis);
}

function normalizeItem(rawItem, source) {
  const publishedAt = rawItem.isoDate || rawItem.pubDate || rawItem.updated || rawItem.atomUpdated;
  const parsedDate = publishedAt ? new Date(publishedAt) : new Date();
  const summarySource = rawItem.contentSnippet || rawItem.summary || rawItem.description || "";
  const summary = limitSummary(summarySource);
  const originalUrl = rawItem.link || rawItem.guid || rawItem.url || "";
  const url = sanitizeArticleUrl(originalUrl, source);
  const canonicalUrl = url;

  return {
    title: stripHtml(rawItem.title || "Untitled"),
    summary,
    url: canonicalUrl,
    originalUrl: originalUrl || canonicalUrl,
    canonicalUrl,
    originalSource: source.sourceName || source.sourceId || source.rssUrl,
    source: source.sourceName || source.sourceId || source.rssUrl,
    legalMode: LEGAL_MODE,
    contentType: "link_preview",
    summaryGeneratedBy: summary ? "rss" : null,
    thumbnailUrl: "",
    publishedAt: Number.isNaN(parsedDate.getTime()) ? new Date() : parsedDate,
  };
}

async function fetchRssText(source) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(createTimeoutError(source.rssUrl)), RSS_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(source.rssUrl, {
      headers: {
        "user-agent": "RSS Firestore Local Collector/1.0",
        "accept": "application/rss+xml, application/xml, text/xml, */*",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    return await response.text();
  } catch (error) {
    if (error.name === "AbortError" || error.code === "RSS_TIMEOUT") {
      throw createTimeoutError(source.rssUrl);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchSource(source) {
  const startedAt = Date.now();
  const label = sourceLabel(source);
  if (source.allowCrawl === false) {
    console.log(`[SKIP] ${label} - allowCrawl=false`);
    return [];
  }
  console.log(`[FETCH] ${label} - ${source.rssUrl}`);

  let xmlText;
  try {
    xmlText = await fetchRssText(source);
  } catch (error) {
    if (error.code === "RSS_TIMEOUT") {
      console.log(`[TIMEOUT] ${label} - ${formatSeconds(startedAt)} - ${source.rssUrl}`);
    } else {
      console.log(`[ERROR] ${label} - ${formatSeconds(startedAt)} - ${error.message}`);
    }
    throw error;
  }

  let feed;
  try {
    feed = await parser.parseString(xmlText);
  } catch (error) {
    error.code = "RSS_PARSE_ERROR";
    console.log(`[PARSE_ERROR] ${label} - ${formatSeconds(startedAt)} - ${error.message}`);
    throw error;
  }

  const items = (feed.items || [])
    .map((item) => normalizeItem(item, source))
    .filter((item) => item.title && item.url && !isFeedUrl(item.url))
    .sort((left, right) => right.publishedAt - left.publishedAt)
    .slice(0, MAX_ITEMS_PER_FEED);

  console.log(`[OK] ${label} - ${formatSeconds(startedAt)} - ${items.length} items`);

  return items;
}

async function saveItem(db, item) {
  const hash = item.hash || createHash(item);
  const docRef = db.collection("news").doc(hash);
  const snapshot = await docRef.get();
  if (snapshot.exists) {
    return {saved: false, hash};
  }

  const analysis = analyzeNews(item);
  await docRef.set({
    ...item,
    summary: limitSummary(item.summary || ""),
    legalMode: true,
    contentType: "link_preview",
    originalSource: item.originalSource || item.source || "",
    originalUrl: item.originalUrl || item.url || "",
    canonicalUrl: item.canonicalUrl || item.url || "",
    summaryGeneratedBy: item.summaryGeneratedBy || (item.summary ? "rss" : null),
    thumbnailUrl: "",
    publishedAt: admin.firestore.Timestamp.fromDate(item.publishedAt),
    fetchedAt: admin.firestore.FieldValue.serverTimestamp(),
    analyzed: true,
    analyzedAt: admin.firestore.FieldValue.serverTimestamp(),
    hash,
    ...analysis,
    status: "analyzed",
  });

  return {saved: true, hash};
}

function createFirestoreNewsPayload(item) {
  const hash = item.hash || createHash(item);
  const analysis = analyzeNews(item);
  return {
    ...item,
    summary: limitSummary(item.summary || ""),
    legalMode: true,
    contentType: "link_preview",
    originalSource: item.originalSource || item.source || "",
    originalUrl: item.originalUrl || item.url || "",
    canonicalUrl: item.canonicalUrl || item.url || "",
    summaryGeneratedBy: item.summaryGeneratedBy || (item.summary ? "rss" : null),
    thumbnailUrl: "",
    publishedAt: admin.firestore.Timestamp.fromDate(item.publishedAt),
    fetchedAt: admin.firestore.FieldValue.serverTimestamp(),
    analyzed: true,
    analyzedAt: admin.firestore.FieldValue.serverTimestamp(),
    hash,
    ...analysis,
    status: "analyzed",
  };
}

function createAnalysisUpdatePayload(item) {
  const analysis = analyzeNews(item);
  return {
    newsType: analysis.newsType,
    assetType: analysis.assetType,
    marketScope: analysis.marketScope,
    marketSentiment: analysis.marketSentiment,
    impactHorizon: analysis.impactHorizon,
    signalStrength: analysis.signalStrength,
    tickers: analysis.tickers,
    sectors: analysis.sectors,
    keywords: analysis.keywords,
    sentiment: analysis.sentiment,
    impactLevel: analysis.impactLevel,
    sector: analysis.sector,
    eventType: analysis.eventType,
    relatedStocks: analysis.relatedStocks,
    decision: analysis.decision,
    reasonShort: analysis.reasonShort,
    noiseReason: analysis.noiseReason,
    clusterId: analysis.clusterId,
    clusterTitle: analysis.clusterTitle,
    duplicateCount: analysis.duplicateCount,
    sources: analysis.sources,
    sourceUrls: analysis.sourceUrls,
    sourceWeight: analysis.sourceWeight,
    marketImpactWeight: analysis.marketImpactWeight,
    enterpriseTier: analysis.enterpriseTier,
    riskLevel: analysis.riskLevel,
    impactScore: analysis.impactScore,
    finalScore: analysis.finalScore,
    priorityLabel: analysis.priorityLabel,
    confidenceScore: analysis.confidenceScore,
    advisoryAction: analysis.advisoryAction,
    brokerDecision: analysis.brokerDecision,
    advisoryNote: analysis.advisoryNote,
    clientSuitability: analysis.clientSuitability,
    isNoise: analysis.isNoise,
    isEtfNotice: analysis.isEtfNotice,
    isTechnicalNotice: analysis.isTechnicalNotice,
    reasonTags: analysis.reasonTags,
    analyzed: true,
    analyzedAt: admin.firestore.FieldValue.serverTimestamp(),
    status: "analyzed",
  };
}

function titlePreview(title) {
  const value = String(title || "Untitled").replace(/\s+/g, " ").trim();
  return value.length > 90 ? `${value.slice(0, 87)}...` : value;
}

function prepareItemsForWrite(items) {
  const seenHashes = new Set();
  const uniqueItems = [];
  let inMemoryDuplicates = 0;

  for (const item of items) {
    const hash = createHash(item);
    if (seenHashes.has(hash)) {
      inMemoryDuplicates += 1;
      console.log(`[SKIP] duplicate ${titlePreview(item.title)}`);
      continue;
    }
    seenHashes.add(hash);
    uniqueItems.push({...item, hash});
    if (uniqueItems.length >= MAX_TOTAL_ITEMS) {
      break;
    }
  }

  return {uniqueItems, inMemoryDuplicates};
}

async function writeItemsToFirestore(db, items, errors) {
  const startedAt = Date.now();
  if (!items.length) {
    console.log(`Firestore write completed in ${formatSeconds(startedAt)}`);
    return {saved: 0, duplicates: 0};
  }

  const docRefs = items.map((item) => db.collection("news").doc(item.hash || createHash(item)));
  console.log("Checking Firestore duplicates...");
  const duplicateCheckStartedAt = Date.now();
  let snapshots = [];
  let skipDuplicateCheck = false;

  try {
    snapshots = await withTimeout(
      checkFirestoreDuplicates(db, docRefs, items, errors),
      FIRESTORE_OPERATION_TIMEOUT_MS,
      "Firestore duplicate check"
    );
    console.log(`Firestore duplicate check completed in ${formatSeconds(duplicateCheckStartedAt)}`);
  } catch (error) {
    if (error.code === "OPERATION_TIMEOUT") {
      console.log("[TIMEOUT] Firestore duplicate check");
      skipDuplicateCheck = true;
    } else {
      errors.push({source: "Firestore duplicate check", error: error.message});
      skipDuplicateCheck = true;
    }
  }

  const pendingWrites = [];
  let duplicates = 0;
  let saved = 0;

  if (skipDuplicateCheck) {
    items.forEach((item, index) => {
      pendingWrites.push({
        index,
        item,
        ref: docRefs[index],
      });
    });
  } else {
    snapshots.forEach((snapshot, index) => {
      const item = items[index];
      if (snapshot.exists) {
        duplicates += 1;
        console.log(`[SKIP] duplicate ${titlePreview(item.title)}`);
        return;
      }

      pendingWrites.push({
        index,
        item,
        ref: docRefs[index],
      });
    });
  }

  console.log("Starting Firestore batch write...");
  const batchWriteStartedAt = Date.now();

  try {
    await withTimeout(
      commitFirestoreBatches(db, pendingWrites, items.length, errors, (count) => {
        saved += count;
      }),
      FIRESTORE_OPERATION_TIMEOUT_MS,
      "Firestore batch write"
    );
    console.log(`Firestore batch write completed in ${formatSeconds(batchWriteStartedAt)}`);
  } catch (error) {
    if (error.code === "OPERATION_TIMEOUT") {
      console.log("[TIMEOUT] Firestore batch write");
      errors.push({source: "Firestore batch write", error: error.message});
    } else {
      errors.push({source: "Firestore batch write", error: error.message});
    }
    console.log(`Firestore write completed in ${formatSeconds(startedAt)}`);
    return {saved, duplicates};
  }

  console.log(`Firestore write completed in ${formatSeconds(startedAt)}`);
  return {saved, duplicates};
}

async function checkFirestoreDuplicates(db, docRefs, items, errors) {
  const snapshots = new Array(docRefs.length);

  for (let index = 0; index < docRefs.length; index += FIRESTORE_DUPLICATE_CHECK_CHUNK_SIZE) {
    const chunkRefs = docRefs.slice(index, index + FIRESTORE_DUPLICATE_CHECK_CHUNK_SIZE);
    const result = await Promise.allSettled([db.getAll(...chunkRefs)]);

    if (result[0].status === "fulfilled") {
      result[0].value.forEach((snapshot, offset) => {
        snapshots[index + offset] = snapshot;
      });
    } else {
      const error = result[0].reason;
      chunkRefs.forEach((_, offset) => {
        const item = items[index + offset];
        errors.push({source: item.sourceFeed || item.source, error: `Duplicate check failed: ${error.message || error}`});
        snapshots[index + offset] = {exists: false};
      });
    }
  }

  return snapshots.map((snapshot) => snapshot || {exists: false});
}

async function commitFirestoreBatches(db, pendingWrites, totalItems, errors, onSaved) {
  for (let index = 0; index < pendingWrites.length; index += FIRESTORE_BATCH_LIMIT) {
    const chunk = pendingWrites.slice(index, index + FIRESTORE_BATCH_LIMIT);
    const batch = db.batch();

    chunk.forEach((entry) => {
      batch.set(entry.ref, createFirestoreNewsPayload(entry.item));
    });

    await batch.commit();

    chunk.forEach((entry) => {
      console.log(`[SAVE] ${entry.index + 1}/${totalItems} ${titlePreview(entry.item.title)}`);
    });

    onSaved(chunk.length);
  }
}

async function reanalyzeExistingNews(db) {
  console.log("Reanalyzing existing Firestore news...");
  const snapshot = await db.collection("news")
    .orderBy("publishedAt", "desc")
    .limit(500)
    .get();

  const docs = snapshot.docs;
  let updated = 0;

  for (let index = 0; index < docs.length; index += FIRESTORE_BATCH_LIMIT) {
    const chunk = docs.slice(index, index + FIRESTORE_BATCH_LIMIT);
    const batch = db.batch();

    chunk.forEach((doc, offset) => {
      const data = doc.data();
      const item = {
        title: data.title || "",
        summary: data.summary || "",
        source: data.source || "",
        url: data.url || "",
        relatedStocks: Array.isArray(data.relatedStocks) ? data.relatedStocks : [],
        tickers: Array.isArray(data.tickers) ? data.tickers : [],
        publishedAt: data.publishedAt && typeof data.publishedAt.toDate === "function"
          ? data.publishedAt.toDate()
          : new Date(),
      };

      console.log(`[REANALYZE] ${index + offset + 1}/${docs.length} ${titlePreview(item.title)}`);
      batch.update(doc.ref, createAnalysisUpdatePayload(item));
    });

    await batch.commit();
    updated += chunk.length;
  }

  console.log(`Reanalysis completed. Updated ${updated} documents.`);
}

async function analyzeNewNews(db) {
  console.log("Analyzing new Firestore news with analyzed=false...");
  const snapshot = await db.collection("news")
    .where("analyzed", "==", false)
    .limit(100)
    .get();

  const docs = snapshot.docs;
  let updated = 0;

  for (let index = 0; index < docs.length; index += FIRESTORE_BATCH_LIMIT) {
    const chunk = docs.slice(index, index + FIRESTORE_BATCH_LIMIT);
    const batch = db.batch();

    chunk.forEach((doc, offset) => {
      const data = doc.data();
      const item = {
        title: data.title || "",
        summary: data.summary || "",
        source: data.source || data.originalSource || "",
        url: data.canonicalUrl || data.url || data.originalUrl || "",
        relatedStocks: Array.isArray(data.relatedStocks) ? data.relatedStocks : [],
        tickers: Array.isArray(data.tickers) ? data.tickers : [],
        publishedAt: data.publishedAt && typeof data.publishedAt.toDate === "function"
          ? data.publishedAt.toDate()
          : new Date(),
      };

      console.log(`[ANALYZE_NEW] ${index + offset + 1}/${docs.length} ${titlePreview(item.title)}`);
      batch.update(doc.ref, {
        ...createAnalysisUpdatePayload(item),
        analyzed: true,
        status: "analyzed",
        analyzedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    await batch.commit();
    updated += chunk.length;
  }

  console.log(`Analyze-new completed. Updated ${updated} documents.`);
}

async function main() {
  const db = initializeFirebase();

  if (process.argv.includes("--analyze-new")) {
    await analyzeNewNews(db);
    console.log("RSS sync completed.");
    await admin.app().delete();
    return;
  }

  if (process.argv.includes("--reanalyze")) {
    await reanalyzeExistingNews(db);
    console.log("RSS sync completed.");
    await admin.app().delete();
    return;
  }

  const defaultSources = loadSources();
  const customSources = await loadCustomSources(db);
  const sources = mergeSources(defaultSources, customSources);
  const errors = [];
  let feedsProcessed = 0;
  let successCount = 0;
  let failCount = 0;
  let totalItemsParsed = 0;
  let itemsProcessed = 0;
  let newItemsSaved = 0;
  let duplicatesSkipped = 0;
  const parsedItems = [];

  console.log(`Default sources: ${defaultSources.length}`);
  console.log(`Custom active sources: ${customSources.length}`);
  console.log(`Total merged sources: ${sources.length}`);
  console.log(`Total feeds: ${sources.length}`);
  console.log("Starting RSS fetch...");

  const results = await Promise.allSettled(sources.map(async (source) => {
    try {
      const items = await fetchSource(source);
      return {source, items};
    } catch (error) {
      throw {
        source: source.sourceName || source.sourceId || source.rssUrl,
        error: error.message || String(error),
      };
    }
  }));

  for (const result of results) {
    feedsProcessed += 1;

    if (result.status === "rejected") {
      failCount += 1;
      errors.push({
        source: result.reason.source || "unknown",
        error: result.reason.error || result.reason.message || String(result.reason),
      });
      continue;
    }

    const {source, items} = result.value;
    successCount += 1;
    totalItemsParsed += items.length;
    parsedItems.push(...items.map((item) => ({
      ...item,
      sourceFeed: source.sourceName || source.sourceId || source.rssUrl,
    })));
  }

  parsedItems.sort((left, right) => right.publishedAt - left.publishedAt);
  const {uniqueItems, inMemoryDuplicates} = prepareItemsForWrite(parsedItems);
  duplicatesSkipped += inMemoryDuplicates;
  itemsProcessed = uniqueItems.length;

  console.log(`Items selected for Firestore: ${itemsProcessed}/${Math.min(MAX_TOTAL_ITEMS, parsedItems.length)}`);

  const writeResult = await writeItemsToFirestore(db, uniqueItems, errors);
  newItemsSaved += writeResult.saved;
  duplicatesSkipped += writeResult.duplicates;

  console.log(`Total items parsed: ${totalItemsParsed}`);
  console.log(`Items processed: ${itemsProcessed}`);
  console.log(`New items saved: ${newItemsSaved}`);
  console.log(`Duplicates skipped: ${duplicatesSkipped}`);
  if (errors.length) {
    console.log("Errors by source:");
    errors.forEach((item) => console.log(`- ${item.source}: ${item.error}`));
  } else {
    console.log("Errors by source: none");
  }

  console.log("Final summary:");
  console.log(`- Total feeds: ${sources.length}`);
  console.log(`- Success feeds: ${successCount}`);
  console.log(`- Failed feeds: ${failCount}`);
  console.log(`- Feeds processed: ${feedsProcessed}/${sources.length}`);
  console.log(`- Total items parsed: ${totalItemsParsed}`);
  console.log(`- Items processed: ${itemsProcessed}`);
  console.log(`- Saved: ${newItemsSaved}`);
  console.log(`- Duplicates skipped: ${duplicatesSkipped}`);
  console.log(`- Errors: ${errors.length}`);
  console.log("RSS sync completed.");

  await admin.app().delete();
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    console.log("RSS sync completed.");
    process.exit(1);
  });
