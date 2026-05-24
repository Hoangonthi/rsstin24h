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

  function stripHtml(value) {
    const temp = document.createElement('div');
    temp.innerHTML = decodeBrokenNumericEntities(value || '');
    return (temp.textContent || temp.innerText || '')
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
      .trim();
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

  function filterLast24h(items) {
    const threshold = Date.now() - 24 * 60 * 60 * 1000;
    return items.filter((item) => {
      const publishedAt = item.publishedAt || item.pubDate;
      return publishedAt instanceof Date && publishedAt.getTime() >= threshold;
    });
  }

  function normalizeNewsItem(item, source) {
    const publishedAt = item.pubDate instanceof Date ? item.pubDate : parseRssDate(item.pubDate || item.updated);
    const summary = item.description || stripHtml(item.rawDescription);
    const contentText = item.contentText || summary;
    const symbolText = `${item.title || ''} ${summary || ''}`;
    return {
      newsId: createStableNewsId(source, item),
      title: item.title,
      sourceName: source.sourceName,
      sourceUrl: item.link || '#',
      hasDetailLink: Boolean(item.link),
      hasExplicitDate: item.hasExplicitDate !== false,
      publishedAt,
      publishedAtText: formatExactTime(publishedAt),
      displayTime: formatDisplayTime(publishedAt),
      summary,
      contentText,
      rawDescription: item.rawDescription || '',
      rawContent: item.rawContent || item.rawDescription || '',
      symbols: detectSymbols(symbolText),
      fetchedAt: new Date(),
      sourceCategory: source.category || 'market',
      category: source.category || 'market',
      status: 'published',
      group: source.group || 'international'
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
    normalizeNewsItem,
    parseRssXml,
    removeDuplicateNews,
    sortByPublishedAtDesc,
    stripHtml
  };
})();
