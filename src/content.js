// RepoGloss – content.js
// GitHub 上の英語をそのまま残し、辞書に載っている概念語へ ⓘ を添えて日本語の説明を出す。
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

  // 複数形で一致した語は、そのままでは辞書に無い。単数形へ戻して引き直し、
  // 辞書のキーを返す。"Pull requests" と "pull request" は同じキーになる。
  function lookupKey(word) {
    const n = norm(word);
    if (DICT[n]) return n;
    if (n.endsWith('ies') && DICT[n.slice(0, -3) + 'y']) return n.slice(0, -3) + 'y';  // repositories -> repository
    if (n.endsWith('es') && DICT[n.slice(0, -2)]) return n.slice(0, -2);   // branches -> branch
    if (n.endsWith('s')  && DICT[n.slice(0, -1)]) return n.slice(0, -1);   // commits  -> commit
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
    '.iiyaku-icon', '.iiyaku-toggle', '.iiyaku-tooltip',
    '[aria-hidden="true"]', '.sr-only', '.visually-hidden'
  ].join(',');

  const handled = new WeakSet();   // 処理済みのテキストノード（分割で生じた断片を含む）
  // このページで印を付けた辞書キー -> 実際に挿入した印の要素。
  // Set ではなく要素を持つのは、GitHub がサイドバー等を描き直すと印ごと
  // 消えることがあり、「付けた」記録だけが残ると二度と付かなくなるため。
  // 参照先が DOM から外れていたら、付け直しを許す。
  const glossed = new Map();

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
  // 印は文字コードの記号を使わない。U+1F6C8（🛈）は Windows の Segoe UI Symbol には
  // あるが macOS の標準フォントには無く、豆腐（□）になる。要素は空にして
  // styles.css の ::after で丸と "i" を描くので、フォントに左右されない。
  // なお ::after の生成内容は DOM のテキストではないため、本文をコピーしても
  // 印は混ざらないはずだが、これは仕様からの推測で実測していない。
  function makeIcon(ja) {
    const icon = document.createElement('sup');
    icon.className = 'iiyaku-icon';
    // title 属性は使わない。ブラウザ標準のツールチップは表示までに
    // 1秒前後の待ちがあり、こちらからは短くできないため。
    // 説明文は data 属性に持たせ、下の自前ツールチップで即座に出す。
    icon.dataset.iiyaku = ja;
    icon.setAttribute('role', 'img');   // 中身が空なので読み上げ用の名前を別に与える
    icon.setAttribute('aria-label', ja);
    return icon;
  }

  /* ---------- 4b. ツールチップ（即時表示） ---------- */
  // アイコン1つずつに listener を付けず、document に1つだけ置いて委譲する。
  let tip = null;

  function hideTip() {
    if (tip) { tip.remove(); tip = null; }
  }

  function showTip(icon) {
    hideTip();
    const text = icon.dataset.iiyaku;
    if (!text) return;
    tip = document.createElement('div');
    tip.className = 'iiyaku-tooltip';
    tip.textContent = text;
    document.body.appendChild(tip);

    // 画面外へはみ出さないよう、右端・下端で寄せる／上に出す
    const r = icon.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    let left = r.left + window.scrollX;
    let top  = r.bottom + window.scrollY + 6;
    const maxLeft = window.scrollX + vw - t.width - 8;
    if (left > maxLeft) left = Math.max(window.scrollX + 8, maxLeft);
    if (r.bottom + t.height + 12 > vh) top = r.top + window.scrollY - t.height - 6;
    tip.style.left = left + 'px';
    tip.style.top  = top + 'px';
  }

  function bindTip() {
    // 印以外の場所へカーソルが移ったら消す。mouseout だけに頼ると、
    // 表示中に印が DOM から消えた場合（GitHub の再描画など）に
    // mouseout が来ず、ツールチップが residual として残る。
    document.addEventListener('mouseover', e => {
      const icon = e.target.closest && e.target.closest('.iiyaku-icon');
      if (icon) showTip(icon); else hideTip();
    }, true);
    document.addEventListener('mouseout', e => {
      const icon = e.target.closest && e.target.closest('.iiyaku-icon');
      if (icon) hideTip();
    }, true);
    // スクロールや画面遷移で置き去りにならないようにする
    window.addEventListener('scroll', hideTip, true);
    window.addEventListener('resize', hideTip);
  }

  // 1つのテキストノードに含まれる一致すべてへ注記する。
  // 後ろの一致から順に分割すれば、まだ処理していない前方の位置がずれない。
  function annotate(node) {
    if (handled.has(node)) return 0;
    const text = node.nodeValue;
    const hits = [];
    const pending = new Set();   // このノード内での重複も弾く
    REG_G.lastIndex = 0;
    let m;
    while ((m = REG_G.exec(text)) !== null) {
      const key = lookupKey(m[0]);
      // 同じ語はページで最初の1回だけ。説明は一度読めば足りるうえ、
      // git の解説ページのような文書では印が数百個になり本文が読めなくなる。
      // ただし前に付けた印が DOM から消えていたら、付け直す。
      const prev = key ? glossed.get(key) : null;
      if (key && (!prev || !prev.isConnected) && !pending.has(key)) {
        pending.add(key);
        hits.push({ end: m.index + m[0].length, key });
      }
      if (m.index === REG_G.lastIndex) REG_G.lastIndex++;   // 空一致での無限ループ防止
    }
    if (hits.length === 0) return 0;
    const parent = node.parentNode;
    if (!parent) return 0;

    for (let i = hits.length - 1; i >= 0; i--) {
      const tail = node.splitText(hits[i].end);
      handled.add(tail);                                    // 断片を再処理しない
      const icon = makeIcon(DICT[hits[i].key]);
      parent.insertBefore(icon, tail);
      glossed.set(hits[i].key, icon);   // 実際に挿入できたものだけ記録する
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
  let lastUrl = location.href;
  const observer = new MutationObserver(muts => {
    // GitHub はページを読み直さずに画面を差し替えることがある。
    // 別のページに移ったら「印を付けた語」を数え直す。そうしないと、
    // 前の画面で出た語が新しい画面では一度も説明されないままになる。
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      hideTip();
      // 画面全体を走査し直す。URL の書き換えより先に内容が差し込まれた分は、
      // その時点で生きていた印のせいで飛ばされている可能性があるため。
      //
      // ここで glossed を空にしてはいけない。GitHub はヘッダーやサイドバーを
      // 画面遷移をまたいで保持するので、そこに付いた印が残ったまま数え直すと、
      // 新しい本文に同じ語がもう一度付いて重複する。判定は「いま画面に印が
      // 生きているか」（isConnected）だけで足りる。消えた語は自然に付け直され、
      // 残っている語は二重に付かない。
      scan(document.body);
    }
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
    bindTip();
  }
  createToggle();
})();
