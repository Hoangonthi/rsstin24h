(function attachLocalTranslator(root) {
  const COMMON_ENGLISH_WORDS = /\b(the|and|or|as|with|from|after|before|over|under|market|markets|stock|stocks|bitcoin|crypto|traders|fed|rate|oil|gold|dollar|bank|etf|price|prices|rally|falls|slides|jumps|rise|drops|amid|says|warns|launches|could|may|will)\b/i;

  const PHRASE_RULES = [
    [/\bprediction markets\b/gi, "thị trường dự đoán"],
    [/\bspot bitcoin etfs?\b/gi, "ETF Bitcoin giao ngay"],
    [/\bbitcoin etfs?\b/gi, "ETF Bitcoin"],
    [/\bexchange traded funds?\b/gi, "quỹ ETF"],
    [/\bstablecoins?\b/gi, "stablecoin"],
    [/\bliquidation setup\b/gi, "vùng rủi ro thanh lý"],
    [/\bliquidations?\b/gi, "thanh lý vị thế"],
    [/\bopen interest\b/gi, "hợp đồng mở"],
    [/\brate cuts?\b/gi, "cắt giảm lãi suất"],
    [/\brate hikes?\b/gi, "tăng lãi suất"],
    [/\bfed cuts?\b/gi, "Fed cắt giảm lãi suất"],
    [/\bfed\b/gi, "Fed"],
    [/\bcpi\b/gi, "CPI"],
    [/\bdefi\b/gi, "DeFi"],
    [/\bonchain\b/gi, "on-chain"],
    [/\bcritical on-?chain support\b/gi, "vùng hỗ trợ on-chain quan trọng"],
    [/\bcritical support\b/gi, "vùng hỗ trợ quan trọng"],
    [/\boptions? showdown\b/gi, "cuộc đối đầu quyền chọn"],
    [/\boptions?\b/gi, "quyền chọn"],
    [/\bthis signal shows\b/gi, "tín hiệu này cho thấy"],
    [/\bis sitting on\b/gi, "đang nằm trên"],
    [/\btied to\b/gi, "gắn với"],
    [/\bblockchain\b/gi, "blockchain"],
    [/\bcrypto traders?\b/gi, "nhà giao dịch crypto"],
    [/\btraders?\b/gi, "nhà giao dịch"],
    [/\binvestors?\b/gi, "nhà đầu tư"],
    [/\bwhales?\b/gi, "cá voi"],
    [/\bmarkets?\b/gi, "thị trường"],
    [/\bstocks?\b/gi, "cổ phiếu"],
    [/\bbond yields?\b/gi, "lợi suất trái phiếu"],
    [/\byields?\b/gi, "lợi suất"],
    [/\btreasur(?:y|ies)\b/gi, "trái phiếu kho bạc Mỹ"],
    [/\boil futures?\b/gi, "hợp đồng dầu"],
    [/\boil\b/gi, "dầu"],
    [/\bgold\b/gi, "vàng"],
    [/\bdollar\b/gi, "đồng USD"],
    [/\bbitcoin\b/gi, "Bitcoin"],
    [/\bethereum\b/gi, "Ethereum"],
    [/\bxrp\b/gi, "XRP"],
    [/\bbtc\b/gi, "BTC"],
    [/\beth\b/gi, "ETH"],
    [/\bcrypto\b/gi, "crypto"],
    [/\bslides?\b/gi, "giảm"],
    [/\bfalls?\b/gi, "giảm"],
    [/\bdrops?\b/gi, "giảm"],
    [/\bdives?\b/gi, "lao dốc"],
    [/\bsinks?\b/gi, "giảm sâu"],
    [/\bjumps?\b/gi, "tăng mạnh"],
    [/\brall(?:y|ies)\b/gi, "hồi phục"],
    [/\brises?\b/gi, "tăng"],
    [/\bsurges?\b/gi, "tăng vọt"],
    [/\bsoars?\b/gi, "bứt phá"],
    [/\bclimbs?\b/gi, "tăng"],
    [/\bslips?\b/gi, "trượt giảm"],
    [/\bweakens?\b/gi, "suy yếu"],
    [/\bstrengthens?\b/gi, "mạnh lên"],
    [/\b(?:heads?|heading) towards?\b/gi, "hướng tới"],
    [/\bcaught between\b/gi, "kẹt giữa"],
    [/\bcritical\b/gi, "quan trọng"],
    [/\bsupport\b/gi, "hỗ trợ"],
    [/\bresistance\b/gi, "kháng cự"],
    [/\bvolatility trap\b/gi, "bẫy biến động"],
    [/\bvolatility\b/gi, "biến động"],
    [/\bliquidity dries up\b/gi, "thanh khoản cạn dần"],
    [/\bliquidity\b/gi, "thanh khoản"],
    [/\bleverage builds?\b/gi, "đòn bẩy tăng lên"],
    [/\bleverage\b/gi, "đòn bẩy"],
    [/\boutflows?\b/gi, "dòng vốn rút ra"],
    [/\binflows?\b/gi, "dòng vốn vào"],
    [/\bdemand\b/gi, "nhu cầu"],
    [/\bsupply\b/gi, "nguồn cung"],
    [/\btreasury\b/gi, "kho bạc"],
    [/\bcourt cases?\b/gi, "các vụ kiện"],
    [/\bsanctions?\b/gi, "lệnh trừng phạt"],
    [/\bregulation\b/gi, "quy định"],
    [/\bregulatory\b/gi, "pháp lý"],
    [/\bpolicy\b/gi, "chính sách"],
    [/\bmacro\b/gi, "vĩ mô"],
    [/\bceasefire\b/gi, "lệnh ngừng bắn"],
    [/\bstrikes?\b/gi, "cuộc tấn công"],
    [/\bwarns?\b/gi, "cảnh báo"],
    [/\bsays?\b/gi, "cho biết"],
    [/\bpraises?\b/gi, "ca ngợi"],
    [/\bdefends?\b/gi, "bảo vệ"],
    [/\blaunch(?:es|ed)?\b/gi, "ra mắt"],
    [/\bjoins?\b/gi, "tham gia"],
    [/\bacquires?\b/gi, "mua lại"],
    [/\bbuy(?:s|ing)?\b/gi, "mua"],
    [/\bsell(?:s|ing)?\b/gi, "bán"],
    [/\bfaces?\b/gi, "đối mặt"],
    [/\btests?\b/gi, "kiểm tra"],
    [/\bafter\b/gi, "sau khi"],
    [/\bbefore\b/gi, "trước khi"],
    [/\bas\b/gi, "khi"],
    [/\bamid\b/gi, "giữa lúc"],
    [/\bwith\b/gi, "với"],
    [/\bwithout\b/gi, "không có"],
    [/\band\b/gi, "và"],
    [/\bor\b/gi, "hoặc"],
    [/(^|\s)an?\s+/gi, "$1một "],
    [/(^|\s)the\s+/gi, "$1"],
    [/\bfrom\b/gi, "từ"],
    [/\bto\b/gi, "đến"],
    [/\bnear\b/gi, "gần"],
    [/\babove\b/gi, "trên"],
    [/\bbelow\b/gi, "dưới"],
    [/\bcould\b/gi, "có thể"],
    [/\bmay\b/gi, "có thể"],
    [/\bwill\b/gi, "sẽ"],
    [/\bnew\b/gi, "mới"],
    [/\bmajor\b/gi, "lớn"],
    [/\bfresh\b/gi, "mới"],
    [/\bglobal\b/gi, "toàn cầu"],
    [/\bbillion\b/gi, "tỷ USD"],
    [/\bus\b/gi, "Mỹ"],
    [/\buk\b/gi, "Anh"],
    [/\beu\b/gi, "EU"],
    [/\bchina\b/gi, "Trung Quốc"],
    [/\bjapan\b/gi, "Nhật Bản"],
    [/\bir[aă]n\b/gi, "Iran"],
  ];

  function stripTags(value) {
    return String(value || "")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isLikelyEnglishText(value) {
    const text = stripTags(value);
    if (!text) return false;
    const asciiLetters = (text.match(/[A-Za-z]/g) || []).length;
    const vietnameseMarks = (text.match(/[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/gi) || []).length;
    return asciiLetters >= 8 && vietnameseMarks <= 2 && COMMON_ENGLISH_WORDS.test(text);
  }

  function localTranslateText(value) {
    let text = stripTags(value);
    if (!isLikelyEnglishText(text)) return "";
    for (const [pattern, replacement] of PHRASE_RULES) {
      text = text.replace(pattern, replacement);
    }
    text = text
      .replace(/\s+([,.;:!?])/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
    return text;
  }

  function translateNewsTextLite(value) {
    const translated = localTranslateText(value);
    if (!translated) return "";
    const original = stripTags(value).toLowerCase();
    if (translated.toLowerCase() === original) return "";
    return translated;
  }

  const api = {isLikelyEnglishText, translateNewsTextLite};
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.localTranslator = api;
})(typeof window !== "undefined" ? window : globalThis);
