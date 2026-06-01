window.simpleNewsBoardService = (function () {
  const DIRECT_FETCH_TIMEOUT_MS = 2500;
  const PROXY_FETCH_TIMEOUT_MS = 4500;
  const RSS_CACHE_TTL_MS = 3 * 60 * 1000;
  const rssCache = new Map();

  const RSS_FETCH_PROXIES = [
    (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`
  ];

  const SYMBOL_ALLOWLIST = new Set([
    'AAA', 'ACB', 'BCM', 'BID', 'BMP', 'BSI', 'BVH', 'BWE', 'CII', 'CMG',
    'CTD', 'CTG', 'DGC', 'DIG', 'DPM', 'DXG', 'EIB', 'FPT', 'GAS', 'GEX',
    'GMD', 'HAG', 'HCM', 'HDB', 'HPG', 'HSG', 'KBC', 'KDH', 'MBB', 'MSB',
    'MSN', 'MWG', 'NLG', 'NVL', 'OCB', 'PDR', 'PLX', 'PNJ', 'POW', 'PVD',
    'PVS', 'SAB', 'SHB', 'SSI', 'STB', 'TCB', 'TPB', 'VCB', 'VCG', 'VHM',
    'VIB', 'VIC', 'VJC', 'VND', 'VNM', 'VPB', 'VPI', 'VRE'
  ]);

  function parseRssDate(value) {
    if (!value) {
      return new Date();
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  }

  function formatExactTime(date) {
    return date.toLocaleString('vi-VN', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function decodeBrokenNumericEntities(value) {
    return (value || '').replace(/(^|[^&])#(\d{2,7});?/g, (match, prefix, code) => {
      const codePoint = Number(code);
      if (!Number.isFinite(codePoint) || codePoint < 32 || codePoint > 1114111) {
        return match;
      }
      try {
        return `${prefix}${String.fromCodePoint(codePoint)}`;
      } catch (error) {
        return match;
      }
    });
  }

  const WINDOWS_1252_REVERSE = new Map([
    [0x20AC, 0x80], [0x201A, 0x82], [0x0192, 0x83], [0x201E, 0x84],
    [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87], [0x02C6, 0x88],
    [0x2030, 0x89], [0x0160, 0x8A], [0x2039, 0x8B], [0x0152, 0x8C],
    [0x017D, 0x8E], [0x2018, 0x91], [0x2019, 0x92], [0x201C, 0x93],
    [0x201D, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
    [0x02DC, 0x98], [0x2122, 0x99], [0x0161, 0x9A], [0x203A, 0x9B],
    [0x0153, 0x9C], [0x017E, 0x9E], [0x0178, 0x9F]
  ]);

  function mojibakeScore(value) {
    return ((String(value || '').match(/[ÃÂÄÆáºá»]/g) || []).length * 2)
      + ((String(value || '').match(/�/g) || []).length * 5);
  }

  function decodeWindows1252AsUtf8(value) {
    const text = String(value || '');
    if (!/[ÃÂÄÆáºá»]/.test(text)) return text;
    const bytes = [];
    for (const char of text) {
      const code = char.codePointAt(0);
      if (WINDOWS_1252_REVERSE.has(code)) {
        bytes.push(WINDOWS_1252_REVERSE.get(code));
      } else if (code <= 255) {
        bytes.push(code);
      } else {
        return text;
      }
    }
    try {
      const decoded = new TextDecoder('utf-8', {fatal: false}).decode(new Uint8Array(bytes));
      return mojibakeScore(decoded) < mojibakeScore(text) && !decoded.includes('�') ? decoded : text;
    } catch (error) {
      return text;
    }
  }

  function fixMojibake(value) {
    let text = decodeWindows1252AsUtf8(value);
    for (let index = 0; index < 2 && mojibakeScore(text) > 0; index += 1) {
      const decoded = decodeWindows1252AsUtf8(text);
      if (decoded === text) break;
      text = decoded;
    }
    return text;
  }

  function stripHtml(value) {
    const temp = document.createElement('div');
    temp.innerHTML = decodeBrokenNumericEntities(value || '');
    return fixMojibake((temp.textContent || temp.innerText || '')
      .replace(/#(\d{2,7});?/g, (match, code) => {
        const codePoint = Number(code);
        if (!Number.isFinite(codePoint) || codePoint < 32 || codePoint > 1114111) {
          return match;
        }
        try {
          return String.fromCodePoint(codePoint);
        } catch (error) {
          return match;
        }
      })
      .replace(/\s+/g, ' ')
      .trim());
  }

  function normalizeText(value) {
    return stripHtml(value || '').replace(/\s+/g, ' ').trim();
  }

  function getChildText(node, localNames) {
    const names = Array.isArray(localNames) ? localNames : [localNames];
    const child = Array.from(node.children || []).find((element) => {
      const localName = (element.localName || element.nodeName || '').toLowerCase();
      const nodeName = (element.nodeName || '').toLowerCase();
      return names.some((name) => {
        const expected = name.toLowerCase();
        return localName === expected || nodeName === expected || nodeName.endsWith(`:${expected}`);
      });
    });
    return normalizeText(child?.textContent || '');
  }

  function getChildRawText(node, localNames) {
    const names = Array.isArray(localNames) ? localNames : [localNames];
    const child = Array.from(node.children || []).find((element) => {
      const localName = (element.localName || element.nodeName || '').toLowerCase();
      const nodeName = (element.nodeName || '').toLowerCase();
      return names.some((name) => {
        const expected = name.toLowerCase();
        return localName === expected || nodeName === expected || nodeName.endsWith(`:${expected}`);
      });
    });
    return child?.textContent || '';
  }

  function getAtomLink(node) {
    const links = Array.from(node.children || []).filter((element) => {
      const localName = (element.localName || element.nodeName || '').toLowerCase();
      return localName === 'link';
    });
    const alternate = links.find((element) => !element.getAttribute('rel') || element.getAttribute('rel') === 'alternate');
    const link = alternate || links[0];
    return normalizeText(link?.getAttribute('href') || link?.getAttribute('url') || '');
  }

  function getChildRawTextValue(node, localNames) {
    const names = Array.isArray(localNames) ? localNames : [localNames];
    const child = Array.from(node.children || []).find((element) => {
      const localName = (element.localName || element.nodeName || '').toLowerCase();
      const nodeName = (element.nodeName || '').toLowerCase();
      return names.some((name) => {
        const expected = name.toLowerCase();
        return localName === expected || nodeName === expected || nodeName.endsWith(`:${expected}`);
      });
    });
    return (child?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function getChildUrlAttribute(node, localNames) {
    const names = Array.isArray(localNames) ? localNames : [localNames];
    const child = Array.from(node.children || []).find((element) => {
      const localName = (element.localName || element.nodeName || '').toLowerCase();
      const nodeName = (element.nodeName || '').toLowerCase();
      return names.some((name) => {
        const expected = name.toLowerCase();
        return localName === expected || nodeName === expected || nodeName.endsWith(`:${expected}`);
      });
    });
    return normalizeText(child?.getAttribute('href') || child?.getAttribute('url') || '');
  }

  function getFirstLinkFromHtml(value) {
    const temp = document.createElement('div');
    temp.innerHTML = value || '';
    return normalizeText(temp.querySelector('a[href]')?.getAttribute('href') || '');
  }

  function isLikelyUrl(value) {
    return /^https?:\/\//i.test(normalizeText(value));
  }

  function resolveUrl(value, baseUrl) {
    const url = normalizeText(value);
    if (!url) {
      return '';
    }
    try {
      return new URL(url, baseUrl).href;
    } catch (error) {
      return url;
    }
  }

  function isSameUrl(left, right) {
    if (!left || !right) {
      return false;
    }
    return normalizeKey(left) === normalizeKey(right);
  }

  function isFeedUrl(value, sourceUrl) {
    const url = normalizeText(value);
    return isSameUrl(url, sourceUrl)
      || /\.rss(?:$|[?#])/i.test(url)
      || /\/News\/NewsByCateFeed\//i.test(url);
  }

  function pickItemLink(itemNode, rawDescription, guid, sourceUrl) {
    const candidates = [
      getChildRawTextValue(itemNode, ['origLink', 'link']),
      getAtomLink(itemNode),
      getChildUrlAttribute(itemNode, ['link', 'enclosure']),
      guid,
      getFirstLinkFromHtml(rawDescription)
    ];

    const resolved = candidates
      .map((candidate) => resolveUrl(candidate, sourceUrl))
      .filter((candidate) => candidate && isLikelyUrl(candidate) && !isFeedUrl(candidate, sourceUrl));

    return resolved[0] || '';
  }

  function stableHash(value) {
    let hash = 0;
    const input = String(value || '');
    for (let index = 0; index < input.length; index += 1) {
      hash = (hash * 31 + input.charCodeAt(index)) >>> 0;
    }
    return hash.toString(36);
  }

  function normalizeKey(value) {
    return normalizeText(value).toLowerCase().replace(/\/$/, '');
  }

  function createStableNewsId(source, item) {
    const seed = normalizeKey(item.link || item.guid || item.title);
    return `${source.sourceId}_${stableHash(seed)}`;
  }

  function detectSymbols(text) {
    const matches = normalizeText(text).match(/\b[A-Z]{3}\b/g) || [];
    return Array.from(new Set(matches.filter((symbol) => SYMBOL_ALLOWLIST.has(symbol))));
  }

  function unique(values) {
    return Array.from(new Set((values || []).filter(Boolean)));
  }

  function compactTicker(value) {
    return String(value || '').trim().toUpperCase();
  }

  function normalizeTickerList(values, limit) {
    return unique((values || [])
      .map(compactTicker)
      .filter((ticker) => /^[A-Z0-9]{2,10}$/.test(ticker)))
      .slice(0, limit);
  }

  function confidenceFromGraph(value) {
    const number = Number(value || 0);
    if (!Number.isFinite(number)) {
      return 0;
    }
    return Math.max(0, Math.min(100, number <= 1 ? Math.round(number * 100) : Math.round(number)));
  }

  function traceTargetTitle(title = '') {
    const normalized = normalizeText(title);
    return normalized.includes('pet fair') || normalized.includes('gia usd hom nay 26.5.2026');
  }

  function compactTraceGraph(graph) {
    if (!graph) return null;
    return {
      finalSector: graph.finalSector || graph.sector || '',
      finalTickers: normalizeTickerList([
        ...(Array.isArray(graph.finalTickers) ? graph.finalTickers : []),
        ...(Array.isArray(graph.primaryTickers) ? graph.primaryTickers : []),
        graph.primaryTicker,
        ...(Array.isArray(graph.relatedStocks) ? graph.relatedStocks : []),
        ...(Array.isArray(graph.watchlistStocks) ? graph.watchlistStocks : [])
      ], 20),
      sector: graph.sector || '',
      finalDecidedBy: graph.finalDecidedBy || '',
      sectorEvidenceCount: graph.sectorEvidenceCount || 0,
      sectorRejectedReason: graph.sectorRejectedReason || ''
    };
  }

  function topLevelMarketGraph(item = {}) {
    if (!item || !(item.finalDecidedBy || item.analyzedWithRulesVersion || item.sectorEvidenceCount !== undefined || item.finalSector || item.sector)) {
      return null;
    }
    return {
      finalSector: item.finalSector || item.sector || '',
      finalTickers: normalizeTickerList([
        ...(Array.isArray(item.finalTickers) ? item.finalTickers : []),
        ...(Array.isArray(item.primaryTickers) ? item.primaryTickers : []),
        item.primaryTicker,
        ...(Array.isArray(item.relatedStocks) ? item.relatedStocks : []),
        ...(Array.isArray(item.watchlistStocks) ? item.watchlistStocks : [])
      ], 20),
      sector: item.finalSector || item.sector || '',
      eventType: item.eventType || '',
      primaryTicker: item.primaryTicker || null,
      primaryTickers: Array.isArray(item.primaryTickers) ? item.primaryTickers : [],
      relatedStocks: Array.isArray(item.relatedStocks) ? item.relatedStocks : [],
      watchlistStocks: Array.isArray(item.watchlistStocks) ? item.watchlistStocks : [],
      tickerDetails: Array.isArray(item.tickerDetails) ? item.tickerDetails : [],
      sentiment: item.sentiment || item.marketSentiment || '',
      impactLevel: item.impactLevel || '',
      confidence: item.confidence ?? item.confidenceScore ?? 0,
      matchedBy: Array.isArray(item.matchedBy) ? item.matchedBy : [],
      reason: item.reason || item.reasonShort || '',
      horizon: item.horizon || item.impactHorizon || '',
      finalDecidedBy: item.finalDecidedBy || 'top_level_market_graph',
      sectorEvidenceCount: item.sectorEvidenceCount || 0,
      sectorRejectedReason: item.sectorRejectedReason || ''
    };
  }

  function traceService(item, stage, payload) {
    if (!traceTargetTitle(item?.title || '')) return;
    // eslint-disable-next-line no-console
    console.debug(`[MI_TRACE:${stage}]`, { title: item.title || '', ...payload });
  }

  function deriveMarketIntelligence(item) {
    const savedGraph = item.marketGraph || item.marketIntelligence || topLevelMarketGraph(item);
    if (savedGraph) {
      const primaryTickers = normalizeTickerList([
        ...(Array.isArray(savedGraph.primaryTickers) ? savedGraph.primaryTickers : []),
        savedGraph.primaryTicker
      ], 2);
      const relatedStocks = normalizeTickerList(savedGraph.relatedStocks || [], 5)
        .filter((ticker) => !primaryTickers.includes(ticker));
      const watchlistStocks = normalizeTickerList(savedGraph.watchlistStocks || [], 10)
        .filter((ticker) => !primaryTickers.includes(ticker) && !relatedStocks.includes(ticker));
      const output = {
        primaryTickers,
        primaryTicker: primaryTickers[0] || null,
        relatedStocks,
        watchlistStocks,
        tickerDetails: Array.isArray(savedGraph.tickerDetails) ? savedGraph.tickerDetails : [],
        finalSector: savedGraph.finalSector || savedGraph.sector || '',
        finalTickers: normalizeTickerList([
          ...(Array.isArray(savedGraph.finalTickers) ? savedGraph.finalTickers : []),
          ...primaryTickers,
          ...relatedStocks,
          ...watchlistStocks
        ], 20),
        eventType: savedGraph.eventType || item.eventType || '',
        impactLevel: savedGraph.impactLevel || item.impactLevel || '',
        sentiment: savedGraph.sentiment || item.sentiment || item.marketSentiment || '',
        horizon: savedGraph.horizon || item.horizon || item.impactHorizon || '',
        confidence: confidenceFromGraph(savedGraph.confidence ?? item.confidence ?? item.confidenceScore),
        matchedBy: Array.isArray(savedGraph.matchedBy) ? savedGraph.matchedBy : [],
        reason: savedGraph.reason || item.reason || item.reasonShort || '',
        tickerCoverageLevel: savedGraph.tickerCoverageLevel || (primaryTickers.length ? 'direct' : relatedStocks.length ? 'inferred' : watchlistStocks.length ? 'watchlist_only' : 'none'),
        tickerCoverageReason: savedGraph.tickerCoverageReason || item.tickerCoverageReason || ''
      };
      traceService(item, 'after_simpleNewsBoardService', {
        displaySector: output.finalSector,
        displayTickers: output.finalTickers,
        sector: output.finalSector,
        tickers: output.finalTickers,
        marketGraph: compactTraceGraph(savedGraph)
      });
      return output;
    }

    return {
      primaryTickers: [],
      primaryTicker: null,
      relatedStocks: [],
      watchlistStocks: [],
      tickerDetails: [],
      eventType: '',
      impactLevel: '',
      sentiment: '',
      horizon: '',
      confidence: 0,
      matchedBy: [],
      reason: '',
      tickerCoverageLevel: 'none',
      tickerCoverageReason: ''
    };
  }

  function formatDisplayTime(date) {
    const now = new Date();
    const diffMs = now - date;
    const diffMinutes = Math.floor(diffMs / 60000);
    if (diffMinutes < 2) {
      return 'vừa xong';
    }
    if (diffMinutes < 60) {
      return `${diffMinutes} phút trước`;
    }
    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) {
      return `${diffHours} giờ trước`;
    }
    return date.toLocaleString('vi-VN', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  async function fetchText(url, timeoutMs) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

    let response;
    try {
      response = await fetch(url, { signal: controller.signal });
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error(`RSS fetch timeout sau ${Math.round(timeoutMs / 1000)}s`);
      }
      throw error;
    } finally {
      window.clearTimeout(timeoutId);
    }

    if (!response.ok) {
      throw new Error(`RSS fetch failed: ${response.status} ${response.statusText}`);
    }
    return await response.text();
  }

  async function fetchRss(url) {
    const cached = rssCache.get(url);
    if (cached && Date.now() - cached.fetchedAt < RSS_CACHE_TTL_MS) {
      return cached.xmlText;
    }

    const candidates = [
      { url, timeoutMs: DIRECT_FETCH_TIMEOUT_MS },
      ...RSS_FETCH_PROXIES.map((buildProxyUrl) => ({
        url: buildProxyUrl(url),
        timeoutMs: PROXY_FETCH_TIMEOUT_MS
      }))
    ];

    try {
      const xmlText = await Promise.any(
        candidates.map((candidate) => fetchText(candidate.url, candidate.timeoutMs))
      );
      rssCache.set(url, {
        fetchedAt: Date.now(),
        xmlText
      });
      return xmlText;
    } catch (error) {
      const errors = error.errors || [error];
      const message = errors.map((item) => item.message || String(item)).join(' | ');
      throw new Error(message || 'RSS fetch failed');
    }
  }

  function parseRssXml(xmlText, sourceUrl = '') {
    const parser = new DOMParser();
    const xml = parser.parseFromString(xmlText, 'application/xml');
    const parseError = xml.querySelector('parsererror');
    if (parseError) {
      throw new Error('Không thể phân tích RSS XML');
    }

    const rssItems = Array.from(xml.getElementsByTagName('item'));
    const atomEntries = Array.from(xml.getElementsByTagName('entry'));
    const nodes = rssItems.length ? rssItems : atomEntries;

    return nodes.map((item) => {
      const title = getChildText(item, 'title') || 'Không có tiêu đề';
      const rawDescription = getChildRawText(item, ['description', 'summary']);
      const rawContent = getChildRawText(item, ['encoded', 'content']) || rawDescription;
      const guid = getChildText(item, ['guid', 'id']);
      const link = pickItemLink(item, rawDescription, guid, sourceUrl);
      const updated = getChildText(item, ['updated', 'modified']);
      const pubDate = getChildText(item, ['pubDate', 'published', 'date']) || updated;
      return {
        title,
        link,
        guid,
        description: stripHtml(rawDescription),
        rawDescription,
        contentText: stripHtml(rawContent),
        rawContent,
        hasExplicitDate: Boolean(pubDate),
        pubDate: parseRssDate(pubDate),
        updated: updated ? parseRssDate(updated) : null
      };
    });
  }

  function filterLast48h(items) {
    const threshold = Date.now() - 48 * 60 * 60 * 1000;
    return items.filter((item) => {
      const publishedAt = item.publishedAt || item.pubDate;
      return publishedAt instanceof Date && publishedAt.getTime() >= threshold;
    });
  }

  function filterLast24h(items) {
    return filterLast48h(items);
  }

  function normalizeNewsItem(item, source) {
    const publishedAt = item.pubDate instanceof Date ? item.pubDate : parseRssDate(item.pubDate || item.updated);
    const summary = item.description || stripHtml(item.rawDescription);
    const contentText = item.contentText || summary;
    const symbolText = `${item.title || ''} ${summary || ''}`;
    const baseItem = {
      newsId: createStableNewsId(source, item),
      title: item.title,
      sourceName: fixMojibake(source.sourceName),
      sourceUrl: item.link || '#',
      hasDetailLink: Boolean(item.link),
      hasExplicitDate: item.hasExplicitDate !== false,
      publishedAt,
      publishedAtText: formatExactTime(publishedAt),
      displayTime: formatDisplayTime(publishedAt),
      summary: fixMojibake(summary),
      contentText: fixMojibake(contentText),
      rawDescription: item.rawDescription || '',
      rawContent: item.rawContent || item.rawDescription || '',
      symbols: detectSymbols(symbolText),
      fetchedAt: new Date(),
      sourceCategory: source.category || 'market',
      category: source.category || 'market',
      status: 'published',
      group: source.group || 'international'
    };
    const intelligence = deriveMarketIntelligence(baseItem);
    return {
      ...baseItem,
      ...intelligence,
      symbols: unique([...(baseItem.symbols || []), ...(intelligence.primaryTickers || []), ...(intelligence.relatedStocks || [])]).slice(0, 6)
    };
  }

  function removeDuplicateNews(items) {
    const seen = new Set();
    return items.filter((item) => {
      const link = item.sourceUrl && item.sourceUrl !== '#' ? item.sourceUrl : item.link;
      const key = normalizeKey(link || item.newsId);
      const dedupeKey = key || item.newsId;
      if (!dedupeKey || seen.has(dedupeKey)) {
        return false;
      }
      seen.add(dedupeKey);
      seen.add(item.newsId);
      return true;
    });
  }

  function sortByPublishedAtDesc(items) {
    return items.slice().sort((a, b) => b.publishedAt - a.publishedAt);
  }

  return {
    createStableNewsId,
    detectSymbols,
    fetchRss,
    filterLast24h,
    filterLast48h,
    deriveMarketIntelligence,
    normalizeNewsItem,
    parseRssXml,
    removeDuplicateNews,
    sortByPublishedAtDesc,
    stripHtml,
    fixMojibake
  };
})();
