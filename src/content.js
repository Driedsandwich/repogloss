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
    // inert の中は、見えていても操作も読み上げもできない（開いていないダイアログの
    // 裏側など）。ここに注記すると、その語の「ページで最初の1回」を使い切ってしまい、
    // 後ろにある読める同じ語へ説明が付かなくなる。印自体も Tab で到達できない。
    '[inert]',
    // hidden 属性が付いた領域。hidden="until-found" は要素自体が描画されたままなので、
    // 可視性の判定だけでは落ちない（実測）。文字列を読む前にここで落とす。
    '[hidden]',
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
  // このページで印を付けた辞書キー -> そのとき自分が何を作ったかの記録。
  //
  // 印の要素だけを覚えるのでは足りない。片づけるときに「印の隣にあるもの」を見て
  // 自分が割った対だと推し量ることになり、次の3つが起きる（いずれも実測で再現）:
  //   - ページ側が印の隣へ挿し込んだ Text node を、自分のものと誤って消す
  //   - その巻き添えで、利用者が選んでいた範囲が空になる
  //   - ページ側が印だけを外した場合、隣をたどれず、その語が二度と説明されない
  // だから注記した時点で「自分が割った節点」「自分が作った節点」を控えておき、
  // 片づけるときはその記録だけを扱う。記録は辞書のキーの数（61）で頭打ちになる。
  const glossed = new Map();
  let triggerSeq = 0;

  // その語が「実際に読める場所」に出ているか。
  //
  // 直接の親だけを見ていては足りない。opacity と content-visibility は、
  // 祖先に掛かっていても子の computed 値は変わらないため、子を見ても分からない。
  // 実測（Chrome 151）: 祖先が opacity:0 でも content-visibility:hidden でも、
  // 子は rects=1・offsetWidth=1264 を返す。箱の有無では判別できない。
  //
  // checkVisibility は祖先までまとめて見てくれる。ただし contentVisibilityAuto は
  // 渡さない——渡すと content-visibility:auto の画面外要素まで false になり、
  // 長いページの下のほうが永久に注記されなくなる（実測で確認）。
  // 古い Chrome では引数名が違うので、両方の綴りを一緒に渡す（知らない項目は無視される）。
  const CHECK_VISIBILITY_OPTS = {
    opacityProperty: true, visibilityProperty: true,     // 現行の綴り
    checkOpacity: true, checkVisibilityCSS: true         // 古い綴り
  };
  // 箱を持たない要素（display:contents）の**先祖**に聞くとき用。
  // visibility だけをわざと外す——visibility は継承する性質で、子が
  // visibility:visible に戻していれば、先祖が hidden でも文字は見えているため。
  // display:none・opacity・先祖の content-visibility は継承しないので、
  // これらは先祖側に聞くしかない。
  const CONTENTS_HOST_OPTS = { opacityProperty: true, checkOpacity: true };
  const HAS_CHECK_VISIBILITY = typeof Element.prototype.checkVisibility === 'function';

  let visibleCache = null;   // 走査1回のあいだだけ有効

  // 読み上げ専用テキストの定番の書き方: 1px 四方まで潰し、clip で中身を隠す。
  // checkVisibility はこれを不可視と見なさない（実測で true が返る）。
  //
  // GitHub も使っている。実測では `prc-src-InternalVisuallyHidden-…` の中の
  // "Repository files navigation" に印が付いており、目に見える repository より先に
  // 「ページで最初の1回」を使い切っていた。クラス名は版ごとに変わる自動生成なので、
  // 名前ではなく形（1px 以下 ＋ clip）で判定する。
  //
  // 大きな箱へ全面の切り取りを掛ける書き方もある（実測で、この形の中の語に
  // 印が付いていた）。1px という大きさだけを条件にすると取りこぼすので、
  // 「全面を切り落とす指定」もあわせて見る。
  const FULL_CLIP = /^rect\(0(?:px)?(?:,)?\s+0(?:px)?(?:,)?\s+0(?:px)?(?:,)?\s+0(?:px)?\)$/;
  const FULL_CLIP_PATH = /^inset\(\s*50%\s*\)$/;

  let clipCache = null;   // 走査1回のあいだだけ有効

  function clipsAwayContent(n) {
    if (clipCache) {
      const hit = clipCache.get(n);
      if (hit !== undefined) return hit;
    }
    let v = false;
    // 大きさの確認は安い。ここを先に見て、多くの要素で getComputedStyle を避ける。
    const tiny = n.offsetWidth <= 1 && n.offsetHeight <= 1;
    const cs = getComputedStyle(n);
    const clip = cs.clip && cs.clip !== 'auto' ? cs.clip.replace(/\s+/g, ' ').trim() : '';
    const path = cs.clipPath && cs.clipPath !== 'none' ? cs.clipPath.trim() : '';
    if (clip || path) {
      // 1px 四方まで潰したうえで切り取る書き方（読み上げ専用の定番）か、
      // 大きさに関係なく全面を切り落とす書き方か。
      v = tiny || FULL_CLIP.test(clip) || FULL_CLIP_PATH.test(path);
    }
    if (clipCache) clipCache.set(n, v);
    return v;
  }

  // 祖先をたどった結果そのものを覚える。要素ごとの判定だけを覚えても、
  // 候補が変わるたびに同じ祖先の連なりを何度も上りなおすことになる。
  // 連なりの答えを覚えると、同じ枝の2件目からは1回で済む。
  let clipChainCache = null;

  function isClipHidden(el) {
    if (!el || el === document.body) return false;
    if (clipChainCache) {
      const hit = clipChainCache.get(el);
      if (hit !== undefined) return hit;
    }
    const v = clipsAwayContent(el) || isClipHidden(el.parentElement);
    if (clipChainCache) clipChainCache.set(el, v);
    return v;
  }

  // display:contents は箱を作らない。可視性を判断できる最も近い先祖まで上がる。
  function boxedAncestor(el) {
    let n = el.parentElement;
    while (n && getComputedStyle(n).display === 'contents') n = n.parentElement;
    return n;
  }

  // 文字そのものが描かれているか。display:contents の要素は箱を持たないので
  // offsetWidth / offsetHeight が 0 になるが、中の文字は普通に見えている。
  // 要素の箱ではなく、文字の範囲で確かめる。
  //
  // ⚠️ これ単独では可視性の証明にならない。content-visibility:hidden で飛ばされた
  // 中身にも Range は矩形を返す（実測で 3 個）。描かれていない文字にも矩形が出る。
  function hasRenderedText(el) {
    const r = document.createRange();
    r.selectNodeContents(el);
    return r.getClientRects().length > 0;
  }

  // display:contents の要素にある文字が、実際に読めるか。
  //
  // 箱を持つ先祖の可視性を、そのまま子の答えに使ってはいけない。実測の反例が2つある:
  //   - 先祖が content-visibility:hidden … 先祖自身は描画されたままなので、
  //     先祖に聞くと「見えている」と答える。しかし中身は飛ばされていて読めない
  //     （Range の矩形も出るので、矩形の有無でも見抜けない）。
  //   - 先祖が visibility:hidden で、子が visibility:visible に戻している …
  //     先祖に聞くと「見えていない」。しかし子の文字は見えている。
  // どちらも「先祖の1つの答え」を子へ転用したことが原因なので、性質ごとに分ける。
  //   visibility            … 継承する。子の computed 値が正しい
  //   display:none / opacity / 先祖の content-visibility … 継承しない。先祖に聞く
  //   文字が実際に描かれているか … 子の Range で見る
  //   clip                  … 子から上へたどる（既存の判定）
  // content-visibility:auto は落とさない（画面外というだけで永久に除外しないため）。
  function isVisibleContentsText(el, cs) {
    if (cs.visibility !== 'visible') return false;
    const host = boxedAncestor(el);
    if (host) {
      // visibility を外して聞く。display:none と opacity と、
      // さらに上の content-visibility:hidden は、これで落ちる。
      if (!host.checkVisibility(CONTENTS_HOST_OPTS)) return false;
      // 先祖自身が中身を飛ばしている場合、その先祖は描画されたままなので
      // checkVisibility では落ちない。ここだけは名指しで見る。
      if (getComputedStyle(host).contentVisibility === 'hidden') return false;
    }
    if (!hasRenderedText(el)) return false;
    return !isClipHidden(el);
  }

  function isVisibleOccurrence(el) {
    if (!el || !el.isConnected) return false;
    if (visibleCache) {
      const hit = visibleCache.get(el);
      if (hit !== undefined) return hit;
    }
    // レイアウトを起こすので高い。1要素につき1回だけ取って使い回す。
    const cs = getComputedStyle(el);
    let ok;
    if (cs.display === 'contents') {
      // 箱を作らない要素。Chrome は checkVisibility に false を返すが（実測）、
      // それは「隠れている」ではなく「箱が無い」という意味なので、転用できない。
      ok = HAS_CHECK_VISIBILITY
        ? isVisibleContentsText(el, cs)
        : (cs.visibility === 'visible' && hasRenderedText(el) && !isClipHidden(el));
    } else if (HAS_CHECK_VISIBILITY) {
      ok = el.checkVisibility(CHECK_VISIBILITY_OPTS);
      // その要素自身が content-visibility:hidden のとき、**中身**は隠れているのに
      // 要素自体は描画されているので checkVisibility は true を返す（実測）。
      // 直接テキストを持つ場合はここで落とさないと、見えない語に印が付く。
      if (ok && cs.contentVisibility === 'hidden') ok = false;
      // 箱をまったく持たず、文字も描かれていないもの
      if (ok && el.offsetWidth === 0 && el.offsetHeight === 0) ok = hasRenderedText(el);
      if (ok && isClipHidden(el)) ok = false;
    } else {
      // checkVisibility が無い環境。manifest の minimum_chrome_version より古い
      // Chrome か、拡張を手で読み込んだ場合にしか起きない。祖先の opacity や
      // content-visibility は見抜けないので、ここは「落ちないための保険」にすぎない。
      ok = !(cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0');
      if (ok && cs.contentVisibility === 'hidden') ok = false;
      if (ok && el.offsetWidth === 0 && el.offsetHeight === 0) ok = hasRenderedText(el);
      if (ok && isClipHidden(el)) ok = false;
    }
    if (visibleCache) visibleCache.set(el, ok);
    return ok;
  }

  // 走査してよい場所かを、**テキストの中身に触れる前に**決める。
  // 編集中の内容・フォーム・コード・aria-hidden・inert は、書き換えないだけでなく
  // 値を読み取りもしない。「変えない」と「読まない」は別のことなので、
  // 判定の順序そのものを約束にする（順序が戻っていないかは verify.mjs が検査する）。
  function isTarget(node) {
    if (handled.has(node)) return false;
    const el = node.parentElement;
    if (!el) return false;
    if (el.closest(SKIP)) return false;

    // ---- ここから下でだけ、テキストの文字列に触れる ----
    const v = node.nodeValue;
    if (!v || !v.trim()) return false;
    // 辞書に当たらないノードで可視性の計算をしないよう、正規表現を先に通す。
    // 逆順にすると全テキストノードでレイアウト計算が走り、ページが重くなる。
    if (!matcher.test(v)) return false;
    return isVisibleOccurrence(el);
  }

  /* ---------- 3. 入口（trigger）の解決 ---------- */
  // 「操作要素らしいか」ではなく「実ブラウザで Tab の順路に入るか」で決める。
  // 要素名を並べたり tabindex 属性を自前で解釈したりすると、ブラウザの判断と
  // ずれる。ずれた結果、印を装飾扱いにしたのに代わりの入口が無い、という
  // キーボードから読めない説明ができてしまう。

  // 描画されているか。ここは「その要素自身が箱を持つか」だけを見る。
  //
  // 先祖が描画されていることを、子から推し量ってはいけない。isTarget が確認
  // しているのはテキストの**直接の親**だけで、それより上は別の要素である。
  //   - display:contents の先祖は箱を作らないので、子が見えていても
  //     その先祖自身は Tab の順路に入らない（getClientRects().length === 0）。
  //   - visibility:hidden の先祖の中で、子だけ visibility:visible に戻すこともできる。
  // v1.8.2 はここを「先祖は確認済み」として省いており、上の2つと
  // display:contents の button を、到達できると誤って判定していた（外部監査で実証）。
  //
  // getComputedStyle と getClientRects はレイアウトを強制するので高い。
  // 省くのではなく、同じ要素を測り直さないようにして戻す。
  let renderCache = null;   // 走査1回のあいだだけ有効（scan が作って捨てる）

  function isRendered(el) {
    if (renderCache) {
      const hit = renderCache.get(el);
      if (hit !== undefined) return hit;
    }
    const cs = getComputedStyle(el);
    let ok = !(cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse');
    // 箱が無いものは押せない。display:none の子孫と display:contents は
    // どちらもここで落ちる。opacity:0 は箱があるので除外しない
    // （透明でもフォーカスは当たり、読み上げにも出るため）。
    if (ok && el.getClientRects().length === 0) ok = false;
    if (renderCache) renderCache.set(el, ok);
    return ok;
  }

  // フォーカスを持てる前提。ここを通らないものは tabIndex がいくつでも入口にしない。
  // 安い判定から順に並べる（レイアウトを起こす isRendered は最後）。
  function canHoldFocus(el) {
    if (!el || !el.isConnected) return false;
    if (el.tagName === 'INPUT' && el.type === 'hidden') return false;
    // fieldset[disabled] の子孫は、要素の disabled プロパティが false のままでも
    // 実際には無効になる。:disabled なら、最初の legend の中だけ例外にしてくれる。
    if (el.matches(':disabled')) return false;
    if (el.closest('[inert]')) return false;
    return isRendered(el);
  }

  // Tab の順路に入るか。tabIndex はブラウザが解釈したあとの値なので、
  // tabindex="" や空白だけの指定、details の2番目の summary、
  // details の外に置かれた summary も、正しく -1 になる。
  // tabIndex の読み取りはレイアウトを起こさないので、こちらを先に見る。
  //
  // tabIndex が負のものは入口にしない。矢印キーで移動する部品（roving tabindex）は
  // tabindex="-1" のまま到達できることがあるが、それが成り立つのは keydown を
  // 受けて focus() を動かす実装がある場合だけで、role と容器と 0/-1 の並びからは
  // 判定できない。v1.8.2 は構造だけで認めており、handler の無い部品を
  // 到達可能と誤判定していた（外部監査が反例で実証）。
  // 実サイト計測: GitHub 4ページで、この推定に依存していた注記は0件だった
  // （ファイル一覧の readme も、入口側の tabIndex=0 の項目に付いている）。
  function tabbable(el) {
    return !!el && el.tabIndex >= 0 && canHoldFocus(el);
  }

  function resolveTrigger(host) {
    if (!host) return null;
    if (host.tagName === 'LABEL') {
      // label 自体は止まれない。関連付いた control だけを入口にする。
      // 中を querySelector で探すと、隠れた入力欄まで拾ってしまう。
      const c = host.control;
      return c && tabbable(c) ? c : null;
    }
    return tabbable(host) ? host : null;
  }

  // 印を入れようとしている場所から、扱いを決める。
  //   standalone … ふつうの文章の中。印そのものを入口にする
  //   hosted     … 操作要素の中。その要素を入口にし、印は装飾にする
  //   skip       … 操作要素の中だが入口が無い。ここには注記しない
  function resolvePlacement(parentEl) {
    let el = parentEl.closest(HOST_CANDIDATE);
    if (!el) return { kind: 'standalone' };
    while (el) {
      // 先祖であっても、その要素自身が描画されているかを毎回確かめる（isRendered）。
      const trigger = resolveTrigger(el);
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

  // 画面が動いたとき。印が見えていれば位置を追従させ、画面の外へ出たら閉じる。
  function onViewportChange() {
    if (!tip) return;
    if (!tipAnchor || !tipAnchor.isConnected) { hideTip(); return; }
    const r = tipAnchor.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) { hideTip(); return; }
    placeTip(tipAnchor);
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

    // スクロールや画面の変化では、閉じずに位置を合わせ直す。
    // キーボードで画面外の印へ移ると、ブラウザがその要素まで自動でスクロールする。
    // ここで一律に閉じると、Tab で止まった瞬間に説明が消えてしまう（実測）。
    window.addEventListener('scroll', onViewportChange, true);
    window.addEventListener('resize', onViewportChange);
  }

  /* ---------- 5-2. 付けた印が、まだ説明として使えるか ---------- */
  // DOM に残っていること（isConnected）は「使える」ことを意味しない。
  // 祖先が display:none や opacity:0 になっても、inert の中へ移されても、
  // isConnected は true のままである。それを説明済みの証拠にすると、
  // 後から現れた**読める同じ語**へ説明が付かなくなる（実測で再現）。
  //
  // 使えると言えるのは、次をすべて満たすときだけ:
  //   - DOM にあり、その場所が実際に見えている
  //   - 単独の印なら、その印自身が Tab の順路に入る
  //   - 装飾扱いの印なら、対応する入口が生きていて Tab の順路に入る
  function usableGloss(key) {
    const rec = glossed.get(key);
    if (!rec) return null;
    const icon = rec.icon;
    if (!icon.isConnected) return null;
    if (!isVisibleOccurrence(icon.parentElement)) return null;
    const forId = icon.dataset.iiyakuFor;
    if (forId) {
      const trigger = document.querySelector(`[data-iiyaku-trigger="${forId}"]`);
      return trigger && tabbable(trigger) ? rec : null;
    }
    return tabbable(icon) ? rec : null;
  }

  // 使えなくなった印を片づける。**元の語を、また注記できる状態へ戻す**ところまでやる。
  //
  // 印を入れるとき splitText でテキストを割り、両方を handled へ入れている。
  // 印だけ消すと、割れたテキストは handled に残ったままなので、その語は
  // そのページを開いている間ずっと説明されなくなる（隠した場所をあとで戻しても、
  // 画面遷移で全体を走査し直しても復活しない。実測で再現）。
  //
  // 割ったものを繋ぎ直しはしない。繋ぎ直すには2つの節点を1つにまとめる必要があり、
  // 消える側に利用者の選択範囲やページ側の参照があると壊れる（実測: 選択していた
  // 一文が空になった）。文字数は割っても変わらないので、割ったまま handled から
  // 外して走査対象へ返せば足りる。空の節点が増え続けないよう、注記する側で
  // 「用語が末尾ちょうどで終わるときは割らない」ようにしてある。
  //
  // 隣を見て自分の割った対を推し量ることはしない。ページ側は印の隣へ自由に
  // 節点を挿し込めるし、印そのものを外すこともある。注記したときの記録だけを使う。
  function retireGloss(key) {
    const rec = glossed.get(key);
    if (!rec) return null;
    glossed.delete(key);
    if (rec.icon.isConnected) {
      // その印について説明を出している最中なら、先に閉じる
      if (tip && tipIcons.includes(rec.icon)) hideTip();
      rec.icon.remove();     // 外すのは自分が入れた <sup> だけ
    }
    // 印が既にページ側から外されていても、ここへ来る。記録があるので、
    // 用語を含む節点を走査対象へ戻せる（隣をたどる必要がない）。
    handled.delete(rec.termNode);
    return rec;
  }

  // 自分の印が、この片づけを通らずに DOM から外れることがある。GitHub が一部を
  // 描き直したときや、ページ側が要素を消したときである。放っておくと、記録した
  // 節点が handled に残り、その語はページを開いているあいだ二度と説明されない
  // （実測: 印を外して画面遷移しても付き直さなかった）。
  //
  // 記録は辞書のキーの数（61）で頭打ちなので、変更のたびに数え直しても軽い。
  // 外れていた印を片づけたら、その場所をすぐ見直す（画面遷移を待たない）。
  function recoverDetachedGlosses() {
    let released = null;
    for (const key of [...glossed.keys()]) {
      const rec = glossed.get(key);
      if (rec && !rec.icon.isConnected) (released ??= []).push(retireGloss(key));
    }
    if (!released) return 0;
    let n = 0;
    for (const rec of released) {
      if (rec.termNode.isConnected) n += scanInner(rec.termNode);
    }
    return n;
  }

  /* ---------- 6. 注記 ---------- */
  // 1つのテキストノードに含まれる一致すべてへ注記する。
  //
  // 前から順に処理する。一致ごとに「用語で終わる左側」と「その後ろ」に割り、
  // 後ろを次の一致の作業対象にする。後ろから割ると、先に控えた節点があとの分割で
  // さらに割られ、記録が実物とずれる（片づけのときに別の節点を戻してしまう）。
  function annotate(node) {
    if (handled.has(node)) return 0;
    const parent = node.parentNode;
    if (!parent || parent.nodeType !== Node.ELEMENT_NODE) return 0;

    // 同じ語はページで最初の1回だけ。説明は一度読めば足りるうえ、
    // git の解説ページのような文書では印が数百個になり本文が読めなくなる。
    // ただし前に付けた印が「もう説明として使えない」なら、付け直す。
    const hits = matcher.findHits(node.nodeValue, key => usableGloss(key) !== null);
    if (hits.length === 0) { handled.add(node); return 0; }
    // 付け直すと決まったキーについて、使えなくなった古い印を取り除く。
    // 残しておくと、同じ語の印が画面に2つあることになる。
    for (const h of hits) retireGloss(h.key);

    // 入れる場所の扱いは、印を入れると決まってから調べる。
    // closest() は祖先をたどるので、一致の有無に関わらず全候補で呼ぶと重い
    // （実測で大きなページの初期走査が 15ms から 29ms へ倍増した）。
    const placement = resolvePlacement(parent);
    if (placement.kind === 'skip') { handled.add(node); return 0; }

    let cur = node;        // いま扱っている節点（用語で終わる左側になる）
    let consumed = 0;      // cur の先頭が、元の文字列の何文字目にあたるか
    let added = 0;
    for (const hit of hits) {
      const at = hit.end - consumed;
      // 用語が末尾ちょうどで終わるときは割らない。割ると空の節点が1つ増え、
      // 片づけと付け直しを繰り返すたびに増え続ける（往復のたびに1つずつ）。
      const tail = at < cur.length ? cur.splitText(at) : null;
      if (tail) handled.add(tail);                          // 断片を再処理しない
      const icon = makeIcon(hit.key, hit.match, DICT[hit.key]);
      parent.insertBefore(icon, tail ?? cur.nextSibling);
      applyIconSemantics(icon, placement);                  // 入った場所を見てから決める
      handled.add(cur);
      // 実際に挿入できたものだけ、作ったものと一緒に控える。
      // termNode は用語を末尾に含む節点。片づけのとき、これを走査対象へ戻す。
      // tailNode は自分が作った右側（作らなかったときは null）。控えるのは
      // 「何を作ったか」を後から言えるようにするためで、DOM は動かさない。
      glossed.set(hit.key, {
        key: hit.key, term: hit.match, icon, parent,
        termNode: cur, tailNode: tail, splitOffset: at,
        placementKind: placement.kind,
        trigger: placement.kind === 'hosted' ? placement.trigger : null
      });
      added++;
      if (!tail) break;    // 後ろが無い＝これ以上の一致は入らない
      cur = tail;
      consumed = hit.end;
    }
    handled.add(node);
    return added;
  }

  /* ---------- 7. 走査 ---------- */
  // 走査のあいだだけ、描画状態の測定結果を覚えておく。
  // 走査は同期的に走り、その間にページ側が要素を隠したり display を変えたりはしない
  // （こちらが差し込む印は <sup> 1つで、入口候補の display や箱の有無を変えない）。
  // 走査を抜けたら必ず捨てる。持ち越すと、GitHub が画面を差し替えたあとに
  // 古い測定値で判定してしまう。
  function withRenderCache(fn) {
    const owner = renderCache === null;
    if (owner) { renderCache = new WeakMap(); visibleCache = new WeakMap();
                 clipCache = new WeakMap(); clipChainCache = new WeakMap(); }
    try {
      return fn();
    } finally {
      if (owner) { renderCache = null; visibleCache = null; clipCache = null; clipChainCache = null; }
    }
  }

  function scan(root) {
    return withRenderCache(() => scanInner(root));
  }

  function scanInner(root) {
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
  // 差し込みが一度に何十件も来るので、1回分の呼び出しでは測定結果を共有する。
  const observer = new MutationObserver(muts => withRenderCache(() => {
    // 自分の印だけがページ側から外されることがある。記録した節点を handled へ
    // 残したままにすると、その語は二度と説明されない。外れていたら片づけて、
    // その場で見直す（画面遷移やノードの追加を待たない）。
    let removals = false;
    for (const mu of muts) if (mu.removedNodes.length) { removals = true; break; }
    if (removals) recoverDetachedGlosses();

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
      // 新しい本文に同じ語がもう一度付いて重複する。判定は「いま画面に、
      // 説明として使える印があるか」（usableGloss）で行う。DOM に残っている
      // だけでは足りない——隠れた印を「説明済み」と見なすと、後から現れた
      // 読める同じ語に説明が付かなくなる。使えなくなった印は片づけて付け直す。
      scan(document.body);
    }
    for (const mu of muts) {
      for (const n of mu.addedNodes) scan(n);
    }
  }));

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
