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
    // 自分の吹き出しと切替ボタンは、ここ（class 名）ではなく要素そのもので除く
    // （→ isOurChrome）。名前で除くと、ページ側の同名 class まで巻き込む。
    '.iiyaku-icon',
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

  // 処理済みのテキストノード（分割で生じた断片を含む）。**世代つき**で持つ。
  //
  // ただの集合にすると、「その語はもう説明済みだから何もしなかった」ノードまで
  // 永久に処理済みとして残る。すると、最初の印を含む場所がページから消えたとき、
  // **既にページにある2番目の候補**が二度と選ばれない。実測では、`branch` を
  // 2か所に置いて最初の場所を削除したところ、ページ全体の印が 0 個になった
  // （URL を変えて全体を走査し直しても戻らない）。
  // 正規の印が退役したときだけ世代を進め、全体から選び直す（下の reselect）。
  const handled = new WeakMap();   // Text -> 処理した世代
  let generation = 0;
  const isHandled = n => handled.get(n) === generation;
  const markHandled = n => handled.set(n, generation);

  // 辞書には当たったが、そのときは見えていなかった節点。
  //
  // 見え方が変わる合図（遷移・画面幅・stylesheet・操作・暇なとき）を受けても、
  // v1.8.9 は**既にある印を確かめ直すだけ**で、まだ印の無い語は探さなかった。
  // 走査し直す場所も、退役した記録も無いからである。その結果、最初に隠れていた
  // 語は、そのタブを開いているあいだ永久に説明されなかった（4通りで実測）。
  // 合図のたびにページ全体を走り直すのは高いので、ここだけを見直す。
  const latent = new Set();          // Text ノード（自分で掃除する）
  const LATENT_MAX = 2000;           // これを超えたら控えるのをやめ、全体走査へ落とす
  let latentOverflow = false;

  function rememberLatent(node) {
    if (latentOverflow) return;
    if (latent.size >= LATENT_MAX) { latent.clear(); latentOverflow = true; return; }
    latent.add(node);
  }
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
  // ただし CSS2 の clip は **絶対配置の要素にしか効かない**。position が static や
  // relative のままの要素に rect(0 0 0 0) と書いても、中身はふつうに見えている。
  // 位置を見ずに「全面の切り取り」とみなすと、読める文章のほうを除外してしまう
  // （実測: position:static・幅1264px の要素にある語へ印が付かなかった）。
  // clip-path は position に関係なく効くので、こちらは位置を問わない。
  // 決まった書き方だけを文字列で照合するのはやめる。`rect(0 0 0 0)` と
  // `inset(50%)` だけを見ていたため、**面積は 0 なのに座標が 0 でない**書き方を
  // 取りこぼしていた（実測: `rect(5px,5px,5px,5px)` と `inset(100%)` の中の語に
  // 印が付き、後ろの読める同じ語が説明されなくなった）。値として解いて面積で決める。
  const CLIP_POSITIONS = ['absolute', 'fixed'];   // legacy clip が効く配置

  // clip: rect(top, right, bottom, left)。comma でも空白でも書ける。
  // 面積が 0 になるのは right <= left か bottom <= top のとき。
  // auto が混ざっていたら、その辺は決められないので「全面非表示」と断定しない。
  function rectClipsAll(v) {
    const m = /^rect\((.+)\)$/.exec(v);
    if (!m) return false;
    const parts = m[1].split(/\s*,\s*|\s+/).filter(Boolean);
    if (parts.length !== 4) return false;
    if (parts.some(p => p === 'auto')) return false;
    const n = parts.map(p => parseFloat(p));
    if (n.some(x => !Number.isFinite(x))) return false;
    const [top, right, bottom, left] = n;
    return right <= left || bottom <= top;
  }

  // clip-path: inset(...)。1〜4値を上右下左へ展開する。
  //
  // 百分率だけを見ていては足りなかった。ブラウザが返す computed 値には
  // `inset(50% 0px)` のように**長さと百分率が混ざる**（`inset(50% 0 50% 0)` と
  // 書いただけでこうなる）。混在を「決められない」として捨てていたため、
  // 全面が隠れているのに可視と答えていた（実測: 隠れた側に印が付き、
  // 後ろの読める同じ語が説明されなくなった）。
  // 箱の寸法が分かるならそこへ換算し、**px で面積を判定する**。
  //
  // `calc()` ・`polygon()` ・`path()` ・`shape()` は解かない。値だけからは
  // 面積を決められないので、**断定しないほうへ倒す**（可視として扱う）。
  // これは既知の制約として DESIGN.md に書いてある。
  const LEN_PX = /^(-?\d*\.?\d+)px$/;
  const LEN_PCT = /^(-?\d*\.?\d+)%$/;

  // 1つの値を px にする。base はその辺の長さ。決められなければ null。
  function lenToPx(part, base) {
    if (part === '0') return 0;
    let m = LEN_PX.exec(part);
    if (m) return parseFloat(m[1]);
    m = LEN_PCT.exec(part);
    if (m) return base === null ? null : parseFloat(m[1]) / 100 * base;
    return null;                     // calc() や未知の単位
  }

  // w / h は border box の寸法。取れないときは null を渡す（百分率だけで判定する）。
  function insetClipsAll(v, w = null, h = null) {
    const m = /^inset\((.*)\)$/.exec(v);
    if (!m) return false;
    const body = m[1].split(/\s+round\s+/)[0].trim();
    if (/calc\(|var\(|min\(|max\(|clamp\(/.test(body)) return false;   // 解かない
    const parts = body.split(/\s+/).filter(Boolean);
    if (parts.length < 1 || parts.length > 4) return false;
    const [t, r, b, l] =
      parts.length === 1 ? [parts[0], parts[0], parts[0], parts[0]]
      : parts.length === 2 ? [parts[0], parts[1], parts[0], parts[1]]
      : parts.length === 3 ? [parts[0], parts[1], parts[2], parts[1]]
      : parts;
    // 箱の寸法が 0 以下だと「0 + 0 >= 0」で何でも全面非表示になってしまう。
    // その場合は百分率だけで判断する（px は箱に対する割合が決まらない）。
    const useBox = typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0;
    const bw = useBox ? w : null;
    const bh = useBox ? h : null;
    const top = lenToPx(t, bh), bottom = lenToPx(b, bh);
    const left = lenToPx(l, bw), right = lenToPx(r, bw);
    if (useBox) {
      if (top !== null && bottom !== null && (top + bottom) >= bh) return true;
      if (left !== null && right !== null && (left + right) >= bw) return true;
      return false;
    }
    // 箱が分からないときは、百分率だけで言えることに限る
    const pct = s => { const mm = LEN_PCT.exec(s); return mm ? parseFloat(mm[1]) : (s === '0' ? 0 : null); };
    const [pt, pr, pb, pl] = [pct(t), pct(r), pct(b), pct(l)];
    if (pt !== null && pb !== null && (pt + pb) >= 100) return true;
    if (pl !== null && pr !== null && (pl + pr) >= 100) return true;
    return false;
  }

  // circle() / ellipse() は半径が 0 なら面積も 0。
  // 中心（at …）は面積に関係しないので落とす。
  //
  // 半径にはキーワードも書ける（closest-side / farthest-side）。実測の computed 値は
  // `ellipse(0px closest-side)` のように**数値とキーワードが混ざる**。混在を
  // 「解けない」として捨てていたため、全面が隠れているのに可視と答えていた。
  // キーワード側は 0 ではない（辺までの距離）ので、**片方が 0 なら面積は 0**。
  const SHAPE_KEYWORD = /^(closest|farthest)-side$/;
  // 位置を、参照ボックスの中の px へ直す。解けなければ null。
  function posToPx(s, size) {
    if (s === '0') return 0;
    if (LEN_PX.test(s)) return parseFloat(s);
    if (LEN_PCT.test(s)) return parseFloat(s) / 100 * size;
    return null;
  }
  // 引数を「半径の並び」と「中心の位置」に分ける。
  // 半径を省くと、computed 値は `circle(at 0px 50%)` のように **at から始まる**。
  // `\s+at\s+` で切ると、この形では at の前に空白が無いので切れず、半径の側へ
  // 丸ごと入ってしまう（実測で取りこぼした）。行頭の at も切れるようにする。
  function splitShapeArgs(inner) {
    const m = /(^|\s)at\s+/.exec(inner);
    if (!m) return { radii: inner.trim(), pos: null };
    return { radii: inner.slice(0, m.index).trim(), pos: inner.slice(m.index + m[0].length).trim() };
  }

  // 半径を省いたときの既定は closest-side——中心から参照ボックスのいちばん近い辺
  // までの距離が半径になる。中心が辺の上にあれば 0 で、全面が切り取られる
  // （実測: `circle(closest-side at 0 50%)` は computed 値から半径が消え、
  // 当たり判定でも文字に触れなかった）。中心が箱の外なら負になり、やはり 0。
  function defaultRadiusClipsAll(pos, w, h) {
    if (!(w > 0 && h > 0) || !pos) return false;
    const at = pos.split(/\s+/);
    if (at.length !== 2) return false;
    const cx = posToPx(at[0], w), cy = posToPx(at[1], h);
    if (cx === null || cy === null) return false;
    return Math.min(cx, w - cx, cy, h - cy) <= 0;
  }

  function shapeClipsAll(v, w = null, h = null) {
    const zero = s => s === '0' || /^0(\.0+)?(px|%)$/.test(s);
    const known = s => zero(s) || LEN_PX.test(s) || LEN_PCT.test(s) || SHAPE_KEYWORD.test(s);
    let m = /^circle\((.*)\)$/.exec(v);
    if (m) {
      const { radii, pos } = splitShapeArgs(m[1]);
      return radii !== '' ? zero(radii) : defaultRadiusClipsAll(pos, w, h);
    }
    m = /^ellipse\((.*)\)$/.exec(v);
    if (m) {
      const { radii, pos } = splitShapeArgs(m[1]);
      if (radii === '') return defaultRadiusClipsAll(pos, w, h);   // 縦横とも省略＝closest-side
      const rr = radii.split(/\s+/).filter(Boolean);
      // 縦横どちらかが 0 なら、その時点で面積は 0
      return rr.length > 0 && rr.length <= 2 && rr.some(zero) && rr.every(known);
    }
    return false;
  }

  // clip-path は `<basic-shape> || <geometry-box>` を取る。実測の computed 値は
  // `inset(50%) content-box` のように**参照ボックスが後ろに付く**。これを外して
  // 形だけを解き、百分率はその参照ボックスの実寸に対して解決する
  // （content-box の 50% は、padding を除いた内側の 50%）。
  // 付いていなければ border-box が既定。
  //
  // **参照ボックスだけを書くこともできる**（`clip-path: content-box`）。そのときは
  // その箱の辺がそのまま切り取り線になるので、箱の幅か高さが 0 なら全面が消える。
  // 先頭一致も認めないと、形が無い書き方をまるごと取りこぼす（実測で再現）。
  const GEOMETRY_BOX = /(?:^|\s+)(border-box|padding-box|content-box|margin-box|fill-box|stroke-box|view-box)$/;

  function splitGeometryBox(v) {
    const m = GEOMETRY_BOX.exec(v);
    return m ? { shape: v.slice(0, m.index).trim(), box: m[1] } : { shape: v, box: 'border-box' };
  }

  // 参照ボックスの実寸。取れなければ null を返す（＝箱の大きさを使わない判定へ）。
  const px = s => { const n = parseFloat(s); return Number.isFinite(n) ? n : 0; };
  function refBoxSize(el, cs, box) {
    const bw = el.offsetWidth, bh = el.offsetHeight;   // border box
    if (!(bw > 0 && bh > 0)) return null;
    if (box === 'border-box' || box === 'view-box' || box === 'stroke-box') return { w: bw, h: bh };
    const bl = px(cs.borderLeftWidth), br = px(cs.borderRightWidth);
    const bt = px(cs.borderTopWidth), bb = px(cs.borderBottomWidth);
    if (box === 'padding-box') return { w: bw - bl - br, h: bh - bt - bb };
    if (box === 'content-box' || box === 'fill-box') {
      const pl = px(cs.paddingLeft), pr = px(cs.paddingRight);
      const pt = px(cs.paddingTop), pb = px(cs.paddingBottom);
      return { w: bw - bl - br - pl - pr, h: bh - bt - bb - pt - pb };
    }
    if (box === 'margin-box') {
      const ml = px(cs.marginLeft), mr = px(cs.marginRight);
      const mt = px(cs.marginTop), mb = px(cs.marginBottom);
      return { w: bw + ml + mr, h: bh + mt + mb };
    }
    return { w: bw, h: bh };
  }

  let clipCache = null;   // 走査1回のあいだだけ有効

  function clipsAwayContent(n) {
    if (clipCache) {
      const hit = clipCache.get(n);
      if (hit !== undefined) return hit;
    }
    let v = false;
    // 大きさの確認は安い。ここを先に見て、多くの要素で getComputedStyle を避ける。
    // 寸法は inset() の百分率・絶対長を面積へ換算するのにも使う（border box）。
    const bw = n.offsetWidth, bh = n.offsetHeight;
    const tiny = bw <= 1 && bh <= 1;
    const cs = getComputedStyle(n);
    // display:contents の要素は箱を作らないので、clip も clip-path も**効かない**。
    // 通常の箱と同じに扱うと、見えている文章のほうを落とす（実測: 当たり判定でも
    // 文字に指が当たるのに、印が後ろの文章へ回っていた）。箱を持つ先祖は別に見る。
    if (cs.display === 'contents') {
      if (clipCache) clipCache.set(n, false);
      return false;
    }
    const clip = CLIP_POSITIONS.includes(cs.position) && cs.clip && cs.clip !== 'auto'
      ? cs.clip.replace(/\s+/g, ' ').trim() : '';
    const path = cs.clipPath && cs.clipPath !== 'none' ? cs.clipPath.trim() : '';
    if (clip || path) {
      // 1px 四方まで潰したうえで切り取る書き方（読み上げ専用の定番）か、
      // 面積が 0 になる書き方か。inset は参照ボックスの実寸へ換算して面積で決める。
      const { shape, box } = splitGeometryBox(path);
      const ref = path ? refBoxSize(n, cs, box) : null;
      // 参照ボックスだけを書いた場合。その箱が潰れていれば、中身は全部消える。
      const boxOnly = path !== '' && shape === '';
      v = tiny || rectClipsAll(clip)
        || (boxOnly && ref !== null && (ref.w <= 0 || ref.h <= 0))
        || insetClipsAll(shape, ref ? ref.w : null, ref ? ref.h : null)
        || shapeClipsAll(shape, ref ? ref.w : null, ref ? ref.h : null);
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
  // 除外領域かどうかは、走査1回のあいだ変わらない（こちらが入れるのは空の <sup> だけで、
  // それが本文の**祖先**になることはない）。SKIP は25個ほどの選択子を持つので、
  // テキストノードごとに毎回 closest を呼ぶと積み上がる。要素ごとに覚えて使い回す。
  let skipCache = null;

  function inSkip(el) {
    if (skipCache) {
      const hit = skipCache.get(el);
      if (hit !== undefined) return hit;
    }
    const v = isOurChrome(el) || !!el.closest(SKIP);
    if (skipCache) skipCache.set(el, v);
    return v;
  }

  function isTarget(node) {
    if (isHandled(node)) return false;
    const el = node.parentElement;
    if (!el) return false;
    if (inSkip(el)) return false;

    // ---- ここから下でだけ、テキストの文字列に触れる ----
    const v = node.nodeValue;
    if (!v || !v.trim()) return false;
    // 辞書に当たらないノードで可視性の計算をしないよう、正規表現を先に通す。
    // 逆順にすると全テキストノードでレイアウト計算が走り、ページが重くなる。
    //
    // 当たらなかった節点は**処理済みにする**。文字が変わらない限り答えは同じで、
    // 走査し直すたびに `closest(SKIP)` と正規表現を掛け直す理由が無い。文字が
    // 変わったときは characterData の合図で記録を消す（→ セクション8）。
    // 2,500段落の祖先を隠す／戻すを繰り返す試験では、ここが費用の大半だった。
    // 可視でないだけの節点は**印を付けない**が処理済みにもしない（あとで見えたら注記する）。
    if (!matcher.test(v)) { markHandled(node); return false; }
    if (isVisibleOccurrence(el)) return true;
    // 見えないだけの節点は処理済みにしない。あとで見えたときに拾えるよう控える。
    rememberLatent(node);
    return false;
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

  // 入口と印の結び付きは、**DOM の属性ではなく内部の表**で持つ。
  //
  // 以前はページ要素へ `data-iiyaku-trigger` を書き、その値で querySelector して
  // 引き当てていた。これには3つの穴があった（いずれも実測で再現）:
  //   - ページに同じ属性が既にあると、その値をそのまま自分の ID として採用した。
  //     2つの入口が同じ値を持つと、両方に**相手の説明まで**出た（milestone と wiki）。
  //   - 値に `"` や `]` が入っていると、selector を組んだ時点で SyntaxError になる。
  //   - 属性は cloneNode でそのまま複製されるので、複製側が引き当てられうる。
  // 内部の表なら、ページが何を書いても影響を受けない。ページ要素へ書き込まない
  // ぶん、ページ DOM を汚さないという利点もある。
  const triggerIdOf = new WeakMap();   // 入口の要素 -> 自分が付けた内部 ID
  const iconTrigger = new WeakMap();   // 印 -> その印が属する入口の要素
  // ID から要素を引く表は持たない。持つとページ要素を強く掴んだままになり、
  // ページから外れても解放されない。引き当ては印の側（iconTrigger）から行う。

  // 入口に付ける目印。**書くだけで、ここから入口を探すことはしない。**
  // 名前を以前と変えてある——同じ名前のままだと、ページ側が持っている値と
  // 見分けが付かず、「読まない」という約束を確かめにくい。
  const ENTRANCE_ATTR = 'data-iiyaku-entrance';

  function triggerKey(trigger) {
    let id = triggerIdOf.get(trigger);
    if (!id) {
      id = UID + '-t' + (++triggerSeq);
      triggerIdOf.set(trigger, id);
      // ページ側が同じ名前の属性を既に持っていたら、上書きしない。
      // 引き当ては内部の表なので、書けなくても動作は変わらない。
      if (!trigger.hasAttribute(ENTRANCE_ATTR)) setOwnAttr(trigger, ENTRANCE_ATTR, id);
    }
    ownedTriggers.add(trigger);
    return id;
  }

  // その入口を指す記録が1つも無くなったら、目印を外して手を引く。
  // 残したままにすると、入口でなくなった要素に目印だけが残る
  // （実測: label の for が別の control を指したあと、古い control に残っていた）。
  function releaseTriggerIfUnused(trigger) {
    if (!trigger) return;
    for (const rec of glossed.values()) if (rec.trigger === trigger) return;
    ownedTriggers.delete(trigger);
    triggerIdOf.delete(trigger);
    if (trigger.isConnected &&
        (trigger.getAttribute(ENTRANCE_ATTR) || '').startsWith(UID + '-t')) {
      setOwnAttr(trigger, ENTRANCE_ATTR, null);
    }
  }

  /* ---------- 3-2. 自分が作ったものだけを自分のものとして扱う ---------- */
  // ページ側が、注記済みの領域を丸ごと cloneNode で複製することがある。
  // 複製された印は class も data 属性もそのままなので、見た目には区別が付かない。
  // 自分が作ったものを控えておき、それ以外は自分のものとして扱わない。
  // 「いま自分の正規の印か」。退役したら取り消す（下の retireGloss）。
  const ownedIcons = new WeakSet();
  const ownedTriggers = new WeakSet();
  // 「自分が作った要素か」。こちらは取り消さない。
  // 2つを分けるのは、問いが別だからである。所有を取り消した印を DOM から外すと、
  // その削除は「ページが起こした変更」に見えてしまい、余計なまとめ直しを呼ぶ。
  // 変更の出どころを言うにはこちらを、正規かどうかを言うには上の表を使う。
  const madeIcons = new WeakSet();

  /* ---------- 3-1b. 自分が書いた属性の「予定表」 ---------- */
  // 「その要素は自分のものか」と「その変更を起こしたのは自分か」は別のこと。
  // MutationRecord に変更の主体は載らないので、所有だけで自分の変更と決めると、
  // **ページ側が自分の印へ加えた変更まで無視する**ことになる
  // （実測: ページが正規の印へ style="display:none" を書くと、見えない印が
  // 「説明済み」として残り、後ろの読める語が抑止された）。
  //
  // そこで、自分が書くつもりの「要素 + 属性名 + 値」を控えておき、
  // **その3つが完全に一致する変更だけ**を自分の仕業として無視する。
  // 予定と違う値になっていたら、書いたのは自分ではない。
  const expectedAttrs = new WeakMap();   // Element -> Map<属性名, 期待する値（null は削除）>

  // 本文を割るのも自分である。1回割ると、右側の節点が増える（childList）と同時に、
  // 左側の中身が短くなる（characterData）。どちらも自分の変更なので数え直しの
  // 合図にしない。**1回だけ**受け取って消す（属性の予定表と同じ考え方）。
  // 消さずに覚えっぱなしにすると、そのあとページがその節点を書き換えても
  // 気づけなくなる。実測では、この2つが「1回の変更で2回のまとめ直し」の正体だった。
  const expectedSplit = new WeakSet();   // 割ってできた右側（増える）
  const expectedTrim = new WeakSet();    // 割られた左側（短くなる）

  function setOwnAttr(el, name, value) {
    let m = expectedAttrs.get(el);
    if (!m) expectedAttrs.set(el, m = new Map());
    m.set(name, value);
    if (value === null) el.removeAttribute(name);
    else el.setAttribute(name, value);
  }

  // その属性変更は、自分が予定したとおりのものか
  function isExpectedAttrChange(el, name) {
    const m = expectedAttrs.get(el);
    if (!m || !m.has(name)) return false;
    const want = m.get(name);
    const now = el.getAttribute(name);
    return want === null ? now === null : now === want;
  }

  // 印の祖先をたどって、**自分が作った印**を返す。class だけで見てはいけない。
  // ページ側が `class="iiyaku-icon"` の要素を持っていることがあり、それを
  // 自分のものとして扱うと、そのリンクのクリックを横取りしてしまう（実測）。
  function ownedIconAt(el) {
    for (let n = el; n; n = n.parentElement) if (ownedIcons.has(n)) return n;
    return null;
  }

  // 自分が作った印か（退役したものも含む）。変更の出どころを言うときに使う。
  function madeIconAt(el) {
    for (let n = el; n; n = n.parentElement) if (madeIcons.has(n)) return n;
    return null;
  }

  // 吹き出しと切替ボタンは、**その要素そのもの**で見分ける。
  // class 名で見分けていたときは、ページ側が同じ class を自分の段落へ付けただけで、
  // その段落を自分の持ち物として扱っていた（実測: ページが `.iiyaku-tooltip` を
  // 付けてから自分で隠すと、その変更が「自分の変更」として無視され、中の印が
  // 退役せず、後ろの読める語が抑止された）。名前は誰でも名乗れる。
  function isOurChrome(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (tip && (el === tip || tip.contains(el))) return true;
    if (toggleBtn && (el === toggleBtn || toggleBtn.contains(el))) return true;
    return false;
  }

  // 追加された領域を走査する前に、複製された「自分のふり」を取り除く。
  //
  // 判定は class だけではしない。class は誰でも付けられる。自分が作った印には
  // 読み込みごとに変わる合言葉（data-iiyaku-owner = UID）を入れてあるので、
  // **「合言葉を持つ」かつ「自分が作ったものではない」**＝複製、と決める。
  // ページ側が自前で `.iiyaku-icon` を使っていても、それには触らない。
  function sanitizeClones(root) {
    if (!root || root.nodeType !== Node.ELEMENT_NODE) return;
    const pick = sel => {
      const out = root.matches && root.matches(sel) ? [root] : [];
      if (root.querySelectorAll) out.push(...root.querySelectorAll(sel));
      return out;
    };
    // 複製かどうかは、**自分が書いた説明文そのもの**で決める。
    // 合言葉の値で決めていたときは、値を書き換えた複製も、値を消した複製も
    // すり抜けた（実測: 前者は印として描かれ、後者は幅0のまま Tab で止まった）。
    // 辞書のキーと、そのキーの説明文が一致していれば、それは自分の作ったものの
    // 複製である。ページ側が同じ class を使っているだけの要素には当たらない。
    for (const ic of pick('[data-iiyaku-key]')) {
      if (ownedIcons.has(ic)) continue;
      const key = ic.dataset ? ic.dataset.iiyakuKey : null;
      if (key && Object.prototype.hasOwnProperty.call(DICT, key) && ic.dataset.iiyaku === DICT[key]) {
        ic.remove();
      }
    }
    // 入口の目印も複製される。引き当てには使っていないので実害は無いが、
    // ページに自分の合言葉だけが残るのは紛らわしいので外す。
    // 外すのは「自分の合言葉つきの値」を持つ、自分の入口ではない要素だけ。
    for (const t of pick(`[${ENTRANCE_ATTR}]`)) {
      if (ownedTriggers.has(t)) continue;
      if ((t.getAttribute(ENTRANCE_ATTR) || '').startsWith(UID + '-t')) {
        setOwnAttr(t, ENTRANCE_ATTR, null);
      }
    }
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
    // 読み込みごとに変わる合言葉。複製にはこれもそのまま付いてくるので、
    // 「合言葉あり かつ 自分の作ったものではない」を複製の判定に使う。
    icon.dataset.iiyakuOwner = UID;
    ownedIcons.add(icon);   // 複製された印と区別するため、自分の作ったものを控える
    madeIcons.add(icon);
    return icon;
  }

  function applyIconSemantics(icon, placement) {
    if (placement.kind === 'hosted') {
      // リンク名の後ろへ解説文が丸ごと足されるのを避けるため、装飾として扱う。
      // 説明は、入口となる要素にフォーカス／カーソルが来たときに出す。
      setOwnAttr(icon, 'aria-hidden', 'true');
      setOwnAttr(icon, 'role', null);
      setOwnAttr(icon, 'aria-label', null);
      setOwnAttr(icon, 'tabindex', null);
      // 引き当ては内部の表で行う。属性は「どの入口の装飾か」を人が読めるように
      // 残しているだけで、ここから入口を探すことはしない（ページ側が同じ属性を
      // 持っていても影響を受けないようにするため）。
      setOwnAttr(icon, 'data-iiyaku-for', triggerKey(placement.trigger));
      iconTrigger.set(icon, placement.trigger);
    } else {
      // 押して開閉するので、role は img ではなく button にする。
      // 名前は「どの語の解説か」だけの短いものにし、説明文そのものは
      // ツールチップ側（aria-describedby）に置く。名前と説明が同じ全文だと、
      // 読み上げで同じ内容が二度読まれる。
      setOwnAttr(icon, 'role', 'button');
      setOwnAttr(icon, 'aria-label', `「${icon.dataset.iiyakuTerm}」の解説`);
      setOwnAttr(icon, 'aria-expanded', 'false');
      setOwnAttr(icon, 'tabindex', '0');
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
    setOwnAttr(el, 'aria-describedby', cur.join(' '));
  }

  function removeDescribedBy(el, token) {
    const cur = (el.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
    const next = cur.filter(t => t !== token);
    if (next.length) setOwnAttr(el, 'aria-describedby', next.join(' '));
    else setOwnAttr(el, 'aria-describedby', null);
  }

  // その入口に属する印を、内部の記録から集める。記録は辞書のキーの数（61）で
  // 頭打ちなので、DOM を検索するより安く、ページ側の属性にも左右されない。
  function iconsForTrigger(trigger) {
    const out = [];
    for (const rec of glossed.values()) {
      if (rec.trigger === trigger && rec.icon.isConnected && ownedIcons.has(rec.icon)) out.push(rec.icon);
    }
    return out;
  }

  function triggerOf(icon) {
    const t = iconTrigger.get(icon);
    return t && t.isConnected ? t : null;
  }

  // label 自体はフォーカスを取らないが、カーソルは乗る。
  // その場合は、関連付いた control を入口として扱う。
  // 判定は「自分が入口として登録したか」だけで行う。ページ側が同じ名前の
  // 属性を持っていても、それを入口とは見なさない。
  function triggerNear(el) {
    for (let n = el; n; n = n.parentElement) if (ownedTriggers.has(n)) return n;
    const label = el.closest('label');
    const c = label && label.control;
    return c && ownedTriggers.has(c) ? c : null;
  }

  function hideTip() {
    if (tipDescribed) { removeDescribedBy(tipDescribed, TIP_ID); tipDescribed = null; }
    for (const ic of tipIcons) {
      if (ic.getAttribute('role') === 'button') setOwnAttr(ic, 'aria-expanded', 'false');
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
    tip.dataset.iiyakuOwner = UID;   // 見た目は合言葉つきの要素にだけ与える
    tip.id = TIP_ID;
    tip.setAttribute('role', 'tooltip');
    tip.appendChild(buildTipBody(icons));
    document.body.appendChild(tip);

    tipAnchor = anchor;
    tipIcons = icons;
    tipDescribed = describe || anchor;
    addDescribedBy(tipDescribed, TIP_ID);
    for (const ic of icons) {
      if (ic.getAttribute('role') === 'button') setOwnAttr(ic, 'aria-expanded', 'true');
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
    const icon = ownedIconAt(el);
    if (icon) {
      const trigger = triggerOf(icon);
      return { icons: [icon], anchor: icon, describe: trigger || icon };
    }
    const trigger = triggerNear(el);
    if (trigger) {
      const icons = iconsForTrigger(trigger);
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
      if (!el || !ownedIcons.has(el)) return;   // ページ側の同名 class には反応しない
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();   // Space でページが送られないようにする
        if (tip && tipIcons.length === 1 && tipIcons[0] === el) hideTip();
        else show(requestFrom(el));
      }
    }, true);

    // 触って操作する端末と、留めて読みたい場合。
    document.addEventListener('click', e => {
      const el = asElement(e.target);
      // 自分が作った印のときだけ横取りする。class だけで見ていたため、
      // ページ側の `class="iiyaku-icon"` のリンクを押しても遷移しなくなっていた（実測）。
      const icon = el && ownedIconAt(el);
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
  // 記録した内容と、いまの DOM が食い違っていないか。
  //
  // 印が DOM に在ることだけを見ていると、**語のほうが消された場所に残った印**を
  // 「使える」と誤認する。実測では、語の Text node を消して印だけ残すと、
  // その後に現れた本物の語が「説明済み」として抑止された。ページ側が語と印の
  // あいだへ節点を挿し込んだ場合も、印は語の直後ではなくなる（実測）。
  // だから、記録した組み合わせがそのまま残っているかを毎回確かめる。
  // ここは**レイアウトを起こさない**判定だけを置く（毎回の変更で全記録に掛かるため）。
  // 見え方に関わる判定は下の isUsable に分けてある。
  function isCoherent(rec) {
    if (!rec.icon.isConnected || !rec.termNode.isConnected) return false;
    if (rec.icon.parentNode !== rec.parent || rec.termNode.parentNode !== rec.parent) return false;
    // 合言葉は、印の見た目と複製の判定の両方が拠り所にしている。ページ側が外したり
    // 別の値へ書き換えたりできる以上、**記録の不変条件として毎回確かめる**。
    // 確かめないと、見えないまま Tab で止まる印が残り、後ろの読める語が抑止される
    // （実測: 合言葉を外された印は幅0になるが、role=button と tabindex=0 は残った）。
    if (!ownedIcons.has(rec.icon)) return false;
    if (rec.icon.getAttribute('data-iiyaku-owner') !== UID) return false;

    // ---- 本文の文字に触れる前に、いまも触れてよい場所かを確かめる ----
    // 注記したあとで、ページ側がその場所を編集領域・コード・aria-hidden・inert・
    // hidden へ変えることがある。isTarget は走査の入口で SKIP を先に見るが、
    // ここで同じ順序を守らないと、**触れないと約束した場所の本文を読む**ことになる
    // （実測: contenteditable へ移したあと、記録の照合が中身を読んでいた）。
    // 読まずに退役させれば、その語はふつうの候補として後ろの出現へ回る。
    if (inSkip(rec.parent)) return false;

    // 記録した位置に、記録した語がまだあるか。
    // 語の**うしろに文字が増えていない**ことも要る。増えると印は語の直後ではなく
    // 別の文字列の直後に残るのに、部分一致だけでは整合と見えてしまう
    // （実測: appendData('PAGE_SUFFIX') で印が "A rebasePAGE_SUFFIX" の後ろに残り、
    // 後から現れた本物の rebase が「説明済み」として抑止された）。
    // 注記した時点では必ず termNode.length === splitOffset になっている。
    if (rec.termNode.length !== rec.splitOffset) return false;
    const v = rec.termNode.nodeValue;
    if (v.slice(rec.splitOffset - rec.term.length, rec.splitOffset) !== rec.term) return false;
    // 印は語のすぐ後ろか（ページ側が間へ挿し込んでいないか）
    if (rec.icon.previousSibling !== rec.termNode) return false;
    // 装飾扱いの印は、記録した入口がいまも自分のものとして生きていること。
    // 引き当ては内部の表で行うので、ここで document 全体を引き直さない。
    if (rec.placementKind === 'hosted') {
      if (!rec.trigger || !rec.trigger.isConnected || !ownedTriggers.has(rec.trigger)) return false;
      if (iconTrigger.get(rec.icon) !== rec.trigger) return false;
    }
    return true;
  }

  // いまも「説明として使える」か。**レイアウトを起こす**ので、変更の種類を見て
  // 必要なときだけ呼ぶ（下の reconcileGlosses の deep）。
  //
  // DOM に在って整合していることは、使えることを意味しない。祖先が display:none に
  // なっても、入口が disabled になっても、記録は整合したままである。それを
  // 「説明済み」の証拠にすると、**読める同じ語**が二度と説明されない（実測で再現）。
  //
  // 入口の意味そのものが変わることもある。label の for が別の control を指すように
  // 変わると、HTML 上の正式な関連付けと説明の入口が食い違う（実測: 新しい control へ
  // フォーカスしても説明が出ず、古い control のほうに出た）。だから記録した入口が
  // いまも「その場所から解決される入口」かどうかを、毎回解き直して確かめる。
  // 走査1回のあいだは、同じ記録を測り直さない。
  // `usableGloss` は「その語はもう説明済みか」の判定として、**語が見つかるたびに**
  // 呼ばれる。入口の解き直し（closest ＋ 描画確認）を毎回やると、用語の多いページで
  // 初期走査が 24ms → 34ms になった（10組すべてで遅く、実測）。1回の走査のあいだに
  // 記録の見え方が変わることはないので、ここで覚えてよい。
  let usableCache = null;

  function isUsable(rec) {
    if (usableCache) {
      const hit = usableCache.get(rec);
      if (hit !== undefined) return hit;
    }
    const v = computeUsable(rec);
    if (usableCache) usableCache.set(rec, v);
    return v;
  }

  function computeUsable(rec) {
    if (!isVisibleOccurrence(rec.icon.parentElement)) return false;
    const now = resolvePlacement(rec.parent);
    if (now.kind !== rec.placementKind) return false;
    if (rec.placementKind === 'hosted') {
      if (now.trigger !== rec.trigger) return false;
      return tabbable(rec.trigger);
    }
    return tabbable(rec.icon);
  }

  function usableGloss(key) {
    const rec = glossed.get(key);
    if (!rec) return null;
    if (!isCoherent(rec)) return null;
    return isUsable(rec) ? rec : null;
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
    // 所有をその場で取り消す。取り消さないと、ページが退役した領域を保持していて
    // あとから DOM へ戻したとき、その印が「自分の正規の印」のまま生き返る
    // （実測: 同じ語の、押せる印が2つ並んだ）。
    ownedIcons.delete(rec.icon);
    iconTrigger.delete(rec.icon);
    expectedAttrs.delete(rec.icon);
    if (rec.icon.isConnected) {
      // その印について説明を出している最中なら、先に閉じる
      if (tip && tipIcons.includes(rec.icon)) hideTip();
      rec.icon.remove();     // 外すのは自分が入れた <sup> だけ
    }
    // 印が既にページ側から外されていても、ここへ来る。記録があるので、
    // 用語を含む節点を走査対象へ戻せる（隣をたどる必要がない）。
    handled.delete(rec.termNode);
    // その入口を指す記録が他に無ければ、目印も外して手を引く
    if (rec.placementKind === 'hosted') releaseTriggerIfUnused(rec.trigger);
    return rec;
  }

  // 記録と DOM の食い違いを見つけて片づける。
  //
  // 印が外れる形（GitHub の描き直し）だけでなく、語だけが消される形、語と印の
  // あいだへページ側が節点を挿す形もある。後者は removedNodes を伴わないので、
  // **ノードが増えただけの変更でも**数え直す。記録は辞書のキーの数（61）で
  // 頭打ちなので、毎回全部見ても軽い（DOM の読み取りだけでレイアウトは起こさない）。
  // deep を付けると、見え方・到達性・入口の意味まで確かめる（レイアウトを起こす）。
  // 属性が変わった・文字が書き換わった・ノードが外れた、のいずれかを含む変更と、
  // 画面遷移・ON 復帰のときだけ deep にする。ノードが増えただけの変更では、
  // 見え方は変わらないので安いほうだけを回す。
  function reconcileGlosses(deep) {
    let released = null;
    for (const key of [...glossed.keys()]) {
      const rec = glossed.get(key);
      if (!rec) continue;
      if (!isCoherent(rec) || (deep && !isUsable(rec))) (released ??= []).push(retireGloss(key));
    }
    return released;
  }

  // 正規の印が居なくなったので、ページ全体から選び直す。
  //
  // 世代を進めると、「そのとき既に説明済みだったので何もしなかった」節点も
  // もう一度候補に戻る。これをしないと、**既にページにある2番目の候補**が
  // 永久に選ばれない（実測で、語がページから完全に消えた）。
  // 退役は稀なので、ここだけ全体走査でよい。ふつうの変更では世代は進めない。
  function reselect() {
    generation++;
    return scanInner(document.body);
  }

  /* ---------- 6. 注記 ---------- */
  // 1つのテキストノードに含まれる一致すべてへ注記する。
  //
  // 前から順に処理する。一致ごとに「用語で終わる左側」と「その後ろ」に割り、
  // 後ろを次の一致の作業対象にする。後ろから割ると、先に控えた節点があとの分割で
  // さらに割られ、記録が実物とずれる（片づけのときに別の節点を戻してしまう）。
  function annotate(node) {
    if (isHandled(node)) return 0;
    const parent = node.parentNode;
    if (!parent || parent.nodeType !== Node.ELEMENT_NODE) return 0;

    // 同じ語はページで最初の1回だけ。説明は一度読めば足りるうえ、
    // git の解説ページのような文書では印が数百個になり本文が読めなくなる。
    // ただし前に付けた印が「もう説明として使えない」なら、付け直す。
    const hits = matcher.findHits(node.nodeValue, key => usableGloss(key) !== null);
    if (hits.length === 0) { markHandled(node); return 0; }
    // 付け直すと決まったキーについて、使えなくなった古い印を取り除く。
    // 残しておくと、同じ語の印が画面に2つあることになる。
    for (const h of hits) retireGloss(h.key);

    // 入れる場所の扱いは、印を入れると決まってから調べる。
    // closest() は祖先をたどるので、一致の有無に関わらず全候補で呼ぶと重い
    // （実測で大きなページの初期走査が 15ms から 29ms へ倍増した）。
    const placement = resolvePlacement(parent);
    if (placement.kind === 'skip') { markHandled(node); return 0; }

    let cur = node;        // いま扱っている節点（用語で終わる左側になる）
    let consumed = 0;      // cur の先頭が、元の文字列の何文字目にあたるか
    let added = 0;
    for (const hit of hits) {
      const at = hit.end - consumed;
      // 用語が末尾ちょうどで終わるときは割らない。割ると空の節点が1つ増え、
      // 片づけと付け直しを繰り返すたびに増え続ける（往復のたびに1つずつ）。
      const tail = at < cur.length ? cur.splitText(at) : null;
      if (tail) {
        markHandled(tail);                                  // 断片を再処理しない
        expectedSplit.add(tail);                            // 増えるのも短くなるのも自分
        expectedTrim.add(cur);
      }
      const icon = makeIcon(hit.key, hit.match, DICT[hit.key]);
      parent.insertBefore(icon, tail ?? cur.nextSibling);
      applyIconSemantics(icon, placement);                  // 入った場所を見てから決める
      markHandled(cur);
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
    markHandled(node);
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
                 clipCache = new WeakMap(); clipChainCache = new WeakMap();
                 usableCache = new WeakMap(); skipCache = new WeakMap(); }
    try {
      return fn();
    } finally {
      if (owner) { renderCache = null; visibleCache = null; clipCache = null;
                   clipChainCache = null; usableCache = null; skipCache = null; }
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

  // 見えるようになった語を探す。
  //
  // 全体を走り直さず、控えてある候補（初回に見えていなかった節点）だけを見る。
  // 同じキーに使える印が別の場所にあるなら `findHits` が落とすので、
  // ここで印が2つになることはない（移動もしない。読める説明が1つあれば足りる）。
  function discoverLatent() {
    if (latentOverflow) { latentOverflow = false; return scanInner(document.body); }
    let n = 0;
    for (const node of latent) {
      if (!node.isConnected || isHandled(node)) { latent.delete(node); continue; }
      const el = node.parentElement;
      if (!el) { latent.delete(node); continue; }
      // ---- ここまでで、まだ本文の文字には触れていない ----
      // **触れてよい場所かを、文字を読む前に確かめる。** 走査の入口（isTarget）と
      // 同じ順序にする。控えへ入れたあとで、ページがその場所を編集領域・コード・
      // aria-hidden・inert・hidden へ変えることがある。順序を崩すと、触れないと
      // 約束した本文を読むことになる（実測: 編集中の本文が2秒ごとに読まれていた）。
      // 触れない場所へ移ったものは、読まずに控えから外す。戻ってきたときは、
      // その属性変更が走査し直す場所として渡ってくるので、そこで入り直す。
      if (inSkip(el)) { latent.delete(node); continue; }
      // 見え方を測る前に、「まだ読める説明が無い語」を含むかだけを見る。
      // ここは文字列の照合だけで、レイアウトを起こさない。印は1語につき1つなので、
      // 既に読める印がある語しか入っていない節点は、見えるようになっても何も足せない。
      // 控えからは外さない——その印があとで退役すれば、また候補に戻るからである。
      const v = node.nodeValue;
      if (!v || matcher.findHits(v, key => usableGloss(key) !== null).length === 0) continue;
      if (!isTarget(node)) continue;
      n += annotate(node);
      // 外すのは「もう当たらない」と決まったときだけ。入口がまだ無い節点は控えに残す。
      // ⚠️ ここで先に外して annotate に戻させると、**反復中の Set へ追加**することに
      // なり、その要素をもう一度訪れて無限に回る（実際に固まった）。外すのは後。
      if (isHandled(node)) latent.delete(node);
    }
    return n;
  }

  /* ---------- 8. 変更の検知と、まとめ直しの予約 ---------- */
  // 見え方が変わる合図は、DOM の変更だけではない。CSS の遷移が終わったとき、
  // 画面の幅が変わって media query が入れ替わったとき、`<head>` へ stylesheet が
  // 足されたときも、いま画面に出ている印が使えなくなりうる（すべて実測で再現した）。
  // 合図の出どころはばらばらでも、やることは同じなので、**1つの予約口**へ集める。
  //
  // 1回のまとめ直しでやることの上限（多重に走らせない）:
  //   複製の除去 1 / 整合の確認 1 / 見え方の確認 1 / 世代を進める 1 / 全体の選び直し 1
  let lastUrl = location.href;
  let batchScheduled = false;
  let wantDeep = false;                 // 見え方まで確かめ直すか
  let pendingRoots = new Set();         // 走査し直す場所
  // まとめ直し中の再入は、旗ではなく「自分が起こした変更は数えない」で防いでいる
  // （isSelfMutation / isOurNode）。読まれない旗を残すと、守っているつもりの
  // 不変条件が実際には誰も見ていない、という状態になる。

  function schedule({ deep = false, root = null } = {}) {
    if (deep) wantDeep = true;
    if (root) pendingRoots.add(root);
    if (batchScheduled) return;
    batchScheduled = true;
    // MutationObserver の callback はマイクロタスクなので、そこから予約すると
    // 同じチェックポイントの終わりにまとめて1回だけ走る。
    queueMicrotask(runBatch);
  }

  function runBatch() {
    batchScheduled = false;
    const deep = wantDeep;
    const roots = pendingRoots;
    wantDeep = false;
    pendingRoots = new Set();
    if (!observing) return;

    withRenderCache(() => {
      // ① 記録と DOM の食い違いを片づける。deep なら見え方・到達性・入口の意味まで。
      let released = reconcileGlosses(deep);

      // ② GitHub はページを読み直さずに画面を差し替えることがある。
      //    別のページに移ったら、DOM がそのままでも見え方は変わりうる。
      let full = false;
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        hideTip();
        if (!deep) released = released || reconcileGlosses(true);
        full = true;
      }
      // ③ 正規の印が居なくなったなら、ページ全体から選び直す。
      //    既にページにある候補へ引き継ぐには、世代を進めるしかない。
      if (released) full = true;

      if (full) {
        // 全体を走るので、変更のあった場所を別に走る必要はない
        // （同じ枝を二度歩かない。大きな領域の属性が変わったときに効く）。
        if (released) reselect();      // generation++ ＋ 全体走査
        else scan(document.body);
      } else {
        // 入れ子になった場所は、いちばん外側だけを走ればよい
        for (const n of roots) {
          let covered = false;
          for (let p = n.parentNode; p && !covered; p = p.parentNode) if (roots.has(p)) covered = true;
          if (!covered) scanInner(n);
        }
        // ④ 見え方が変わったのなら、まだ印の無い語も見直す。
        //    全体を走ったときは、そこで既に拾えている（同じ枝を二度歩かない）。
        if (deep) discoverLatent();
      }
    });
  }

  // その変更は、自分が起こしたものか。
  // **所有だけでは決められない**——ページ側も自分の印へ手を出せる（実測）。
  // 属性は「予定表と完全に一致するか」で見る。予定と違えば、書いたのは自分ではない。
  function isSelfMutation(mu) {
    const t = mu.target;
    if (mu.type === 'attributes') {
      // 吹き出しと切替ボタンは自分だけのもので、記録を持たない。
      // ここの位置合わせで毎回いちばん重い経路へ入らないよう、まとめて除く。
      if (isOurChrome(t)) return true;
      return isExpectedAttrChange(t, mu.attributeName);
    }
    return false;
  }

  // 自分が出し入れするもの（印・吹き出し・切替ボタン）か
  function isOurNode(node) {
    const el = node && (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
    if (!el) return false;
    // 退役させた印の削除も「自分が起こした変更」である。所有を取り消したあとに
    // 外すので、ここで所有だけを見ると自分の後始末がページの変更に見えてしまう。
    if (madeIconAt(el)) return true;
    return isOurChrome(el);
  }

  const observer = new MutationObserver(muts => {
    // 複製された「自分のふり」は、走査より前に取り除く
    for (const mu of muts) for (const n of mu.addedNodes) sanitizeClones(n);

    let deep = false;
    const roots = [];
    for (const mu of muts) {
      if (mu.type === 'attributes') {
        if (isSelfMutation(mu)) continue;
        // 属性は絞り込まない。`type` や任意の `data-*` でも、CSS 次第で
        // 見え方は変わる（実測: data-state ひとつで display:none になった）。
        deep = true;
        roots.push(mu.target);
        continue;
      }
      if (mu.type === 'characterData') {
        if (isOurNode(mu.target)) continue;
        // 自分が割ったことで短くなった分は、自分の変更。1回だけ受け取って消す
        // （ここを数えていたので、注記した直後にその節点の処理済み印を自分で
        //   外し、同じ節点をもう一度走査していた）。
        if (expectedTrim.has(mu.target)) { expectedTrim.delete(mu.target); continue; }
        deep = true;
        handled.delete(mu.target);      // 文字が変われば、前の判断の根拠も消えている
        roots.push(mu.target);
        continue;
      }
      // childList。**増えただけでも見え方は変わりうる**——`:has()` や構造疑似クラスを
      // 使えば、子を1つ足すだけで祖先が display:none になる（実測で再現）。
      // 「追加だけなら安全」という前提は置けない。
      // 自分が入れた印と、自分が割ってできた節点は、走査し直す場所に**入れない**。
      // 入れると、印を1つ動かすたびに空のまとめ直しがもう1回走った（実測: 1回の
      // hide で2回。語が節点の末尾で終わる形＝割らない形では1回だったので、
      // 割ったことが原因だと切り分けられた）。
      for (const n of mu.addedNodes) {
        if (expectedSplit.has(n)) { expectedSplit.delete(n); continue; }
        if (!isOurNode(n)) { deep = true; roots.push(n); }
      }
      for (const n of mu.removedNodes) if (!isOurNode(n)) deep = true;
    }
    if (!deep && roots.length === 0) return;
    for (const r of roots) pendingRoots.add(r);
    schedule({ deep });
  });

  const OBSERVE_OPTS = {
    childList: true, subtree: true,
    characterData: true,               // 語そのものの書き換えに、その場で気づく
    attributes: true                   // 属性は絞り込まない（→ 上のコメント）
  };

  // `<head>` の stylesheet が変わると、body には何の変更も出ないまま見え方が変わる。
  // ここは記録の確認だけでよいので、走査し直す場所は渡さない。
  const headObserver = new MutationObserver(muts => {
    for (const mu of muts) if (!isSelfMutation(mu)) { schedule({ deep: true }); return; }
  });
  const HEAD_OPTS = { childList: true, subtree: true, attributes: true };

  // DOM の変更を伴わない合図。CSS の遷移・アニメーションの終わり、画面の大きさの変化。
  const EXTERNAL_SIGNALS = ['transitionend', 'transitioncancel', 'animationend', 'animationcancel'];
  const onExternal = e => { if (!isOurNode(e.target)) schedule({ deep: true }); };
  const onViewport = () => schedule({ deep: true });
  // 利用者の操作は、属性に出ない状態（checked など）を変えうる
  const onInteraction = () => schedule({ deep: true });

  // 属性にも DOM にも出ない変化（property だけの書き換え）は、どの合図にも乗らない。
  // 暇なときにだけ、記録の見え方を確かめ直す。画面が見えていないときは何もしない。
  const IDLE_GAP = 2000;
  let idleTimer = null;
  const canIdle = typeof requestIdleCallback === 'function';
  function scheduleIdleCheck() {
    if (!observing || idleTimer !== null) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (!observing) return;
      // 印が1つも無くても、あとで見えるかもしれない候補があるなら見に行く
      // （property だけの変化は、この経路でしか気づけない）。
      if (document.hidden || (glossed.size === 0 && latent.size === 0)) { scheduleIdleCheck(); return; }
      const run = () => { schedule({ deep: true }); scheduleIdleCheck(); };
      if (canIdle) requestIdleCallback(run, { timeout: IDLE_GAP });
      else run();
    }, IDLE_GAP);
  }

  /* ---------- 9. ON / OFF の切り替え ---------- */
  let observing = false;

  function startRuntime() {
    if (observing) return;
    observing = true;
    // OFF のあいだは見張っていないので、その間の複製はそのまま残っている。
    // **走査より前に、ページ全体から複製を取り除く**（実測: OFF 中に注記済みの
    // 領域を複製して ON へ戻すと、正規の印と複製の印が2つ並んだ）。
    withRenderCache(() => {
      sanitizeClones(document.body);
      // OFF のあいだにページが変わっていることがある。先に記録を見え方まで
      // 確かめ直してから走査する（隠された印を「説明済み」として残さない）。
      if (reconcileGlosses(true)) generation++;
    });
    scan(document.body);
    observer.observe(document.body, OBSERVE_OPTS);
    if (document.head) headObserver.observe(document.head, HEAD_OPTS);
    for (const t of EXTERNAL_SIGNALS) document.addEventListener(t, onExternal, true);
    window.addEventListener('resize', onViewport);
    window.addEventListener('orientationchange', onViewport);
    for (const t of ['input', 'change', 'click']) document.addEventListener(t, onInteraction, true);
    scheduleIdleCheck();
  }

  function stopRuntime() {
    if (!observing) return;
    observer.disconnect();
    headObserver.disconnect();
    for (const t of EXTERNAL_SIGNALS) document.removeEventListener(t, onExternal, true);
    window.removeEventListener('resize', onViewport);
    window.removeEventListener('orientationchange', onViewport);
    for (const t of ['input', 'change', 'click']) document.removeEventListener(t, onInteraction, true);
    if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null; }
    observing = false;
    hideTip();
  }

  // OFF でも印を DOM から消さず、CSS で隠すだけにする。消してしまうと、
  // 分割済みのテキストノードが handled に残ったまま元へ戻らず、
  // ON に直しても付き直さない語が出るため。
  function applyEnabled(next) {
    enabled = next;
    const root = document.documentElement;
    const cls = new Set((root.getAttribute('class') || '').split(/\s+/).filter(Boolean));
    if (enabled) cls.delete(OFF_CLASS); else cls.add(OFF_CLASS);
    setOwnAttr(root, 'class', [...cls].join(' '));
    if (enabled) startRuntime(); else stopRuntime();
    updateToggle();
  }

  /* ---------- 10. トグルボタン ---------- */
  let toggleBtn = null;

  function updateToggle() {
    if (!toggleBtn) return;
    // 「意訳」とは書かない。この拡張は英語を置き換えず、説明を添えるだけのため。
    toggleBtn.textContent = enabled ? '解説 ON' : '解説 OFF';
    setOwnAttr(toggleBtn, 'aria-pressed', String(enabled));
    toggleBtn.title = enabled ? 'クリックすると解説の印を隠します' : 'クリックすると解説の印を表示します';
  }

  function createToggle() {
    const btn = document.createElement('button');
    btn.className = 'iiyaku-toggle';
    btn.dataset.iiyakuOwner = UID;   // 見た目は合言葉つきの要素にだけ与える
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

  /* ---------- 10-2. 合言葉の値まで見る（見た目の側） ---------- */
  // `styles.css` は合言葉の**有無**しか見られない。読み込みごとに変わる値を
  // 静的なファイルへ書けないためである。そこで、値が自分のものでない要素からは
  // 自分の装飾を引き上げる規則を、走り出しに1つだけ足す。
  // 消すのではなく「与えない」だけなので、ページ側の要素を壊さない。
  function scopeOwnStyle() {
    try {
      const st = document.createElement('style');
      const not = `.iiyaku-icon[data-iiyaku-owner]:not([data-iiyaku-owner="${CSS.escape(UID)}"])`;
      st.textContent =
        `${not}{display:inline;width:auto;height:auto;border:0;margin-left:0;` +
        `background:none;opacity:1;cursor:auto}` +
        `${not}::after{content:none}`;
      (document.head || document.documentElement).appendChild(st);
    } catch (e) {
      // 足せなくても本体の動作は変わらない（複製は sanitizeClones が取り除く）
      console.error('[iiyaku] 見た目の絞り込みを足せません:', e);
    }
  }

  /* ---------- 11. 実行 ---------- */
  scopeOwnStyle();
  bindTip();        // 監視の ON / OFF に関わらず、入口は一度だけ張る
  createToggle();
  applyEnabled(enabled);
})();
