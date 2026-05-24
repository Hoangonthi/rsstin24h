(function () {
  const elements = {
    statusLine: document.getElementById('status-line'),
    domesticList: document.getElementById('domestic-news-list'),
    internationalList: document.getElementById('international-news-list'),
    domesticCount: document.getElementById('domestic-count'),
    internationalCount: document.getElementById('international-count'),
    loadButton: document.getElementById('load-news-btn'),
    refreshButton: document.getElementById('refresh-news-btn'),
    mockButton: document.getElementById('mock-news-btn'),
    categoryTabs: Array.from(document.querySelectorAll('.tab-button'))
  };

  let currentCategory = 'all';
  let currentNews = {
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

  function applyCategoryTab(category) {
    currentCategory = category;
    elements.categoryTabs.forEach((tab) => {
      tab.classList.toggle('active', tab.dataset.category === category);
    });
    renderNewsColumns();
  }

  function buildNewsItem(item) {
    const summary = item.summary
      ? `<p class="news-summary">${escapeHtml(item.summary)}</p>`
      : '';
    const symbols = Array.isArray(item.symbols) && item.symbols.length
      ? `<div class="symbol-row">${item.symbols.map((symbol) => `<span class="symbol-badge">${escapeHtml(symbol)}</span>`).join('')}</div>`
      : '';
    const contentPreview = item.contentText
      ? `<div class="news-content-popover">${escapeHtml(item.contentText)}</div>`
      : '';
    const titleLink = item.hasDetailLink === false
      ? `<span class="news-title news-title-muted">${escapeHtml(item.title)}</span>`
      : `<a class="news-title" href="${escapeHtml(item.sourceUrl)}" target="_blank" rel="noreferrer">${escapeHtml(item.title)}</a>`;
    const title = `<div class="news-title-wrap">${titleLink}${contentPreview}</div>`;

    return `
      <li class="news-item">
        <div class="news-row">
          <span class="item-time">${escapeHtml(item.displayTime)}</span>
          <span class="item-date">${escapeHtml(item.publishedAtText || '')}</span>
          <span class="item-source">${escapeHtml(item.sourceName)}</span>
        </div>
        ${title}
        ${summary}
        ${symbols}
      </li>
    `;
  }

  function filterByCategory(items) {
    if (currentCategory === 'all') {
      return items;
    }
    return items.filter((item) => item.category === currentCategory);
  }

  function renderNewsColumns() {
    const domesticItems = filterByCategory(currentNews.domestic);
    const internationalItems = filterByCategory(currentNews.international);

    elements.domesticList.innerHTML = domesticItems.length
      ? domesticItems.map(buildNewsItem).join('')
      : '<li class="news-item">Không có tin phù hợp.</li>';
    elements.internationalList.innerHTML = internationalItems.length
      ? internationalItems.map(buildNewsItem).join('')
      : '<li class="news-item">Không có tin phù hợp.</li>';

    elements.domesticCount.textContent = `${domesticItems.length} tin`;
    elements.internationalCount.textContent = `${internationalItems.length} tin`;
  }

  function updateNewsState(items) {
    currentNews.domestic = items.filter((item) => item.group === 'domestic');
    currentNews.international = items.filter((item) => item.group === 'international');
    currentNews.domestic = simpleNewsBoardService.sortByPublishedAtDesc(currentNews.domestic);
    currentNews.international = simpleNewsBoardService.sortByPublishedAtDesc(currentNews.international);
  }

  function renderMockNotice() {
    updateStatus('Hiển thị dữ liệu mock, không phải RSS thật.', false);
  }

  function renderLoadStatus(totalItems, loadedSources, totalSources, messages) {
    const errorText = messages.length ? ` Lỗi: ${messages.join(' | ')}` : ' Lỗi: không có';
    updateStatus(`Đã tải ${totalItems} tin từ ${loadedSources}/${totalSources} nguồn.${errorText}`, messages.length > 0);
  }

  async function loadFromSources() {
    const enabledSources = (window.newsSources || []).filter((source) => (
      source.enabled === true
      && source.fetchMode === 'rss'
      && source.rssUrl
    ));

    if (!enabledSources.length) {
      throw new Error('Chưa có nguồn RSS được bật.');
    }

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
    const recentItems = simpleNewsBoardService.filterLast24h(sortedItems);

    return {
      items: recentItems,
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

      updateStatus('Đang tải tin 24h...', false);
      const { items, loadedSources, totalSources, warnings } = await loadFromSources();

      if (items.length === 0) {
        updateNewsState(window.mockNewsBoardItems || []);
        renderNewsColumns();
        const errorText = warnings.length ? warnings.join(' | ') : 'không có tin mới trong 24h';
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

  elements.loadButton.addEventListener('click', () => loadNews(false));
  elements.refreshButton.addEventListener('click', () => loadNews(false));
  elements.mockButton.addEventListener('click', () => loadNews(true));
  elements.categoryTabs.forEach((tab) => {
    tab.addEventListener('click', () => applyCategoryTab(tab.dataset.category));
  });

  renderNewsColumns();
})();
