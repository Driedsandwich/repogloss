// GitHub 意訳支援 – content.js（非表示ノード除外・WeakSetトラッキング・トグル対応）
(async () => {
  /* ---------- 0. ON / OFF 状態 ---------- */
  const STORE_KEY = 'iiyakuEnabled';
  let   enabled   = localStorage.getItem(STORE_KEY) !== 'off';

  /* ---------- 1. 辞書読み込み ---------- */
  const DICT_URL = chrome.runtime.getURL('locales/dict.json');
  let   DICT     = {};
  try {
    DICT = await fetch(DICT_URL).then(r => r.json());
  } catch (e) {
    console.error('[iiyaku] dict.json 読み込み失敗:', e);
    return;
  }

  /* ---------- 2. 正規表現準備 ---------- */
  const esc  = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const norm = s => s.trim().toLowerCase().replace(/\s+/g, ' ');
  const REG  = new RegExp(
    `\\b(${Object.keys(DICT)
      .map(k => esc(k).replace(/ /g, '\\s+'))
      .join('|')})\\b`, 'gi'
  );

  /* ---------- 3. 可視ノード判定 ---------- */
  const SKIP_TAG = new Set(['STYLE', 'SCRIPT', 'CODE', 'PRE']);
  function isVisibleText(node) {
    const el = node.parentElement;
    if (!el || !node.nodeValue.trim()) return false;              // 空文字列
    if (el.closest('.iiyaku-icon'))             return false;     // 既にアイコン内
    if (SKIP_TAG.has(el.tagName))               return false;     // 対象外タグ
    if (el.classList.contains('sr-only') ||
        el.classList.contains('visually-hidden')) return false;   // 視覚的に非表示
    if (el.getAttribute('aria-hidden') === 'true') return false;  // aria-hidden
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0')
      return false;                                               // CSS 非表示
    const rect = el.getBoundingClientRect();
    if ((rect.width === 0 && rect.height === 0) ||
        (el.offsetWidth === 0 && el.offsetHeight === 0))
      return false;                                               // 実体サイズ 0
    return true;
  }

  /* ---------- 4. アイコン注入 ---------- */
  const processed = new WeakSet();    // TextNode → 処理済みフラグ
  function inject(node, word) {
    if (processed.has(node)) return;  // 二重処理ガード

    const ja = DICT[norm(word)];
    if (!ja) return;

    const parent = node.parentElement;
    if (!parent || parent.querySelector('.iiyaku-icon')) return;

    const icon = document.createElement('sup');
    icon.className = 'iiyaku-icon';
    icon.textContent = '🛈';
    icon.title = ja;                                   // ネイティブツールチップ

    // テキストノードを分割し、アイコンを語尾に挿入
    const idxEnd = node.nodeValue.indexOf(word) + word.length;
    const tail   = node.splitText(idxEnd);
    parent.insertBefore(icon, tail);

    processed.add(node);
  }

  /* ---------- 5. 走査 ---------- */
  function scan(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (!isVisibleText(n)) continue;
      const hits = n.nodeValue.match(REG);
      if (hits) hits.forEach(h => inject(n, h));
    }
  }

  /* ---------- 6. DOM 監視 ---------- */
  const observer = new MutationObserver(muts => {
    muts.forEach(m =>
      m.addedNodes.forEach(n => (n.nodeType === 1) && scan(n))
    );
  });

  /* ---------- 7. トグルボタン ---------- */
  function createToggle() {
    const btn = document.createElement('button');
    btn.className = 'iiyaku-toggle';
    const setLabel = () =>
      (btn.textContent = enabled ? '意訳 ON' : '意訳 OFF');
    setLabel();
    btn.title = 'クリックするとページを再読み込みして ON / OFF を切り替えます';
    btn.addEventListener('click', () => {
      enabled = !enabled;
      localStorage.setItem(STORE_KEY, enabled ? 'on' : 'off');
      location.reload();   // 状態を確実に反映
    });
    document.body.appendChild(btn);
  }

  /* ---------- 8. 実行 ---------- */
  if (enabled) {
    scan(document.body);
    observer.observe(document.body, { childList: true, subtree: true });
  }
  createToggle();
})();
