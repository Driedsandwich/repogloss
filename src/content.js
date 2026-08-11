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
    // 自分の印・吹き出し・切替ボタンは、ここ（class 名）ではなく要素そのもので除く
    // （→ isOurChrome / ownedIconAt）。名前で除くと、ページ側の同名 class まで巻き込み、
    // そのページ本文を一度も走査しなくなる（実測: `class="iiyaku-icon"` の段落が
    // まるごと説明されなかった）。
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
  // 控えるのは「不可視だった」節点だけではない。**いまは入口が無い**だけの節点も
  // ここへ入れる（disabled の button など）。処理済みにしてしまうと、あとで入口が
  // できても同じ世代では二度と見ない（実測: disabled を外しても説明が付かなかった）。
  const latent = new Set();          // Text ノード（自分で掃除する）
  const LATENT_MAX = 20000;          // 安全弁。ここまで来たら**捨てずに**、増やすのをやめる
  let latentTruncated = false;

  // 死んだ控え（ページから外れた・もう処理済み）を落として空きを作る。
  let latentPruneGuard = -1;   // 直前に掃除したときの数。変わらないなら掃除し直さない

  function pruneLatent() {
    for (const n of latent) if (!n.isConnected || isHandled(n)) latent.delete(n);
  }

  function rememberLatent(node) {
    // 既に控えてあるなら何もしない。ここで数え直すと、見直しのたびに上限へ達し、
    // **控えを丸ごと捨てて二度と探さなくなる**（実測: ちょうど上限の件数で発生した）。
    if (latent.has(node)) return;
    if (latent.size >= LATENT_MAX) {
      // 満杯でも、まず死んだ控えを落として空きを作る。掃除せずに断ると、
      // 一度上限へ触れただけで、以後ずっと新しい候補を取りこぼす。
      if (latentPruneGuard !== latent.size) { latentPruneGuard = latent.size; pruneLatent(); }
      // 上限では捨てない。捨てると「もう探さない」に化ける。増やすのをやめるだけにして、
      // 取りこぼしがあることを旗に立て、空きができたら索引を作り直す（→ reindexLatent）。
      if (latent.size >= LATENT_MAX) { latentTruncated = true; return; }
      latentPruneGuard = -1;
    }
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

  // 可視性は語の範囲ごとに変わるので、要素を鍵にした覚え書きは持たない

  // 語が「実際に画面へ描かれている場所」に出ているか。
  //
  // 切り取りの**指定が面積0か**だけを見ていては足りなかった。切り取り自体に面積が
  // あっても、その語が切り取りの外に置かれていることがある。実測（画面の画素を数えた）:
  // `overflow:hidden` / `overflow:clip` / 面積のある `clip-path` の外に置いた語は
  // **0画素しか描かれていない**のに印が付き、後ろの読める同じ語が説明されなかった。
  // 描画効果でも同じことが起きる（`filter:opacity(0)` ・`transform:scale(0)` ・
  // 完全に透明な mask。いずれも0画素）。
  //
  // 逆に落としすぎもあった。1px 四方の箱に切り取りの指定があるだけで不可視と決めて
  // いたため、`clip-path: inset(-100px)` で外へ広がって**362画素が実際に描かれて
  // いる**語を除外していた（実測）。
  //
  // だから、大きさの目安ではなく **viewport 座標の矩形**で決める。祖先が課す切り取りを
  // 積み上げ、**語そのものの矩形と交わるか**を見る。交わらなければ描かれていない。
  const CLIP_POSITIONS = ['absolute', 'fixed'];   // legacy clip が効く配置

  // 矩形は viewport 座標の { x1, y1, x2, y2 }。null は「制限なし」。
  function intersectRect(a, b) {
    if (a === null) return b;
    if (b === null) return a;
    return { x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1),
             x2: Math.min(a.x2, b.x2), y2: Math.min(a.y2, b.y2) };
  }
  // 幅か高さが 1px 以下の帯には、読める文字は残らない。読み上げ専用テキストの
  // 定番（1px 四方 ＋ overflow:hidden）は切り取りの指定を持たないこともあるので、
  // 「面積 0」ではなく「読める幅が残らない」を境目にする。
  function rectIsEmpty(r) {
    return r !== null && (r.x2 - r.x1 <= 1 || r.y2 - r.y1 <= 1);
  }

  const px = s => { const n = parseFloat(s); return Number.isFinite(n) ? n : 0; };
  const LEN_PX = /^(-?\d*\.?\d+)px$/;
  const LEN_PCT = /^(-?\d*\.?\d+)%$/;
  const SHAPE_KEYWORD = /^(closest|farthest)-side$/;
  const UNRESOLVED = /calc\(|var\(|min\(|max\(|clamp\(/;

  // 1つの値を px にする。base はその辺の長さ。解けなければ null。
  function lenToPx(part, base) {
    if (part === '0') return 0;
    let m = LEN_PX.exec(part);
    if (m) return parseFloat(m[1]);
    m = LEN_PCT.exec(part);
    if (m) return parseFloat(m[1]) / 100 * base;
    return null;                     // calc() や未知の単位
  }

  // clip-path は `<basic-shape> || <geometry-box>` を取る。実測の computed 値は
  // `inset(50%) content-box` のように**参照ボックスが後ろに付く**。これを外して
  // 形だけを解き、百分率はその参照ボックスの実寸に対して解決する。
  // **参照ボックスだけを書くこともできる**（`clip-path: content-box`）。
  const GEOMETRY_BOX = /(?:^|\s+)(border-box|padding-box|content-box|margin-box|fill-box|stroke-box|view-box)$/;

  function splitGeometryBox(v) {
    const m = GEOMETRY_BOX.exec(v);
    return m ? { shape: v.slice(0, m.index).trim(), box: m[1] } : { shape: v, box: 'border-box' };
  }

  // 参照ボックスを viewport 座標の矩形で返す。border box は実測値をそのまま使う。
  // 変形が掛かっているときは辺の削り込みをしない（回転すると軸に沿った外接矩形に
  // なるため、削ると小さくしすぎる＝落としすぎる方へ倒れる）。
  function refBoxRect(cs, border, transformed, box) {
    const b = { x1: border.left, y1: border.top, x2: border.right, y2: border.bottom };
    if (box === 'border-box' || box === 'view-box' || box === 'stroke-box' || transformed) return b;
    if (box === 'margin-box') {
      return { x1: b.x1 - px(cs.marginLeft), y1: b.y1 - px(cs.marginTop),
               x2: b.x2 + px(cs.marginRight), y2: b.y2 + px(cs.marginBottom) };
    }
    const l = px(cs.borderLeftWidth), r = px(cs.borderRightWidth);
    const t = px(cs.borderTopWidth), bo = px(cs.borderBottomWidth);
    if (box === 'padding-box') return { x1: b.x1 + l, y1: b.y1 + t, x2: b.x2 - r, y2: b.y2 - bo };
    // content-box / fill-box
    return { x1: b.x1 + l + px(cs.paddingLeft), y1: b.y1 + t + px(cs.paddingTop),
             x2: b.x2 - r - px(cs.paddingRight), y2: b.y2 - bo - px(cs.paddingBottom) };
  }

  // inset(...) を矩形にする。解けなければ null（＝制限しない側へ倒す）。
  function insetRect(body, ref) {
    const s = body.split(/\s+round\s+/)[0].trim();
    if (UNRESOLVED.test(s)) return null;
    const parts = s.split(/\s+/).filter(Boolean);
    if (parts.length < 1 || parts.length > 4) return null;
    const [t, r, b, l] =
      parts.length === 1 ? [parts[0], parts[0], parts[0], parts[0]]
      : parts.length === 2 ? [parts[0], parts[1], parts[0], parts[1]]
      : parts.length === 3 ? [parts[0], parts[1], parts[2], parts[1]]
      : parts;
    const w = ref.x2 - ref.x1, h = ref.y2 - ref.y1;
    const top = lenToPx(t, h), bottom = lenToPx(b, h);
    const left = lenToPx(l, w), right = lenToPx(r, w);
    if (top === null || bottom === null || left === null || right === null) return null;
    return { x1: ref.x1 + left, y1: ref.y1 + top, x2: ref.x2 - right, y2: ref.y2 - bottom };
  }

  // 引数を「半径の並び」と「中心の位置」に分ける。
  // 半径を省くと computed 値は `circle(at 0px 50%)` のように **at から始まる**。
  function splitShapeArgs(inner) {
    const m = /(^|\s)at\s+/.exec(inner);
    if (!m) return { radii: inner.trim(), pos: null };
    return { radii: inner.slice(0, m.index).trim(), pos: inner.slice(m.index + m[0].length).trim() };
  }

  // 中心。省略時は 50% 50%。解けなければ null。
  function centerOf(pos, ref) {
    const w = ref.x2 - ref.x1, h = ref.y2 - ref.y1;
    if (!pos) return { cx: ref.x1 + w / 2, cy: ref.y1 + h / 2 };
    const at = pos.split(/\s+/).filter(Boolean);
    if (at.length !== 2) return null;
    const x = lenToPx(at[0], w), y = lenToPx(at[1], h);
    if (x === null || y === null) return null;
    return { cx: ref.x1 + x, cy: ref.y1 + y };
  }

  // 半径1つ。キーワードは中心から辺までの距離で解く（省略時の既定は closest-side）。
  function radiusOf(v, c, ref, axis) {
    const w = ref.x2 - ref.x1, h = ref.y2 - ref.y1;
    const near = axis === 'x' ? Math.min(c.cx - ref.x1, ref.x2 - c.cx)
               : axis === 'y' ? Math.min(c.cy - ref.y1, ref.y2 - c.cy)
               : Math.min(c.cx - ref.x1, ref.x2 - c.cx, c.cy - ref.y1, ref.y2 - c.cy);
    const far = axis === 'x' ? Math.max(c.cx - ref.x1, ref.x2 - c.cx)
              : axis === 'y' ? Math.max(c.cy - ref.y1, ref.y2 - c.cy)
              : Math.max(c.cx - ref.x1, ref.x2 - c.cx, c.cy - ref.y1, ref.y2 - c.cy);
    if (v === '' || v === 'closest-side') return near;
    if (v === 'farthest-side') return far;
    if (SHAPE_KEYWORD.test(v)) return near;
    // circle の百分率は対角線を基準にする（仕様）。ellipse は各軸。
    const base = axis === 'x' ? w : axis === 'y' ? h : Math.sqrt((w * w + h * h) / 2);
    return lenToPx(v, base);
  }

  // 軸に沿った矩形と楕円が交わるか。矩形のうち中心にいちばん近い点が楕円の内側なら交わる。
  // 外接矩形で代用してはいけない——実測: `circle(50px at 60px 60px)` の角に置いた語は
  // 0画素しか描かれていないのに、外接矩形の中なので可視と答えていた。
  function rectHitsEllipse(r, cx, cy, rx, ry) {
    if (!(rx > 0 && ry > 0)) return false;
    const nx = Math.max(r.left, Math.min(cx, r.right));
    const ny = Math.max(r.top, Math.min(cy, r.bottom));
    const dx = (nx - cx) / rx, dy = (ny - cy) / ry;
    return dx * dx + dy * dy <= 1;
  }

  // 角丸の矩形と交わるか。角の四分円の外側だけを落とす。
  function rectHitsRounded(r, box, radius) {
    if (r.right <= box.x1 || r.left >= box.x2 || r.bottom <= box.y1 || r.top >= box.y2) return false;
    if (!(radius > 0)) return true;
    const rr = Math.min(radius, (box.x2 - box.x1) / 2, (box.y2 - box.y1) / 2);
    // 角の四分円の中心
    for (const [cx, cy, qx1, qy1, qx2, qy2] of [
      [box.x1 + rr, box.y1 + rr, box.x1, box.y1, box.x1 + rr, box.y1 + rr],
      [box.x2 - rr, box.y1 + rr, box.x2 - rr, box.y1, box.x2, box.y1 + rr],
      [box.x1 + rr, box.y2 - rr, box.x1, box.y2 - rr, box.x1 + rr, box.y2],
      [box.x2 - rr, box.y2 - rr, box.x2 - rr, box.y2 - rr, box.x2, box.y2]
    ]) {
      // その角の正方形の**中だけ**に収まっている矩形は、四分円との交差で決める
      if (r.left >= qx1 && r.right <= qx2 && r.top >= qy1 && r.bottom <= qy2) {
        return rectHitsEllipse(r, cx, cy, rr, rr);
      }
    }
    return true;
  }

  // 形を、それを囲む矩形にする。囲む矩形は本物の形より**広い**ので、
  // 「交わらない」と言えるときだけ落とす、という向きを崩さない。
  // 形そのものとの交差は shapeHitTest が別に見る（外接矩形だけでは落としきれない）。
  function shapeBoundsRect(shape, ref) {
    if (shape === '') return ref;                       // 参照ボックスだけの指定
    if (UNRESOLVED.test(shape)) return null;
    let m = /^inset\((.*)\)$/.exec(shape);
    if (m) return insetRect(m[1], ref);
    m = /^circle\((.*)\)$/.exec(shape);
    if (m) {
      const { radii, pos } = splitShapeArgs(m[1]);
      const c = centerOf(pos, ref);
      if (!c) return null;
      const r = radiusOf(radii, c, ref, null);
      if (r === null) return null;
      return { x1: c.cx - r, y1: c.cy - r, x2: c.cx + r, y2: c.cy + r };
    }
    m = /^ellipse\((.*)\)$/.exec(shape);
    if (m) {
      const { radii, pos } = splitShapeArgs(m[1]);
      const c = centerOf(pos, ref);
      if (!c) return null;
      const rr = radii === '' ? ['', ''] : radii.split(/\s+/).filter(Boolean);
      if (rr.length !== 2) return null;
      const rx = radiusOf(rr[0], c, ref, 'x'), ry = radiusOf(rr[1], c, ref, 'y');
      if (rx === null || ry === null) return null;
      return { x1: c.cx - rx, y1: c.cy - ry, x2: c.cx + rx, y2: c.cy + ry };
    }
    // polygon() / path() / shape() / rect() / xywh() は解かない。
    // 断定できないので制限しない側（可視）へ倒す。DESIGN.md の既知の限界に書いてある。
    return null;
  }

  // legacy clip: rect(top, right, bottom, left)。border box の左上からの距離。
  // auto はその辺を切らない。
  function legacyClipRect(v, border) {
    const m = /^rect\((.+)\)$/.exec(v.replace(/\s+/g, ' ').trim());
    if (!m) return null;
    const parts = m[1].split(/\s*,\s*|\s+/).filter(Boolean);
    if (parts.length !== 4) return null;
    const [t, r, b, l] = parts;
    const num = (s, edge) => {
      if (s === 'auto') return edge;
      const n = lenToPx(s, 0);
      return n === null ? null : n;
    };
    const top = num(t, 0), right = num(r, border.width),
          bottom = num(b, border.height), left = num(l, 0);
    if (top === null || right === null || bottom === null || left === null) return null;
    return { x1: border.left + left, y1: border.top + top,
             x2: border.left + right, y2: border.top + bottom };
  }

  // 描画効果だけで完全に消えている形。**断定できるものだけ**を並べる。
  const FILTER_OPACITY_ZERO = /(^|[\s(])opacity\(\s*0(\.0+)?%?\s*\)/;

  function isFullyTransparentGradient(v) {
    if (!/^(-webkit-)?(linear|radial|conic|repeating-linear|repeating-radial)-gradient\(/.test(v)) return false;
    const colors = v.match(/rgba?\([^)]*\)/g);
    if (!colors || colors.length === 0) return false;
    return colors.every(c => {
      const m = /^rgba\(([^)]*)\)$/.exec(c);
      if (!m) return false;                       // rgb(...) は不透明
      const parts = m[1].split(/\s*[,/]\s*|\s+/).filter(Boolean);
      return parts.length >= 4 && parseFloat(parts[parts.length - 1]) === 0;
    });
  }

  function paintHidesAll(cs) {
    if (cs.filter && cs.filter !== 'none' && FILTER_OPACITY_ZERO.test(cs.filter)) return true;
    const mi = cs.maskImage || cs.webkitMaskImage;
    if (mi && mi !== 'none' && isFullyTransparentGradient(mi)) return true;
    return false;
  }

  // その要素が課す切り取りを、**逃げられるものと逃げられないものに分けて**返す。
  //   overflow … 絶対・固定配置は、包含ブロックでない祖先のこれを逃れる（CSS 2.2）
  //   shape    … `clip` と `clip-path`。要素と**子孫の描画そのもの**を制限するので逃げられない
  //   tests    … 形そのものとの交差判定（外接矩形だけでは、円や角丸の外を落とせない）
  // 一緒くたにしていたため、包含ブロックでない祖先の clip-path が丸ごと無視されていた
  // （実測: 0画素の語に印が付き、後ろの読める同じ語が説明されなかった）。
  function ownClips(el, cs) {
    if (cs.display === 'contents') return null;      // 箱を作らないので切り取りも効かない
    const border = el.getBoundingClientRect();
    // 変形があっても、**平行移動だけ**なら辺の削り込みはそのまま使える。
    // 回転や拡大縮小のときだけ、軸に沿った外接矩形になるので削らない（落としすぎ防止）。
    const m = /^matrix\(([^)]*)\)$/.exec(cs.transform || '');
    const n = m ? m[1].split(',').map(Number) : null;
    const skewed = cs.transform !== 'none' &&
      !(n && n.length === 6 && n[0] === 1 && n[1] === 0 && n[2] === 0 && n[3] === 1);
    let overflow = null, shape = null;
    const tests = [];
    // ① overflow。切り取り線は padding box（overflow clip edge）。
    //    `auto` と `scroll` は**入れない**——中身はスクロールで読めるので、
    //    画面外というだけで永久に除外すると、長い一覧の下のほうが説明されなくなる。
    const clips = v => v === 'hidden' || v === 'clip';
    const cx = clips(cs.overflowX), cy = clips(cs.overflowY);
    if (cx || cy) {
      let x1 = border.left, y1 = border.top, x2 = border.right, y2 = border.bottom;
      if (!skewed) {
        x1 += px(cs.borderLeftWidth); y1 += px(cs.borderTopWidth);
        x2 -= px(cs.borderRightWidth); y2 -= px(cs.borderBottomWidth);
      }
      const mg = px(cs.overflowClipMargin);   // overflow:clip は外側へ余白を足せる
      if (mg > 0) { x1 -= mg; y1 -= mg; x2 += mg; y2 += mg; }
      if (!cx) { x1 = -Infinity; x2 = Infinity; }
      if (!cy) { y1 = -Infinity; y2 = Infinity; }
      overflow = { x1, y1, x2, y2 };
    }
    // ② legacy clip。**絶対配置の要素にしか効かない**（position を見ずに判定すると、
    //    読める文章のほうを除外する。実測で再現済み）。
    if (CLIP_POSITIONS.includes(cs.position) && cs.clip && cs.clip !== 'auto') {
      const lc = legacyClipRect(cs.clip, border);
      if (lc) shape = intersectRect(shape, lc);
    }
    // ③ clip-path。外接矩形に加えて、形そのものとの交差も控える。
    if (cs.clipPath && cs.clipPath !== 'none') {
      const { shape: sh, box } = splitGeometryBox(cs.clipPath.trim());
      const ref = refBoxRect(cs, border, skewed, box);
      const sr = shapeBoundsRect(sh, ref);
      if (sr) shape = intersectRect(shape, sr);
      const t = shapeHitTest(sh, ref);
      if (t) tests.push(t);
    }
    return { overflow, shape, tests };
  }

  // 形そのものとの交差判定。矩形で足りる形は null を返す（外接矩形だけで決まる）。
  function shapeHitTest(shape, ref) {
    let m = /^circle\((.*)\)$/.exec(shape);
    if (m) {
      const { radii, pos } = splitShapeArgs(m[1]);
      const c = centerOf(pos, ref);
      if (!c) return null;
      const r = radiusOf(radii, c, ref, null);
      if (r === null) return null;
      return rect => rectHitsEllipse(rect, c.cx, c.cy, r, r);
    }
    m = /^ellipse\((.*)\)$/.exec(shape);
    if (m) {
      const { radii, pos } = splitShapeArgs(m[1]);
      const c = centerOf(pos, ref);
      if (!c) return null;
      const rr = radii === '' ? ['', ''] : radii.split(/\s+/).filter(Boolean);
      if (rr.length !== 2) return null;
      const rx = radiusOf(rr[0], c, ref, 'x'), ry = radiusOf(rr[1], c, ref, 'y');
      if (rx === null || ry === null) return null;
      return rect => rectHitsEllipse(rect, c.cx, c.cy, rx, ry);
    }
    // inset(... round R)。角丸を捨てると、角に置かれた語を可視と答える（実測）。
    m = /^inset\((.*)\)$/.exec(shape);
    if (m) {
      const parts = m[1].split(/\s+round\s+/);
      if (parts.length !== 2) return null;
      const box = insetRect(parts[0], ref);
      if (!box) return null;
      const w = box.x2 - box.x1, h = box.y2 - box.y1;
      const first = parts[1].trim().split(/[\s/]+/)[0];
      const rad = lenToPx(first, Math.min(w, h));
      if (rad === null) return null;
      return rect => rectHitsRounded(rect, box, rad);
    }
    return null;
  }

  // 絶対・固定配置の箱は、包含ブロックでない祖先の **overflow** からは逃げる。
  // `clip` と `clip-path` は逃げられない（要素と子孫の描画そのものを制限するため）。
  function establishesContainingBlock(cs, forFixed) {
    if (!forFixed && cs.position !== 'static') return true;
    if (cs.transform !== 'none' || cs.perspective !== 'none') return true;
    if (cs.filter !== 'none') return true;
    if (cs.willChange && /transform|perspective|filter/.test(cs.willChange)) return true;
    if (cs.contain && /paint|layout|strict|content/.test(cs.contain)) return true;
    if (cs.containerType && cs.containerType !== 'normal') return true;
    return false;
  }

  function positionEscape(cs) {
    if (cs.display === 'contents') return 'none';    // 箱を作らないので配置もされない
    return cs.position === 'fixed' ? 'fixed' : cs.position === 'absolute' ? 'absolute' : 'none';
  }

  // 祖先までさかのぼって、その場所の文字に効く事情を1回で集める。
  //   clip        … 積み上げた切り取り（null は制限なし）
  //   tests       … 形そのものとの交差判定の並び
  //   hidden      … 描画効果だけで完全に消えている
  //   transformed … 途中に変形があり、箱の寸法から見た目を推し量れない
  // 逃げ方（mode）によって答えが変わるので、覚えるときも mode ごとに分ける。
  let chainCache = null;

  function paintChain(el, mode) {
    if (!el) return { clip: null, tests: [], hidden: false, transformed: false };
    const cache = chainCache && chainCache[mode];
    if (cache) { const hit = cache.get(el); if (hit !== undefined) return hit; }
    const cs = getComputedStyle(el);
    const applies = mode === 'none' || establishesContainingBlock(cs, mode === 'fixed');
    const up = paintChain(el.parentElement, applies ? positionEscape(cs) : mode);
    let clip = up.clip;
    let tests = up.tests;
    const own = ownClips(el, cs);
    if (own) {
      // <body> と <html> の overflow は viewport へ伝わる（要素自身は切り取らない）。
      // ここを切り取りに数えると、画面の下にあるだけの本文が全部「見えない」になる。
      // ただし **root の clip-path・clip・描画効果は効く**ので、そちらは無視しない。
      const isRoot = el === document.body || el === document.documentElement;
      if (applies && own.overflow && !isRoot) clip = intersectRect(clip, own.overflow);
      if (own.shape) clip = intersectRect(clip, own.shape);         // 形は逃げられない
      if (own.tests.length) tests = tests.concat(own.tests);
    }
    // 描画効果は包含ブロックを作るので、逃げられない。配置に関わらず見る。
    const v = { clip, tests, hidden: up.hidden || paintHidesAll(cs),
                transformed: up.transformed || cs.transform !== 'none' };
    if (cache) cache.set(el, v);
    return v;
  }

  // 文字そのものの矩形。**面積のあるものだけ**を返す。
  // `transform: scale(0)` は箱の寸法（offsetWidth）を変えないので、面積を見ないと
  // 落とせない（実測: 0画素しか描かれていないのに印が付いた）。
  function rangeRects(node, start, end) {
    const r = document.createRange();
    if (start === null) r.selectNodeContents(node);
    else { r.setStart(node, start); r.setEnd(node, end); }
    const out = [];
    for (const x of r.getClientRects()) if (x.width > 0 && x.height > 0) out.push(x);
    return out;
  }

  // **その語**が、切り取りを越えて実際に描かれているか。
  //
  // 親要素まるごとで測ってはいけない。同じ親の中に見えている文字が1つでもあれば、
  // 対象の語が完全に切り取りの外でも可視と答えてしまう（実測: 幅120pxの
  // `overflow:hidden` の段落で、先頭だけが見えていると、はみ出した先の語に印が付き、
  // 後ろの読める同じ語が説明されなかった。その語の矩形の画素は0）。
  //   node … 語を含むテキスト節点／start,end … 語の文字範囲（null なら要素の中身全部）
  function isPaintedRange(el, node, start, end) {
    const chain = paintChain(el, 'none');
    if (chain.hidden) return false;
    if (rectIsEmpty(chain.clip)) return false;
    const rects = rangeRects(node, start, end);
    if (rects.length === 0) return false;
    // 形そのものとの交差（円・楕円・角丸）。外接矩形だけでは角の外を落とせない
    for (const t of chain.tests) if (!rects.some(r => t(r))) return false;
    if (!chain.clip) return true;
    const c = chain.clip;
    // 1px 以下の帯しか残らない交わりは、読める文字にならない
    return rects.some(r => Math.min(r.right, c.x2) - Math.max(r.left, c.x1) > 1 &&
                           Math.min(r.bottom, c.y2) - Math.max(r.top, c.y1) > 1);
  }

  // display:contents は箱を作らない。可視性を判断できる最も近い先祖まで上がる。
  function boxedAncestor(el) {
    let n = el.parentElement;
    while (n && getComputedStyle(n).display === 'contents') n = n.parentElement;
    return n;
  }

  // display:contents の要素にある文字が、実際に読めるか。
  //
  // 箱を持つ先祖の可視性を、そのまま子の答えに使ってはいけない。実測の反例が2つある:
  //   - 先祖が content-visibility:hidden … 先祖自身は描画されたままなので、
  //     先祖に聞くと「見えている」と答える。しかし中身は飛ばされていて読めない。
  //   - 先祖が visibility:hidden で、子が visibility:visible に戻している …
  //     先祖に聞くと「見えていない」。しかし子の文字は見えている。
  // どちらも「先祖の1つの答え」を子へ転用したことが原因なので、性質ごとに分ける。
  //   visibility            … 継承する。子の computed 値が正しい
  //   display:none / opacity / 先祖の content-visibility … 継承しない。先祖に聞く
  //   実際に描かれているか … 子の Range と、積み上げた切り取りで見る
  // content-visibility:auto は落とさない（画面外というだけで永久に除外しないため）。
  function isVisibleContentsText(el, cs, node, start, end) {
    if (cs.visibility !== 'visible') return false;
    const host = boxedAncestor(el);
    if (host) {
      if (!host.checkVisibility(CONTENTS_HOST_OPTS)) return false;
      if (getComputedStyle(host).contentVisibility === 'hidden') return false;
    }
    return isPaintedRange(el, node, start, end);
  }

  // その語が読める場所に描かれているか。**語の範囲**で測る。
  function isVisibleOccurrence(el, node, start, end) {
    if (!el || !el.isConnected) return false;
    // レイアウトを起こすので高い。1要素につき1回だけ取って使い回す。
    const cs = getComputedStyle(el);
    let ok;
    if (cs.display === 'contents') {
      // 箱を作らない要素。Chrome は checkVisibility に false を返すが（実測）、
      // それは「隠れている」ではなく「箱が無い」という意味なので、転用できない。
      ok = HAS_CHECK_VISIBILITY
        ? isVisibleContentsText(el, cs, node, start, end)
        : (cs.visibility === 'visible' && isPaintedRange(el, node, start, end));
    } else if (HAS_CHECK_VISIBILITY) {
      ok = el.checkVisibility(CHECK_VISIBILITY_OPTS);
      // その要素自身が content-visibility:hidden のとき、**中身**は隠れているのに
      // 要素自体は描画されているので checkVisibility は true を返す（実測）。
      if (ok && cs.contentVisibility === 'hidden') ok = false;
      if (ok && !isPaintedRange(el, node, start, end)) ok = false;
    } else {
      // checkVisibility が無い環境。manifest の minimum_chrome_version より古い
      // Chrome か、拡張を手で読み込んだ場合にしか起きない。祖先の opacity や
      // content-visibility は見抜けないので、ここは「落ちないための保険」にすぎない。
      ok = !(cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0');
      if (ok && cs.contentVisibility === 'hidden') ok = false;
      if (ok && !isPaintedRange(el, node, start, end)) ok = false;
    }
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
    // 退役した印は、ページが本文として使い回すことがある。「自分が作った」を
    // 永久の除外理由にすると、その中の文章が二度と走査されない（実測: 使い回した
    // 節点の中の語に、そのタブを開いているあいだ説明が付かなかった）。
    // ここで見るのは「**いま**自分の正規の印か」だけにする。
    const v = isOurChrome(el) || !!ownedIconAt(el) || !!el.closest(SKIP);
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
    // 可視性は**一致した語の範囲**で見る。親要素まるごとで測ると、同じ親に
    // 見えている文字が1つでもあるだけで、切り取りの外の語まで可視と答える。
    if (visibleHits(node, el).length > 0) return true;
    // 見えないだけの節点は処理済みにしない。あとで見えたときに拾えるよう控える。
    rememberLatent(node);
    return false;
  }

  // その節点のうち、**実際に描かれている**一致だけを返す。
  function visibleHits(node, el) {
    const hits = matcher.findHits(node.nodeValue, key => usableGloss(key) !== null);
    return hits.filter(h => isVisibleOccurrence(el, node, h.end - h.match.length, h.end));
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
  // 「自分が作ったことがある」という記録は**持たない**。持つと、退役した印を
  // ページが本文として使い回したときにも自分のものとして扱ってしまい、その領域が
  // 一度も走査されず、同じ語の印が2つ並ぶ経路もできた（どちらも実測）。
  // 変更の出どころは「いま自分のものか（ownedIcons）」と、
  // 「自分が外す直前に控えたか（expectedRemovals）」の2つだけで言う。

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
  // Element -> Map<属性名, [{ from, to }]>。予定は起きた順に1つずつ消費する。
  let expectedAttrs = new WeakMap();

  // 本文を割るのも自分である。1回割ると、右側の節点が増える（childList）と同時に、
  // 左側の中身が短くなる（characterData）。どちらも自分の変更なので数え直しの
  // 合図にしない。**1回だけ**受け取って消す（属性の予定表と同じ考え方）。
  // 消さずに覚えっぱなしにすると、そのあとページがその節点を書き換えても
  // 気づけなくなる。実測では、この2つが「1回の変更で2回のまとめ直し」の正体だった。
  const expectedSplit = new WeakSet();   // 割ってできた右側（増える）
  const expectedTrim = new WeakSet();    // 割られた左側（短くなる）
  // 節点を外すのも自分である。**外す直前にだけ**控え、1回受け取って消す。
  // 「自分が作ったものか（madeIcons）」を永久の証明に使ってはいけない。ページ側が
  // 正規の印を外したことに気づけなくなる（実測: 説明が約2秒間0個になり、
  // 暇なときの確認が来るまで戻らなかった）。作ったのが自分でも、外したのは相手でありうる。
  const expectedRemovals = new WeakSet();

  function removeOwn(node) {
    if (!node) return;
    expectedRemovals.add(node);
    node.remove();
  }

  function isOwnRemoval(node) {
    if (expectedRemovals.has(node)) { expectedRemovals.delete(node); return true; }
    return false;
  }

  function setOwnAttr(el, name, value) {
    let m = expectedAttrs.get(el);
    if (!m) expectedAttrs.set(el, m = new Map());
    // 何も起きない書き込みは予定に積まない。属性が無いものを消しても
    // MutationRecord は出ないので、消費されない予定だけが残る。
    if (value === null && !el.hasAttribute(name)) return;
    let q = m.get(name);
    if (!q) m.set(name, q = []);
    // 予定は「いくつ起きるはずか」を含めて控える。前の値まで覚えておかないと、
    // ページが同じ値へ書き戻した変更まで自分のものとして捨てる（→ 下の consume）。
    q.push({ from: el.getAttribute(name), to: value });
    if (value === null) el.removeAttribute(name);
    else el.setAttribute(name, value);
  }

  // その属性変更は、自分が予定したとおりのものか。**1回だけ**受け取って消す。
  // 消さずに覚えっぱなしにすると、そのあとページが同じ値へ戻した変更に気づけない。
  // 突き合わせは変更前の値で行う（MutationRecord ごとに一意で、順序も保たれる）。
  function consumeExpectedAttr(el, name, oldValue) {
    const m = expectedAttrs.get(el);
    const q = m && m.get(name);
    if (!q || q.length === 0) return false;
    const i = q.findIndex(e => e.from === oldValue);
    if (i === -1) return false;
    q.splice(i, 1);
    if (q.length === 0) m.delete(name);
    return true;
  }

  // 見張っていないあいだの予定は、消費される機会がないまま残る。持ち越すと
  // 再開後の最初のページ変更を自分のものとして捨てるので、切り替えのたびに捨てる。
  function clearExpectations() {
    expectedAttrs = new WeakMap();
  }

  // 印の祖先をたどって、**自分が作った印**を返す。class だけで見てはいけない。
  // ページ側が `class="iiyaku-icon"` の要素を持っていることがあり、それを
  // 自分のものとして扱うと、そのリンクのクリックを横取りしてしまう（実測）。
  function ownedIconAt(el) {
    for (let n = el; n; n = n.parentElement) if (ownedIcons.has(n)) return n;
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

  // 自分の名札。複製の後始末で外すのはこれだけにする。
  const OWN_DATA_ATTRS = ['data-iiyaku', 'data-iiyaku-key', 'data-iiyaku-term',
                          'data-iiyaku-owner', 'data-iiyaku-for'];
  // 印を「押せる・Tab で止まれる」ものにしている属性。これだけを外せば、
  // 見えない停止点でなくなる（class も本文も残す＝ページの持ち物を壊さない）。
  const OWN_SEMANTIC_ATTRS = ['role', 'tabindex', 'aria-label', 'aria-expanded', 'aria-hidden'];
  const OWN_CLASSES = ['iiyaku-icon', 'iiyaku-tooltip', 'iiyaku-toggle'];

  // ページが失って困る中身があるか。Comment や空の Text は中身ではない——
  // それを「中身がある」と数えていたため、複製に空の Text を1つ足すだけで
  // 後始末をすり抜け、見えない Tab の停止点が残った（実測）。
  function hasPageContent(el) {
    for (const n of el.childNodes) {
      if (n.nodeType === Node.ELEMENT_NODE) return true;
      if (n.nodeType === Node.TEXT_NODE && n.nodeValue.trim() !== '') return true;
    }
    return false;
  }

  function stripOperability(el) {
    for (const a of OWN_SEMANTIC_ATTRS) el.removeAttribute(a);
  }
  function stripOwnIdentity(el) {
    for (const a of OWN_DATA_ATTRS) el.removeAttribute(a);
    el.classList.remove(...OWN_CLASSES);
    stripOperability(el);
    removeDescribedBy(el, TIP_ID);
  }

  // 追加された領域を走査する前に、複製された「自分のふり」を無力化する。
  //
  // **辞書の説明文を所有の証明に使ってはいけない。** キーと説明文の一致だけで
  // 消していたため、ページ側が同じ data 属性を持つ要素まで、その本文ごと黙って
  // 消えていた（実測: `<span data-iiyaku-key=… data-iiyaku=…>PAGE DATA</span>` が
  // 起動時に消滅した）。判定は**自分の側の証拠**だけで行い、消すのは
  // 「中身が空で、自分の作ったものの複製だと断定できる」ときに限る。
  //   ① 読み込みごとに変わる合言葉が今回の値 … 自分が作ったものの複製と断定できる
  //   ② 合言葉を消された／書き換えられた複製 … 断定できないので、**空で操作できる**
  //      ものから操作性だけを外す（class も本文も data も触らない）
  // ページ側が中身を入れている節点は、どちらの場合も消さない。退役した印を
  // ページが本文として使い回すことがあり、消すとその文章まで失われる（実測）。
  function sanitizeClones(root) {
    if (!root || root.nodeType !== Node.ELEMENT_NODE) return;
    const pick = sel => {
      const out = root.matches && root.matches(sel) ? [root] : [];
      if (root.querySelectorAll) out.push(...root.querySelectorAll(sel));
      return out;
    };
    // ① 今回の合言葉を持つのに、自分が作ったものではない
    for (const el of pick(`[data-iiyaku-owner="${CSS.escape(UID)}"]`)) {
      // 見るのは「**いま**自分の正規の印か」。「作ったことがある」で除くと、
      // 退役した印をページが DOM へ戻したときに素通りし、同じ語の印が2つ並ぶ（実測）。
      if (ownedIcons.has(el) || isOurChrome(el)) continue;
      if (!hasPageContent(el)) removeOwn(el);
      else stripOwnIdentity(el);
    }
    // ② 合言葉を消された／書き換えられた複製。断定はできないので、条件を重ねる:
    //    自分が作る印と同じ形（<sup> ＋ 自分の class）で、**中身が空**で、
    //    押せる／Tab で止まれる状態のものだけを扱う。ページ側が中身を持つ要素には
    //    触れない（名前だけが同じ要素は、そのページの持ち物である）。
    for (const el of pick('.' + OWN_CLASSES[0])) {
      if (ownedIcons.has(el)) continue;
      if (el.getAttribute('data-iiyaku-owner') === UID) continue;   // ① で扱った
      if (el.tagName !== 'SUP') continue;
      if (hasPageContent(el)) continue;                             // ページの中身がある
      if (!el.hasAttribute('tabindex') && el.getAttribute('role') !== 'button') continue;
      // **自分の名札が2つ以上そろっているものだけ**を扱う。1つだけなら、名前が
      // 同じだけのページの持ち物と区別できない（実測: ページが置いた
      // `<sup class="iiyaku-icon" role="button" tabindex="0" data-iiyaku-owner="page">`
      // から class も role も tabindex も剥がしていた）。自分が作る印は必ず
      // key・説明・用語・合言葉の4つを持つので、1つ消されても2つ以上は残る。
      // 名札を全部消された複製は、見えない停止点として残る——これは既知の限界。
      if (OWN_DATA_ATTRS.filter(a => el.hasAttribute(a)).length < 2) continue;
      stripOwnIdentity(el);
    }
    // 入口の目印も複製される。引き当てには使っていないので実害は無いが、
    // ページに自分の合言葉だけが残るのは紛らわしいので外す。
    // 外すのは「自分の合言葉つきの値」を持つ、自分の入口ではない要素だけ。
    for (const t of pick(`[${ENTRANCE_ATTR}]`)) {
      if (ownedTriggers.has(t)) continue;
      if ((t.getAttribute(ENTRANCE_ATTR) || '').startsWith(UID + '-t')) {
        setOwnAttr(t, ENTRANCE_ATTR, null);
        removeDescribedBy(t, TIP_ID);
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
    if (!el.hasAttribute('aria-describedby')) return;
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
    if (tip) { removeOwn(tip); tip = null; }
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
  // 吹き出しの中か。**いま出している吹き出しそのもの**で見分ける。
  // class 名で見分けると、ページ側が同じ class を使った要素へカーソルが移っただけで
  // 「吹き出しの中へ移った」と誤認し、説明が閉じないまま残る（実測）。
  const inTooltip = target => {
    const el = asElement(target);
    return !!(el && tip && (el === tip || tip.contains(el)));
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
    // 合言葉だけでは足りない。**中身と意味も記録どおりでなければならない。**
    // 確かめないと、ページ側が説明文や役割を書き換えても正規の記録のまま残り、
    // 誤った説明を出し続ける（実測: `data-iiyaku` を書き換えると、3秒後も
    // その文言が吹き出しに出た。role を img へ変えても押せる印として残った）。
    // 食い違ったら退役させ、正しい印を付け直す（本文には触れない）。
    if (rec.icon.tagName !== 'SUP') return false;
    if (!rec.icon.classList.contains('iiyaku-icon')) return false;
    if (rec.icon.dataset.iiyakuKey !== rec.key) return false;
    if (rec.icon.dataset.iiyaku !== DICT[rec.key]) return false;
    if (rec.icon.dataset.iiyakuTerm !== rec.term) return false;
    // 自分が作る印は**必ず空**。ページが中へ書き込んだものを、自分の UI として
    // 抱えたままにしない（実測: 印の中へ入れた文字がそのまま残った）。
    if (rec.icon.firstChild) return false;
    if (rec.placementKind === 'hosted') {
      // 装飾扱い。読み上げに出さず、Tab の順路にも入れない
      if (rec.icon.getAttribute('aria-hidden') !== 'true') return false;
      if (rec.icon.hasAttribute('role') || rec.icon.hasAttribute('tabindex')) return false;
    } else {
      if (rec.icon.getAttribute('role') !== 'button') return false;
      if (rec.icon.getAttribute('tabindex') !== '0') return false;
      if (rec.icon.getAttribute('aria-label') !== `「${rec.term}」の解説`) return false;
      // 読み上げから隠されたまま Tab で止まる印を残さない（実測: ページが
      // `aria-hidden="true"` を足しても、tabindex=0 のまま正規の記録として残った）。
      if (rec.icon.hasAttribute('aria-hidden')) return false;
      // 開閉の状態は出し入れで変わるので、値そのものではなく**取りうる値か**を見る
      const ex = rec.icon.getAttribute('aria-expanded');
      if (ex !== 'true' && ex !== 'false') return false;
    }

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
    // 記録した語の範囲で見る。印の親要素まるごとで測ると、同じ親の別の文字が
    // 見えているだけで「まだ読める」と答えてしまう。
    const start = rec.splitOffset - rec.term.length;
    if (!isVisibleOccurrence(rec.termNode.parentElement, rec.termNode, start, rec.splitOffset)) return false;
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
      // 外すのは自分が入れた <sup> だけ。ただしページがその節点を作り替えて
      // 中身を入れているなら、消すとページの本文まで消える（実測: 使い回された
      // 節点が、その中の文章ごと画面から無くなった）。そのときは手を引くだけにする。
      if (!hasPageContent(rec.icon)) removeOwn(rec.icon);
      else stripOwnIdentity(rec.icon);
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
    // 見えている一致だけを注記する。見えない一致に印を付けると、その語の
    // 「ページで最初の1回」を使い切って、後ろの読める同じ語が説明されなくなる。
    const all = matcher.findHits(node.nodeValue, key => usableGloss(key) !== null);
    if (all.length === 0) { markHandled(node); return 0; }
    const hits = all.filter(h =>
      isVisibleOccurrence(parent, node, h.end - h.match.length, h.end));
    if (hits.length === 0) { rememberLatent(node); return 0; }
    // 付け直すと決まったキーについて、使えなくなった古い印を取り除く。
    // 残しておくと、同じ語の印が画面に2つあることになる。
    for (const h of hits) retireGloss(h.key);

    // 入れる場所の扱いは、印を入れると決まってから調べる。
    // closest() は祖先をたどるので、一致の有無に関わらず全候補で呼ぶと重い
    // （実測で大きなページの初期走査が 15ms から 29ms へ倍増した）。
    const placement = resolvePlacement(parent);
    if (placement.kind === 'skip') {
      // **入口が無いのは、いまだけかもしれない。** disabled が外れる、tabindex が
      // 変わる、label の対応先ができる——どれも入口を生む。処理済みにすると同じ世代
      // では二度と見ないので、控えへ入れて見直す（実測: disabled を外しても、その語は
      // そのタブを開いているあいだ説明されなかった）。
      rememberLatent(node);
      return 0;
    }

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
    if (owner) { renderCache = new WeakMap();
                 // 積み上げた切り取りは「どう逃げているか」で答えが変わるので、
                 // 覚えるときも逃げ方ごとに分ける（混ぜると別の答えを使い回す）。
                 chainCache = { none: new WeakMap(), absolute: new WeakMap(), fixed: new WeakMap() };
                 usableCache = new WeakMap(); skipCache = new WeakMap(); }
    try {
      return fn();
    } finally {
      if (owner) { renderCache = null; chainCache = null;
                   usableCache = null; skipCache = null; }
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
  // 1回で全部を見ない。控えが多いページでは、2秒ごとに毎回 30〜60ms 掛かっていた
  // （実測: 20,000件で 32.7〜60.6ms／1回）。予算を決めて途中で止め、続きは次に回す。
  const LATENT_BUDGET_MS = 8;
  let latentPass = null;       // 見直し中の並び（途中で控えが増えても順番が崩れないようにする）
  let latentCursor = 0;
  let latentResume = null;

  function scheduleLatentResume() {
    if (latentResume !== null) return;
    // マイクロタスクで続けると同じ処理の中で回り続け、区切った意味が無くなる。
    // ブラウザへ一度返してから続ける。
    latentResume = setTimeout(() => {
      latentResume = null;
      if (!observing) return;
      withRenderCache(() => discoverLatent());
    }, 0);
  }

  // 上限で控えきれなかった候補を、控えへ入れ直す。旗を立てるだけで何もしないと
  // 「もう探さない」が黙って続く（実測: 上限の次の1件は、痕跡の残らない見え方の
  // 変化では、そのタブを開いているあいだ説明されなかった）。
  function reindexLatent() {
    pruneLatent();
    // ⚠️ 旗を下ろすのは、**実際に入れ直したときだけ**。先に下ろすと、空きが無くて
    // 引き返した1回で旗が消え、あとで空きができても二度と入れ直さない（実測で再現）。
    if (latent.size >= LATENT_MAX) return;
    latentTruncated = false;
    scanInner(document.body);                // isTarget が控えへ入れ直す
  }

  function discoverLatent() {
    if (latentPass === null) { latentPass = [...latent]; latentCursor = 0; }
    const started = performance.now();
    let n = 0;
    while (latentCursor < latentPass.length) {
      if ((latentCursor & 15) === 0 && performance.now() - started > LATENT_BUDGET_MS) {
        scheduleLatentResume();
        return n;
      }
      const node = latentPass[latentCursor++];
      if (!latent.has(node)) continue;                 // この見直しの途中で外れた
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
    latentPass = null; latentCursor = 0;
    // ひと回りし終えたときだけ、上限で取りこぼした分を入れ直す。
    if (latentTruncated) reindexLatent();
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

    // 見た目の絞り込みが外されていないか（外れていると同名要素へ自分の装飾が戻る）
    ensureOwnStyle();

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
      return consumeExpectedAttr(t, mu.attributeName, mu.oldValue);
    }
    return false;
  }

  // 自分が出し入れするもの（印・吹き出し・切替ボタン）か
  function isOurNode(node) {
    const el = node && (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
    if (!el) return false;
    // 見るのは「**いま**自分の正規の印か」だけ。「自分が作った」を永久の証明に
    // 使うと、退役した節点をページが本文として戻したときにも自分の変更と数え、
    // その領域が一度も走査されない（実測: 使い回された節点の中の語に説明が付かなかった）。
    // 自分が外した削除は expectedRemovals が1回だけ受け取る（→ isOwnRemoval）。
    if (ownedIconAt(el)) return true;
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
        // ただし `<html>` の属性は、走査し直す場所に**入れない**。入れると
        // 1回の書き換えでページ全体を歩き直すことになる（`<head>` の
        // stylesheet と同じ扱い）。見えるようになった語は控えの見直しで拾う。
        if (mu.target !== document.documentElement) roots.push(mu.target);
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
      // 外れた節点は「自分が外す直前に控えたか」だけで判定する。作ったのが自分でも、
      // 外したのはページかもしれない（→ expectedRemovals）。
      for (const n of mu.removedNodes) if (!isOwnRemoval(n)) deep = true;
    }
    if (!deep && roots.length === 0) return;
    for (const r of roots) pendingRoots.add(r);
    schedule({ deep });
  });

  const OBSERVE_OPTS = {
    childList: true, subtree: true,
    characterData: true,               // 語そのものの書き換えに、その場で気づく
    attributes: true,                  // 属性は絞り込まない（→ 上のコメント）
    attributeOldValue: true            // 予定を1件ずつ突き合わせるのに要る
  };

  // `<html>` の属性は、body を見張っていても**1件も届かない**（実測: `data-color-mode`
  // を変えて表示が消えても、まとめ直しは1回も走らず、暇なときの確認まで約2秒かかった）。
  // 見た目を切り替える指定は `<html>` に置かれることが多いので、ここも見張る。
  // 子孫は body 側で見ているので、subtree は付けない（同じ変更を二度数えない）。
  const ROOT_OPTS = { attributes: true, attributeOldValue: true };

  // `<head>` の stylesheet が変わると、body には何の変更も出ないまま見え方が変わる。
  // ここは記録の確認だけでよいので、走査し直す場所は渡さない。
  const headObserver = new MutationObserver(muts => {
    for (const mu of muts) if (!isSelfMutation(mu)) { schedule({ deep: true }); return; }
  });
  const HEAD_OPTS = { childList: true, subtree: true, attributes: true, attributeOldValue: true };

  // DOM の変更を伴わない合図。CSS の遷移・アニメーションの終わり、画面の大きさの変化。
  const EXTERNAL_SIGNALS = ['transitionend', 'transitioncancel', 'animationend', 'animationcancel'];
  const onExternal = e => { if (!isOurNode(e.target)) schedule({ deep: true }); };
  const onViewport = () => schedule({ deep: true });
  // 利用者の操作は、属性に出ない状態（checked など）を変えうる
  const onInteraction = () => schedule({ deep: true });

  // カーソルとフォーカスも合図にする。`:hover` / `:focus-within` だけで開く
  // メニューは、DOM も属性も transition も動かさないので、どの合図にも乗らない。
  // 実測: 400ms 出しただけのメニューには説明が1つも付かず、開けたまま2秒の確認を
  // またいで初めて付いた。短いメニューは、それより先に閉じる。
  //
  // 見直す先が無いなら何もしない。カーソルは大量に動くので、1フレームに1回へまとめる
  // （まとめないと、動かした回数だけまとめ直しが走る）。
  let hoverPending = false;
  const onPointerOrFocus = () => {
    if (latent.size === 0 || hoverPending) return;
    hoverPending = true;
    const fire = () => { hoverPending = false; if (observing) schedule({ deep: true }); };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fire);
    else setTimeout(fire, 16);
  };
  const HOVER_SIGNALS = ['pointerover', 'pointerout', 'focusin', 'focusout'];

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
      // 控えが上限で打ち切られている場合も、控えてある分は見に行く。
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
    // **走査より先に見張り始める。** 走査の途中で自分が起こす変更（本文の分割）は
    // 「次に1回だけ起きるはず」として控えてある。見張っていなければ、その控えは
    // 消費されないまま残り、**そのあとページが起こした最初の文字変更を自分のものと
    // して捨てる**（実測: 語を消しても、次に暇なときの確認が来るまで印が動かなかった）。
    // 見張り始める**前**に書いた予定は、消費される機会が無いまま残る。持ち越すと、
    // あとでページが同じ変更を起こしたときに自分のものとして捨てる（実測: `<html>` の
    // class を消して足し直すと、その変更が捨てられ、暇なときの確認まで約2秒遅れた）。
    clearExpectations();
    observer.observe(document.body, OBSERVE_OPTS);
    // `<html>` の属性も見張る（body だけでは1件も届かない）
    observer.observe(document.documentElement, ROOT_OPTS);
    scan(document.body);
    if (document.head) headObserver.observe(document.head, HEAD_OPTS);
    for (const t of EXTERNAL_SIGNALS) document.addEventListener(t, onExternal, true);
    window.addEventListener('resize', onViewport);
    window.addEventListener('orientationchange', onViewport);
    for (const t of ['input', 'change', 'click']) document.addEventListener(t, onInteraction, true);
    for (const t of HOVER_SIGNALS) document.addEventListener(t, onPointerOrFocus, true);
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
    for (const t of HOVER_SIGNALS) document.removeEventListener(t, onPointerOrFocus, true);
    if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null; }
    if (latentResume !== null) { clearTimeout(latentResume); latentResume = null; }
    latentPass = null; latentCursor = 0;
    observing = false;
    hideTip();
    // 見張っていないあいだに書いた分の予定は、消費される機会が無い。
    // 残すと、再開後の最初のページ変更を自分のものとして捨てる。
    clearExpectations();
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
  // `styles.css` がこの3つの class へ与えている性質。**ここに漏れがあると、
  // ページ側の同名要素へ自分の見た目が残る**（実測: ページが置いた
  // `class="iiyaku-tooltip" data-iiyaku-owner="page"` の要素が、画面に固定され
  // z-index も最大値になっていた）。styles.css との突き合わせは verify.mjs が行う。
  const OWN_STYLE_PROPS = [
    'align-items', 'background', 'background-color', 'border', 'border-radius', 'border-top',
    'bottom', 'box-shadow', 'box-sizing', 'color', 'content', 'cursor', 'display',
    'font-family', 'font-size', 'font-style', 'font-weight', 'height', 'justify-content',
    'line-height', 'margin-left', 'margin-top', 'max-height', 'max-width', 'opacity',
    'outline', 'outline-offset', 'overflow', 'overflow-wrap', 'padding', 'padding-top',
    'pointer-events', 'position', 'right', 'text-align', 'text-decoration', 'transition',
    'user-select', 'vertical-align', 'white-space', 'width', 'word-break', 'z-index'
  ];

  let ownStyle = null;

  function scopeOwnStyle() {
    try {
      const st = document.createElement('style');
      const mine = `[data-iiyaku-owner="${CSS.escape(UID)}"]`;
      // 印だけでなく、吹き出しと切替ボタンも今回の合言葉へ絞る。
      // 合言葉の**有無**しか見ない静的な条件を残すと、ページ側が同じ class と
      // 適当な合言葉を書いただけで、自分の見た目がその要素へ乗る。
      const sels = OWN_CLASSES.map(c => `.${c}[data-iiyaku-owner]:not(${mine})`);
      // 中の部品にも同じ名前を使っているので、そこも一緒に戻す。
      // ページ側の**他の**子孫には触れない（名前を名乗っているものだけ）。
      const inner = ['iiyaku-tooltip-item', 'iiyaku-tooltip-term']
        .map(c => `.iiyaku-tooltip[data-iiyaku-owner]:not(${mine}) .${c}`);
      const revert = OWN_STYLE_PROPS.map(p => `${p}:revert`).join(';');
      st.textContent =
        `${sels.concat(inner).join(',')}{${revert}}` +
        `${sels.map(s => `${s}::after`).join(',')}{content:none}`;
      (document.head || document.documentElement).appendChild(st);
      ownStyle = st;
    } catch (e) {
      // 足せなくても本体の動作は変わらない（複製は sanitizeClones が無力化する）
      console.error('[iiyaku] 見た目の絞り込みを足せません:', e);
    }
  }

  // ページ側が消したら足し直す。消されたままだと、複製や同名要素へ自分の見た目が戻る。
  function ensureOwnStyle() {
    if (ownStyle && ownStyle.isConnected) return;
    ownStyle = null;
    scopeOwnStyle();
  }

  /* ---------- 11. 実行 ---------- */
  scopeOwnStyle();
  bindTip();        // 監視の ON / OFF に関わらず、入口は一度だけ張る
  createToggle();
  applyEnabled(enabled);
})();
