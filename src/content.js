// RepoGloss – content.js
// GitHub 上の英語をそのまま残し、辞書に載っている概念語へ ⓘ を添えて日本語の説明を出す。
// 語の判定そのものは src/matcher.js にある（Node からも同じコードを呼んで検証するため）。
(async () => {
  /* ---------- 0. ON / OFF 状態 ---------- */
  // 設定は chrome.storage.local に置く。localStorage は「いま開いているサイト側」の
  // 保管庫なので、拡張の設定を入れると github.com のデータを汚すことになる。
  const STORE_KEY = 'iiyakuEnabled';
  const OFF_CLASS = 'iiyaku-off';   // <html> に付けると印だけが CSS で隠れる
  // 同じ ID がページ側や他の拡張と衝突しないよう、読み込みごとに変える。
  const UID = 'iiyaku-' + Math.random().toString(36).slice(2, 10);
  const TIP_ID = UID + '-tip';

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
  //
  // 編集中の領域にも絶対に触れない。表示を助ける拡張が、利用者が書いている
  // DOM を書き換えると、選択範囲・取り消し履歴・貼り付け・送信内容が壊れうる。
  // contenteditable は "true" だけでなく、属性のみ・plaintext-only・
  // 祖先からの継承もあるため、closest() で上へたどって判定する。
  const EDITABLE = '[contenteditable]:not([contenteditable="false"])';
  const SKIP = [
    'pre', 'code', 'textarea', 'input', 'select', 'script', 'style', 'svg',
    EDITABLE,
    '.blob-code', '.js-file-line',
    '.react-code-lines', '.react-code-line-contents', '.react-blob-print-hide',
    '.cm-editor', '.CodeMirror', '.highlight', '.snippet-clipboard-content',
    '[data-testid="code-cell"]', '[data-testid="blob-viewer-file-content"]',
    '.iiyaku-icon', '.iiyaku-toggle', '.iiyaku-tooltip',
    '[aria-hidden="true"]', '.sr-only', '.visually-hidden'
  ].join(',');

  // 「印の入口になりうる」要素＝**中身から名前が決まる操作要素**に限る。
  // ここへ印の名前を足すと、その要素の読み上げ名の後ろへ解説文が丸ごと付く。
  // 中に別の操作要素を入れるのも避けたい。だから装飾扱いにして親を入口にする。
  //
  // 「フォーカスできる要素」全部をここに入れてはいけない。GitHub は本文を
  // tabindex="0" の大きなスクロール領域で包んでおり、それを入口にすると
  // 本文中の印がすべてその容器1つにぶら下がる（実測で11個が1か所に集まった）。
  // 容器は中身から名前が決まらないので、その中の印はふつうの文章として扱う。
  const HOST_CANDIDATE = [
    'a[href]', 'button', 'summary', 'label',
    '[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]', '[role="tab"]', '[role="option"]', '[role="checkbox"]',
    '[role="radio"]', '[role="switch"]', '[role="treeitem"]'
  ].join(',');

  const handled = new WeakSet();   // 処理済みのテキストノード（分割で生じた断片を含む）
  // このページで印を付けた辞書キー -> 実際に挿入した印の要素。
  // Set ではなく要素を持つのは、GitHub がサイドバー等を描き直すと印ごと
  // 消えることがあり、「付けた」記録だけが残ると二度と付かなくなるため。
  // 参照先が DOM から外れていたら、付け直しを許す。
  const glossed = new Map();
  let triggerSeq = 0;

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

  /* ---------- 3. 入口（trigger）の解決 ---------- */
  // 「操作要素らしいか」ではなく「実ブラウザで Tab の順路に入るか」で決める。
  // 要素名を並べたり tabindex 属性を自前で解釈したりすると、ブラウザの判断と
  // ずれる。ずれた結果、印を装飾扱いにしたのに代わりの入口が無い、という
  // キーボードから読めない説明ができてしまう。

  // フォーカスを持てる前提。ここを通らないものは tabIndex がいくつでも入口にしない。
  // 安い判定から順に並べる。getComputedStyle と getClientRects はレイアウトを
  // 強制するので、最後に置く（先に置くと大きなページで走査時間が1.7倍になった）。
  // known = true は「この要素が描画されていることを既に確認済み」という意味。
  // 印を入れる場所の先祖はこれに当たる（isTarget が、テキストの親の display /
  // visibility と箱の有無を確認してから通している）。先祖まで描画の確認を
  // やり直すと、大きなページで走査が 29ms から 67ms へ倍増した（実測）。
  // label が指す入力欄や、矢印ウィジェットの兄弟は先祖ではないので、確認する。
  function canHoldFocus(el, known = false) {
    if (!el || !el.isConnected) return false;
    if (el.tagName === 'INPUT' && el.type === 'hidden') return false;
    // fieldset[disabled] の子孫は、要素の disabled プロパティが false のままでも
    // 実際には無効になる。:disabled なら、最初の legend の中だけ例外にしてくれる。
    if (el.matches(':disabled')) return false;
    if (el.closest('[inert]')) return false;
    if (known) return true;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
    // 描画の箱が無いものは押せない（display:none の親を持つ子孫はここで落ちる）。
    // opacity:0 は箱があるので除外しない。透明でもフォーカスは当たるため。
    if (el.getClientRects().length === 0) return false;
    return true;
  }

  // Tab の順路に入るか。tabIndex はブラウザが解釈したあとの値なので、
  // tabindex="" や空白だけの指定、details の2番目の summary、
  // details の外に置かれた summary も、正しく -1 になる。
  // tabIndex の読み取りはレイアウトを起こさないので、こちらを先に見る。
  function tabbable(el, known = false) {
    return !!el && el.tabIndex >= 0 && canHoldFocus(el, known);
  }

  // ファイルツリーやタブのような複合ウィジェットは、項目のうち1つだけが Tab で
  // 止まり、残りは tabindex="-1" のまま矢印キーで移動する（roving tabindex）。
  const ROVING_ROLES = ['treeitem', 'option', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'radio'];

  function rovingItem(el) {
    const role = el.getAttribute('role');
    if (!role || !ROVING_ROLES.includes(role)) return false;
    const ti = el.getAttribute('tabindex');
    return ti !== null && Number.isInteger(Number(ti));
  }

  // known = true は「host が描画されている先祖である」ことが分かっている場合。
  function resolveTrigger(host, known = false) {
    if (!host) return null;
    if (host.tagName === 'LABEL') {
      // label 自体は止まれない。関連付いた control だけを入口にする。
      // 中を querySelector で探すと、隠れた入力欄まで拾ってしまう。
      // control は先祖ではないので、描画の確認まで行う。
      const c = host.control;
      return c && tabbable(c) ? c : null;
    }
    if (tabbable(host, known)) return host;
    return rovingItem(host) ? host : null;
  }

  // 印を入れようとしている場所から、扱いを決める。
  //   standalone … ふつうの文章の中。印そのものを入口にする
  //   hosted     … 操作要素の中。その要素を入口にし、印は装飾にする
  //   skip       … 操作要素の中だが入口が無い。ここには注記しない
  function resolvePlacement(parentEl) {
    let el = parentEl.closest(HOST_CANDIDATE);
    if (!el) return { kind: 'standalone' };
    while (el) {
      // ここでたどるのは、印を入れる場所の先祖だけ。isTarget が可視を確認済み。
      const trigger = resolveTrigger(el, true);
      if (trigger) return { kind: 'hosted', trigger };
      el = el.parentElement && el.parentElement.closest(HOST_CANDIDATE);
    }
    return { kind: 'skip' };
  }

  function triggerKey(trigger) {
    let id = trigger.getAttribute('data-iiyaku-trigger');
    if (!id) {
      id = UID + '-t' + (++triggerSeq);
      trigger.setAttribute('data-iiyaku-trigger', id);
    }
    return id;
  }

  /* ---------- 4. アイコン注入 ---------- */
  // 印は文字コードの記号を使わない。U+1F6C8（🛈）は Windows の Segoe UI Symbol には
  // あるが macOS の標準フォントには無く、豆腐（□）になる。要素は空にして
  // styles.css の ::after で丸と "i" を描くので、フォントに左右されない。
  function makeIcon(key, term, ja) {
    const icon = document.createElement('sup');
    icon.className = 'iiyaku-icon';
    // title 属性は使わない。ブラウザ標準のツールチップは表示までに
    // 1秒前後の待ちがあり、こちらからは短くできないため。
    icon.dataset.iiyaku = ja;
    icon.dataset.iiyakuKey = key;
    icon.dataset.iiyakuTerm = term;
    return icon;
  }

  function applyIconSemantics(icon, placement) {
    if (placement.kind === 'hosted') {
      // リンク名の後ろへ解説文が丸ごと足されるのを避けるため、装飾として扱う。
      // 説明は、入口となる要素にフォーカス／カーソルが来たときに出す。
      icon.setAttribute('aria-hidden', 'true');
      icon.removeAttribute('role');
      icon.removeAttribute('aria-label');
      icon.removeAttribute('tabindex');
      // 入口側と同じ属性名にしない。同じ名前だと querySelector が
      // 印自身を入口として拾ってしまう（label の中では印のほうが先に来る）。
      icon.dataset.iiyakuFor = triggerKey(placement.trigger);
    } else {
      // 押して開閉するので、role は img ではなく button にする。
      // 名前は「どの語の解説か」だけの短いものにし、説明文そのものは
      // ツールチップ側（aria-describedby）に置く。名前と説明が同じ全文だと、
      // 読み上げで同じ内容が二度読まれる。
      icon.setAttribute('role', 'button');
      icon.setAttribute('aria-label', `「${icon.dataset.iiyakuTerm}」の解説`);
      icon.setAttribute('aria-expanded', 'false');
      icon.tabIndex = 0;
    }
  }

  /* ---------- 5. ツールチップ ---------- */
  // アイコン1つずつに listener を付けず、document に1つだけ置いて委譲する。
  let tip = null;
  let tipAnchor = null;      // 位置の基準にした要素
  let tipDescribed = null;   // aria-describedby を足した相手
  let tipIcons = [];         // いま出している説明のもと

  const asElement = t => (t && t.nodeType === Node.ELEMENT_NODE ? t : null);

  // aria-describedby は空白区切りの集合として足し引きする。
  // 丸ごと保存して戻すと、表示中にページ側が足した ID を消してしまう。
  function addDescribedBy(el, token) {
    const cur = (el.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
    if (!cur.includes(token)) cur.push(token);
    el.setAttribute('aria-describedby', cur.join(' '));
  }

  function removeDescribedBy(el, token) {
    const cur = (el.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
    const next = cur.filter(t => t !== token);
    if (next.length) el.setAttribute('aria-describedby', next.join(' '));
    else el.removeAttribute('aria-describedby');
  }

  function iconsForTriggerId(id) {
    return [...document.querySelectorAll(`.iiyaku-icon[data-iiyaku-for="${id}"]`)]
      .filter(ic => ic.isConnected);
  }

  function triggerOf(icon) {
    const id = icon.dataset.iiyakuFor;
    return id ? document.querySelector(`[data-iiyaku-trigger="${id}"]`) : null;
  }

  // label 自体はフォーカスを取らないが、カーソルは乗る。
  // その場合は、関連付いた control を入口として扱う。
  function triggerNear(el) {
    const direct = el.closest('[data-iiyaku-trigger]');
    if (direct) return direct;
    const label = el.closest('label');
    const c = label && label.control;
    return c && c.hasAttribute('data-iiyaku-trigger') ? c : null;
  }

  function hideTip() {
    if (tipDescribed) { removeDescribedBy(tipDescribed, TIP_ID); tipDescribed = null; }
    for (const ic of tipIcons) {
      if (ic.getAttribute('role') === 'button') ic.setAttribute('aria-expanded', 'false');
    }
    if (tip) { tip.remove(); tip = null; }
    tipAnchor = null;
    tipIcons = [];
  }

  // 同じ内容を出し直さないための鍵
  const requestKey = icons => icons.map(i => i.dataset.iiyakuKey).join('|');

  function buildTipBody(icons) {
    const frag = document.createDocumentFragment();
    const seen = new Set();
    const list = icons.filter(ic => {
      const k = ic.dataset.iiyakuKey;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    for (const ic of list) {
      const row = document.createElement('div');
      row.className = 'iiyaku-tooltip-item';
      if (list.length > 1) {
        // 1つの操作要素に複数の用語がある場合、どの語の説明かを添える
        const term = document.createElement('span');
        term.className = 'iiyaku-tooltip-term';
        term.textContent = ic.dataset.iiyakuTerm;
        row.appendChild(term);
      }
      row.appendChild(document.createTextNode(ic.dataset.iiyaku));
      frag.appendChild(row);
    }
    return frag;
  }

  function placeTip(anchor) {
    // viewport 座標で置く（position: fixed）。狭い画面や拡大表示でも
    // 画面の外へ出ないよう、上下左右を余白の内側へ収める。
    const r = anchor.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const M = 8;
    let left = r.left;
    if (left + t.width > vw - M) left = vw - t.width - M;
    if (left < M) left = M;
    let top = r.bottom + 6;
    if (top + t.height > vh - M) top = r.top - t.height - 6;
    if (top < M) top = M;
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }

  // icons: 出す説明のもと（複数可）／anchor: 位置の基準／describe: 説明を結びつける相手
  function showTip(icons, anchor, describe) {
    if (!enabled || !icons || icons.length === 0) return;
    if (tip && tipAnchor === anchor && requestKey(tipIcons) === requestKey(icons)) return;
    hideTip();

    tip = document.createElement('div');
    tip.className = 'iiyaku-tooltip';
    tip.id = TIP_ID;
    tip.setAttribute('role', 'tooltip');
    tip.appendChild(buildTipBody(icons));
    document.body.appendChild(tip);

    tipAnchor = anchor;
    tipIcons = icons;
    tipDescribed = describe || anchor;
    addDescribedBy(tipDescribed, TIP_ID);
    for (const ic of icons) {
      if (ic.getAttribute('role') === 'button') ic.setAttribute('aria-expanded', 'true');
    }
    placeTip(anchor);
  }

  // 触れた場所から「何を出すか」を決める。
  //   印そのもの     … その1件だけ
  //   入口の要素     … その入口に属する印すべて（1つのリンクに複数の用語があるとき）
  function requestFrom(target) {
    const el = asElement(target);
    if (!el) return null;
    const icon = el.closest('.iiyaku-icon');
    if (icon) {
      const trigger = triggerOf(icon);
      return { icons: [icon], anchor: icon, describe: trigger || icon };
    }
    const trigger = triggerNear(el);
    if (trigger) {
      const icons = iconsForTriggerId(trigger.getAttribute('data-iiyaku-trigger'));
      if (icons.length) return { icons, anchor: icons[0], describe: trigger };
    }
    return null;
  }

  const show = req => req && showTip(req.icons, req.anchor, req.describe);
  const inTooltip = target => {
    const el = asElement(target);
    return !!(el && el.closest('.iiyaku-tooltip'));
  };

  function bindTip() {
    // 印以外の場所へカーソルが移ったら消す。mouseout だけに頼ると、
    // 表示中に印が DOM から消えた場合（GitHub の再描画など）に
    // mouseout が来ず、ツールチップが residual として残る。
    document.addEventListener('mouseover', e => {
      if (inTooltip(e.target)) return;   // 吹き出しの上に来ただけなら消さない
      const req = requestFrom(e.target);
      if (req) show(req); else hideTip();
    }, true);
    document.addEventListener('mouseout', e => {
      // 吹き出しへカーソルを移す途中で消さない（長い説明を読めるようにする）
      if (inTooltip(e.relatedTarget) || requestFrom(e.relatedTarget)) return;
      if (requestFrom(e.target)) hideTip();
    }, true);

    // キーボード。Tab で入口に止まったら出し、離れたら消す。
    document.addEventListener('focusin', e => {
      const req = requestFrom(e.target);
      if (req) show(req); else hideTip();
    }, true);
    document.addEventListener('focusout', e => {
      if (requestFrom(e.target)) hideTip();
    }, true);
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') { if (tip) hideTip(); return; }
      const el = asElement(e.target);
      if (!el || !el.classList.contains('iiyaku-icon')) return;
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();   // Space でページが送られないようにする
        if (tip && tipIcons.length === 1 && tipIcons[0] === el) hideTip();
        else show(requestFrom(el));
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
        if (tip && tipIcons.length === 1 && tipIcons[0] === icon) hideTip();
        else show(requestFrom(icon));
        return;
      }
      if (!inTooltip(e.target)) hideTip();
    }, true);

    // スクロールや画面の変化で置き去りにならないようにする
    window.addEventListener('scroll', hideTip, true);
    window.addEventListener('resize', hideTip);
  }

  /* ---------- 6. 注記 ---------- */
  // 1つのテキストノードに含まれる一致すべてへ注記する。
  // 後ろの一致から順に分割すれば、まだ処理していない前方の位置がずれない。
  function annotate(node) {
    if (handled.has(node)) return 0;
    const parent = node.parentNode;
    if (!parent || parent.nodeType !== Node.ELEMENT_NODE) return 0;

    // 同じ語はページで最初の1回だけ。説明は一度読めば足りるうえ、
    // git の解説ページのような文書では印が数百個になり本文が読めなくなる。
    // ただし前に付けた印が DOM から消えていたら、付け直す。
    const hits = matcher.findHits(node.nodeValue, key => {
      const prev = glossed.get(key);
      return !!(prev && prev.isConnected);
    });
    if (hits.length === 0) { handled.add(node); return 0; }

    // 入れる場所の扱いは、印を入れると決まってから調べる。
    // closest() は祖先をたどるので、一致の有無に関わらず全候補で呼ぶと重い
    // （実測で大きなページの初期走査が 15ms から 29ms へ倍増した）。
    const placement = resolvePlacement(parent);
    if (placement.kind === 'skip') { handled.add(node); return 0; }

    for (let i = hits.length - 1; i >= 0; i--) {
      const tail = node.splitText(hits[i].end);
      handled.add(tail);                                    // 断片を再処理しない
      const icon = makeIcon(hits[i].key, hits[i].match, DICT[hits[i].key]);
      parent.insertBefore(icon, tail);
      applyIconSemantics(icon, placement);                  // 入った場所を見てから決める
      glossed.set(hits[i].key, icon);   // 実際に挿入できたものだけ記録する
    }
    handled.add(node);
    return hits.length;
  }

  /* ---------- 7. 走査 ---------- */
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

  /* ---------- 8. DOM 監視 ---------- */
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

  /* ---------- 9. ON / OFF の切り替え ---------- */
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

  /* ---------- 10. トグルボタン ---------- */
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

  /* ---------- 11. 実行 ---------- */
  bindTip();        // 監視の ON / OFF に関わらず、入口は一度だけ張る
  createToggle();
  applyEnabled(enabled);
})();
