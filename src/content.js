// RepoGloss – content.js
// GitHub 上の英語をそのまま残し、辞書に載っている概念語へ ⓘ を添えて日本語の説明を出す。
// 語の判定そのものは src/matcher.js にある（Node からも同じコードを呼んで検証するため）。
(async () => {
  /* ---------- 0. ON / OFF 状態 ---------- */
  // 設定は chrome.storage.local に置く。localStorage は「いま開いているサイト側」の
  // 保管庫なので、拡張の設定を入れると github.com のデータを汚すことになる。
  const STORE_KEY = 'iiyakuEnabled';
  const OFF_CLASS = 'iiyaku-off';   // <html> に付けると印だけが CSS で隠れる
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
  const matcher = globalThis.RepoGlossMatcher && globalThis.RepoGlossMatcher.createMatcher(DICT);
  if (!matcher) {
    console.error('[iiyaku] matcher.js が読み込まれていないか、辞書が空です');
    return;
  }

  /* ---------- 2. 走査対象の判定 ---------- */
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

  // 既に操作できる要素。この中へ入った印は、それ自体を操作対象にしない。
  // リンクの中にもう一つ操作要素を作ることになるうえ、印に付けた説明文が
  // GitHub 本来のリンク名（「Pull requests」）の後ろへ丸ごと足されてしまう。
  const INTERACTIVE = [
    'a[href]', 'button', 'summary', 'input', 'select', 'textarea', 'label',
    '[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="tab"]',
    '[role="checkbox"]', '[contenteditable="true"]', '[tabindex]:not([tabindex="-1"])'
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
    if (!matcher.test(v)) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    if (el.offsetWidth === 0 && el.offsetHeight === 0) return false;
    return true;
  }

  /* ---------- 3. アイコン注入 ---------- */
  // 印は文字コードの記号を使わない。U+1F6C8（🛈）は Windows の Segoe UI Symbol には
  // あるが macOS の標準フォントには無く、豆腐（□）になる。要素は空にして
  // styles.css の ::after で丸と "i" を描くので、フォントに左右されない。
  function makeIcon(ja) {
    const icon = document.createElement('sup');
    icon.className = 'iiyaku-icon';
    // title 属性は使わない。ブラウザ標準のツールチップは表示までに
    // 1秒前後の待ちがあり、こちらからは短くできないため。
    icon.dataset.iiyaku = ja;
    return icon;
  }

  // 読み上げとキーボードの扱いは、印が入った場所によって変える。
  // ・ふつうの文章の中: 印自体に名前を与え、Tab で止まれるようにする
  // ・リンクやボタンの中: 装飾として扱い、説明は親要素へフォーカスしたときに出す
  function applyIconSemantics(icon) {
    const host = icon.parentElement && icon.parentElement.closest(INTERACTIVE);
    if (host) {
      icon.setAttribute('aria-hidden', 'true');
      icon.removeAttribute('role');
      icon.removeAttribute('aria-label');
      icon.removeAttribute('tabindex');
    } else {
      icon.setAttribute('role', 'img');
      icon.setAttribute('aria-label', icon.dataset.iiyaku);
      icon.tabIndex = 0;
    }
  }

  /* ---------- 4. ツールチップ ---------- */
  // アイコン1つずつに listener を付けず、document に1つだけ置いて委譲する。
  const TIP_ID = 'iiyaku-tooltip';
  let tip = null;
  let tipIcon = null;        // いま説明を出している印
  let tipHost = null;        // aria-describedby を付けた相手
  let tipHostPrevDesc = null;  // 相手が元々持っていた aria-describedby

  const asElement = t => (t && t.nodeType === Node.ELEMENT_NODE ? t : null);

  // host の中にある「この host を入口とする印」を返す。
  // 大きな要素が tabindex を持つ場合に、無関係な子孫の印を拾わないようにする。
  function iconInHost(host) {
    for (const ic of host.querySelectorAll('.iiyaku-icon')) {
      if (ic.parentElement && ic.parentElement.closest(INTERACTIVE) === host) return ic;
    }
    return null;
  }

  function iconFrom(target) {
    const el = asElement(target);
    if (!el) return null;
    const direct = el.closest('.iiyaku-icon');
    if (direct) return direct;
    const host = el.closest(INTERACTIVE);
    return host ? iconInHost(host) : null;
  }

  const inTooltip = target => {
    const el = asElement(target);
    return !!(el && el.closest('.iiyaku-tooltip'));
  };

  function hideTip() {
    if (tipHost) {
      // 相手が元から持っていた説明を消さない
      if (tipHostPrevDesc === null) tipHost.removeAttribute('aria-describedby');
      else tipHost.setAttribute('aria-describedby', tipHostPrevDesc);
      tipHost = null;
      tipHostPrevDesc = null;
    }
    if (tip) { tip.remove(); tip = null; }
    tipIcon = null;
  }

  function showTip(icon) {
    if (!enabled || !icon) return;
    if (tipIcon === icon && tip) return;   // 同じ印なら描き直さない
    hideTip();
    const text = icon.dataset.iiyaku;
    if (!text) return;

    tip = document.createElement('div');
    tip.className = 'iiyaku-tooltip';
    tip.id = TIP_ID;
    tip.setAttribute('role', 'tooltip');
    tip.textContent = text;
    document.body.appendChild(tip);
    tipIcon = icon;

    // 読み上げ用の関連付け。リンクの中の印は、リンク自体を入口にする。
    const host = icon.parentElement && icon.parentElement.closest(INTERACTIVE);
    tipHost = host || icon;
    tipHostPrevDesc = tipHost.getAttribute('aria-describedby');
    tipHost.setAttribute('aria-describedby', tipHostPrevDesc ? `${tipHostPrevDesc} ${TIP_ID}` : TIP_ID);

    // 画面外へはみ出さないよう、右端・下端で寄せる／上に出す
    const r = icon.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    let left = r.left + window.scrollX;
    let top = r.bottom + window.scrollY + 6;
    const maxLeft = window.scrollX + vw - t.width - 8;
    if (left > maxLeft) left = Math.max(window.scrollX + 8, maxLeft);
    if (r.bottom + t.height + 12 > vh) top = r.top + window.scrollY - t.height - 6;
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }

  function toggleTip(icon) {
    if (tipIcon === icon && tip) hideTip(); else showTip(icon);
  }

  function bindTip() {
    // 印以外の場所へカーソルが移ったら消す。mouseout だけに頼ると、
    // 表示中に印が DOM から消えた場合（GitHub の再描画など）に
    // mouseout が来ず、ツールチップが residual として残る。
    document.addEventListener('mouseover', e => {
      if (inTooltip(e.target)) return;   // 吹き出しの上に来ただけなら消さない
      const icon = iconFrom(e.target);
      if (icon) showTip(icon); else hideTip();
    }, true);
    document.addEventListener('mouseout', e => {
      // 吹き出しへカーソルを移す途中で消さない（長い説明を読めるようにする）
      if (inTooltip(e.relatedTarget) || iconFrom(e.relatedTarget)) return;
      if (iconFrom(e.target)) hideTip();
    }, true);

    // キーボード。Tab で入口に止まったら出し、離れたら消す。
    document.addEventListener('focusin', e => {
      const icon = iconFrom(e.target);
      if (icon) showTip(icon); else hideTip();
    }, true);
    document.addEventListener('focusout', e => {
      if (iconFrom(e.target)) hideTip();
    }, true);
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') { if (tip) hideTip(); return; }
      const el = asElement(e.target);
      if (!el || !el.classList.contains('iiyaku-icon')) return;
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();   // Space でページが送られないようにする
        toggleTip(el);
      }
    }, true);

    // 触って操作する端末と、留めて読みたい場合。
    document.addEventListener('click', e => {
      const el = asElement(e.target);
      const icon = el && el.closest('.iiyaku-icon');
      if (icon) {
        // リンクの中の印を押しても、そのリンクへ移動しないようにする
        e.preventDefault();
        e.stopPropagation();
        toggleTip(icon);
        return;
      }
      if (!inTooltip(e.target)) hideTip();
    }, true);

    // スクロールや画面の変化で置き去りにならないようにする
    window.addEventListener('scroll', hideTip, true);
    window.addEventListener('resize', hideTip);
  }

  /* ---------- 5. 注記 ---------- */
  // 1つのテキストノードに含まれる一致すべてへ注記する。
  // 後ろの一致から順に分割すれば、まだ処理していない前方の位置がずれない。
  function annotate(node) {
    if (handled.has(node)) return 0;
    // 同じ語はページで最初の1回だけ。説明は一度読めば足りるうえ、
    // git の解説ページのような文書では印が数百個になり本文が読めなくなる。
    // ただし前に付けた印が DOM から消えていたら、付け直す。
    const hits = matcher.findHits(node.nodeValue, key => {
      const prev = glossed.get(key);
      return !!(prev && prev.isConnected);
    });
    if (hits.length === 0) return 0;
    const parent = node.parentNode;
    if (!parent) return 0;

    for (let i = hits.length - 1; i >= 0; i--) {
      const tail = node.splitText(hits[i].end);
      handled.add(tail);                                    // 断片を再処理しない
      const icon = makeIcon(DICT[hits[i].key]);
      parent.insertBefore(icon, tail);
      applyIconSemantics(icon);                             // 入った場所を見てから決める
      glossed.set(hits[i].key, icon);   // 実際に挿入できたものだけ記録する
    }
    handled.add(node);
    return hits.length;
  }

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

  /* ---------- 7. ON / OFF の切り替え ---------- */
  let observing = false;

  function startRuntime() {
    if (observing) return;
    scan(document.body);
    observer.observe(document.body, { childList: true, subtree: true });
    observing = true;
  }

  function stopRuntime() {
    if (!observing) return;
    observer.disconnect();
    observing = false;
    hideTip();
  }

  // OFF でも印を DOM から消さず、CSS で隠すだけにする。消してしまうと、
  // 分割済みのテキストノードが handled に残ったまま元へ戻らず、
  // ON に直しても付き直さない語が出るため。
  function applyEnabled(next) {
    enabled = next;
    document.documentElement.classList.toggle(OFF_CLASS, !enabled);
    if (enabled) startRuntime(); else stopRuntime();
    updateToggle();
  }

  /* ---------- 8. トグルボタン ---------- */
  let toggleBtn = null;

  function updateToggle() {
    if (!toggleBtn) return;
    // 「意訳」とは書かない。この拡張は英語を置き換えず、説明を添えるだけのため。
    toggleBtn.textContent = enabled ? '解説 ON' : '解説 OFF';
    toggleBtn.setAttribute('aria-pressed', String(enabled));
    toggleBtn.title = enabled ? 'クリックすると解説の印を隠します' : 'クリックすると解説の印を表示します';
  }

  function createToggle() {
    const btn = document.createElement('button');
    btn.className = 'iiyaku-toggle';
    btn.type = 'button';
    toggleBtn = btn;
    updateToggle();
    btn.addEventListener('click', async () => {
      const prev = enabled;
      applyEnabled(!prev);   // 先に表示を変える。ページの再読み込みはしない
      try {
        await chrome.storage.local.set({ [STORE_KEY]: enabled });
      } catch (e) {
        // 保存できなかったのに表示だけ変わっている状態を残さない
        console.error('[iiyaku] 設定の保存に失敗。表示を元に戻します:', e);
        applyEnabled(prev);
      }
    });
    document.body.appendChild(btn);
  }

  // 別のタブで切り替えたときも、開いている GitHub のタブへ反映する。
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[STORE_KEY]) return;
      const next = changes[STORE_KEY].newValue !== false;
      if (next !== enabled) applyEnabled(next);
    });
  } catch (e) {
    console.error('[iiyaku] 設定の変更を受け取れません:', e);
  }

  /* ---------- 9. 実行 ---------- */
  bindTip();        // 監視の ON / OFF に関わらず、入口は一度だけ張る
  createToggle();
  applyEnabled(enabled);
})();
