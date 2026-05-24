(function () {
  const now = Date.now();
  const domesticSources = [
    { sourceName: 'VnEconomy - Dau tu', sourceUrl: 'https://vneconomy.vn/mock-dau-tu.htm', group: 'domestic', category: 'market', symbols: ['SSI'] },
    { sourceName: 'VnEconomy - Tai chinh', sourceUrl: 'https://vneconomy.vn/mock-tai-chinh.htm', group: 'domestic', category: 'stocks', symbols: ['VND'] },
    { sourceName: 'HOSE - Tin cong bo', sourceUrl: 'https://api.hsx.vn/tin-tuc/mock/22', group: 'domestic', category: 'company', symbols: ['HPG'] },
    { sourceName: 'HNX - Cong bo tu so', sourceUrl: 'https://www.hnx.vn/tin-cung-cap-rss-vi_vn-mock-1.html', group: 'domestic', category: 'macro', symbols: ['FPT'] },
    { sourceName: 'VnEconomy - Dia oc', sourceUrl: 'https://vneconomy.vn/mock-dia-oc.htm', group: 'domestic', category: 'research', symbols: ['VHM'] }
  ];

  const internationalSources = [
    { sourceName: 'Reuters', sourceUrl: 'https://www.reuters.com', group: 'international', category: 'market', symbols: [] },
    { sourceName: 'Bloomberg', sourceUrl: 'https://www.bloomberg.com', group: 'international', category: 'stocks', symbols: [] },
    { sourceName: 'CNBC', sourceUrl: 'https://www.cnbc.com', group: 'international', category: 'company', symbols: [] },
    { sourceName: 'Financial Times', sourceUrl: 'https://www.ft.com', group: 'international', category: 'macro', symbols: [] },
    { sourceName: 'MarketWatch', sourceUrl: 'https://www.marketwatch.com', group: 'international', category: 'research', symbols: [] }
  ];

  function createItem(index, source, offsetMinutes) {
    const publishedAt = new Date(now - offsetMinutes * 60 * 1000);
    const summary = `Tom tat nhanh ve thong tin ${source.category} tu ${source.sourceName}.`;
    return {
      newsId: `${source.sourceName.toLowerCase().replace(/\W+/g, '_')}_${index}`,
      title: `${source.sourceName} cap nhat tin ${source.category} #${index}`,
      sourceName: source.sourceName,
      sourceUrl: source.sourceUrl,
      hasDetailLink: true,
      hasExplicitDate: true,
      publishedAt,
      publishedAtText: publishedAt.toLocaleString('vi-VN', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      }),
      displayTime: `${offsetMinutes < 60 ? offsetMinutes + ' phut truoc' : Math.floor(offsetMinutes / 60) + ' gio truoc'}`,
      summary,
      contentText: summary,
      rawDescription: summary,
      symbols: source.symbols,
      fetchedAt: new Date(now),
      sourceCategory: source.category,
      category: source.category,
      status: 'mock',
      group: source.group
    };
  }

  const mockNewsBoardItems = [];
  for (let i = 0; i < 20; i += 1) {
    const source = domesticSources[i % domesticSources.length];
    mockNewsBoardItems.push(createItem(i + 1, source, i * 30 + 5));
  }

  for (let i = 0; i < 20; i += 1) {
    const source = internationalSources[i % internationalSources.length];
    mockNewsBoardItems.push(createItem(i + 1, source, i * 28 + 12));
  }

  window.mockNewsBoardItems = mockNewsBoardItems.sort((a, b) => b.publishedAt - a.publishedAt);
})();
