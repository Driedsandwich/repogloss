// RepoGloss – content.js
// GitHub 上の英語をそのまま残し、辞書に載っている概念語へ 🛈 を添えて日本語の説明を出す。
(async () => {
  /* ---------- 0. ON / OFF 状態 ---------- */
  // 設定は chrome.storage.local に置く。localStorage は「いま開いているサイト側」の
  // 保管庫なので、拡張の設定を入れると github.com のデータを汚すことになる。
  const STORE_KEY = 'iiyakuEnabled';
  let enabled = true;
  try {
    const got = await chrome.storage.local.get(STORE_KEY);
    enabled = got[STORE_KEY] !== false;   // 未設定なら ON
  } catch (e) {
    console.error('[iiyaku] 設定の読み込みに失敗。ON として続行します:', e);
  }

  /* ---------- 1. 辞書読み込み ---------- */
  const DICT_URL = chrome.runtime.getURL('locales/dict.json');
  let DICT = {};
  try {
    DICT = await fetch(DICT_URL).then(r => r.json());
  } catch (e) {
    console.error('[iiyaku] dict.json 読み込み失敗:', e);
    return;
  }
  const KEYS = Object.keys(DICT);
  if (KEYS.length === 0) return;

  /* ---------- 2. 正規表現 ---------- */
  const esc  = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const norm = s => s.trim().toLowerCase().replace(/\s+/g, ' ');

  // 長いキーから順に並べる。正規表現の | は左から先に当たるので、
  // 'pull' が 'pull request' より前にあると「Pull requests」に
  // pull（取り込む操作）の説明が付いてしまう。
  // repository -> repositories のように y で終わる語は s を足すだけでは
  // 複数形にならないので、綴りの変わる形も候補に並べておく。
  const VARIANTS = KEYS.flatMap(k => (k.endsWith('y') ? [k, k.slice(0, -1) + 'ies'] : [k]));
  const PATTERN = VARIANTS
    .slice()
    .sort((a, b) => b.length - a.length)
    .map(k => esc(k).replace(/ /g, '\\s+'))
    .join('|');
  // 末尾の (?:e?s)? は単複の揺れを吸収する。GitHub の画面では
  // "Pull requests" のように複数形で出る語が多く、これが無いと
  // 単数形キー 'pull request' の後ろの \b が s に阻まれ、
  // 代わりに 'pull'（取り込む操作）だけに当たってしまう。
  const REG_G = new RegExp(`\\b(?:${PATTERN})(?:e?s)?\\b`, 'gi');  // 走査用（lastIndex を持つ）
  const REG_T = new RegExp(`\\b(?:${PATTERN})(?:e?s)?\\b`, 'i');   // 足切り用（状態を持たない）

  // 複数形で一致した語は、そのままでは辞書に無い。単数形へ戻して引き直す。
  function lookup(word) {
    const n = norm(word);
    if (DICT[n]) return DICT[n];
    if (n.endsWith('ies') && DICT[n.slice(0, -3) + 'y']) return DICT[n.slice(0, -3) + 'y'];  // repositories -> repository
    if (n.endsWith('es') && DICT[n.slice(0, -2)]) return DICT[n.slice(0, -2)];   // branches -> branch
    if (n.endsWith('s')  && DICT[n.slice(0, -1)]) return DICT[n.slice(0, -1)];   // commits  -> commit
    return null;
  }

  /* ---------- 3. 走査対象の判定 ---------- */
  // コードそのものには注記しない。GitHub のコード表示は、旧来の
  // <pre>/<code>/.blob-code と React 版のコードビューアが併存している。
  const SKIP = [
    'pre', 'code', 'textarea', 'script', 'style', 'svg',
    '.blob-code', '.js-file-line',
    '.react-code-lines', '.react-code-line-contents', '.react-blob-print-hide',
    '.cm-editor', '.CodeMirror', '.highlight', '.snippet-clipboard-content',
    '[data-testid="code-cell"]', '[data-testid="blob-viewer-file-content"]',
    '.iiyaku-icon', '.iiyaku-toggle',
    '[aria-hidden="true"]', '.sr-only', '.visually-hidden'
  ].join(',');

  const handled = new WeakSet();   // 処理済みのテキストノード（分割で生じた断片を含む）

  function isTarget(node) {
    const v = node.nodeValue;
    if (!v || !v.trim()) return false;
    if (handled.has(node)) return false;
    const el = node.parentElement;
    if (!el) return false;
    if (el.closest(SKIP)) return false;
    // 辞書に当たらないノードで getComputedStyle を呼ばないよう、正規表現を先に通す。
    // 逆順にすると全テキストノードでレイアウト計算が走り、ページが重くなる。
    if (!REG_T.test(v)) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    if (el.offsetWidth === 0 && el.offsetHeight === 0) return false;
    return true;
  }

  /* ---------- 4. アイコン注入 ---------- */
  function makeIcon(ja) {
    const icon = document.createElement('sup');
    icon.className = 'iiyaku-icon';
    icon.textContent = '🛈';
    icon.title = ja;   // ネイティブツールチップ
    return icon;
  }

  // 1つのテキストノードに含まれる一致すべてへ注記する。
  // 後ろの一致から順に分割すれば、まだ処理していない前方の位置がずれない。
  function annotate(node) {
    if (handled.has(node)) return 0;
    const text = node.nodeValue;
    const hits = [];
    REG_G.lastIndex = 0;
    let m;
    while ((m = REG_G.exec(text)) !== null) {
      const ja = lookup(m[0]);
      if (ja) hits.push({ end: m.index + m[0].length, ja });
      if (m.index === REG_G.lastIndex) REG_G.lastIndex++;   // 空一致での無限ループ防止
    }
    if (hits.length === 0) return 0;
    const parent = node.parentNode;
    if (!parent) return 0;

    for (let i = hits.length - 1; i >= 0; i--) {
      const tail = node.splitText(hits[i].end);
      handled.add(tail);                                    // 断片を再処理しない
      parent.insertBefore(makeIcon(hits[i].ja), tail);
    }
    handled.add(node);
    return hits.length;
  }

  /* ---------- 5. 走査 ---------- */
  function scan(root) {
    if (!root || !root.nodeType) return 0;
    if (root.nodeType === Node.TEXT_NODE) {
      return isTarget(root) ? annotate(root) : 0;
    }
    if (root.nodeType !== Node.ELEMENT_NODE) return 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const targets = [];
    while (walker.nextNode()) {
      if (isTarget(walker.currentNode)) targets.push(walker.currentNode);
    }
    let n = 0;
    for (const t of targets) n += annotate(t);
    return n;
  }

  /* ---------- 6. DOM 監視 ---------- */
  // GitHub は画面遷移でページ全体を読み直さないことがあるため、
  // 後から差し込まれた部分も見張る。自分が挿入した断片は handled で弾く。
  const observer = new MutationObserver(muts => {
    for (const mu of muts) {
      for (const n of mu.addedNodes) scan(n);
    }
  });

  /* ---------- 7. トグルボタン ---------- */
  function createToggle() {
    const btn = document.createElement('button');
    btn.className = 'iiyaku-toggle';
    btn.type = 'button';
    btn.textContent = enabled ? '意訳 ON' : '意訳 OFF';
    btn.title = 'クリックするとページを再読み込みして ON / OFF を切り替えます';
    btn.addEventListener('click', async () => {
      enabled = !enabled;
      try {
        await chrome.storage.local.set({ [STORE_KEY]: enabled });
      } catch (e) {
        console.error('[iiyaku] 設定の保存に失敗:', e);
      }
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
