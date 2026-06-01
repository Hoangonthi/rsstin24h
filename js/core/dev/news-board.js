(function () {
  const ADMIN_EMAILS = ['vvhoangvn@gmail.com'];
  const META_FETCH_PROXIES = [
    (url) => url,
    (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`
  ];

  const elements = {
    statusLine: document.getElementById('status-line'),
    domesticList: document.getElementById('domestic-news-list'),
    internationalList: document.getElementById('international-news-list'),
    domesticCount: document.getElementById('domestic-count'),
    internationalCount: document.getElementById('international-count'),
    loadButton: document.getElementById('load-news-btn'),
    refreshButton: document.getElementById('refresh-news-btn'),
    mockButton: document.getElementById('mock-news-btn'),
    signinButton: document.getElementById('admin-signin-btn'),
    signoutButton: document.getElementById('admin-signout-btn'),
    appTabs: Array.from(document.querySelectorAll('[data-view]')),
    boardPanel: document.getElementById('board-panel'),
    manualPanel: document.getElementById('manual-panel'),
    categoryTabs: Array.from(document.querySelectorAll('[data-category]')),
    clearFiltersButton: document.getElementById('clear-filters-btn'),
    manual: {
      form: document.getElementById('manual-news-form'),
      id: document.getElementById('manual-news-id'),
      url: document.getElementById('manual-url'),
      title: document.getElementById('manual-title'),
      source: document.getElementById('manual-source'),
      publishedAt: document.getElementById('manual-published-at'),
      summary: document.getElementById('manual-summary'),
      tickers: document.getElementById('manual-tickers'),
      sectors: document.getElementById('manual-sectors'),
      adminNote: document.getElementById('manual-admin-note'),
      status: document.getElementById('manual-status'),
      analysis: document.getElementById('manual-analysis-preview'),
      list: document.getElementById('manual-news-list'),
      count: document.getElementById('manual-count'),
      paste: document.getElementById('manual-paste-btn'),
      fetchMeta: document.getElementById('manual-fetch-meta-btn'),
      saveDraft: document.getElementById('manual-save-draft-btn'),
      reanalyze: document.getElementById('manual-reanalyze-btn'),
      reset: document.getElementById('manual-reset-btn')
    },
    filters: {
      primaryTicker: document.getElementById('filter-primary-ticker'),
      relatedTicker: document.getElementById('filter-related-ticker'),
      eventType: document.getElementById('filter-event-type'),
      impactLevel: document.getElementById('filter-impact-level'),
      sentiment: document.getElementById('filter-sentiment'),
      horizon: document.getElementById('filter-horizon')
    }
  };

  let db = null;
  let currentUser = null;
  let currentCategory = 'all';
  let manualUnsubscribe = null;
  let currentFilters = {
    primaryTicker: '',
    relatedTicker: '',
    eventType: '',
    impactLevel: '',
    sentiment: '',
    horizon: ''
  };
  let currentNews = {
    rss: [],
    manual: [],
    domestic: [],
    international: []
  };

  function updateStatus(message, isError) {
    elements.statusLine.textContent = message;
    elements.statusLine.style.color = isError ? '#f97316' : '#9ca3af';
  }

  function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value || '';
    return div.innerHTML;
  }

  function compactTicker(value) {
    return String(value || '').trim().toUpperCase();
  }

  function unique(values) {
    return Array.from(new Set((values || []).filter(Boolean)));
  }

  function splitList(value, formatter = (item) => item) {
    return unique(String(value || '')
      .split(/[\s,;|/]+/)
      .map((item) => formatter(item.trim()))
      .filter(Boolean));
  }

  function normalizeList(values) {
    return unique((values || []).map(compactTicker).filter(Boolean));
  }

  function normalizeUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
      const url = new URL(raw);
      url.hash = '';
      url.hostname = url.hostname.toLowerCase();
      return url.href.replace(/\/$/, '');
    } catch (error) {
      return raw.replace(/\/$/, '');
    }
  }

  function formatLabel(value) {
    return String(value || '').replace(/_/g, ' ').trim() || '-';
  }

  function fixText(value) {
    return window.simpleNewsBoardService?.fixMojibake
      ? window.simpleNewsBoardService.fixMojibake(value)
      : String(value || '');
  }

  function toDate(value) {
    if (!value) return null;
    if (typeof value.toDate === 'function') return value.toDate();
    if (Number.isFinite(value.seconds)) return new Date(value.seconds * 1000);
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  function toDatetimeLocalValue(value) {
    const date = toDate(value) || new Date();
    const pad = (number) => String(number).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function formatExactTime(date) {
    const safeDate = toDate(date) || new Date();
    return safeDate.toLocaleString('vi-VN', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function formatDisplayTime(date) {
    const safeDate = toDate(date) || new Date();
    const diffMinutes = Math.floor((Date.now() - safeDate.getTime()) / 60000);
    if (diffMinutes < 2) return 'vừa xong';
    if (diffMinutes < 60) return `${diffMinutes} phút trước`;
    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) return `${diffHours} giờ trước`;
    return safeDate.toLocaleString('vi-VN', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function compactMatchedBy(values) {
    const list = Array.isArray(values) ? values : [];
    return list.length ? list.join(', ') : '-';
  }

  function ensureFirebaseInitialized() {
    if (!window.firebase || !firebase.firestore || !firebase.auth) return false;
    if (!firebase.apps.length) {
      firebase.initializeApp(window.NEW24H_FIREBASE_CONFIG);
    }
    db = firebase.firestore();
    return true;
  }

  function isAdmin() {
    return Boolean(currentUser && ADMIN_EMAILS.includes(currentUser.email));
  }

  function adminLoginMessage(user) {
    if (!user) return 'Chưa đăng nhập admin. Public chỉ thấy tin thủ công đã published.';
    if (!ADMIN_EMAILS.includes(user.email)) {
      return `Tài khoản ${user.email || 'không rõ email'} chưa có quyền admin. Hãy đăng xuất rồi chọn ${ADMIN_EMAILS.join(', ')}.`;
    }
    return `Admin: ${user.email}`;
  }

  function mapImpactLevel(value) {
    const raw = String(value || '').toLowerCase();
    if (['high', 'hot'].includes(raw)) return 'high';
    if (['watch', 'medium', 'normal'].includes(raw)) return 'normal';
    return raw === 'low' ? 'low' : 'normal';
  }

  function analyzeManualForm() {
    const manualTickers = splitList(elements.manual.tickers.value, compactTicker).filter((ticker) => /^[A-Z0-9]{2,10}$/.test(ticker));
    const manualSectors = splitList(elements.manual.sectors.value, (value) => value.trim()).slice(0, 12);
    const item = {
      title: elements.manual.title.value.trim(),
      summary: elements.manual.summary.value.trim(),
      contentText: elements.manual.summary.value.trim(),
      sourceName: elements.manual.source.value.trim() || 'Manual',
      sourceCategory: 'manual',
      category: 'manual',
      tickers: manualTickers,
      primaryTickers: manualTickers.slice(0, 2),
      relatedStocks: manualTickers.slice(2, 7),
      sectors: manualSectors
    };
    const intelligence = window.simpleNewsBoardService?.deriveMarketIntelligence
      ? window.simpleNewsBoardService.deriveMarketIntelligence(item)
      : {};
    const tickers = unique([
      ...manualTickers,
      ...(intelligence.primaryTickers || []),
      ...(intelligence.relatedStocks || []),
      ...(intelligence.watchlistStocks || [])
    ]).slice(0, 20);
    const sectors = unique([
      ...manualSectors,
      intelligence.finalSector,
      intelligence.sector
    ].filter(Boolean)).slice(0, 12);
    const analysis = {
      ...intelligence,
      tickers,
      sectors,
      primaryTickers: unique([...(intelligence.primaryTickers || []), ...manualTickers.slice(0, 2)]).slice(0, 2),
      relatedStocks: unique([...(intelligence.relatedStocks || []), ...manualTickers.slice(2)]).slice(0, 8),
      eventType: intelligence.eventType || '',
      sentiment: ['positive', 'neutral', 'negative'].includes(intelligence.sentiment) ? intelligence.sentiment : 'neutral',
      impactLevel: mapImpactLevel(intelligence.impactLevel),
      horizon: intelligence.horizon || ''
    };
    renderManualAnalysis(analysis);
    return analysis;
  }

  function renderManualAnalysis(analysis) {
    elements.manual.analysis.innerHTML = `
      <strong>Phân tích:</strong>
      Event ${escapeHtml(analysis.eventType || '-')} ·
      Sentiment ${escapeHtml(analysis.sentiment || 'neutral')} ·
      Impact ${escapeHtml(analysis.impactLevel || 'normal')} ·
      Mã ${escapeHtml((analysis.tickers || []).join(', ') || '-')} ·
      Ngành ${escapeHtml((analysis.sectors || []).join(', ') || '-')}
    `;
  }

  function manualFormPayload() {
    const url = normalizeUrl(elements.manual.url.value);
    const publishedAt = elements.manual.publishedAt.value
      ? new Date(elements.manual.publishedAt.value)
      : new Date();
    const analysis = analyzeManualForm();
    return {
      url,
      title: fixText(elements.manual.title.value.trim()),
      source: fixText(elements.manual.source.value.trim()),
      sourceName: fixText(elements.manual.source.value.trim()),
      publishedAt: firebase.firestore.Timestamp.fromDate(Number.isNaN(publishedAt.getTime()) ? new Date() : publishedAt),
      summary: fixText(elements.manual.summary.value.trim()),
      content: fixText(elements.manual.summary.value.trim()),
      contentText: fixText(elements.manual.summary.value.trim()),
      tickers: analysis.tickers || [],
      sectors: analysis.sectors || [],
      primaryTickers: analysis.primaryTickers || [],
      relatedStocks: analysis.relatedStocks || [],
      watchlistStocks: analysis.watchlistStocks || [],
      tickerDetails: Array.isArray(analysis.tickerDetails) ? analysis.tickerDetails : [],
      eventType: analysis.eventType || '',
      sentiment: analysis.sentiment || 'neutral',
      impactLevel: analysis.impactLevel || 'normal',
      horizon: analysis.horizon || '',
      confidence: analysis.confidence || 0,
      matchedBy: Array.isArray(analysis.matchedBy) ? analysis.matchedBy : [],
      reason: analysis.reason || '',
      adminNote: fixText(elements.manual.adminNote.value.trim()),
      status: elements.manual.status.value || 'draft',
      isManual: true,
      uiBadge: 'Thủ công',
      category: 'manual',
      group: 'domestic',
      sourceUrl: url,
      link: url,
      originalUrl: url,
      canonicalUrl: url,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
  }

  function normalizeManualItem(doc) {
    const data = doc.data ? doc.data() : doc;
    const publishedAt = toDate(data.publishedAt) || toDate(data.createdAt) || new Date();
    return enrichItem({
      ...data,
      id: doc.id || data.id,
      newsId: doc.id || data.newsId,
      title: fixText(data.title || ''),
      source: fixText(data.source || data.sourceName || 'Manual'),
      sourceName: fixText(data.source || data.sourceName || 'Manual'),
      sourceUrl: data.url || data.sourceUrl || data.link || '#',
      hasDetailLink: Boolean(data.url || data.sourceUrl || data.link),
      hasExplicitDate: true,
      publishedAt,
      publishedAtText: formatExactTime(publishedAt),
      displayTime: formatDisplayTime(publishedAt),
      summary: fixText(data.summary || data.content || ''),
      contentText: fixText(data.content || data.summary || ''),
      fetchedAt: toDate(data.createdAt) || new Date(),
      sourceCategory: 'manual',
      category: 'manual',
      group: data.group || 'domestic',
      status: data.status || 'draft',
      isManual: true,
      uiBadge: 'Thủ công'
    });
  }

  async function duplicateExists(url, currentId = '') {
    const normalized = normalizeUrl(url);
    if (!normalized || !db) return false;
    const manualSnapshot = await db.collection('manual_news').where('url', '==', normalized).limit(2).get();
    if (manualSnapshot.docs.some((doc) => doc.id !== currentId)) return true;
    const fields = ['url', 'canonicalUrl', 'originalUrl', 'link'];
    const snapshots = await Promise.all(fields.map((field) => (
      db.collection('news').where(field, '==', normalized).limit(1).get().catch(() => ({ empty: true }))
    )));
    return snapshots.some((snapshot) => !snapshot.empty);
  }

  async function saveManualNews(event) {
    event.preventDefault();
    if (!db || !isAdmin()) {
      updateStatus('Cần đăng nhập admin để lưu tin thủ công.', true);
      return;
    }
    const submitterId = event.submitter?.id || '';
    if (submitterId === 'manual-save-btn') {
      elements.manual.status.value = 'published';
    }
    if (elements.manual.url.value.trim() && (!elements.manual.title.value.trim() || !elements.manual.source.value.trim())) {
      await fetchManualMeta().catch(() => {});
    }
    const currentId = elements.manual.id.value.trim();
    const payload = manualFormPayload();
    if (!payload.url || !payload.title || !payload.source) {
      updateStatus('Nhập link, tiêu đề và nguồn trước khi lưu.', true);
      return;
    }
    if (await duplicateExists(payload.url, currentId)) {
      updateStatus('Tin này đã có', true);
      return;
    }
    if (currentId) {
      await db.collection('manual_news').doc(currentId).set(payload, { merge: true });
      updateStatus('Đã cập nhật tin thủ công.', false);
    } else {
      const docRef = await db.collection('manual_news').add({
        ...payload,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        createdBy: currentUser.email || currentUser.uid || 'admin'
      });
      elements.manual.id.value = docRef.id;
      updateStatus('Đã lưu tin thủ công.', false);
    }
  }

  async function fetchText(url, timeoutMs = 5500) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  function parseMeta(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const meta = (selector) => doc.querySelector(selector)?.getAttribute('content')?.trim() || '';
    return {
      title: fixText(meta('meta[property="og:title"]') || doc.querySelector('title')?.textContent?.trim() || ''),
      summary: fixText(meta('meta[property="og:description"]') || meta('meta[name="description"]') || ''),
      source: fixText(meta('meta[property="og:site_name"]') || '')
    };
  }

  async function fetchManualMeta() {
    const url = normalizeUrl(elements.manual.url.value);
    if (!url) {
      updateStatus('Dán link trước khi fetch meta.', true);
      return;
    }
    updateStatus('Đang fetch title/meta...', false);
    let lastError = null;
    for (const buildUrl of META_FETCH_PROXIES) {
      try {
        const html = await fetchText(buildUrl(url));
        const meta = parseMeta(html);
        if (meta.title && !elements.manual.title.value.trim()) elements.manual.title.value = meta.title;
        if (meta.summary && !elements.manual.summary.value.trim()) elements.manual.summary.value = meta.summary;
        if (meta.source && !elements.manual.source.value.trim()) elements.manual.source.value = meta.source;
        if (!elements.manual.source.value.trim()) elements.manual.source.value = new URL(url).hostname.replace(/^www\./, '');
        analyzeManualForm();
        updateStatus('Đã fetch meta. Nếu thiếu dữ liệu, nhập tay phần còn lại.', false);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    updateStatus(`Không fetch được meta: ${lastError?.message || lastError}. Có thể nhập tay.`, true);
  }

  function resetManualForm() {
    elements.manual.form.reset();
    elements.manual.id.value = '';
    elements.manual.status.value = 'published';
    elements.manual.publishedAt.value = toDatetimeLocalValue(new Date());
    elements.manual.analysis.textContent = 'Chưa phân tích.';
  }

  function fillManualForm(item) {
    elements.manual.id.value = item.id || '';
    elements.manual.url.value = item.url || item.sourceUrl || '';
    elements.manual.title.value = item.title || '';
    elements.manual.source.value = item.source || item.sourceName || '';
    elements.manual.publishedAt.value = toDatetimeLocalValue(item.publishedAt);
    elements.manual.summary.value = item.summary || item.content || '';
    elements.manual.tickers.value = (item.tickers || item.primaryTickers || []).join(', ');
    elements.manual.sectors.value = (item.sectors || []).join(', ');
    elements.manual.adminNote.value = item.adminNote || '';
    elements.manual.status.value = item.status || 'draft';
    analyzeManualForm();
    applyView('manual');
  }

  async function updateManualStatus(id, status) {
    if (!db || !isAdmin()) return;
    await db.collection('manual_news').doc(id).set({
      status,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  }

  async function deleteManualNews(id) {
    if (!db || !isAdmin()) return;
    if (!window.confirm('Xóa tin thủ công này?')) return;
    await db.collection('manual_news').doc(id).delete();
  }

  function renderManualList() {
    const items = currentNews.manual.slice().sort((a, b) => (toDate(b.publishedAt) || 0) - (toDate(a.publishedAt) || 0));
    elements.manual.count.textContent = `${items.length} tin`;
    elements.manual.list.innerHTML = items.length ? items.map((item) => `
      <li class="manual-list-item">
        <strong>${escapeHtml(item.title)}</strong>
        <div class="manual-meta">
          <span>${escapeHtml(item.source || item.sourceName || 'Manual')}</span>
          <span>${escapeHtml(item.status || 'draft')}</span>
          <span>${escapeHtml(formatExactTime(item.publishedAt))}</span>
          <span>${escapeHtml((item.tickers || []).join(', ') || '-')}</span>
        </div>
        <div class="manual-item-actions">
          <button type="button" data-manual-edit="${escapeHtml(item.id)}">Sửa</button>
          <button type="button" data-manual-status="${escapeHtml(item.id)}" data-status="published">Publish</button>
          <button type="button" data-manual-status="${escapeHtml(item.id)}" data-status="hidden">Ẩn</button>
          <button type="button" data-manual-delete="${escapeHtml(item.id)}">Xóa</button>
        </div>
      </li>
    `).join('') : '<li class="manual-list-item">Chưa có tin thủ công.</li>';
  }

  function subscribeManualNews() {
    if (!db) return;
    if (manualUnsubscribe) manualUnsubscribe();
    let query = db.collection('manual_news').orderBy('publishedAt', 'desc').limit(120);
    if (!isAdmin()) query = db.collection('manual_news').where('status', '==', 'published').orderBy('publishedAt', 'desc').limit(80);
    manualUnsubscribe = query.onSnapshot((snapshot) => {
      currentNews.manual = snapshot.docs.map(normalizeManualItem);
      renderManualList();
      rebuildNewsState();
      renderNewsColumns();
    }, (error) => {
      updateStatus(`Không tải được manual_news: ${error.message}`, true);
    });
  }

  function enrichItem(item) {
    if (!window.simpleNewsBoardService?.deriveMarketIntelligence) {
      return item;
    }
    const intelligence = item.eventType || item.isManual
      ? window.simpleNewsBoardService.deriveMarketIntelligence(item)
      : window.simpleNewsBoardService.deriveMarketIntelligence(item);
    return {
      ...item,
      ...(!item.eventType ? intelligence : {}),
      symbols: unique([...(item.symbols || []), ...(item.tickers || []), ...(item.primaryTickers || []), ...(intelligence.primaryTickers || []), ...(intelligence.relatedStocks || [])]).slice(0, 10)
    };
  }

  function rebuildNewsState() {
    const enrichedItems = [...currentNews.rss, ...currentNews.manual].map(enrichItem);
    currentNews.domestic = enrichedItems.filter((item) => item.group === 'domestic');
    currentNews.international = enrichedItems.filter((item) => item.group === 'international');
    currentNews.domestic = simpleNewsBoardService.sortByPublishedAtDesc(currentNews.domestic);
    currentNews.international = simpleNewsBoardService.sortByPublishedAtDesc(currentNews.international);
    updateFilterOptions();
  }

  function applyView(view) {
    elements.appTabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.view === view));
    elements.boardPanel.hidden = view !== 'board';
    elements.manualPanel.hidden = view !== 'manual';
  }

  function applyCategoryTab(category) {
    currentCategory = category;
    elements.categoryTabs.forEach((tab) => {
      tab.classList.toggle('active', tab.dataset.category === category);
    });
    renderNewsColumns();
  }

  function updateFilterOptions() {
    const items = [...currentNews.domestic, ...currentNews.international];
    const optionSets = {
      eventType: unique(items.map((item) => item.eventType)).sort(),
      impactLevel: unique(items.map((item) => item.impactLevel)).sort(),
      sentiment: unique(items.map((item) => item.sentiment)).sort(),
      horizon: unique(items.map((item) => item.horizon)).sort()
    };

    Object.entries(optionSets).forEach(([key, values]) => {
      const select = elements.filters[key];
      const previous = select.value;
      select.innerHTML = '<option value="">Tất cả</option>' + values
        .map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(formatLabel(value))}</option>`)
        .join('');
      select.value = values.includes(previous) ? previous : '';
      currentFilters[key] = select.value;
    });
  }

  function badge(label, value, className = '') {
    if (!value) return '';
    return `<span class="info-badge ${className}"><span>${escapeHtml(label)}</span>${escapeHtml(formatLabel(value))}</span>`;
  }

  function tickerTooltip(detail) {
    return [
      `ticker: ${detail.ticker || '-'}`,
      `role: ${detail.role || '-'}`,
      `confidence: ${detail.confidence ?? 0}`,
      `matchedBy: ${compactMatchedBy(detail.matchedBy)}`,
      `reason: ${detail.reason || '-'}`
    ].join('\n');
  }

  function tickerBadge(ticker, role, item) {
    const detail = (item.tickerDetails || []).find((entry) => compactTicker(entry.ticker) === compactTicker(ticker)) || {
      ticker,
      role,
      confidence: item.confidence || 0,
      matchedBy: item.matchedBy || [],
      reason: ''
    };
    return `<span class="ticker-badge ${escapeHtml(role)}" title="${escapeHtml(tickerTooltip(detail))}">${escapeHtml(ticker)}</span>`;
  }

  function buildTickerSection(item) {
    const primaryTickers = normalizeList(item.primaryTickers || [item.primaryTicker]).slice(0, 2);
    const relatedStocks = normalizeList(item.relatedStocks || item.tickers).filter((ticker) => !primaryTickers.includes(ticker)).slice(0, 5);
    const watchlistStocks = normalizeList(item.watchlistStocks).filter((ticker) => !primaryTickers.includes(ticker) && !relatedStocks.includes(ticker)).slice(0, 10);
    const primaryRow = primaryTickers.length
      ? `<div class="ticker-group"><span>Mã chính</span>${primaryTickers.map((ticker) => tickerBadge(ticker, 'primary', item)).join('')}</div>`
      : '';
    const relatedRow = relatedStocks.length
      ? `<div class="ticker-group"><span>Mã liên quan</span>${relatedStocks.slice(0, 3).map((ticker) => tickerBadge(ticker, 'related', item)).join('')}${relatedStocks.length > 3 ? `<em>+${relatedStocks.length - 3}</em>` : ''}</div>`
      : '';
    const watchlist = watchlistStocks.length
      ? `<div class="ticker-group detail-tickers"><span>Mã theo dõi</span>${watchlistStocks.map((ticker) => tickerBadge(ticker, 'watchlist', item)).join('')}</div>`
      : '';
    return primaryRow || relatedRow || watchlist ? `<div class="market-tickers">${primaryRow}${relatedRow}${watchlist}</div>` : '';
  }

  function buildInfoBadges(item) {
    return `
      <div class="info-badge-row">
        ${item.isManual ? badge('Nguồn', 'Thủ công', 'manual') : ''}
        ${item.isManual ? badge('Status', item.status || 'draft') : ''}
        ${badge('Event', item.eventType)}
        ${badge('Impact', item.impactLevel, `impact-${item.impactLevel || ''}`)}
        ${badge('Sentiment', item.sentiment, `sentiment-${item.sentiment || ''}`)}
        ${badge('Horizon', item.horizon)}
        ${badge('Confidence', item.confidence ? `${item.confidence}%` : '')}
      </div>
    `;
  }

  function displayTitle(item) {
    const saved = String(item.titleVi || item.translatedTitle || '').trim();
    if (saved) return saved;
    const original = String(item.titleOriginal || item.originalTitle || item.title || '').trim();
    if (window.localTranslator?.isLikelyEnglishText?.(original)) {
      return window.localTranslator.translateNewsTextLite(original) || original;
    }
    return original;
  }

  function originalTitle(item) {
    return String(item.titleOriginal || item.originalTitle || item.title || '').trim();
  }

  function buildNewsItem(item) {
    const shownTitle = displayTitle(item);
    const titleTooltip = originalTitle(item) && originalTitle(item) !== shownTitle ? ` title="${escapeHtml(`Gốc: ${originalTitle(item)}`)}"` : '';
    const summary = item.summary ? `<p class="news-summary">${escapeHtml(item.summary)}</p>` : '';
    const contentPreview = item.contentText ? `<div class="news-content-popover">${escapeHtml(item.contentText)}</div>` : '';
    const titleLink = item.hasDetailLink === false
      ? `<span class="news-title news-title-muted"${titleTooltip}>${escapeHtml(shownTitle)}</span>`
      : `<a class="news-title" href="${escapeHtml(item.sourceUrl)}" target="_blank" rel="noreferrer"${titleTooltip}>${escapeHtml(shownTitle)}</a>`;
    return `
      <li class="news-item">
        <div class="news-row">
          <span class="item-time">${escapeHtml(item.displayTime)}</span>
          <span class="item-date">${escapeHtml(item.publishedAtText || '')}</span>
          <span class="item-source">${escapeHtml(item.sourceName)}</span>
        </div>
        <div class="news-title-wrap">${titleLink}${contentPreview}</div>
        ${buildInfoBadges(item)}
        ${summary}
        ${buildTickerSection(item)}
      </li>
    `;
  }

  function filterByCategory(items) {
    let filtered = currentCategory === 'all' ? items : items.filter((item) => item.category === currentCategory);
    const primaryTicker = compactTicker(currentFilters.primaryTicker);
    const relatedTicker = compactTicker(currentFilters.relatedTicker);
    if (primaryTicker) filtered = filtered.filter((item) => normalizeList(item.primaryTickers || [item.primaryTicker]).includes(primaryTicker));
    if (relatedTicker) filtered = filtered.filter((item) => normalizeList(item.relatedStocks || item.tickers).includes(relatedTicker));
    if (currentFilters.eventType) filtered = filtered.filter((item) => item.eventType === currentFilters.eventType);
    if (currentFilters.impactLevel) filtered = filtered.filter((item) => item.impactLevel === currentFilters.impactLevel);
    if (currentFilters.sentiment) filtered = filtered.filter((item) => item.sentiment === currentFilters.sentiment);
    if (currentFilters.horizon) filtered = filtered.filter((item) => item.horizon === currentFilters.horizon);
    return filtered;
  }

  function renderNewsColumns() {
    const domesticItems = filterByCategory(currentNews.domestic);
    const internationalItems = filterByCategory(currentNews.international);
    elements.domesticList.innerHTML = domesticItems.length ? domesticItems.map(buildNewsItem).join('') : '<li class="news-item">Không có tin phù hợp.</li>';
    elements.internationalList.innerHTML = internationalItems.length ? internationalItems.map(buildNewsItem).join('') : '<li class="news-item">Không có tin phù hợp.</li>';
    elements.domesticCount.textContent = `${domesticItems.length} tin`;
    elements.internationalCount.textContent = `${internationalItems.length} tin`;
  }

  function updateNewsState(items) {
    currentNews.rss = items;
    rebuildNewsState();
  }

  function renderMockNotice() {
    updateStatus('Hiển thị dữ liệu mock, không phải RSS thật.', false);
  }

  function renderLoadStatus(totalItems, loadedSources, totalSources, messages) {
    const manualCount = currentNews.manual.length ? ` Tin thủ công: ${currentNews.manual.length}.` : '';
    const errorText = messages.length ? ` Lỗi: ${messages.join(' | ')}` : ' Lỗi: không có';
    updateStatus(`Đã tải ${totalItems} tin từ ${loadedSources}/${totalSources} nguồn.${manualCount}${errorText}`, messages.length > 0);
  }

  async function loadFromSources() {
    const enabledSources = (window.newsSources || []).filter((source) => (
      source.enabled === true && source.fetchMode === 'rss' && source.rssUrl
    ));
    if (!enabledSources.length) throw new Error('Chưa có nguồn RSS được bật.');

    const fetchTasks = enabledSources.map(async (source) => {
      const xmlText = await simpleNewsBoardService.fetchRss(source.rssUrl);
      const parsed = simpleNewsBoardService.parseRssXml(xmlText, source.rssUrl);
      return parsed.map((item) => simpleNewsBoardService.normalizeNewsItem(item, source));
    });
    const settled = await Promise.allSettled(fetchTasks);
    const warnings = [];
    const items = [];
    let loadedSources = 0;
    settled.forEach((result, index) => {
      const source = enabledSources[index];
      if (result.status === 'fulfilled') {
        loadedSources += 1;
        items.push(...result.value);
      } else {
        warnings.push(`${source.sourceName}: ${result.reason.message || result.reason}`);
      }
    });
    const detailedItems = items.filter((item) => item.hasDetailLink && item.hasExplicitDate);
    const dedupedItems = simpleNewsBoardService.removeDuplicateNews(detailedItems);
    const sortedItems = simpleNewsBoardService.sortByPublishedAtDesc(dedupedItems);
    return {
      items: simpleNewsBoardService.filterLast48h(sortedItems),
      loadedSources,
      totalSources: enabledSources.length,
      warnings
    };
  }

  async function loadNews(useMock = false) {
    try {
      if (useMock) {
        updateNewsState(window.mockNewsBoardItems || []);
        renderNewsColumns();
        renderMockNotice();
        return;
      }
      updateStatus('Đang tải tin 48h...', false);
      const { items, loadedSources, totalSources, warnings } = await loadFromSources();
      if (items.length === 0) {
        updateNewsState(window.mockNewsBoardItems || []);
        renderNewsColumns();
        const errorText = warnings.length ? warnings.join(' | ') : 'không có tin mới trong 48h';
        updateStatus(`Đã tải 0 tin từ ${loadedSources}/${totalSources} nguồn. Lỗi: ${errorText}. Đang hiển thị mock, không phải RSS thật.`, true);
        return;
      }
      updateNewsState(items);
      renderNewsColumns();
      renderLoadStatus(items.length, loadedSources, totalSources, warnings);
    } catch (error) {
      updateStatus(`Tải tin lỗi: ${error.message || error}. Đang dùng mock, không phải RSS thật.`, true);
      updateNewsState(window.mockNewsBoardItems || []);
      renderNewsColumns();
    }
  }

  function initAuth() {
    if (!ensureFirebaseInitialized()) {
      updateStatus('Không tải được Firebase SDK. Vẫn có thể xem RSS/mock, chưa lưu được tin thủ công.', true);
      return;
    }
    elements.signinButton.addEventListener('click', async () => {
      try {
        if (location.hostname === '127.0.0.1') {
          location.href = `${location.protocol}//localhost:${location.port}${location.pathname}${location.search}${location.hash}`;
          return;
        }
        updateStatus('Đang mở Google để đăng nhập admin...', false);
        await firebase.auth().setPersistence(firebase.auth.Auth.Persistence.LOCAL);
        const provider = new firebase.auth.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account' });
        try {
          await firebase.auth().signInWithPopup(provider);
        } catch (popupError) {
          if (['auth/popup-blocked', 'auth/popup-closed-by-user', 'auth/cancelled-popup-request'].includes(popupError.code)) {
            updateStatus('Popup bị chặn hoặc bị đóng. Đang chuyển sang redirect...', true);
            await firebase.auth().signInWithRedirect(provider);
            return;
          }
          throw popupError;
        }
      } catch (error) {
        updateStatus(`Đăng nhập lỗi: ${error.code || ''} ${error.message || error}`.trim(), true);
      }
    });
    elements.signoutButton.addEventListener('click', () => firebase.auth().signOut());
    firebase.auth().getRedirectResult().catch((error) => updateStatus(`Đăng nhập lỗi: ${error.message}`, true));
    firebase.auth().onAuthStateChanged((user) => {
      currentUser = user && ADMIN_EMAILS.includes(user.email) ? user : null;
      elements.signinButton.hidden = Boolean(currentUser);
      elements.signoutButton.hidden = !user;
      subscribeManualNews();
      updateStatus(adminLoginMessage(user), Boolean(user && !currentUser));
    });
  }

  elements.loadButton.addEventListener('click', () => loadNews(false));
  elements.refreshButton.addEventListener('click', () => loadNews(false));
  elements.mockButton.addEventListener('click', () => loadNews(true));
  elements.clearFiltersButton.addEventListener('click', () => {
    Object.keys(currentFilters).forEach((key) => {
      currentFilters[key] = '';
      elements.filters[key].value = '';
    });
    renderNewsColumns();
  });
  Object.entries(elements.filters).forEach(([key, element]) => {
    element.addEventListener('input', () => {
      currentFilters[key] = element.value.trim();
      renderNewsColumns();
    });
    element.addEventListener('change', () => {
      currentFilters[key] = element.value.trim();
      renderNewsColumns();
    });
  });
  elements.categoryTabs.forEach((tab) => tab.addEventListener('click', () => applyCategoryTab(tab.dataset.category)));
  elements.appTabs.forEach((tab) => tab.addEventListener('click', () => applyView(tab.dataset.view)));
  elements.manual.form.addEventListener('submit', (event) => saveManualNews(event).catch((error) => updateStatus(`Không lưu được tin: ${error.message}`, true)));
  elements.manual.saveDraft.addEventListener('click', () => {
    elements.manual.status.value = 'draft';
    elements.manual.form.requestSubmit();
  });
  elements.manual.reanalyze.addEventListener('click', analyzeManualForm);
  elements.manual.reset.addEventListener('click', resetManualForm);
  elements.manual.fetchMeta.addEventListener('click', () => fetchManualMeta().catch((error) => updateStatus(`Fetch meta lỗi: ${error.message}`, true)));
  elements.manual.paste.addEventListener('click', async () => {
    try {
      elements.manual.url.value = await navigator.clipboard.readText();
      await fetchManualMeta();
    } catch (error) {
      updateStatus(`Không đọc được clipboard: ${error.message}`, true);
    }
  });
  elements.manual.list.addEventListener('click', async (event) => {
    const edit = event.target.closest('[data-manual-edit]');
    if (edit) fillManualForm(currentNews.manual.find((item) => item.id === edit.dataset.manualEdit) || {});
    const status = event.target.closest('[data-manual-status]');
    if (status) await updateManualStatus(status.dataset.manualStatus, status.dataset.status);
    const remove = event.target.closest('[data-manual-delete]');
    if (remove) await deleteManualNews(remove.dataset.manualDelete);
  });

  resetManualForm();
  renderNewsColumns();
  initAuth();
})();
