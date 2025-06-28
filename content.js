/* GitHub 意訳支援 – content.js  (dict.json 連携版) */
(async () => {
  /* ――― 1. 辞書を非同期で読み込む ――― */
  const dictUrl = chrome.runtime.getURL('dict.json');
  let dict = {};
  try {
    dict = await fetch(dictUrl).then(res => res.json());
  } catch (err) {
    console.error('[iiyaku] dict.json の読み込みに失敗しました:', err);
    return;                       // 辞書が無いと処理できないので終了
  }

  /* ――― 2. 正規表現ユーティリティ ――― */
  const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const normalizeDictKey = w => w.trim().toLowerCase().replace(/\s+/g, ' ');
  const keys = Object.keys(dict).map(k => escapeRegExp(k).replace(/ /g, '\\s+'));
  if (keys.length === 0) return;  // 辞書が空なら何もしない
  const REG = new RegExp(`\\b(${keys.join('|')})\\b`, 'gi');

  /* ――― 3. アイコンを挿入する処理 ――― */
  function injectIcon(textNode, matchedWord) {
    const dictKey = normalizeDictKey(matchedWord);
    const tooltipText = dict[dictKey];
    if (!tooltipText) return;

    const parent = textNode.parentElement;
    if (!parent || parent.querySelector('.iiyaku-icon')) return;

    const icon = document.createElement('sup');
    icon.className = 'iiyaku-icon';
    icon.textContent = '🛈';

    const showTooltip = () => {
      if (document.querySelector('.iiyaku-tooltip')) return;
      const tip = document.createElement('div');
      tip.className = 'iiyaku-tooltip';
      tip.textContent = tooltipText;
      document.body.appendChild(tip);

      const rect = icon.getBoundingClientRect();
      tip.style.top  = `${rect.bottom + window.scrollY + 5}px`;
      tip.style.left = `${rect.left   + window.scrollX}px`;
      requestAnimationFrame(() => (tip.style.opacity = '1'));
      icon._tooltip = tip;
    };

    const hideTooltip = () => {
      if (icon._tooltip) {
        icon._tooltip.remove();
        icon._tooltip = null;
      }
    };

    icon.addEventListener('mouseenter', showTooltip);
    icon.addEventListener('mouseleave', hideTooltip);

    /* テキストノードを分割し、アイコンを後ろに挿入 */
    const endIdx = textNode.nodeValue.indexOf(matchedWord) + matchedWord.length;
    const rest   = textNode.nodeValue.slice(endIdx);
    textNode.nodeValue = textNode.nodeValue.slice(0, endIdx);
    parent.insertBefore(icon, textNode.nextSibling);
    if (rest) parent.insertBefore(document.createTextNode(rest), icon.nextSibling);
  }

  /* ――― 4. 処理対象かどうか判定 ――― */
  function shouldProcess(node) {
    const el = node.parentElement;
    if (!node.nodeValue.trim()) return false;
    if (!el) return false;
    if (el.closest('.iiyaku-icon')) return false;
    if (el.classList.contains('sr-only') ||
        el.classList.contains('visually-hidden') ||
        el.getAttribute('aria-hidden') === 'true') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const tag = el.tagName;
    if (tag === 'STYLE' || tag === 'SCRIPT' || tag === 'CODE' || tag === 'PRE')
      return false;
    return true;
  }

  /* ――― 5. ノード走査 & マッチ処理 ――― */
  function scanNodes(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const buf = [];
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (shouldProcess(n)) buf.push(n);
    }
    buf.forEach(n => {
      const m = n.nodeValue.match(REG);
      if (m) m.forEach(word => injectIcon(n, word));
    });
  }

  /* ――― 6. ページ読み込み & 監視開始 ――― */
  scanNodes(document.body);
  const observer = new MutationObserver(muts => {
    muts.forEach(m => {
      m.addedNodes.forEach(n => {
        if (n.nodeType === Node.ELEMENT_NODE) scanNodes(n);
      });
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();
