// RepoGloss – content.js
// GitHub 上の英語をそのまま残し、辞書に載っている概念語へ ⓘ を添えて日本語の説明を出す。
// 語の判定そのものは src/matcher.js にある（Node からも同じコードを呼んで検証するため）。
(async () => {
  /* ---------- 0. ON / OFF 状態 ---------- */
  // 設定は chrome.storage.local に置く。localStorage は「いま開いているサイト側」の
  // 保管庫なので、拡張の設定を入れると github.com のデータを汚すことになる。
  const STORE_KEY = 'iiyakuEnabled';
  // 同じ ID がページ側や他の拡張と衝突しないよう、読み込みごとに変える。
  const UID = 'iiyaku-' + Math.random().toString(36).slice(2, 10);
  // OFF の目印。**名前ごと読み込みごとに変える**（第17回 RG-17-05）。
  // 以前は `<html>` の class（第16回 RG-16-06 で是正）→ 固定名の属性、と来たが、
  // 固定名である限りページと共有してしまう。実測: ページが置いた
  // `data-iiyaku-off="page"` を、OFF にすると自分の値で上書きし、ON へ戻すと消していた
  // （消す側だけ直しても、書く側で壊れる）。名前が毎回変われば、そもそも重ならない。
  const OFF_ATTR = 'data-' + UID + '-off';
  const TIP_ID = UID + '-tip';
  // カスケードレイヤーの名前も、**読み込みごとに変える**（第19回 RG-19-06）。
  // 固定名だったため、ページが同じ名前のレイヤーを先に宣言して順序を握れた。
  // 実測: ページが `@layer repogloss-e7b41d-scope, repogloss-e7b41d;` を先に宣言し、
  // 自分の規則をその中へ書くと、**ページ自身の指定が UA 既定へ差し戻されて**いた
  // （display:grid → inline、赤 → 黒、140×30px → auto）。名前が毎回変われば、
  // そもそも同じレイヤーへ入れない。
  const MAIN_LAYER = UID + '-look';
  const SCOPE_LAYER = UID + '-scope';

  let enabled = true;
  try {
    const got = await chrome.storage.local.get(STORE_KEY);
    enabled = got[STORE_KEY] !== false;   // 未設定なら ON
  } catch (e) {
    console.error('[iiyaku] 設定の読み込みに失敗。ON として続行します:', e);
  }

  /* ---------- 1. 辞書読み込み ---------- */
  const DICT_URL = chrome.runtime.getURL('locales/dict.json');
  // 見た目も、辞書と同じ経路で走り出しに読み込む（第19回 RG-19-06）。
  // 以前は `content_scripts.css` として静的に入れていたが、静的なファイルには
  // 読み込みごとに変わる合言葉を書けないので、レイヤー名も選択子も固定になる。
  // ここで読み込み、**選択子へ合言葉を埋めてから**入れる。ページ側の同名要素は
  // そもそも一致しなくなるので、打ち消す規則（revert）が要らなくなった。
  const CSS_URL = chrome.runtime.getURL('styles.css');
  let DICT = {}, CSS_TEXT = '';
  try {
    const [d, c] = await Promise.all([
      fetch(DICT_URL).then(r => r.json()),
      fetch(CSS_URL).then(r => r.text())
    ]);
    DICT = d; CSS_TEXT = c;
  } catch (e) {
    console.error('[iiyaku] dict.json / styles.css 読み込み失敗:', e);
    return;
  }
  // 印の見た目は CSS が作る（`::after` の丸と "i"）。読めていないのに走ると、
  // **見えない押せる点**を並べることになる。失敗したら何もしない。
  if (!CSS_TEXT.trim()) {
    console.error('[iiyaku] styles.css が空です。何もしません');
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

  // 変形の「線形部分」だけを取り出す。平行移動は捨てる——`transform-origin` は
  // 平行移動しか生まないので、線形部分には効かない（だから origin を解かなくてよい）。
  // 平行移動ぶんは、あとで外接矩形の実測値と突き合わせて解く。
  //   戻り値 { m, flat } … m は 2D の線形行列（恒等なら null）、flat は 2D で表せるか
  // `zoom` も見る（第17回 RG-17-03）。`zoom` は箱の寸法を変えずに**描画だけ**を
  // 拡大するので、これを写像へ入れないと `getBoundingClientRect()` と食い違う
  // （実測: `zoom:2` の 120px の箱は、計算後のスタイルでは 120px、矩形では 240px）。
  // 一様な拡大なので、変形の線形部分とは掛ける順序を気にしなくてよい。
  function angleToRad(v) {
    const m = /^(-?[0-9.]+)(deg|rad|grad|turn)$/.exec((v || '').trim());
    if (!m) return null;
    const n = parseFloat(m[1]);
    return m[2] === 'deg' ? n * Math.PI / 180
         : m[2] === 'rad' ? n
         : m[2] === 'grad' ? n * Math.PI / 200
         : n * 2 * Math.PI;
  }

  // `rotate` プロパティ。z 軸まわりだけが 2D で表せる。
  function rotateLinear(v) {
    if (!v || v === 'none') return { m: null, flat: true };
    const p = v.trim().split(/\s+/);
    let ang = null;
    if (p.length === 1) ang = angleToRad(p[0]);
    else if (p.length === 2 && p[0] === 'z') ang = angleToRad(p[1]);
    else if (p.length === 4 && +p[0] === 0 && +p[1] === 0 && +p[2] !== 0) ang = angleToRad(p[3]);
    if (ang === null) return { m: null, flat: false };
    const c = Math.cos(ang), s = Math.sin(ang);
    return { m: { a: c, b: s, c: -s, d: c }, flat: true };
  }

  // `scale` プロパティ。3つ目（z）が 1 以外なら 2D では表せない。
  function scaleLinear(v) {
    if (!v || v === 'none') return { m: null, flat: true };
    const p = v.trim().split(/\s+/).map(x => x.endsWith('%') ? parseFloat(x) / 100 : parseFloat(x));
    if (p.some(x => !isFinite(x))) return { m: null, flat: false };
    if (p.length >= 3 && p[2] !== 1) return { m: null, flat: false };
    return { m: { a: p[0], b: 0, c: 0, d: p.length >= 2 ? p[1] : p[0] }, flat: true };
  }

  function transformLinear(v) {
    if (!v || v === 'none') return { m: null, flat: true };
    const m = /^matrix\(([^)]*)\)$/.exec(v);
    if (!m) return { m: null, flat: false };        // matrix3d など。解かない
    const n = m[1].split(',').map(Number);
    if (n.length !== 6 || n.some(x => !isFinite(x))) return { m: null, flat: false };
    if (n[0] === 1 && n[1] === 0 && n[2] === 0 && n[3] === 1) return { m: null, flat: true };
    return { m: { a: n[0], b: n[1], c: n[2], d: n[3] }, flat: true };
  }

  // その要素の変形の線形部分。
  // ⚠️ `transform` だけを見ていたため、**個別の変形プロパティ**（`rotate` / `scale`）で
  // 回された切り抜きを、回っていないものとして判定していた（第18回 RG-18-03。実測:
  // `rotate:35deg` の楕円の外にある0画素の語に印が付いた）。
  // CSS Transforms 2 の順序は translate → rotate → scale → offset → transform。
  // 平行移動は線形部分に効かないので見ない。`offset-path` に沿う回転は解かない。
  function ownLinear(cs) {
    const z = parseFloat(cs.zoom);
    const zoom = isFinite(z) && z > 0 ? z : 1;
    let m = zoom === 1 ? null : { a: zoom, b: 0, c: 0, d: zoom };
    let flat = !(cs.offsetPath && cs.offsetPath !== 'none');
    for (const part of [rotateLinear(cs.rotate), scaleLinear(cs.scale), transformLinear(cs.transform)]) {
      if (!part.flat) flat = false;
      if (part.m) m = m ? mul(m, part.m) : part.m;
    }
    return { m, flat };
  }

  const IDENTITY = { a: 1, b: 0, c: 0, d: 1 };
  const isIdentity = L => L.a === 1 && L.b === 0 && L.c === 0 && L.d === 1;
  const mul = (p, q) => ({ a: p.a * q.a + p.c * q.b, b: p.b * q.a + p.d * q.b,
                           c: p.a * q.c + p.c * q.d, d: p.b * q.c + p.d * q.d });

  // 要素の**変形前**の座標を viewport 座標へ写す写像。
  // 線形部分 L は祖先から掛け合わせて分かる。平行移動は、L で写した箱の外接矩形が
  // `getBoundingClientRect()` と一致することから逆算する（平行移動は外接矩形の
  // 形を変えないので、この1点で決まる）。
  function localToViewport(L, bw, bh, border) {
    const xs = [], ys = [];
    for (const [x, y] of [[0, 0], [bw, 0], [bw, bh], [0, bh]]) {
      xs.push(L.a * x + L.c * y); ys.push(L.b * x + L.d * y);
    }
    const tx = border.left - Math.min(...xs), ty = border.top - Math.min(...ys);
    const det = L.a * L.d - L.b * L.c;
    if (!det) return null;                       // つぶれている＝面積が無い（別で落ちる）
    return {
      to: (x, y) => [L.a * x + L.c * y + tx, L.b * x + L.d * y + ty],
      // viewport 座標の矩形を、変形前の座標へ戻す。
      //
      // ⚠️ 4隅をそのまま戻してはいけない（第18回 RG-18-03）。`getClientRects()` が返すのは
      // **回った箱の外接矩形**なので、それを戻すと元より大きな平行四辺形になり、形の外の
      // 語まで拾う（実測: 35°回した楕円の外の0画素の語に印が付いた。元の箱は約12×4なのに
      // 戻すと約17×16になっていた）。
      //
      // 元の箱は復元できる。変形前の箱を w×h とすると、外接矩形の寸法は
      //   W = |a|w + |c|h,  H = |b|w + |d|h
      // なので、この2式を解けばよい（中心は、外接矩形の中心を戻した点と一致する）。
      //
      // ⚠️ ちょうど45°など |a||d| = |b||c| のときは解が定まらない。以前はそこで
      // **viewport の外接矩形の4隅を逆写像した平行四辺形**へ落としていたが、これは
      // 実際の文字より大きく、形の外の語まで拾う（第19回 RG-19-03。実測: 45°回した
      // 楕円の外の語は0画素・5点すべての hit test が BODY なのに印が付いた）。
      // 広く見積もった形を「見える」の根拠にはできないので、**null を返して
      // 「断定できない」**にする。後ろに確実に見える同じ語があればそちらへ付く。
      backPoly: r => {
        const u0 = (r.left + r.right) / 2 - tx, v0 = (r.top + r.bottom) / 2 - ty;
        const cx = (L.d * u0 - L.c * v0) / det, cy = (L.a * v0 - L.b * u0) / det;
        const W = r.right - r.left, H = r.bottom - r.top;
        const D = Math.abs(L.a) * Math.abs(L.d) - Math.abs(L.b) * Math.abs(L.c);
        if (Math.abs(D) > 1e-6) {
          const w = (W * Math.abs(L.d) - H * Math.abs(L.c)) / D;
          const h = (H * Math.abs(L.a) - W * Math.abs(L.b)) / D;
          if (isFinite(w) && isFinite(h) && w >= 0 && h >= 0) {
            return [[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2],
                    [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2]];
          }
        }
        return null;
      }
    };
  }

  // 変形前の座標での参照ボックス。
  function refBoxLocal(cs, bw, bh, box) {
    if (box === 'border-box' || box === 'view-box' || box === 'stroke-box') {
      return { x1: 0, y1: 0, x2: bw, y2: bh };
    }
    if (box === 'margin-box') {
      return { x1: -px(cs.marginLeft), y1: -px(cs.marginTop),
               x2: bw + px(cs.marginRight), y2: bh + px(cs.marginBottom) };
    }
    const l = px(cs.borderLeftWidth), r = px(cs.borderRightWidth);
    const t = px(cs.borderTopWidth), b = px(cs.borderBottomWidth);
    if (box === 'padding-box') return { x1: l, y1: t, x2: bw - r, y2: bh - b };
    return { x1: l + px(cs.paddingLeft), y1: t + px(cs.paddingTop),
             x2: bw - r - px(cs.paddingRight), y2: bh - b - px(cs.paddingBottom) };
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
  // ⚠️ 判定は**多角形**で行う（第18回 RG-18-03）。回転した場所では、語の矩形を
  // 変形前へ戻すと平行四辺形になる。その外接矩形で当てていたため、実際には形の外に
  // ある語まで「交わる」と答えていた（実測: 回転した楕円の外の0画素の語に印が付いた）。
  const rectPoly = r => [[r.left, r.top], [r.right, r.top], [r.right, r.bottom], [r.left, r.bottom]];
  const polyBounds = p => ({
    left: Math.min(...p.map(q => q[0])), right: Math.max(...p.map(q => q[0])),
    top: Math.min(...p.map(q => q[1])), bottom: Math.max(...p.map(q => q[1])) });

  // 凸多角形を、軸に沿った箱で切る（Sutherland–Hodgman）
  function clipPolyToBox(poly, box) {
    let out = poly;
    const edges = [
      [p => p[0] >= box.x1, (a, b) => [box.x1, a[1] + (b[1] - a[1]) * (box.x1 - a[0]) / (b[0] - a[0])]],
      [p => p[0] <= box.x2, (a, b) => [box.x2, a[1] + (b[1] - a[1]) * (box.x2 - a[0]) / (b[0] - a[0])]],
      [p => p[1] >= box.y1, (a, b) => [a[0] + (b[0] - a[0]) * (box.y1 - a[1]) / (b[1] - a[1]), box.y1]],
      [p => p[1] <= box.y2, (a, b) => [a[0] + (b[0] - a[0]) * (box.y2 - a[1]) / (b[1] - a[1]), box.y2]]
    ];
    for (const [inside, cut] of edges) {
      const src = out; out = [];
      for (let i = 0; i < src.length; i++) {
        const a = src[i], b = src[(i + 1) % src.length];
        const ia = inside(a), ib = inside(b);
        if (ia) out.push(a);
        if (ia !== ib) out.push(cut(a, b));
      }
      if (out.length === 0) return [];
    }
    return out;
  }

  // 凸多角形と楕円が交わるか。楕円を単位円へ写して、原点との距離で決める。
  function polyHitsEllipse(poly, cx, cy, rx, ry) {
    if (!(rx > 0 && ry > 0) || poly.length < 3) return false;
    const p = poly.map(q => [(q[0] - cx) / rx, (q[1] - cy) / ry]);
    for (const v of p) if (v[0] * v[0] + v[1] * v[1] <= 1) return true;
    let pos = false, neg = false;
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      const cr = (b[0] - a[0]) * (0 - a[1]) - (b[1] - a[1]) * (0 - a[0]);
      if (cr > 0) pos = true; else if (cr < 0) neg = true;
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const L = dx * dx + dy * dy;
      let t = L === 0 ? 0 : ((0 - a[0]) * dx + (0 - a[1]) * dy) / L;
      t = Math.max(0, Math.min(1, t));
      const qx = a[0] + t * dx, qy = a[1] + t * dy;
      if (qx * qx + qy * qy <= 1) return true;      // 辺が円と交わる
    }
    return !(pos && neg);                            // 全部同じ向き＝原点が中
  }

  // `round` の値を、四隅の { rx, ry } へ展開する。
  //   上左・上右・下右・下左 の順で1〜4値。`/` の後ろがあれば、前が水平・後ろが垂直。
  //
  // ⚠️ 百分率は**軸ごとに基準が違う**。`/` が無いときに水平の px 値をそのまま垂直へ
  // 写していたため、正方形でない箱の `round 50%` で縦半径を取り違えていた
  // （第16回 RG-16-02。実測: 200×50px の `inset(0 round 50%)` の中で 17画素
  // 描かれている語に印が付かず、後ろの同じ語だけが説明された）。
  // `/` が無い指定でも、垂直側は**同じ文字列を高さ基準で解き直す**。
  function cornerRadii(spec, box) {
    const w = box.x2 - box.x1, h = box.y2 - box.y1;
    const sides = spec.split('/');
    if (sides.length > 2) return null;
    const expand = (txt, base) => {
      const p = txt.trim().split(/\s+/).filter(Boolean);
      if (p.length < 1 || p.length > 4) return null;
      const four = p.length === 1 ? [p[0], p[0], p[0], p[0]]
        : p.length === 2 ? [p[0], p[1], p[0], p[1]]
        : p.length === 3 ? [p[0], p[1], p[2], p[1]] : p;
      const v = four.map(x => lenToPx(x, base));
      return v.some(x => x === null) ? null : v;
    };
    const hx = expand(sides[0], w);
    const vy = expand(sides.length === 2 ? sides[1] : sides[0], h);
    if (!hx || !vy) return null;
    // 上左・上右・下右・下左
    const radii = [{ rx: hx[0], ry: vy[0] }, { rx: hx[1], ry: vy[1] },
                   { rx: hx[2], ry: vy[2] }, { rx: hx[3], ry: vy[3] }];
    // 隣り合う角が重なるときは、**すべての半径へ同じ係数**を掛けて縮める
    // （CSS Backgrounds 3 の overlapping curves）。角ごとに辺の長さで頭打ちに
    // していたため、`round 80px 80px 0 0` を 100px 幅の箱へ置くと形が歪んでいた。
    let f = 1;
    const limit = (sum, len) => { if (sum > 0 && len / sum < f) f = len / sum; };
    limit(radii[0].rx + radii[1].rx, w);   // 上辺
    limit(radii[3].rx + radii[2].rx, w);   // 下辺
    limit(radii[0].ry + radii[3].ry, h);   // 左辺
    limit(radii[1].ry + radii[2].ry, h);   // 右辺
    if (f < 1) for (const c of radii) { c.rx *= f; c.ry *= f; }
    return radii;
  }

  // 角丸の矩形と交わるか。角ごとの四分楕円の外側だけを落とす。
  function polyHitsRounded(poly, box, radii) {
    // **先に box で切る**（第17回 RG-17-02）。切らずに「角の箱へまるごと収まるか」を
    // 見ていたため、箱の外へはみ出した形は角の判定に入らず、無条件で可視になっていた。
    const q = clipPolyToBox(poly, box);
    if (q.length < 3) return false;
    const b = polyBounds(q);
    // 上左・上右・下右・下左。それぞれ角の箱と、その四分楕円の中心。
    // 半径は cornerRadii が used value まで縮めてあるので、ここでは頭打ちにしない。
    const corners = [
      { rx: radii[0].rx, ry: radii[0].ry, x1: box.x1, y1: box.y1, sx: 1, sy: 1 },
      { rx: radii[1].rx, ry: radii[1].ry, x1: box.x2, y1: box.y1, sx: -1, sy: 1 },
      { rx: radii[2].rx, ry: radii[2].ry, x1: box.x2, y1: box.y2, sx: -1, sy: -1 },
      { rx: radii[3].rx, ry: radii[3].ry, x1: box.x1, y1: box.y2, sx: 1, sy: -1 }
    ];
    for (const c of corners) {
      const rx = c.rx, ry = c.ry;
      if (!(rx > 0 && ry > 0)) continue;
      const qx1 = c.sx > 0 ? c.x1 : c.x1 - rx, qx2 = c.sx > 0 ? c.x1 + rx : c.x1;
      const qy1 = c.sy > 0 ? c.y1 : c.y1 - ry, qy2 = c.sy > 0 ? c.y1 + ry : c.y1;
      // その角の箱の**中だけ**にあるなら、四分楕円との交差で決まる
      if (b.left >= qx1 && b.right <= qx2 && b.top >= qy1 && b.bottom <= qy2) {
        return polyHitsEllipse(q, c.sx > 0 ? c.x1 + rx : c.x1 - rx,
                                  c.sy > 0 ? c.y1 + ry : c.y1 - ry, rx, ry);
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

  const TRANSPARENT = /^rgba\([^)]*,\s*0(\.0+)?\)$/;

  // 文字そのものが透明なら読めない（第15回 RG-15-05。実測: `color: transparent` の
  // 語に印が付き、後ろの読める同じ語が説明されなかった）。
  //
  // ⚠️ 塗りが透明でも、**文字の形が別の経路で描かれる**ことがある。縁取りは幅だけを
  // 見ていたので、幅はあるが色が透明な語を「読める」と答えていた。逆に、影と
  // `background-clip:text` は見ていなかったので、実際に描かれている語を落としていた
  // （第16回 RG-16-04。実測: 透明な縁取りの語は0画素なのに印が付き、影で描かれた
  // 202画素・背景を文字型に抜いた270画素の語には印が付かなかった）。
  // 断定できるのは「どの経路でも描かれない」ときだけ。
  // 影が、**その語の位置に**届くか。
  // ⚠️ 「不透明な色の影がある」だけでは足りない（第18回 RG-18-04。実測:
  // `text-shadow: 10000px 0 0 black` の語は0画素なのに印が付いた）。影は文字の形を
  // ずらして描くので、ずらし量が語の大きさ（＋ぼかし）を超えると、その語の場所には
  // 何も来ない。
  function shadowPaintsAt(v, rect) {
    if (!v || v === 'none') return false;
    for (const layer of splitTopLevel(v)) {
      const color = (layer.match(/rgba?\([^)]*\)/) || [])[0];
      if (color && TRANSPARENT.test(color)) continue;          // 透明な影は描かない
      const lens = (layer.replace(/rgba?\([^)]*\)/g, '').match(/-?[0-9.]+px/g) || []).map(parseFloat);
      if (lens.length < 2) return true;                        // 読めない＝描かれる側へ倒す
      const [dx, dy] = lens;
      const blur = lens.length > 2 ? Math.abs(lens[2]) : 0;
      if (Math.abs(dx) < rect.width + blur && Math.abs(dy) < rect.height + blur) return true;
    }
    return false;
  }

  // `background-clip: text` の塗りが、**その語の位置に**届くか。
  // ⚠️ 「不透明な背景がある」だけでは足りない（第18回 RG-18-04。実測:
  // `background-position: 10000px 0; background-repeat: no-repeat` の語は0画素なのに
  // 印が付いた）。読み切れない指定は描かれる側へ倒す。
  // ⚠️ `background-size: auto` の**画像**は、背景領域いっぱいではない（第19回 RG-19-04）。
  // auto は置換画像の**自然寸法**を使う。領域全体の寸法で箱を作っていたため、1×1 の
  // 画像を `no-repeat` で置いただけの段落を「語の位置まで塗る」と答えていた
  // （実測: 語の画素は0なのに印が付いた）。自然寸法は同期では分からない——
  // 読みに行けば新しい通信になるので、**断定せず 'unknown' を返す**。
  // gradient の auto は領域いっぱいなので、そちらは今までどおり解ける。
  //   true … 届く／false … 届かない／'unknown' … 断定できない
  // ⚠️ **層は同じ番号どうしで対応する**（第20回 RG-20-05）。以前は2つ間違えていた:
  //   ① `background-size` が `auto` 以外なら即「届く」としていた。実測: 明示 1px×1px の
  //      背景を `no-repeat` で置いた語は0画素なのに印が付いた
  //   ② `background-clip` を層ごとに見ず、文字列全体で `=== 'text'` を見ていた。実測:
  //      1層目だけが `text` の見本で、語は 374画素描かれているのに落としていた
  // `image / size / position / repeat / origin / clip` を同じ層番号で対応付け、
  // 明示の寸法は実寸へ解いて語の矩形と交わるかを見る。
  //   true … 届く／false … 届かない／'unknown' … 断定できない
  // ⚠️ **`background-repeat` は軸ごとに違う**（第21回 RG-21-02）。「`no-repeat` を
  // 含まなければ全面に届く」としていたため、`repeat-x` の背景が下方の語へ届かないのに
  // 可視としていた（実測: 語は0画素なのに印が付いた）。x と y へ正規化する。
  // `space` / `round` は隙間や縮尺が絡むので解かない。
  //   [x が繰り返すか, y が繰り返すか]／null … 解けない
  function repeatAxes(v) {
    const parts = (v || 'repeat').trim().split(/\s+/);
    const one = w => w === 'repeat' ? [true, true]
                   : w === 'no-repeat' ? [false, false]
                   : w === 'repeat-x' ? [true, false]
                   : w === 'repeat-y' ? [false, true] : null;
    if (parts.length === 1) return one(parts[0]);
    const ax = parts[0] === 'repeat' ? true : parts[0] === 'no-repeat' ? false : null;
    const ay = parts[1] === 'repeat' ? true : parts[1] === 'no-repeat' ? false : null;
    return (ax === null || ay === null) ? null : [ax, ay];
  }

  function bgClipTextPaintsAt(el, cs, rect) {
    const at = (v, i, d) => { const a = splitTopLevel(v || d).map(x => x.trim());
                              return a[i % a.length] || d; };
    const clipAll0 = cs.backgroundClip || cs.webkitBackgroundClip || 'border-box';
    const clipList = splitTopLevel(clipAll0).map(x => x.trim());
    // `background-color` はいちばん下に敷かれ、**最後の層の clip** で抜かれる。
    // そこが `text` で色が不透明なら、文字は全面が塗られる。
    if (clipList[clipList.length - 1] === 'text' && !TRANSPARENT.test(cs.backgroundColor || '')) return true;
    const img = cs.backgroundImage;
    if (!img || img === 'none') return false;
    const layers = splitTopLevel(img).map(x => x.trim());
    const border = el.getBoundingClientRect();
    const clipAll = clipAll0;
    let unknown = false;
    for (let i = 0; i < layers.length; i++) {
      // ② その層が文字型に抜かれていなければ、文字は描かない
      if (at(clipAll, i, 'border-box') !== 'text') continue;
      if (isFullyTransparentGradient(layers[i])) continue;
      // ⚠️ **画像の画素は見えない**（第21回 RG-21-01）。明示の寸法があることは
      // 「不透明であること」の証拠にならない。実測: 完全に透明な 1×1 PNG を
      // `background-size:100% 100%` で敷いた語は0画素なのに印が付いた。
      // 中身を知るには読み込みが要る（新しい通信になる）ので、**断定しない**。
      if (!isGradientLayer(layers[i])) { unknown = true; continue; }
      // ⚠️ **`background-origin` も層ごと**（第21回 RG-21-02）。以前はカンマ区切りの
      // 値全体を1つの origin として扱っており、`content-box, border-box` の1層目を
      // padding-box へ落としていた（実測: 語は 320画素描かれているのに印が付かなかった）。
      const og = at(cs.backgroundOrigin, i, 'padding-box');
      const area = refBoxRect(cs, border, false,
                              og === 'content-box' ? 'content-box'
                            : og === 'border-box' ? 'border-box' : 'padding-box');
      const aw = area.x2 - area.x1, ah = area.y2 - area.y1;
      const rep = repeatAxes(at(cs.backgroundRepeat, i, 'repeat'));
      if (rep === null) { unknown = true; continue; }               // space / round は解かない
      // ① 塗る箱の寸法を出す
      const sz = at(cs.backgroundSize, i, 'auto');
      let bw, bh;
      if (sz === 'auto' || sz === 'auto auto' || /^(cover|contain)$/.test(sz)) {
        bw = aw; bh = ah;                                           // gradient は領域いっぱい
      } else {
        const parts = sz.split(/\s+/);
        bw = parts[0] === 'auto' ? aw : lenToPx(parts[0], aw);
        bh = parts[1] === undefined || parts[1] === 'auto' ? ah : lenToPx(parts[1], ah);
        if (bw === null || bh === null) { unknown = true; continue; }
      }
      // 置く場所。繰り返す軸は領域いっぱいへ広がる
      const pv = at(cs.backgroundPosition, i, '0% 0%').split(/\s+/);
      const px0 = rep[0] ? 0 : lenToPx(pv[0], aw - bw);
      const py0 = rep[1] ? 0 : lenToPx(pv[1] !== undefined ? pv[1] : '50%', ah - bh);
      if (px0 === null || py0 === null) { unknown = true; continue; }
      const box = { x1: area.x1 + px0, y1: area.y1 + py0,
                    x2: area.x1 + (rep[0] ? aw : px0 + bw),
                    y2: area.y1 + (rep[1] ? ah : py0 + bh) };
      if (rect.right > box.x1 && rect.left < box.x2 && rect.bottom > box.y1 && rect.top < box.y2) return true;
    }
    return unknown ? 'unknown' : false;
  }

  const GRADIENT = /^(-webkit-)?(repeating-)?(linear|radial|conic)-gradient\(/;
  const isGradientLayer = v => GRADIENT.test(v);

  // その語の位置に、文字が描かれるか。
  //   true … 描かれる／false … 描かれない／'unknown' … 断定できない
  function textPaintsAt(cs, el, rect) {
    const fill = cs.webkitTextFillColor && cs.webkitTextFillColor !== 'currentcolor'
      ? cs.webkitTextFillColor : cs.color;
    if (!TRANSPARENT.test(fill || '')) return true;
    // ① 縁取り。幅と色の**両方**がそろって初めて描かれる
    const sw = parseFloat(cs.webkitTextStrokeWidth || '0');
    const sc = cs.webkitTextStrokeColor || '';
    if (sw > 0 && !TRANSPARENT.test(sc)) return true;
    // ② 影。色と**ずらし量**を見る
    if (shadowPaintsAt(cs.textShadow, rect)) return true;
    // ③ 背景を文字型に抜く指定。塗りが語の位置に届くかを見る。
    // ⚠️ 入口も**層ごと**に見る（第20回 RG-20-05）。文字列全体で `=== 'text'` を
    // 見ていたため、`background-clip: text, border-box` の見本を素通りしていた。
    const bc = cs.backgroundClip || cs.webkitBackgroundClip || '';
    if (splitTopLevel(bc).some(x => x.trim() === 'text')) {
      const s = bgClipTextPaintsAt(el, cs, rect);
      if (s !== false) return s;                                    // true か 'unknown'
    }
    return false;
  }

  // 色の並びのうち、1つでも不透明なものがあるか。`none` は無し。
  // 色を書いていない影（`text-shadow: 0 0 2px`）は `currentColor` なので、
  // 塗りが透明でも描かれうる——読める側へ倒して「不透明あり」とする。
  function anyOpaqueColor(v) {
    if (!v || v === 'none') return false;
    const colors = v.match(/rgba?\([^)]*\)/g);
    if (!colors || colors.length === 0) return true;      // 色の指定が読めない
    return colors.some(c => !TRANSPARENT.test(c));
  }

  // `filter` の並びは**前から順に**適用され、後段の `url()` は前段の出力とは別の
  // 入力から新しい絵を作れる。「どこかに opacity(0) があれば消えている」と
  // 断定していたため、`opacity(0) url(#flood)` で 1,260画素描かれている語を
  // 落としていた（第16回 RG-16-05）。
  // 断定してよいのは、opacity(0) の**後ろに `url()` が1つも無い**ときだけ
  // （ぼかし・明度などは透明な入力を透明のまま返す）。
  // `filter` の並びを**最後まで**たどる。
  // ⚠️ 「最初の opacity(0) より後ろに url があれば可視」で止めていたため、
  // `opacity(0) url(#f) opacity(0)` のように**最後にもう一度 0 になる**並びを
  // 可視と答えていた（第18回 RG-18-05）。
  //   opacity(0) … そこで確実に 0 になる
  //   url(...)   … 別の入力から描き直せるので、それまでの断定を捨てる
  //   その他     … 透明な入力は透明のまま返す（断定は変わらない）
  // 最後まで見て「確実に0」のときだけ消えていると言う。`url()` で描き直された先は
  // 見えているかもしれないので、そこは可視の側へ倒す（断定しない）。
  // ⚠️ `url()` を見たら「見えている」へ**戻して**いた（第19回 RG-19-05）。SVG の
  // filter は `SourceGraphic` 以外を入力にでき、出力は何にでもなる——完全に透明にも
  // できる（実測: `feFlood flood-opacity="0"` を指すだけの filter で、語の画素は0
  // なのに印が付いた）。**解けないものは「断定できない」**として、可視へは昇格しない。
  function filterState(v) {
    const fns = v.match(/[a-zA-Z-]+\([^()]*(\([^()]*\)[^()]*)*\)/g);
    if (!fns) return 'shown';
    let state = 'shown';
    for (const f of fns) {
      if (FILTER_OPACITY_ZERO.test(f)) state = 'hidden';   // ここで確実に 0 になる
      else if (/^url\(/i.test(f)) state = 'unknown';       // 何を描くか解けない
    }
    return state;
  }

  // 色の明るさ（0〜1）。透明なら 0。読めなければ null。
  function luminanceOf(c) {
    const n = (c.match(/[\d.]+/g) || []).map(parseFloat);
    if (n.length < 3) return null;
    const a = n.length > 3 ? n[3] : 1;
    if (a === 0) return 0;
    return (0.2126 * n[0] + 0.7152 * n[1] + 0.0722 * n[2]) / 255 * a;
  }

  // 覆いの1層が、その場所を残すか。
  //   'shown' … 残る／'hidden' … 消える／'unknown' … 断定できない
  // ⚠️ `mask-mode` を見ていなかった（第19回 RG-19-05）。`luminance` では色の明るさが
  // 覆いの値になるので、**黒は 0＝完全に消える**。alpha では黒も不透明なので残る。
  // 既定の `match-source` は、画像・gradient に対しては alpha として働く。
  // ⚠️ **「どこかに明るい色がある」は「その語の場所が残る」ではない**（第20回 RG-20-04）。
  // gradient の中に1つでも不透明／明るい色があれば層全体を残る側にしていたため、
  // 左55%が透明な alpha mask・左55%が黒の luminance mask で、**語は0画素なのに
  // 印が付いて**いた。gradient の値は場所で変わるので、**一様でないものは断定しない**。
  //
  // ⚠️ `match-source` が SVG の `<mask>` を指す場合、参照先の `mask-type` が
  // luminance なら黒は 0 になる。実測: `mask-type="luminance"` の黒い mask で
  // 語は0画素なのに印が付いた。**`url()` はどちらの mode でも断定しない**。
  function maskLayerState(layer, mode) {
    if (isFullyTransparentGradient(layer)) return 'hidden';   // alpha 0 はどちらの解釈でも 0
    // 断片の URL（`url(#id)`）は SVG の `<mask>` を指しうる。`mask-type` が
    // luminance なら黒は 0 になるので、中身を見ないと決められない（第20回 RG-20-04）。
    // → 下の1行が、断片かどうかによらず **URL をすべて**この扱いにする。
    // ⚠️ **画像の画素は見えない**（第21回 RG-21-01）。以前は「断片でない URL は
    // `alpha` / `match-source` なら残る」としていたため、**完全に透明な 1×1 PNG を
    // `mask-image` に置いた語で、語も印も0画素なのに印が Tab の順路へ入って**いた。
    // 中身を知るには読み込みが要る（新しい通信になる）ので、**どの mode でも断定しない**。
    // 背景（`bgClipTextPaintsAt`）と同じ契約にそろえた。
    // ⚠️ 代償: 不透明な画像で覆った語も説明されなくなる（第17回 RG-17-04 の対照）。
    if (!isGradientLayer(layer)) return 'unknown';
    const colors = layer.match(/rgba?\([^)]*\)/g);
    if (!colors || !colors.length) return 'unknown';
    // 一様（すべての色が同じ）でなければ、場所によって値が変わる＝断定しない
    if (colors.some(c => c !== colors[0])) return 'unknown';
    if (mode !== 'luminance') return 'shown';                 // alpha / match-source の gradient
    const l = luminanceOf(colors[0]);
    if (l === null) return 'unknown';
    return l > 0 ? 'shown' : 'hidden';
  }

  // `mask-image` は**層の並び**で、カンマ区切りの各層を合成した結果が最終の覆いになる。
  // 先頭の層だけを見て「透明だから全部消えている」と断定していたため、後ろに不透明な
  // 層がある語を落としていた（第17回 RG-17-04。実測: 透明な gradient と不透明な
  // 画像を並べた語は 391画素描かれているのに印が付かなかった）。
  // 断定してよいのは、**すべての層が完全に透明**なときだけ。
  // 覆い（mask）は層の並びで、`mask-composite` の演算で合成される。
  // ⚠️ 層ごとに透明かを見るだけでは足りない（第18回 RG-18-05。実測: 同じ不透明な層を
  // 2つ `exclude` すると打ち消し合って0画素になるのに、印が付いた）。
  // Porter-Duff の合成は解かない。**足し合わせ以外は「断定できない」**とする。
  function maskState(cs) {
    const v = cs.maskImage || cs.webkitMaskImage;
    if (!v || v === 'none') return 'shown';
    const layers = splitTopLevel(v).map(x => x.trim());
    if (layers.length === 0) return 'shown';
    const comp = splitTopLevel(cs.maskComposite || cs.webkitMaskComposite || 'add').map(x => x.trim());
    const allAdd = comp.every(c => c === '' || c === 'add' || c === 'source-over');
    if (!allAdd) return 'unknown';
    // 層ごとに `mask-mode` を見る。足し合わせなので、1層でも残せば残る。
    const modes = splitTopLevel(cs.maskMode || cs.webkitMaskSourceType || 'match-source').map(x => x.trim());
    let unknown = false;
    for (let i = 0; i < layers.length; i++) {
      const s = maskLayerState(layers[i], modes[i % modes.length] || 'match-source');
      if (s === 'shown') return 'shown';
      if (s === 'unknown') unknown = true;
    }
    return unknown ? 'unknown' : 'hidden';
  }

  // カンマで切る。ただし `rgba(…)` や `url(…)` の中のカンマでは切らない。
  function splitTopLevel(v) {
    const out = [];
    let depth = 0, cur = '';
    for (const ch of v) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim()) out.push(cur);
    return out;
  }

  //   'hidden'  … 描画効果だけで確実に消えている
  //   'unknown' … 解けない指定がある（この候補では語を使い切らない）
  //   'shown'   … 描画効果では消えていない
  function paintState(cs) {
    const f = (cs.filter && cs.filter !== 'none') ? filterState(cs.filter) : 'shown';
    if (f === 'hidden') return 'hidden';
    const m = maskState(cs);
    if (m === 'hidden') return 'hidden';
    return (f === 'unknown' || m === 'unknown') ? 'unknown' : 'shown';
  }

  // その要素が課す切り取りを、**逃げられるものと逃げられないものに分けて**返す。
  //   overflow … 絶対・固定配置は、包含ブロックでない祖先のこれを逃れる（CSS 2.2）
  //   shape    … `clip` と `clip-path`。要素と**子孫の描画そのもの**を制限するので逃げられない
  //   tests    … 形そのものとの交差判定（外接矩形だけでは、円や角丸の外を落とせない）
  // 一緒くたにしていたため、包含ブロックでない祖先の clip-path が丸ごと無視されていた
  // （実測: 0画素の語に印が付き、後ろの読める同じ語が説明されなかった）。
  // その軸で、原点が「終わり側」にあるか（＝スクロール値が負の側へ動くか）。
  //
  // **書字方向10通りを実測して規則にした**（v1.8.17。以前は縦書きの縦方向を
  // いつも正の側と決めつけており、`vertical-rl` ＋ `rtl` の入れ物では上方向へ
  // 動かせる語を「出せない」と落としていた。第18回 RG-18-01）。
  //
  //   writing-mode   dir   scrollLeft   scrollTop
  //   horizontal-tb  ltr   [0, s]       [0, s]
  //   horizontal-tb  rtl   [-s, 0]      [0, s]
  //   vertical-rl    ltr   [-s, 0]      [0, s]
  //   vertical-rl    rtl   [-s, 0]      [-s, 0]
  //   vertical-lr    ltr   [0, s]       [0, s]
  //   vertical-lr    rtl   [0, s]       [-s, 0]
  //   sideways-rl    ltr   [-s, 0]      [0, s]
  //   sideways-rl    rtl   [-s, 0]      [-s, 0]
  //   sideways-lr    ltr   [0, s]       [-s, 0]
  //   sideways-lr    rtl   [0, s]       [0, s]
  //
  // 横は「横書きなら direction、縦書きなら rl かどうか」。
  // 縦は「横書きなら常に正。`sideways-lr` だけ ltr で負、他の縦書きは rtl で負」。
  function scrollAxisNegative(cs, axis) {
    const wm = cs.writingMode || 'horizontal-tb';
    const rtl = cs.direction === 'rtl';
    if (axis === 'x') return wm === 'horizontal-tb' ? rtl : /^(vertical-rl|sideways-rl)$/.test(wm);
    if (wm === 'horizontal-tb') return false;
    return wm === 'sideways-lr' ? !rtl : rtl;
  }

  // その軸で、いまどこまでスクロールできるか。**原点は片側にある**。
  // いまの値が 0 でないときは、その符号だけで原点の側が決まるので、書字方向を見ない。
  function scrollRange(el, cs, axis) {
    const span = axis === 'x' ? Math.max(0, el.scrollWidth - el.clientWidth)
                              : Math.max(0, el.scrollHeight - el.clientHeight);
    const now = axis === 'x' ? el.scrollLeft : el.scrollTop;
    if (span === 0) return { min: now, max: now, now };
    if (now < 0) return { min: -span, max: 0, now };
    if (now > 0) return { min: 0, max: span, now };
    return scrollAxisNegative(cs, axis) ? { min: -span, max: 0, now } : { min: 0, max: span, now };
  }

  // その入れ物で、中身を動かせる量の範囲。scrollLeft を δ 増やすと中身は δ ぶん**左**へ
  // 動くので、中身の動く量は [now - max, now - min]。
  function shiftRange(el, cs, axis) {
    const r = scrollRange(el, cs, axis);
    return [r.now - r.max, r.now - r.min];
  }

  // `scroll-snap-type: <axis> mandatory` の軸。
  // ⚠️ 連続した区間のどこでも止まれる、としてはいけない（第19回 RG-19-02）。
  // mandatory では、有効な止まり位置がある限りブラウザはそこへ吸い寄せるので、
  // 途中の位置では**止まれない**（実測: 0〜200 を頼んでも実効 0、250〜401 を
  // 頼んでも実効 401。その間にある語はどの止まり位置でも読めないのに印が付いた）。
  // 止まり位置そのものは解かない。**いま見えているかだけを断定し、あとは
  // 「断定できない」**として、スクロールが終わってから見直す。
  function snapAxes(cs) {
    const v = cs.scrollSnapType || 'none';
    if (v === 'none' || !/mandatory/.test(v)) return { x: false, y: false };
    if (/^\s*x\b/.test(v)) return { x: true, y: false };
    if (/^\s*y\b/.test(v)) return { x: false, y: true };
    if (/^\s*(block|inline)\b/.test(v)) {           // 論理軸は書字方向で決まる
      const vertical = /^vertical|^sideways/.test(cs.writingMode || 'horizontal-tb');
      const isBlock = /^\s*block\b/.test(v);
      const horizontal = isBlock ? vertical : !vertical;
      return { x: horizontal, y: !horizontal };
    }
    return { x: true, y: true };                    // both
  }

  //   L    … 祖先ぶんも含めた変形の線形部分（viewport ← 変形前の座標）
  //   flat … その変形が 2D で表せるか（3D は解かない）
  function ownClips(el, cs, L, flat) {
    if (cs.display === 'contents') return null;      // 箱を作らないので切り取りも効かない
    const border = el.getBoundingClientRect();
    // 変形があっても、**平行移動だけ**なら辺の削り込みはそのまま使える。
    // 回転や拡大縮小のときだけ、軸に沿った外接矩形になるので削らない（落としすぎ防止）。
    const skewed = !flat || !isIdentity(L);
    let overflow = null, shape = null;
    const tests = [];
    // ① overflow。切り取り線は padding box（overflow clip edge）。
    //    `auto` と `scroll` は**入れない**——中身はスクロールで読めるので、
    //    画面外というだけで永久に除外すると、長い一覧の下のほうが説明されなくなる。
    const clips = v => v === 'hidden' || v === 'clip';
    const scrolls = v => v === 'auto' || v === 'scroll';
    const cx = clips(cs.overflowX), cy = clips(cs.overflowY);
    const padBox = () => {
      let x1 = border.left, y1 = border.top, x2 = border.right, y2 = border.bottom;
      if (!skewed) {
        x1 += px(cs.borderLeftWidth); y1 += px(cs.borderTopWidth);
        x2 -= px(cs.borderRightWidth); y2 -= px(cs.borderBottomWidth);
      }
      return { x1, y1, x2, y2 };
    };
    if (cx || cy) {
      const b = padBox();
      let { x1, y1, x2, y2 } = b;
      // `overflow-clip-margin` が効くのは **`clip` の軸だけ**。`hidden` にも足して
      // いたため、余白のぶん外まで可視扱いになっていた（第16回 RG-16-07。実測:
      // `overflow:hidden; overflow-clip-margin:100px` の外の0画素の語に印が付き、
      // 後ろの読める同じ語が説明されなかった）。
      const mg = px(cs.overflowClipMargin);
      if (mg > 0) {
        if (cs.overflowX === 'clip') { x1 -= mg; x2 += mg; }
        if (cs.overflowY === 'clip') { y1 -= mg; y2 += mg; }
      }
      if (!cx) { x1 = -Infinity; x2 = Infinity; }
      if (!cy) { y1 = -Infinity; y2 = Infinity; }
      overflow = { x1, y1, x2, y2 };
    }
    // スクロールで動かせる入れ物。中身は画面の外にあっても、**動かせる範囲の中なら**読める。
    //
    // 以前は「スクロールできる祖先が1つでもあれば、到達範囲の検査を丸ごとやめる」と
    // していた。実際に動かせる向きも量も見ていなかったので、`left:-10000px` に置いた
    // 語（どうスクロールしても画面へ出せない）に印が付き、Tab で止まれる点まで
    // できていた（第16回 RG-16-01。実測: 入れ物は 300px 中 85px しか出せない）。
    //
    // ⚠️ 量だけ見て**両側へ同じだけ広げる**のは間違いだった（第17回 RG-17-01）。
    // スクロールの原点は片側にあり、その手前へは1pxも動かせない。実測: 横書き左→右の
    // 入れ物では `scrollLeft` は 0〜200 で、負にはできない。`left:-150px` の語は
    // どうやっても画面へ出せないのに印が付き、Tab で止まれる点が残っていた。
    // いまは**軸ごとの実際の可動域**（scrollRange）から、動かせる先を出す。
    // ⚠️ 届く範囲を**1つの矩形へ潰してはいけない**（第18回 RG-18-01）。入れ子の
    // 入れ物では、内側で動かせても外側の切り取り線を越えられないことがある。
    // 実測: 動かせない外側の枠（scrollWidth == clientWidth）の中で、内側の枠が
    // 左へ100pxずれて置かれている形。語は外側の枠の左外にあり、どう動かしても
    // 枠の中へ入らない（`elementFromPoint` も BODY を返す＝描かれていない）のに
    // 印が付いていた。いまは**枠ごとに「箱と動かせる量」を持ち**、内側から外側へ
    // 区間を伝播させて、全部の枠へ同時に入る位置があるかを見る（→ reachable）。
    let scroller = null;
    if (scrolls(cs.overflowX) || scrolls(cs.overflowY)) {
      const snap = snapAxes(cs);
      scroller = {
        box: padBox(),
        dx: scrolls(cs.overflowX) ? shiftRange(el, cs, 'x') : [0, 0],
        dy: scrolls(cs.overflowY) ? shiftRange(el, cs, 'y') : [0, 0],
        snapX: snap.x, snapY: snap.y
      };
    }
    // ② legacy clip。**絶対配置の要素にしか効かない**（position を見ずに判定すると、
    //    読める文章のほうを除外する。実測で再現済み）。
    if (CLIP_POSITIONS.includes(cs.position) && cs.clip && cs.clip !== 'auto') {
      const lc = legacyClipRect(cs.clip, border);
      if (lc) shape = intersectRect(shape, lc);
    }
    // ③ clip-path。外接矩形に加えて、形そのものとの交差も控える。
    //
    // ⚠️ **解けない形は「制限なし」ではない**（第20回 RG-20-02）。`shapeHitTest` が
    // 解けるのは `circle()` / `ellipse()` / 角丸つき `inset()` だけで、それ以外
    // （`polygon()` / `path()` / `shape()` / `calc()` を含む形など）は null を返す。
    // その null を「形の制限は無い」として通していたため、**面積0の
    // `polygon(0 0,0 0,0 0)` の中の語が確実に見えるものとして扱われて**いた
    // （実測: 語も印も0画素・印の5点すべてが BODY・それでも Tab の順路に入った）。
    // 解けないときは「断定できない」を返す。
    if (cs.clipPath && cs.clipPath !== 'none') {
      const { shape: sh, box } = splitGeometryBox(cs.clipPath.trim());
      if (!skewed) {
        const ref = refBoxRect(cs, border, false, box);
        const sr = shapeBoundsRect(sh, ref);
        if (sr) shape = intersectRect(shape, sr);
        const t = shapeHitTest(sh, ref);
        if (typeof t === 'function') tests.push(rect => t(rectPoly(rect)));
        else if (t !== 'rect') tests.push(() => 'unknown');   // 解けない形＝断定できない
      } else if (flat) {
        // 回転・拡大縮小があるときは、形も一緒に回っている。viewport の軸に沿った
        // まま判定していたため、中心も半径もずれ、**外にある語へ印が付き、
        // 中にある語が落ちた**（第16回 RG-16-03。実測: 回転した楕円の外の語は
        // 0画素なのに印が付き、後ろの読める同じ語が説明されなかった）。
        // 形は変形前の座標で解き、**語の矩形のほうを変形前へ戻して**当てる。
        // ⚠️ 変形前の箱は `offsetWidth` / `offsetHeight` で取る（第17回 RG-17-03）。
        // 計算後のスタイルの `width` から padding と border を足していたが、
        // `box-sizing: border-box` では `width` に既に両方が入っているので**二重に
        // 足していた**（実測: 120px の箱を 148px と見なし、切り抜きの外の0画素の語に
        // 印が付いた）。`offsetWidth` は border box そのもので、`zoom` も変形も
        // 掛からない生の寸法なので、そのまま変形前の座標に使える。
        const bw = el.offsetWidth, bh = el.offsetHeight;
        const map = (bw > 0 && bh > 0) ? localToViewport(L, bw, bh, border) : null;
        if (map) {
          const ref = refBoxLocal(cs, bw, bh, box);
          const sr = shapeBoundsRect(sh, ref);
          if (sr) {                       // 変形前の外接矩形を viewport へ写し直す
            const xs = [], ys = [];
            for (const [x, y] of [[sr.x1, sr.y1], [sr.x2, sr.y1], [sr.x2, sr.y2], [sr.x1, sr.y2]]) {
              const [vx, vy] = map.to(x, y); xs.push(vx); ys.push(vy);
            }
            shape = intersectRect(shape, { x1: Math.min(...xs), y1: Math.min(...ys),
                                           x2: Math.max(...xs), y2: Math.max(...ys) });
          }
          const t = shapeHitTest(sh, ref);
          // 変形前へ戻せない角度（ちょうど45°など）では断定しない（第19回 RG-19-03）
          if (typeof t === 'function') {
            tests.push(rect => { const p = map.backPoly(rect); return p ? t(p) : 'unknown'; });
          } else if (t !== 'rect') tests.push(() => 'unknown');   // 解けない形
        } else {
          tests.push(() => 'unknown');               // 変形前の箱が取れない
        }
      } else {
        // 3D・perspective では形を解けない。以前は「制限しない」側へ倒していたが、
        // それは「確実に見える」と同じ意味になってしまう（第20回 RG-20-02）。
        tests.push(() => 'unknown');
      }
    }
    return { overflow, shape, tests, scroller };
  }

  // 形そのものとの交差判定。矩形で足りる形は null を返す（外接矩形だけで決まる）。
  function shapeHitTest(shape, ref) {
    // 形の指定が無く**参照ボックスだけ**（`clip-path: content-box` など）は、
    // その箱そのもの＝外接矩形で足りる。解けないのとは違う（第20回 RG-20-02 の
    // 直しで、ここを一緒くたにして `clip-path: content-box` の中の語を落とした）。
    if (!shape || !shape.trim()) return 'rect';
    let m = /^circle\((.*)\)$/.exec(shape);
    if (m) {
      const { radii, pos } = splitShapeArgs(m[1]);
      const c = centerOf(pos, ref);
      if (!c) return null;
      const r = radiusOf(radii, c, ref, null);
      if (r === null) return null;
      return poly => polyHitsEllipse(poly, c.cx, c.cy, r, r);
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
      return poly => polyHitsEllipse(poly, c.cx, c.cy, rx, ry);
    }
    // inset(... round …)。**角ごとに半径が違う**（1〜4値を上左・上右・下右・下左へ
    // 展開し、`/` の前後で水平・垂直を分ける）。先頭の1値を四隅へ広げていたため、
    // 丸めていない角の語を落とし、丸めた角の語を残していた（第15回 RG-15-02）。
    m = /^inset\((.*)\)$/.exec(shape);
    if (m) {
      const parts = m[1].split(/\s+round\s+/);
      // 角を丸めていない `inset()` は、**外接矩形そのもの**。形の判定は要らない。
      // ⚠️ ここを「解けない」と同じ扱いにすると、ふつうの `inset(0)` まで断定
      // できないことになり、読める語を軒並み落とす（対照12件が落ちて気づいた）。
      if (parts.length !== 2) return insetRect(parts[0], ref) ? 'rect' : null;
      const box = insetRect(parts[0], ref);
      if (!box) return null;
      const radii = cornerRadii(parts[1], box);
      if (!radii) return null;
      return poly => polyHitsRounded(poly, box, radii);
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
    if (!el) return { clip: null, tests: [], hidden: false, transformed: false, fixed: false,
                      captured: false, paintUnknown: false, scrolls: [],
                      linear: IDENTITY, flat: true };
    const cache = chainCache && chainCache[mode];
    if (cache) { const hit = cache.get(el); if (hit !== undefined) return hit; }
    const cs = getComputedStyle(el);
    const applies = mode === 'none' || establishesContainingBlock(cs, mode === 'fixed');
    const up = paintChain(el.parentElement, applies ? positionEscape(cs) : mode);
    let clip = up.clip;
    let tests = up.tests;
    // 変形は祖先から掛け合わさる。自分の分まで含めた線形部分を先に出しておく
    // （clip-path の形は、この要素の変形前の座標で定義されているため）。
    const t = ownLinear(cs);
    const linear = t.m ? mul(up.linear, t.m) : up.linear;
    const flat = up.flat && t.flat;
    const own = ownClips(el, cs, linear, flat);
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
    // スクロールできる入れ物は、**内側から外側の順に並べて**持つ。1つへ潰すと
    // 入れ子の外側を見落とす（第18回 RG-18-01）。
    // `position:fixed` でも、**変形などを持つ祖先が包含ブロックを作ると画面には
    // 固定されない**——文書のスクロールで動く（第17回 RG-17-08。実測: `translateZ(0)`
    // の中の固定要素は、文書を900px送ると y=1166 から y=266 へ動いた。それでも画面へ
    // 固定されている扱いだったので、画面に入ってからも暇なときの確認まで説明が付かなかった）。
    //
    // 捕まっているかは、**上へ辿るときの逃げ方**で分かる。`mode === 'fixed'` で上って
    // いる途中に包含ブロックを作る要素があれば、その下の固定要素は捕まっている。
    // `up.captured` は「ここに置いた固定要素が捕まるか」の答えになっている
    // （自分が固定なら、上へは 'fixed' で辿っているため）。
    const captured = (mode === 'fixed' && applies) || up.captured;
    const own状態 = paintState(cs);
    const v = { clip, tests,
                hidden: up.hidden || own状態 === 'hidden',
                paintUnknown: up.paintUnknown || own状態 === 'unknown',
                transformed: up.transformed || cs.transform !== 'none',
                fixed: (cs.position === 'fixed' && !up.captured) || up.fixed,
                captured,
                scrolls: (applies && own && own.scroller)
                  ? [own.scroller].concat(up.scrolls) : up.scrolls,
                linear, flat };
    if (cache) cache.set(el, v);
    return v;
  }

  // 文字そのものの矩形。**面積のあるものだけ**を返す。
  // `transform: scale(0)` は箱の寸法（offsetWidth）を変えないので、面積を見ないと
  // 落とせない（実測: 0画素しか描かれていないのに印が付いた）。
  //
  // ⚠️ **空白は矩形に含めない**（第18回 RG-18-02）。`pull request` のように語が
  // 2つあるキーでは、語間の空白まで1つの矩形へ入れていたため、語そのものは
  // 切り取りの外なのに、空白ぶんの幅が形の中を横切って可視と答えていた
  // （実測: `word-spacing:70px` の見本で、語の画素は0なのに印が付いた）。
  // 空白で切って、**塗りのある並びごと**に矩形を取る。
  //
  // ⚠️ 並びは**まとめずに、並びごとに分けて**返す（第19回 RG-19-01）。1つの配列へ
  // 平らにしていたため、「どれか1つの矩形が通れば可視」で用語全体を可視と答えて
  // いた。`pull request` の `pull` だけが見えて `request` が切り取りの外にある見本で、
  // 用語の意味が読めないのに印が付き、その印自体も切り取りの外にあって見えない
  // Tab の停止点になっていた（実測: `pull` 158画素・`request` 0画素・切り取りの
  // 右端 35px に対し印は x=93.8）。
  const SPACE = /\s/;
  function rangeRuns(node, start, end) {
    const runs = [];
    const add = r => {
      const rects = [...r.getClientRects()].filter(x => x.width > 0 && x.height > 0);
      if (rects.length) runs.push(rects);
    };
    if (start === null) {
      const r = document.createRange(); r.selectNodeContents(node); add(r); return runs;
    }
    const text = node.nodeValue || '';
    let i = start;
    while (i < end) {
      while (i < end && SPACE.test(text[i])) i++;
      let j = i;
      while (j < end && !SPACE.test(text[j])) j++;
      if (j > i) { const r = document.createRange(); r.setStart(node, i); r.setEnd(node, j); add(r); }
      i = j;
    }
    return runs;
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
    const runs = rangeRuns(node, start, end);
    if (runs.length === 0) return false;
    const cs = getComputedStyle(el);
    const c = chain.clip;
    const inClip = r => !c || (Math.min(r.right, c.x2) - Math.max(r.left, c.x1) > 1 &&
                               Math.min(r.bottom, c.y2) - Math.max(r.top, c.y1) > 1);
    // **同じ断片が、全部の条件を通ること**を求める。条件ごとに「どれか1つの断片が
    // 通るか」を見ていたため、断片Aが形Aだけ・断片Bが形Bだけを通る場合に、
    // どの断片も全部は通っていないのに合格していた（第15回 RG-15-03）。
    // 画面（または動かせる範囲）の外にある語は、読めないしスクロールでも出せない。
    // スクロールできる入れ物の中なら、その入れ物を動かせる範囲で見る。ただし
    // **入れ物そのものが文書のどこにも出せない**なら、中身も出せない。
    //   true … 確実に読める／false … 確実に読めない／'unknown' … 断定できない
    const rectState = r => {
      if (!inClip(r)) return false;
      const reach = reachable(r, chain);
      if (reach === false) return false;
      let u = reach === 'unknown';
      for (const t of chain.tests) {
        const v = t(r);
        if (v === false) return false;
        if (v === 'unknown') u = true;
      }
      // 文字の塗りは**語の位置**で見る（影のずらし・背景の位置がここに効く）
      const p = textPaintsAt(cs, el, r);
      if (p === false) return false;
      if (p === 'unknown') u = true;
      return u ? 'unknown' : true;
    };
    // 1つの並びは、**どれか1つの断片**が通れば読める（折り返しても読める）。
    const runState = rects => {
      let best = false;
      for (const r of rects) {
        const s = rectState(r);
        if (s === true) return true;
        if (s === 'unknown') best = 'unknown';
      }
      return best;
    };
    let unknown = chain.paintUnknown;
    // **全部の並び**が読めることを求める（第19回 RG-19-01）。
    for (const rects of runs) {
      const s = runState(rects);
      if (s === false) return false;
      if (s === 'unknown') unknown = true;
    }
    // 解けない描画効果があるときは「見える」と断定しない。後ろに確実に見える同じ語が
    // あればそちらへ付ける（第18回 RG-18-04 / RG-18-05）。
    //
    // ⚠️ **印が入る場所は、ここでは見ない。** 一度「用語の直後に 1.4em」と見積もって
    // 判定へ入れたが、その見積もりが外れていた（実測: 35°回した楕円の中の語で、
    // 見積もりは形の外なのに、実際の印は5点中4点が印そのものに当たる＝見えていた）。
    // 印は**実物を測れる**ので、入れたあとの「まだ説明として使えるか」で見る
    // （→ iconIsPainted）。
    return unknown ? 'unknown' : true;
  }

  // 印そのものが、切り取りの中に描かれているか（第19回 RG-19-01）。
  // 用語が読めても、印だけが切り取りの外へ出ることがある（実測:
  // `overflow-clip-margin:100px` の枠で、語は余白の中に見えているのに、
  // その直後に入った印は x=176 で余白の外＝5点すべてが印に当たらず、それでも
  // `tabIndex:0` で Tab の順路に入っていた）。**見えない停止点を残さない。**
  // ⚠️ **矩形と切り取りだけでは足りない**（第20回 RG-20-03）。以前は clip・到達性・
  // 形しか見ておらず、次のどちらも「描かれている」と答えていた（実測）:
  //   - ページ側の CSS が `.iiyaku-icon{opacity:0!important}` にした印
  //     （不透明度0でも当たり判定には出るので、`elementFromPoint` は印を返す）
  //   - 不透明な `position:fixed` の要素が印を全面的に覆った状態
  //     （印の画素は 96 → 0 になったのに、5点すべてが覆いを返しても合格していた）
  // どちらも `tabIndex:0` のまま Tab の順路に入っていた。
  // いま見るのは、①自分の描画効果 ②切り取り ③到達性 ④形 ⑤不透明度と visibility
  // ⑥**実際の当たり判定**（自分か自分の子孫が最前面に出る点があるか）。
  const ICON_PROBES = [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];

  /* ---------- 当たり判定に映らない覆い（第22回 RG-22-03） ---------- */
  //
  // `pointer-events: none` の箱は hit testing から外れる。だから `elementFromPoint`
  // はその**下**にあるものを返し、印は「最前面」に見える。実測（実際に読み込んだ
  // 拡張・スクリーンショットの画素を数えた）: 印の上へ不透明な白い箱を
  // `position:fixed; z-index:2147483647; pointer-events:none` で置くと、印の矩形の
  // 白でない画素は **129 → 0**。それでも5点すべてが印を返し、印は Tab の停止点として
  // 残り、後方の読める同じ語は説明されないままだった。
  //
  // ⚠️ **IntersectionObserver v2（`trackVisibility`）は使えない。** 遮蔽まで見てくれる
  //    API だが、実測では**覆いが無くても**この印を `isVisible: false` と答えた
  //    （同じ実行で、ふつうの `<div>` と `<button>` は true。つまり環境の問題ではなく、
  //    この印が対象外と判定されている）。覆いの有無で答えが変わらないので、
  //    判別には使えない。
  //
  // ⚠️ **全要素を歩いて集める形も採らなかった。** 実測で 10,000要素あたり 6〜13ms。
  //    代わりに、`pointer-events: none` を**宣言している規則の選択子**と、
  //    `style` 属性にそう書いてある要素から候補を引く。宣言が1つも無ければ走査は
  //    起きない（ふつうのページはここで終わる）。読めない stylesheet が1枚でもあれば
  //    見落とすので、そのときだけ全要素を歩くほうへ落とす。
  //
  // ⚠️ **断定できるものだけを覆いと数える。** 地の色が不透明で、透けておらず、
  //    位置指定があり、重なり順で印より前に来るもの。画像や gradient で塗られた箱、
  //    重なり順を推し量れない箱は「覆いではない」側へ倒す（落としすぎると、
  //    ふつうのページの語が説明されなくなる）。→ 残る限界は AUDIT.md §7。
  const PE_NONE_INLINE = /(^|[;\s])pointer-events\s*:\s*none/i;
  let ghostSelSerial = -1, ghostSelPrint = -1, ghostSelectors = null, ghostSelWalk = false;

  function ghostSelectorList() {
    const print = styleFingerprint();
    if (ghostSelectors !== null && ghostSelSerial === styleSerial && ghostSelPrint === print) {
      return ghostSelectors;
    }
    ghostSelSerial = styleSerial; ghostSelPrint = print;
    const sels = [];
    let walk = false, seen = 0;
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch (e) { walk = true; continue; }   // 読めない
      if (!rules) continue;
      const stack = [rules];
      while (stack.length) {
        for (const r of stack.pop()) {
          if (++seen > RULE_SCAN_MAX) { walk = true; stack.length = 0; break; }
          if (r.selectorText && r.style && r.style.getPropertyValue('pointer-events') === 'none') {
            sels.push(r.selectorText);
          }
          if (r.cssRules) stack.push(r.cssRules);
        }
      }
    }
    ghostSelWalk = walk;
    ghostSelectors = sels;
    return sels;
  }

  // 祖先まで含めて、その箱が透けていないか
  function opaqueChain(el) {
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.visibility !== 'visible' || cs.display === 'none') return false;
      if (parseFloat(cs.opacity) !== 1) return false;
    }
    return true;
  }

  const GHOST_GAP = 120;
  let ghostAt = -1, ghostList = null;

  function ghostCovers() {
    const now = performance.now();
    if (ghostList !== null && now - ghostAt < GHOST_GAP) return ghostList;
    const out = [];
    const sels = ghostSelectorList();
    let pool = [];
    if (ghostSelWalk) pool = [...document.querySelectorAll('*')];
    else {
      if (sels.length) {
        // 選択子はページの持ち物。1つでも読めない形が混じると全部が落ちるので、
        // まとめて渡さず、落ちたぶんだけ捨てる。
        for (const s of sels) {
          try { pool.push(...document.querySelectorAll(s)); } catch (e) { /* 読めない選択子 */ }
        }
      }
      for (const el of document.querySelectorAll('[style]')) {
        if (PE_NONE_INLINE.test(el.getAttribute('style') || '')) pool.push(el);
      }
      // `pointer-events` は継承する。当たった要素の中も候補に入れる。
      const inner = [];
      for (const el of pool) if (el.firstElementChild) inner.push(...el.querySelectorAll('*'));
      pool.push(...inner);
    }
    const seen = new Set();
    for (const el of pool) {
      if (seen.has(el)) continue;
      seen.add(el);
      if (isOurNode(el) || ownedIcons.has(el)) continue;      // 自分の持ち物は覆いに数えない
      const cs = getComputedStyle(el);
      if (cs.pointerEvents !== 'none') continue;
      if (cs.position === 'static') continue;                 // 重なり順を推し量れない
      if (TRANSPARENT.test(cs.backgroundColor)) continue;     // 地が透明＝断定しない
      const z = cs.zIndex === 'auto' ? 0 : (parseInt(cs.zIndex, 10) || 0);
      if (z < 0) continue;                                    // 後ろに敷いてある
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) continue;
      if (!opaqueChain(el)) continue;
      out.push({ el, r, z });
    }
    ghostAt = now; ghostList = out;
    return out;
  }

  // その点が、当たり判定に映らない覆いで塞がれているか
  function ghostBlocks(icon, x, y) {
    const list = ghostCovers();
    for (const g of list) {
      if (x < g.r.left || x >= g.r.right || y < g.r.top || y >= g.r.bottom) continue;
      if (g.el === icon || g.el.contains(icon) || icon.contains(g.el)) continue;
      if (g.z > 0) return true;
      // 重なり順の指定が無いときは、**後から来たほうが上**に描かれる
      if (icon.compareDocumentPosition(g.el) & Node.DOCUMENT_POSITION_FOLLOWING) return true;
    }
    return false;
  }

  function iconIsPainted(icon) {
    const chain = paintChain(icon, 'none');
    if (chain.hidden) return false;
    if (rectIsEmpty(chain.clip)) return false;
    const b = icon.getBoundingClientRect();
    if (!(b.width > 0 && b.height > 0)) return false;
    const c = chain.clip;
    if (c && !(Math.min(b.right, c.x2) - Math.max(b.left, c.x1) > 1 &&
               Math.min(b.bottom, c.y2) - Math.max(b.top, c.y1) > 1)) return false;
    if (reachable(b, chain) === false) return false;
    for (const t of chain.tests) if (t(b) === false) return false;
    // ⑤ 印そのものの見え方。ページ側の `!important` でも消される。
    const cs = getComputedStyle(icon);
    if (cs.visibility !== 'visible' || cs.display === 'none') return false;
    if (parseFloat(cs.opacity) === 0) return false;
    if (cs.contentVisibility === 'hidden') return false;
    if (HAS_CHECK_VISIBILITY && !icon.checkVisibility(CHECK_VISIBILITY_OPTS)) return false;
    // ⑤-2 **押せる実体**そのものが塗られているか（第22回 RG-22-02）。
    // host だけを見ていては足りない——ページの custom property は shadow の中まで
    // 継承するので、host はふつうに見えているのに、中の button が 0 画素になりうる。
    // 先に塗り直しを試み（ensureShadowPaint）、それでも塗れないなら印を作らない。
    const target = focusTargetOf(icon);
    if (target !== icon) {
      ensureShadowPaint(icon);
      const ts = getComputedStyle(target);
      if (ts.visibility !== 'visible' || ts.display === 'none') return false;
      if (parseFloat(ts.opacity) === 0) return false;
      const tb = target.getBoundingClientRect();
      if (!(tb.width > 0 && tb.height > 0)) return false;
      // 字・枠・地のどれか1つでも塗れていればよい（丸い枠だけでも印として見える）
      if (TRANSPARENT.test(ts.color) && TRANSPARENT.test(ts.borderTopColor) &&
          TRANSPARENT.test(ts.backgroundColor)) return false;
    }
    // ⑥ 覆われていないか。**画面の中にある点だけ**で見る（画面外は覆いの話ではなく
    // 到達性の話で、そこは④で見ている）。画面内の点が1つも無ければ判定しない。
    //
    // ⚠️ **「祖先が最前面」を露出の証拠にしてはいけない**（第21回 RG-21-03）。
    // v1.8.19 は `hit.contains(icon)` を露出に数えていた。祖先の `::before` /
    // `::after` が印を覆うと `elementFromPoint` はその**祖先**を返すので、
    // 印が0画素でも合格していた（実測: 5点すべてが祖先を返し、`tabIndex:0` のまま
    // Tab の順路に入った）。
    // いまは**最前面が印そのものか印の子孫のときだけ**露出と数える。
    // 「スクロールすれば読める語」の対照（v1.8.19 で5件落とした分）を守るのは
    // `hit.contains(icon)` ではなく **`visibleNow` の門**のほうで、
    // 覆いの判定は**いま動かさずに見えている印**にだけ当てる。
    // （`elementsFromPoint` の重なり順も見たが、先頭要素は `elementFromPoint` と
    //   同じもので、この判定に足すものが無かった。実測の重なりは
    //   `[first(::after), 印, first, BODY, HTML]` で、先頭を見れば足りる。）
    //
    // ⚠️ **印自身が `pointer-events: none` にされたら、当たり判定では何も言えない**
    // （残る限界）。そのときは覆いを判定しない側へ倒す（→ AUDIT.md §7）。
    if (cs.pointerEvents === 'none') return true;
    let inView = 0, exposed = 0;
    for (const [fx, fy] of ICON_PROBES) {
      const x = b.left + b.width * fx, y = b.top + b.height * fy;
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
      inView++;
      // 最前面が印そのものか、印の子孫のときだけ「その点で見えている」と数える。
      // ⚠️ **当たり判定に映らない覆いも見る**（第22回 RG-22-03。→ ghostBlocks）。
      // `pointer-events: none` の箱は hit testing から外れるので、`elementFromPoint`
      // は印を返し続ける。点ごとに見るので、**部分的な覆いでは残りの点が露出と数えられ**、
      // 「全面が覆われている」とは判定されない。
      const hit = document.elementFromPoint(x, y);
      if (hit && (hit === icon || icon.contains(hit)) && !ghostBlocks(icon, x, y)) exposed++;
    }
    if (inView > 0 && exposed === 0 && visibleNow(b, chain)) return false;   // 全面が覆われている
    return true;
  }

  // 文書そのものの枠（画面）と、そこで動かせる量。
  // ⚠️ 以前は「文書全体の矩形」を左上へ広げる式で出していた。横書き左→右しか
  // 想定しておらず、`<html dir="rtl">` の文書では**負の向きへスクロールすれば
  // 読める語**を「出せない」と落としていた（第18回 RG-18-01。実測: 語は
  // `scrollX = -1100` で画面に入るのに、印が付かないままだった）。
  // いまは他の入れ物とまったく同じ形（箱＋動かせる量）で扱う。
  function rootScroller(fixed) {
    const de = document.documentElement;
    const box = { x1: 0, y1: 0, x2: de.clientWidth, y2: de.clientHeight };
    if (fixed) return { box, dx: [0, 0], dy: [0, 0], snapX: false, snapY: false };  // 画面に固定＝動かせない
    const se = document.scrollingElement || de;
    const cs = getComputedStyle(se);
    // 文書そのものの吸い寄せは `<html>` 側にも書ける
    const snap = snapAxes(getComputedStyle(de));
    return { box, dx: shiftRange(se, cs, 'x'), dy: shiftRange(se, cs, 'y'),
             snapX: snap.x, snapY: snap.y };
  }

  // その矩形を、**全部の枠へ同時に入れられる**スクロール位置があるか。
  //
  // 内側の枠を動かすと中身だけが動き、外側の枠を動かすと内側の枠ごと動く。
  // そこで「内側から k 番目までの枠を動かした合計」を S_k と置くと、
  //   ・S_k は S_{k-1} に k 番目の可動量を足した範囲に入る
  //   ・語が k 番目の枠に入る条件は S_k ∈ (箱の始点 - 語の終点, 箱の終点 - 語の始点)
  // となり、内側から外側へ**区間を狭めていくだけ**で答えが出る（軸ごとに独立）。
  // 返り値は true / false / 'unknown'。
  // mandatory な吸い寄せがある枠では、**いまの位置でしか断定しない**。いま入って
  // いなければ、連続区間で入れるかを見て、入れるなら 'unknown'（止まり位置は解かない）、
  // 入れないなら false（吸い寄せが無くても届かない）。
  // いま、スクロールを1つも動かさずにその矩形が見えているか。
  // 当たり判定（覆われていないか）は、**この場合にだけ**意味がある——
  // スクロールで送られた先にある印の座標で hit test をすると、そこに描かれている
  // 別のものが返り、覆いと誤判定する（第20回 RG-20-03 の直しで実際にそうなった）。
  function visibleNow(r, chain) {
    const doms = chain.scrolls.concat([rootScroller(chain.fixed)]);
    return feasible(r, doms, 'x', false, true) && feasible(r, doms, 'y', false, true);
  }

  function reachable(r, chain) {
    const doms = chain.scrolls.concat([rootScroller(chain.fixed)]);
    const anySnap = doms.some(d => d.snapX || d.snapY);
    if (!anySnap) {
      return (feasible(r, doms, 'x', false) && feasible(r, doms, 'y', false)) ? true : false;
    }
    if (feasible(r, doms, 'x', true) && feasible(r, doms, 'y', true)) return true;   // いま見えている
    return (feasible(r, doms, 'x', false) && feasible(r, doms, 'y', false)) ? 'unknown' : false;
  }

  //   pinSnap … true なら、吸い寄せのある枠を「いまの位置から動かせない」として解く
  //   pinAll  … true なら、**すべての枠**を今の位置に固定する（＝いま見えているか）
  function feasible(r, doms, axis, pinSnap, pinAll) {
    const t1 = axis === 'x' ? r.left : r.top;
    const t2 = axis === 'x' ? r.right : r.bottom;
    let lo = 0, hi = 0;
    for (const d of doms) {
      const snapped = pinAll || (pinSnap && (axis === 'x' ? d.snapX : d.snapY));
      const sh = snapped ? [0, 0] : (axis === 'x' ? d.dx : d.dy);
      lo += sh[0]; hi += sh[1];
      const b1 = axis === 'x' ? d.box.x1 : d.box.y1;
      const b2 = axis === 'x' ? d.box.x2 : d.box.y2;
      const ilo = b1 - t2, ihi = b2 - t1;      // この枠へ入るための動かし量
      if (!(lo < ihi && hi > ilo)) return false;
      lo = Math.max(lo, ilo); hi = Math.min(hi, ihi);
    }
    return true;
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
      if (!elementIsVisible(host, CONTENTS_HOST_OPTS, 'host')) return false;
      if (getComputedStyle(host).contentVisibility === 'hidden') return false;
    }
    return isPaintedRange(el, node, start, end);
  }

  let visCache = null;

  // `checkVisibility()` の答えを、1回のまとめ直しのあいだ覚える。
  // 隠れた入れ物の中に何語も入っているページで、同じ要素へ何十回も聞いていた。
  function elementIsVisible(el, opts, key) {
    if (!visCache) return el.checkVisibility(opts);
    let m = visCache.get(el);
    if (m === undefined) { m = {}; visCache.set(el, m); }
    if (m[key] === undefined) m[key] = el.checkVisibility(opts);
    return m[key];
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
      ok = elementIsVisible(el, CHECK_VISIBILITY_OPTS, 'self');
      // その要素自身が content-visibility:hidden のとき、**中身**は隠れているのに
      // 要素自体は描画されているので checkVisibility は true を返す（実測）。
      if (ok && cs.contentVisibility === 'hidden') ok = false;
      if (ok) ok = isPaintedRange(el, node, start, end);   // true / false / 'unknown'
    } else {
      // checkVisibility が無い環境。manifest の minimum_chrome_version より古い
      // Chrome か、拡張を手で読み込んだ場合にしか起きない。祖先の opacity や
      // content-visibility は見抜けないので、ここは「落ちないための保険」にすぎない。
      ok = !(cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0');
      if (ok && cs.contentVisibility === 'hidden') ok = false;
      if (ok) ok = isPaintedRange(el, node, start, end);
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
  //
  // キーで1つに絞るのは**見え方で選んだあと**。先に絞ると、「1つ目は隠れていて
  // 2つ目は読める」場合に読めるほうが候補から消える（実測: 2行目の読める語に
  // 説明が付かなかった）。
  // ⚠️ **断定できない候補は、印を作らない**（第20回 RG-20-01）。
  //
  // 第18回から、断定できない候補は1周目で見送り、まとめ直しの最後に
  // 「まだどこも引き受けていない語」を引き受け直していた。しかしその2周目は
  // 通常の `annotate` を通るので、**0画素の語が辞書のキーを取り、`tabindex="0"` の
  // 正規の印を作って**いた。実測（v1.8.18）:
  //   - 透明な `url()` filter の語は0画素・後ろの1,512画素の語は印0
  //   - 面積0の `polygon()`・ちょうど45°・止まれない吸い寄せでも同じ
  //   - どれも印は実際の Tab の順路に入っていた
  // 断定できないものを「たぶん見える」の側へ倒すと、**見えない停止点**が残り、
  // 後ろの確実に読める語が説明されなくなる。
  //
  // いまは 'unknown' を `false` と同じに扱い、**節点は控えへ残す**。ページの状態が
  // 変わって断定できるようになれば、控えの見直しがそこで拾う。
  // 代償: 実際には見えているのに断定できない語（解けない filter・45°・
  // 未対応の `clip-path` の中の語など）は、ページに他の出現が無ければ説明されない。
  // 「見えない押せる点を作らない」ほうを取る。
  function visibleHits(node, el) {
    const all = matcher.findHits(node.nodeValue, key => usableGloss(key) !== null, { all: true });
    const out = [];
    const seen = new Set();
    let deferred = false;
    for (const h of all) {
      if (seen.has(h.key)) continue;
      const v = isVisibleOccurrence(el, node, h.end - h.match.length, h.end);
      if (v === true) { seen.add(h.key); out.push(h); }
      else if (v === 'unknown') deferred = true;
    }
    if (deferred) rememberLatent(node);
    return out;
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
    el.classList.remove(...OWN_CLASSES, UID);
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
    // ② 合言葉の属性を消された／書き換えられた複製。
    //    自分が作る要素には、**読み込みごとに変わる合言葉を class としても**付けて
    //    ある。class は cloneNode でそのまま複製されるので、属性を全部消された
    //    複製でもここで捕まる。そしてページ側の持ち物がこの class を名乗ることは
    //    ない（値は毎回変わり、ページからは読めない隔離された世界で決めている）。
    //
    //    以前は「自分の data 名札が2つ以上」で見分けていた。名札を全部消された複製は
    //    見分けられず、幅0・Tab で止まれる点として残っていた（第16回 RG-16-08。
    //    実測: 実際に Tab を押すと 0×0 の要素へフォーカスが移った）。
    //    数え上げの当て推量をやめ、**自分の印が付いているかどうか**だけで決める。
    for (const el of pick('.' + CSS.escape(UID))) {
      if (ownedIcons.has(el) || isOurChrome(el)) continue;
      if (el.getAttribute('data-iiyaku-owner') === UID) continue;   // ① で扱った
      if (hasPageContent(el)) continue;   // ページが中身を入れた節点は壊さない
      stripOwnIdentity(el);
    }
    // ③ 合言葉の class まで消された複製は、**見分けない**。
    //
    // v1.8.16 では「名乗りが無く・空で・押せて・自分の class を持つ <sup>」から操作性を
    // 外していた。しかしそれは**ページの持ち物を壊す**（第18回 RG-18-06。実測: ページが
    // 置いた `<sup class="iiyaku-icon" role="button" tabindex="0" aria-label="page control">`
    // から role・tabindex・aria-label が消えた）。形が同じだけの要素を、こちらの複製だと
    // 決めつけてはいけない。
    //
    // 見分けられない複製は、幅0で中身の無い、押せるだけの要素として残る。**その形の
    // 停止点は、ページが自分だけでも作れる**（こちらの class を使う必要がない）。
    // 構造として断つには、印を closed shadow root の中へ入れて複製できなくする必要が
    // あり、それは別の作り直しになる（→ AUDIT.md §7）。
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
  // ---- 単独で押せる印を、closed shadow root の中へ入れる（第21回 RG-21-06）----
  // ページが正規の印を `cloneNode` し、`data-*`・`aria-label`・合言葉の class を
  // **全部**消したうえで `role="button" tabindex="0"` を残すと、こちらからは
  // 内部所有物だと証明できず、幅0の押せる点として残っていた（第19回から3巡持ち越し）。
  //
  // 実測（Chrome 151）:
  //   - `cloneNode(true)` は shadow root を**複製しない** → 複製された host は空で、
  //     中に focusable な要素は 0 個
  //   - `host.shadowRoot` は closed なら `null`（ページから中身を取れない）
  //   - `document.querySelectorAll('button')` は shadow の中を**見つけない**
  //   - `elementFromPoint` は host へ retarget される（＝印の実測はそのまま効く）
  //
  // ⚠️ **host は `<span>` でなければならない。** `<sup>` に `attachShadow` すると
  // `NotSupportedError` になる（実測）。見た目は CSS で作っているので、`sup` の
  // 上付き（`vertical-align: super` / `font-size: smaller`）には依存していない。
  const USE_SHADOW_STANDALONE = true;      // 戻せるようにしておく（監査の助言）
  const iconButton = new WeakMap();        // host → 中の button
  const iconDesc = new WeakMap();          // host → 中の説明文
  const iconShadow = new WeakMap();        // host → closed shadow root（付け直しを避ける）
  let shadowSheet;                         // 1枚だけ作って全部の shadow root で共有する

  // `styles.css` のうち、**shadow root の中だけ**で使う区間。
  // ⚠️ この区間はページ側の `<style>` へ入れてはいけない。`button { … }` のような
  // 裸の選択子を含むので、入れるとページのボタンまで作り替えてしまう
  // （実測: 追記した直後、こちらの切替ボタンの字形指定が上書きされて落ちた）。
  const SHADOW_SECTION = /\/\* ===== RG_SHADOW_BEGIN =====[\s\S]*?\/\* ===== RG_SHADOW_END ===== \*\//;

  function shadowIconSheet() {
    if (shadowSheet !== undefined) return shadowSheet;
    shadowSheet = null;
    try {
      const m = SHADOW_SECTION.exec(CSS_TEXT);
      // 区間が見つからないときは**入れない**（見た目が無いほうが、間違った見た目より良い）
      if (!m) return shadowSheet;
      // 冒頭の注記（BEGIN のコメント）を落として、規則だけにする
      const body = m[0].replace(/^\/\*[\s\S]*?\*\//, '').replace(/\/\* ===== RG_SHADOW_END ===== \*\/$/, '');
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(body);
      shadowSheet = sheet;
    } catch (e) { shadowSheet = null; }
    return shadowSheet;
  }

  // shadow の中は document の MutationObserver に映らないので、ここでの属性書き込みは
  // `setOwnAttr` を通さない（ページからは触れないため、予定を控える相手がいない）。
  function ensureShadowButton(host) {
    let btn = iconButton.get(host);
    if (btn) return btn;
    // 一度付けた shadow root は外せない。畳んだ相手をもう一度使うことになっても
    // `attachShadow` をやり直さない（例外になって light DOM の形へ落ちてしまう）。
    let root = iconShadow.get(host);
    if (!root) {
      try { root = host.attachShadow({ mode: 'closed' }); }
      catch (e) { return null; }           // 付けられない環境では light DOM のまま
    }
    try {
      const sheet = shadowIconSheet();
      if (sheet) root.adoptedStyleSheets = [sheet];
    } catch (e) { /* 見た目が無くても、押せることと読み上げは変わらない */ }
    btn = document.createElement('button');
    btn.type = 'button';
    const desc = document.createElement('span');
    desc.hidden = true;
    desc.id = 'iiyaku-desc';
    btn.setAttribute('aria-describedby', desc.id);
    // ⚠️ **`<slot>` を必ず置く。** shadow root を付けた要素は、`<slot>` が無いと
    // light DOM の子を**描かなくなる**。退役した印をページが本文の入れ物として
    // 使い回したとき、その文字が消えてしまう（実測: 退役した印へ
    // `textContent = 'A squash merge inside.'` を入れて本文へ戻すと、
    // 中の語が走査されず 0 件になった。ページの持ち物を壊している）。
    // ふだんの印は light DOM が空なので、slot は何も描かない。
    // 畳んだ相手を使い直す場合、slot は残してあるので足さない（2枚あると二重に描く）。
    root.append(btn, desc);
    if (!root.querySelector('slot')) root.append(document.createElement('slot'));
    iconShadow.set(host, root);
    iconButton.set(host, btn);
    iconDesc.set(host, desc);
    return btn;
  }

  // 退役した印の「中身」を失効させる（第22回 RG-22-01）。
  //
  // ⚠️ **複製されないことと、退役した元が失効することは別の不変条件**である。
  // closed shadow root は `cloneNode` で複製されないが、**元の host はそのまま残る**。
  // ページが退役した印を本文の入れ物として使い回すと（`textContent = 'PAGE CONTENT'`）、
  // light DOM からは自分の印だと分からなくなるのに、中の button は生きたままだった。
  // 実測（実際に読み込んだ拡張・アクセシビリティのツリー）: 使い回された後、
  // 「「branch」の解説」という名前の押せる button が **2個**あり、そのうち1個は
  // ページの本文の中に居て、**実際に Tab で止まった**（停止点1）。
  //
  // light DOM の側（class・data 属性・操作性）は `stripOwnIdentity` が落とすが、
  // shadow の中はページからも自分の走査からも見えないので、ここで明示的に畳む。
  // ⚠️ **`<slot>` は残す。** 外すとページが入れた本文が描かれなくなる（第21回の実測）。
  function deactivateShadowIcon(host) {
    const btn = iconButton.get(host);
    const desc = iconDesc.get(host);
    iconButton.delete(host);
    iconDesc.delete(host);
    if (btn) {
      // 取り除く前に**先に押せなくする**。取り除きに失敗しても、Tab の停止点は残さない。
      try { btn.disabled = true; } catch (e) { /* 無視できる */ }
      btn.tabIndex = -1;
      btn.removeAttribute('aria-label');
      btn.removeAttribute('aria-describedby');
      btn.removeAttribute('aria-expanded');
      btn.remove();
    }
    if (desc) { desc.textContent = ''; desc.remove(); }
  }

  // その印の「押せる実体」。shadow を使わない場合は host 自身。
  const focusTargetOf = icon => iconButton.get(icon) || icon;

  // shadow の中の button が、ページ由来の変数のせいで 0 画素にならないようにする
  // （第22回 RG-22-02）。
  //
  // ⚠️ **custom property は shadow の境界を越えて継承する。** 見た目を GitHub の
  // テーマに合わせるため、button の色は `--fgColor-accent` などを読んでいる。
  // ページが前方の段落へ `--fgColor-accent: transparent` を置くと、その値が
  // shadow の中まで届き、字も枠も透明になる。実測（実際に読み込んだ拡張・
  // スクリーンショットの画素を数えた）: 印の矩形 14×14 のうち白でない画素が
  // **129 → 0**。それでも実際に Tab で止まり、後方の読める同じ語は説明されなかった。
  //
  // ⚠️ `@property { inherits: false }` は使えない。登録は**文書ぜんぶに効く**ので、
  // ページ自身が使っている `--fgColor-accent` の振る舞いまで変えてしまう。
  //
  // 直し方は「測ってから、shadow の中だけで塗り直す」。closed shadow root の中の
  // インライン指定はページから触れないので、上書きされない。塗れているあいだは
  // 何もしないので、ふだんの見た目（テーマ追従）はそのまま。
  const SHADOW_FG = '--rg-fg';
  const SHADOW_BG = '--rg-bg';
  const shadowPaintSeen = new WeakMap();       // host → 直近に見たページ側の値
  const THEME_VARS = ['--fgColor-accent', '--color-accent-fg',
                      '--bgColor-default', '--color-canvas-default'];

  function ensureShadowPaint(host) {
    const btn = iconButton.get(host);
    if (!btn) return;
    const hs = getComputedStyle(host);
    // ページ側の値が変わっていなければ測り直さない（測るたびに style を外して
    // 付け直すので、無条件に毎回やると描き直しを誘う）。
    let seen = hs.color;
    for (const v of THEME_VARS) seen += '' + hs.getPropertyValue(v).trim();
    if (shadowPaintSeen.get(host) === seen) return;
    shadowPaintSeen.set(host, seen);
    // いったん上書きを外し、**ページのテーマ色で塗れるか**を測る
    btn.style.removeProperty(SHADOW_FG);
    btn.style.removeProperty(SHADOW_BG);
    if (!TRANSPARENT.test(getComputedStyle(btn).color)) return;   // 塗れている
    // 塗れない。ページの本文の色を借りる——その色は、語そのものが読める場所では
    // 必ず地と対比している。本文の色も透明なら、環境の既定色（forced-colors でも
    // 生きている system color）へ落とす。
    const ink = TRANSPARENT.test(hs.color) ? 'CanvasText' : hs.color;
    btn.style.setProperty(SHADOW_FG, ink);
    btn.style.setProperty(SHADOW_BG, 'Canvas');
  }

  function makeIcon(key, term, ja) {
    const icon = document.createElement('span');
    icon.className = 'iiyaku-icon ' + UID;
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
    } else if (USE_SHADOW_STANDALONE && ensureShadowButton(icon)) {
      // light DOM の host は、**単独では Tab の停止点にならない**（第21回 RG-21-06）。
      // 意味づけもフォーカスも、closed shadow root の中の button が持つ。
      setOwnAttr(icon, 'role', null);
      setOwnAttr(icon, 'tabindex', null);
      setOwnAttr(icon, 'aria-label', null);
      setOwnAttr(icon, 'aria-expanded', null);
      setOwnAttr(icon, 'aria-hidden', null);
      setOwnAttr(icon, 'data-iiyaku-for', null);
      const btn = iconButton.get(icon);
      const desc = iconDesc.get(icon);
      // 名前は「どの語の解説か」だけの短いものにし、説明文そのものは
      // 説明用の要素へ置く。名前と説明が同じ全文だと、読み上げで二度読まれる。
      // ⚠️ 説明は**同じ shadow root の中**に置く。境界をまたぐ IDREF は解決されない。
      btn.setAttribute('aria-label', `「${icon.dataset.iiyakuTerm}」の解説`);
      btn.setAttribute('aria-expanded', 'false');
      if (desc) desc.textContent = icon.dataset.iiyaku;
      ensureShadowPaint(icon);      // ページの変数で 0 画素にならないようにする
    } else {
      // shadow を付けられなかった場合の従来どおりの形（Chrome 105 未満など）。
      // 押して開閉するので、role は img ではなく button にする。
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

  // 開閉の状態は、**押せる実体**へ書く（第21回 RG-21-06）。単独の印では
  // それは closed shadow root の中の button で、host には意味づけを持たせない。
  function setExpanded(icon, v) {
    const btn = iconButton.get(icon);
    if (btn) { btn.setAttribute('aria-expanded', v); return; }
    if (icon.getAttribute('role') === 'button') setOwnAttr(icon, 'aria-expanded', v);
  }

  function hideTip() {
    if (tipDescribed) { removeDescribedBy(tipDescribed, TIP_ID); tipDescribed = null; }
    for (const ic of tipIcons) setExpanded(ic, 'false');
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
    tip.className = 'iiyaku-tooltip ' + UID;
    tip.dataset.iiyakuOwner = UID;   // 見た目は合言葉つきの要素にだけ与える
    tip.id = TIP_ID;
    tip.setAttribute('role', 'tooltip');
    tip.appendChild(buildTipBody(icons));
    document.body.appendChild(tip);

    tipAnchor = anchor;
    tipIcons = icons;
    tipDescribed = describe || anchor;
    addDescribedBy(tipDescribed, TIP_ID);
    for (const ic of icons) setExpanded(ic, 'true');
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
    if (rec.icon.tagName !== 'SPAN') return false;
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
    } else if (iconButton.has(rec.icon)) {
      // 単独の印。意味づけは closed shadow root の中の button が持ち、
      // light DOM の host は**単独では Tab の停止点にならない**（第21回 RG-21-06）。
      // ⚠️ host 側に role / tabindex が戻っていないことも見る。戻っていれば、
      // 複製されたときに押せる点が復活する（これを閉じるための作り直しなので）。
      if (rec.icon.hasAttribute('role') || rec.icon.hasAttribute('tabindex')) return false;
      if (rec.icon.hasAttribute('aria-label') || rec.icon.hasAttribute('aria-expanded')) return false;
      if (rec.icon.hasAttribute('aria-hidden')) return false;
      const btn = iconButton.get(rec.icon);
      // shadow の中はページから触れないが、**触れないことを前提にしない**——
      // 参照の同一性と意味づけを、ここで毎回確かめる。
      if (!btn || btn.tagName !== 'BUTTON') return false;
      if (btn.getAttribute('aria-label') !== `「${rec.term}」の解説`) return false;
      const ex = btn.getAttribute('aria-expanded');
      if (ex !== 'true' && ex !== 'false') return false;
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
    // 印そのものが切り取りの外なら、見えない停止点になる（第19回 RG-19-01）
    if (!iconIsPainted(rec.icon)) return false;
    // 単独の印では、Tab の停止点は shadow の中の button（第21回 RG-21-06）
    return tabbable(focusTargetOf(rec.icon));
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
    // 中の押せる実体も、ここで畳む（第22回 RG-22-01）。
    // ⚠️ **DOM に繋がっているかを条件にしない。** ページが外して持っていた印を
    // あとから戻すことがあり、そのとき中の button が生き返る。所有を取り消すのと
    // 同じ場所で、同じ回数だけ畳む。
    deactivateShadowIcon(rec.icon);
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
    if (matcher.findHits(node.nodeValue, key => usableGloss(key) !== null).length === 0) {
      markHandled(node); return 0;
    }
    const hits = visibleHits(node, parent);
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
      // ⚠️ **入れてから、その印が本当に描かれているかを測る**（第19回 RG-19-01）。
      // 語が読めても、直後に入る印だけが切り取りの外へ出ることがある（実測:
      // 負の inset で外へ広げた枠と `overflow-clip-margin` の枠で、印の5点すべてが
      // 印に当たらない＝描かれていないのに `tabIndex:0` で Tab の順路に入っていた）。
      // 場所は**予測しない**——一度「用語の直後に 1.4em」と見積もって判定へ入れたが、
      // 35°回した形の中で外れた。入れて測り、描かれていなければ引き取る。
      // その語はこの世代では諦め、控えへ戻す（形が変われば入り直せる）。
      if (!iconIsPainted(icon)) {
        if (tip && tipIcons.includes(icon)) hideTip();
        ownedIcons.delete(icon); iconTrigger.delete(icon); expectedAttrs.delete(icon);
        removeOwn(icon);
        if (placement.kind === 'hosted') releaseTriggerIfUnused(placement.trigger);
        rememberLatent(cur);
        if (!tail) break;
        cur = tail; consumed = hit.end;
        continue;
      }
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
                 usableCache = new WeakMap(); skipCache = new WeakMap();
                 // `checkVisibility()` はレイアウトを起こすので高い。同じ要素へ
                 // 何度も聞かないよう、このまとめ直しのあいだだけ覚える。控えの
                 // 見直しでは、1つの隠れた入れ物の中に何語も入っているのが普通で、
                 // そこが効く（第16回 RG-16-09）。積み上げた切り取りと同じ前提
                 // ——1回のまとめ直しの中では見え方は変わらない——に乗っている。
                 visCache = new WeakMap(); }
    try {
      return fn();
    } finally {
      if (owner) { renderCache = null; chainCache = null;
                   usableCache = null; skipCache = null; visCache = null; }
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
    // 使った時間を積む（上限を超えたら、カーソルの合図では動かなくなる）
    const bill = () => noteLatentCost(performance.now() - started);
    let n = 0;
    while (latentCursor < latentPass.length) {
      if ((latentCursor & 15) === 0 && performance.now() - started > LATENT_BUDGET_MS) {
        scheduleLatentResume();
        bill();
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
      // 同じ世代で既に見た候補は、答えが変わらない（第19回 RG-19-08）。
      // ここから下がレイアウトを起こす部分なので、その手前で飛ばす。
      if (latentEpoch.get(node) === visEpoch) continue;
      // 範囲を絞った世代（カーソルの合図）では、外の節点はこの世代で変わりえない
      if (!inEpochScope(node)) { latentEpoch.set(node, visEpoch); continue; }
      latentEpoch.set(node, visEpoch);
      if (!isTarget(node)) continue;
      n += annotate(node);
      // 外すのは「もう当たらない」と決まったときだけ。入口がまだ無い節点は控えに残す。
      // ⚠️ ここで先に外して annotate に戻させると、**反復中の Set へ追加**することに
      // なり、その要素をもう一度訪れて無限に回る（実際に固まった）。外すのは後。
      if (isHandled(node)) latent.delete(node);
    }
    latentPass = null; latentCursor = 0;
    // ここが「控えをひと回りし終えた」瞬間。いまの擬似クラスの状態は見終わったので、
    // 同じ状態へ戻ってきても測り直さない（第20回 RG-20-09）。
    // ⚠️ まとめ直しの終わりで印を付けてはいけない——控えが多いと予算（8ms）で
    // 必ず途中になり、`latentPass` が残るので一度も済みにならない
    // （最初そう書いて、2,000候補で 24,024回のまま効かなかった）。
    if (pendingState !== null) { doneStates.add(pendingState); pendingState = null; }
    bill();
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

      let found = 0;
      if (full) {
        // 全体を走るので、変更のあった場所を別に走る必要はない
        // （同じ枝を二度歩かない。大きな領域の属性が変わったときに効く）。
        if (released) reselect();      // generation++ ＋ 全体走査
        else found += scan(document.body);
      } else {
        // 入れ子になった場所は、いちばん外側だけを走ればよい
        for (const n of roots) {
          let covered = false;
          for (let p = n.parentNode; p && !covered; p = p.parentNode) if (roots.has(p)) covered = true;
          if (!covered) found += scanInner(n);
        }
        // ④ 見え方が変わったのなら、まだ印の無い語も見直す。
        //    全体を走ったときは、そこで既に拾えている（同じ枝を二度歩かない）。
        if (deep) found += discoverLatent();
      }
      if (hoverTriggered) { hoverTriggered = false; noteHoverFound(found); }
      // ⚠️ 2周目（断定できない候補の引き受け直し）は**廃止した**（第20回 RG-20-01）。
      // そこを通ると 0画素の語が辞書のキーを取り、見えない押せる点を残していた。
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
    // DOM が変わった＝見え方の状態が変わりうる（第19回 RG-19-08）
    bumpEpoch();
    dropStates();

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
    for (const mu of muts) if (!isSelfMutation(mu)) {
      // stylesheet が増減した＝`:hover` を使う規則の有無を調べ直す（第19回 RG-19-08）
      styleSerial++;
      bumpEpoch();
      dropStates();
      schedule({ deep: true });
      return;
    }
  });
  const HEAD_OPTS = { childList: true, subtree: true, attributes: true, attributeOldValue: true };

  // ---- 見え方の世代（第19回 RG-19-08）----
  // 控えの見直しは、合図が来るたびに**全件**やり直していた（実測: 5,000候補・
  // 10移動で `checkVisibility` 65,000回）。同じ状態のまま2回見ても答えは変わらない。
  // 「見え方に関わる状態が変わった」ときだけ世代を進め、同じ世代で既に見た候補は
  // 飛ばす。世代を進めるのは、DOM の変更・stylesheet の増減・画面の大きさ・
  // CSS の遷移の終わり・利用者の操作・スクロール。
  let visEpoch = 1;
  const latentEpoch = new WeakMap();
  // ⚠️ **カーソルの合図でも控え全件を測り直していた**（第21回 RG-21-07。実測:
  // hover 規則のあるページで 500／2,000／5,000候補・10移動＝6,000／24,000／60,000回）。
  // `:hover` が変わるのは、動く前と動いた後の連なりの差だけで、それは両者の
  // **いちばん近い共通の祖先**の中に収まる。`:has()` と兄弟結合子が無ければ、
  // そこから外れた場所の見え方は変わらない——その範囲だけを測り直す。
  // 範囲を絞った世代では、外の節点は「この世代では見た」ことにして層を降ろさない。
  // ⚠️ 絞りが外れても取りこぼしにはならない: 2秒ごとの確認は必ず**全体**を進める。
  let epochScope = null;                 // Element … その中だけ／null … 全体
  const bumpEpoch = () => { visEpoch++; epochScope = null; };
  const bumpEpochWithin = root => { visEpoch++; epochScope = root || null; };
  // ⚠️ **控えに入っているのは文字の節点**で、`asElement` はそれに `null` を返す
  // （要素だけを通す関数だった）。最初これを使ったため、絞った世代では控えの全件が
  // 「範囲の外」になり、`:active` の反例が一度も拾えなかった。入れ物の要素で見る。
  const ownerEl = n => (n ? (n.nodeType === Node.ELEMENT_NODE ? n : n.parentElement) : null);
  const inEpochScope = node => {
    if (!epochScope) return true;
    const e = ownerEl(node);
    return !!e && (e === epochScope || epochScope.contains(e));
  };
  // 2つの節点の、いちばん近い共通の祖先。どちらかが無ければ全体へ倒す。
  function commonAncestor(a, b) {
    const ea = ownerEl(a), eb = ownerEl(b);
    if (!ea || !eb) return null;
    if (ea === eb) return ea;
    if (ea.contains(eb)) return ea;
    if (eb.contains(ea)) return eb;
    for (let n = ea.parentElement; n; n = n.parentElement) if (n.contains(eb)) return n;
    return null;
  }
  // DOM・stylesheet・画面が変わったら、擬似クラスの状態の記録は捨てる
  const dropStates = () => { if (doneStates.size) doneStates.clear(); };
  // stylesheet が変わった回数（`:hover` を使う規則があるかの調べ直しに使う）
  let styleSerial = 0;

  // ページに、カーソル／フォーカスで見え方が変わりうる規則があるか。
  // 無ければ、カーソルが動いても CSS では何も変わらない——JS で開くメニューは
  // DOM の変更として届くので、見張りのほうが拾う。
  // ⚠️ **自分の stylesheet は数えない**（`:hover` / `:focus-visible` を持っている）。
  const HOVERISH = /:hover|:focus|:focus-within|:focus-visible|:active|:has\(/i;
  const RULE_SCAN_MAX = 20000;

  // stylesheet の「形」の指紋。**`insertRule` / `deleteRule` は DOM に何も出さない**ので、
  // 見張りでは気づけない（第20回 RG-20-06。実測: 起動後に `insertRule` で足した
  // `:hover` メニューが、2秒ごとの確認まで説明されなかった）。
  // 枚数と規則の数だけを読む（各 stylesheet の `cssRules.length` は走査を伴わない）。
  // ⚠️ **件数の和だけでは、同数の差し替えを見逃す**（第21回 RG-21-04）。実測:
  // 1つの規則の `selectorText` を `:hover` の規則へ差し替えると、枚数も規則数も
  // 変わらないので気づけず、その語は**2秒ごとの確認まで説明されなかった**
  // （300ms・600ms で印0、2,400ms でようやく1）。
  // 選択子・条件・入れ子の数まで混ぜた**構造の指紋**にする。
  // ⚠️ 走査は費用がかかるので、**直前の指紋を短い窓のあいだ使い回す**
  // （カーソルの間引きが 150〜300ms なので、それより短い窓に留める）。
  const PRINT_GAP = 120;
  const PRINT_SCAN_MAX = 20000;
  let printAt = -1, printVal = -1;
  function hashStr(h, s) {
    for (let i = 0; i < s.length; i++) h = (h * 33 ^ s.charCodeAt(i)) >>> 0;
    return h;
  }
  function styleFingerprint() {
    const now = performance.now();
    if (printVal !== -1 && now - printAt < PRINT_GAP) return printVal;
    let h = 2166136261, seen = 0;
    for (const sheet of document.styleSheets) {
      h = (h * 33 ^ 0x9e37) >>> 0;                       // 枚の区切り
      let rules;
      try { rules = sheet.cssRules; } catch (e) { h = hashStr(h, 'opaque'); continue; }
      if (!rules) continue;
      const stack = [rules];
      while (stack.length) {
        const rs = stack.pop();
        h = (h * 33 ^ rs.length) >>> 0;
        for (const r of rs) {
          if (++seen > PRINT_SCAN_MAX) { stack.length = 0; break; }
          if (r.selectorText) h = hashStr(h, r.selectorText);
          else if (r.conditionText) h = hashStr(h, r.conditionText);
          else if (r.keyText) h = hashStr(h, r.keyText);       // @keyframes の中の位置
          // 宣言の**本数**まで混ぜる（足された／外された宣言に気づくため）。
          // ⚠️ **中身（`cssText`）は混ぜない。** 第22回 RG-22-04 で一度そうしたが、
          // 実測（10,000規則）で 1回 23〜31ms かかった（本数までなら 0.6〜1.4ms、
          // 選択子だけの現行が 2〜8ms）。費用の中身も測ってあり、文字を舐める分では
          // なく **`cssText` を作る分**（20〜27ms）が主なので、安い書き方が無い。
          // この指紋はカーソルの合図ごと（120ms の窓）に取るので、そこへ 25ms を
          // 足すと、カーソルを動かしているあいだ 20% を使うことになる。
          // 値だけの書き換えは、下の「短い周期の見直し」（→ scheduleFastCheck）が拾う。
          if (r.style) h = (h * 33 ^ r.style.length) >>> 0;
          if (r.cssRules) stack.push(r.cssRules);
        }
      }
    }
    printAt = now; printVal = h;
    return h;
  }

  // `:hover` の効き方が**その連なりの中だけ**に収まるか（第21回 RG-21-07）。
  // `:has()` は祖先を、兄弟結合子（`~` / `+`）は横を変えるので、そのときは絞れない。
  const NONLOCAL = /:has\(|[~+]/;
  let hoverCssSerial = -1, hoverCssPrint = -1, hoverCssHas = true, hoverCssLocal = false;
  function pageUsesHoverRules() {
    const print = styleFingerprint();
    if (hoverCssSerial === styleSerial && hoverCssPrint === print) return hoverCssHas;
    if (hoverCssPrint !== print) { bumpEpoch(); dropStates(); cssMoved = true; }   // 規則が変わった
    hoverCssSerial = styleSerial;
    hoverCssPrint = print;
    let seen = 0, has = false, local = true;
    const give = (v, l) => { hoverCssHas = v; hoverCssLocal = v ? l : true; return v; };
    try {
      for (const sheet of document.styleSheets) {
        if (ownStyle && sheet.ownerNode === ownStyle) continue;
        let rules;
        try { rules = sheet.cssRules; } catch (e) { return give(true, false); }  // 読めない＝あるものとして扱う
        if (!rules) continue;
        const stack = [rules];
        while (stack.length) {
          for (const r of stack.pop()) {
            if (++seen > RULE_SCAN_MAX) return give(true, false);           // 大きすぎる＝絞らない
            // ⚠️ ここで最初の1件で切り上げてはいけない。**あるか**だけでなく、
            // **すべてが連なりの中に収まるか**まで知りたい（絞ってよいかの判断）。
            if (r.selectorText && HOVERISH.test(r.selectorText)) {
              has = true;
              if (NONLOCAL.test(r.selectorText)) local = false;
            }
            if (r.cssRules) stack.push(r.cssRules);
          }
        }
      }
    } catch (e) { return give(true, false); }
    return give(has, local);
  }

  // DOM の変更を伴わない合図。CSS の遷移・アニメーションの終わり、画面の大きさの変化。
  const EXTERNAL_SIGNALS = ['transitionend', 'transitioncancel', 'animationend', 'animationcancel'];
  const onExternal = e => { if (!isOurNode(e.target)) { bumpEpoch(); dropStates(); schedule({ deep: true }); } };
  const onViewport = () => { bumpEpoch(); dropStates(); schedule({ deep: true }); };
  // 利用者の操作は、属性に出ない状態（checked など）を変えうる
  const onInteraction = () => { bumpEpoch(); dropStates(); schedule({ deep: true }); };

  // スクロールが落ち着いたら見直す。**吸い寄せのある枠では、止まってからでないと
  // 到達できるかを断定できない**（第19回 RG-19-02）。`scrollend` が無い版のために、
  // `scroll` から遅らせて1回だけ出す形も置く。
  const SCROLL_SETTLE = 150;
  let scrollTail = null;
  const onScrollSignal = () => {
    bumpEpoch();
    dropStates();
    if (scrollTail !== null) clearTimeout(scrollTail);
    scrollTail = setTimeout(() => {
      scrollTail = null;
      if (observing) schedule({ deep: true });
    }, SCROLL_SETTLE);
  };

  // カーソルとフォーカスも合図にする。`:hover` / `:focus-within` だけで開く
  // メニューは、DOM も属性も transition も動かさないので、どの合図にも乗らない。
  // 実測: 400ms 出しただけのメニューには説明が1つも付かず、開けたまま2秒の確認を
  // またいで初めて付いた。短いメニューは、それより先に閉じる。
  //
  // 見直す先が無いなら何もしない。カーソルは大量に動くので、1フレームに1回へまとめる
  // （まとめないと、動かした回数だけまとめ直しが走る）。
  // 控えが多いページでは、カーソルを動かすたびに控え全体の見直しが始まっていた
  // （実測: 5,000候補・40回の移動で 128 回・約887ms）。時間でも間引く。
  // ⚠️ 間引きは「捨てる」ではなく「あとで1回やる」にする。捨てるだけだと、
  // 1つ目のメニューから 60ms で2つ目へ移ったとき、2つ目をどれだけ開いていても
  // 暇なときの確認まで説明が付かない（第15回 RG-15-07）。
  // カーソルの合図1回の費用は、控えの件数に比例する。1件あたりの費用は下げたが
  // （第16回 RG-16-09）、比例そのものは残る。見直す範囲を「カーソルの下の枝」へ
  // 狭めるのは `:has()` や兄弟結合子があるため安全でないので、代わりに
  // **使ってよい時間に上限を置く**（第17回 RG-17-07）。
  //   直近 CPU_WINDOW の間に、控えの見直しへ CPU_BUDGET を超えて使ったら、
  //   カーソルの合図では動かない。2秒ごとの確認は続くので、正しさは失われず遅れるだけ。
  const CPU_WINDOW = 2000;
  const CPU_BUDGET = 200;          // 2秒のうち 200ms（10%）まで
  let spentAt = 0, spent = 0;
  function noteLatentCost(ms) {
    const now = performance.now();
    if (now - spentAt > CPU_WINDOW) { spentAt = now; spent = 0; }
    spent += ms;
  }
  function overBudget() {
    const now = performance.now();
    if (now - spentAt > CPU_WINDOW) { spentAt = now; spent = 0; }
    return spent > CPU_BUDGET;
  }

  // 何も見つからない見直しが続いたら、間隔を空ける（第18回 RG-18-08）。
  // 何もない場所でカーソルを動かし続けているときに効き、メニューが開いて1つでも
  // 見つかれば即座に元の間隔へ戻す。上限は 300ms に留める——第15回 RG-15-07 で
  // 直した「短時間ひらくメニュー」を取りこぼさないため。
  const HOVER_GAP = 150;
  const HOVER_GAP_MAX = 300;
  let hoverGap = HOVER_GAP;
  let emptyRuns = 0;
  function noteHoverFound(n) {
    if (n > 0) { emptyRuns = 0; hoverGap = HOVER_GAP; }
    else { emptyRuns++; hoverGap = Math.min(HOVER_GAP_MAX, HOVER_GAP * (1 + emptyRuns)); }
  }

  let hoverPending = false;
  let hoverAt = 0;
  let hoverTail = null;
  // ---- 擬似クラスの状態（第20回 RG-20-09）----
  // `:hover` が当たるのは、ポインタの祖先の連なりだけ。`:focus-within` も同じ形。
  // **その連なりが同じなら、CSS が作る見え方は同じ**なので、一度ひと回りし終えた
  // 状態へ戻ってきたときに全件を測り直す必要は無い。
  // 以前は、カーソルが要素の境目をまたぐたびに世代を進めて全件を回していた
  // （実測: hover 規則のあるページで 2,000候補・10移動＝28,000回）。
  // DOM や stylesheet が変われば `doneStates` は捨てるので、正しさは落ちない。
  let stateSerial = 0;
  const stateIds = new WeakMap();
  const doneStates = new Set();
  function chainKey(node) {
    const out = [];
    for (let n = asElement(node); n; n = n.parentElement) {
      let id = stateIds.get(n);
      if (id === undefined) { id = ++stateSerial; stateIds.set(n, id); }
      out.push(id);
    }
    return out.join('.');
  }
  // ⚠️ `:active` は**押している相手の連なり**で決まる。カーソルの位置と入力先だけでは、
  // 「同じ場所を押した／離した」が hover と同じ鍵になり、`doneStates` に阻まれて
  // 一度も測り直されない（第21回 RG-21-05）。押している相手も鍵に入れる。
  let pressedNode = null;
  function notePress(e) {
    if (!e || !e.type) return;
    if (e.type === 'pointerdown') pressedNode = e.target;
    else if (e.type === 'pointerup' || e.type === 'pointercancel') pressedNode = null;
  }
  // ⚠️ 入力のやり方も鍵に入れる（第22回 RG-22-05）。連なりだけを鍵にすると、
  // 「同じ相手にフォーカスしたまま modality だけ変わった」が同じ鍵になり、
  // `doneStates` に阻まれて一度も測り直されない。
  function focusVisibleNow() {
    const a = document.activeElement;
    if (!a || typeof a.matches !== 'function') return '-';
    try { return a.matches(':focus-visible') ? 'k' : 'm'; } catch (e) { return '-'; }
  }
  function pseudoStateKey(e) {
    return chainKey(e && e.target) + '|' + chainKey(document.activeElement)
         + '|' + (pressedNode ? chainKey(pressedNode) : '-')
         + '|' + focusVisibleNow();
  }
  let pendingState = null;

  // 間引きの窓で待たせた合図の、**そのときの状態**。⚠️ 以前は待ち時間のあとに
  // `onPointerOrFocus()` を**引数なしで**呼び直していた（第21回 RG-21-05）。
  // `pseudoStateKey(undefined)` は連なりを持たない別の鍵になるので、実際に見ていた
  // 相手を失い、その状態を「済み」として記録してしまう。鍵のほうを持ち越す。
  let hoverTailKey = null;
  let lastStateNode = null;        // 直前に合図の来た相手（範囲を絞るための基点）
  // ---- 測り直す範囲の накопление（第21回 RG-21-07）----
  // ⚠️ **飲み込んだ合図の範囲を捨ててはいけない**。最初こう書いておらず、
  // `hoverPending` で見送った `pointerover`（＝新しく入った相手）の範囲が落ち、
  // 既存の対照が8件落ちた。範囲は合図ごとに**広げて溜め**、実際に走る直前に使う。
  // `undefined` … まだ何も／`null` … 全体（絞らない）／Element … その中だけ
  let scopeAcc;
  let cssMoved = false;            // この間に stylesheet が変わった＝絞らない
  function widenScope(node) {
    if (scopeAcc === null) return;                        // すでに全体
    const e = ownerEl(node);
    if (!e) { scopeAcc = null; return; }                  // 相手が分からない＝絞らない
    scopeAcc = (scopeAcc === undefined) ? e : commonAncestor(scopeAcc, e);
    if (scopeAcc === document.documentElement) scopeAcc = null;
  }
  function takeScope() {
    const s = (cssMoved || !hoverCssLocal || scopeAcc === undefined) ? null : scopeAcc;
    scopeAcc = undefined; cssMoved = false;
    return s;
  }
  const onPointerOrFocus = (e, forcedKey) => {
    notePress(e);                  // 早く返る道でも、押した／離したの記録は落とさない
    if (latent.size === 0) return;
    // カーソルで見え方が変わりうる規則がページに無いなら、見直す意味が無い
    // （第19回 RG-19-08）。JS で開くメニューは DOM の変更として別経路で届く。
    if (!pageUsesHoverRules()) return;
    // 同じ擬似クラスの状態で、既にひと回り終えているなら、答えは変わらない
    const key = forcedKey || pseudoStateKey(e);
    if (doneStates.has(key)) return;
    // 変わった相手を、飲み込む場合でも必ず範囲へ足す（第21回 RG-21-07）
    if (e) { widenScope(lastStateNode); widenScope(e.target); }
    else widenScope(null);                              // 相手が分からない合図＝絞らない
    const now2 = ownerEl(e && e.target);
    if (now2) lastStateNode = now2;
    if (hoverPending) { hoverTailKey = key; return; }   // 予約済み。鍵だけ最新にする
    pendingState = key;
    if (overBudget()) return;      // 使いすぎた。2秒ごとの確認に任せる
    const now = performance.now();
    if (now - hoverAt < hoverGap) {
      // 最後の1回は、間引きの窓が明けたあとに必ず処理する
      hoverTailKey = key;
      if (hoverTail === null) {
        hoverTail = setTimeout(() => {
          hoverTail = null;
          const k = hoverTailKey; hoverTailKey = null;
          onPointerOrFocus(null, k);
        }, hoverGap - (now - hoverAt));
      }
      return;
    }
    hoverAt = now;
    // ⚠️ `hoverPending` は宣言だけで**一度も true にならず**、入口の門が効いていなかった
    // （第21回 RG-21-05）。予約した時点で立てる。
    hoverPending = true;
    const fire = () => {
      hoverPending = false;
      if (!observing) return;
      // ⚠️ 世代を進めるのは**ここ**。合図の時点で進めると、そのあと飲み込んだ
      // 合図の範囲を取り込めない（第21回 RG-21-07）。
      const sc = takeScope();
      if (sc) bumpEpochWithin(sc); else bumpEpoch();
      hoverTriggered = true;
      schedule({ deep: true });
      // 待たせているあいだに状態が進んでいたら、そこから続ける
      if (hoverTailKey !== null && !doneStates.has(hoverTailKey)) {
        const k = hoverTailKey; hoverTailKey = null;
        onPointerOrFocus(null, k);
      }
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fire);
    else setTimeout(fire, 16);
  };
  let hoverTriggered = false;
  // ⚠️ `:active` は規則の走査（HOVERISH）では見ているのに、**購読していなかった**
  // （第21回 RG-21-05。実測: `:active` だけで開くメニューは、押しているあいだ印0で、
  // 2秒ごとの確認まで説明されなかった。対照の `:hover` は即1）。
  // ⚠️ `keydown` も要る（第22回 RG-22-05）。**フォーカスの相手を変えずに、入力の
  // やり方（マウス→キーボード）だけが変わると `:focus-visible` が付く。** 実測:
  // マウスで押して focus した状態から矢印キーを1回押すと `:focus-visible` は
  // false → true になり、それで開くメニューは 600ms 後も印0のままだった
  // （2秒ごとの確認でようやく1）。`focusin` は相手が変わらないので来ない。
  const HOVER_SIGNALS = ['pointerover', 'pointerout', 'focusin', 'focusout',
                         'pointerdown', 'pointerup', 'pointercancel', 'keydown'];
  // 画面内の移動（`:target` の付け替え）。DOM も属性も動かないので、どの合図にも乗らない。
  // 実測: `location.hash` を変えて `:target` で開いたメニューは、600ms 後も印0だった。
  const NAV_SIGNALS = ['hashchange', 'popstate'];
  const onNavState = () => { bumpEpoch(); dropStates(); schedule({ deep: true }); };
  // `pushState` は何の event も出さない。Navigation API があれば、そこも拾う。
  const navApi = (typeof navigation === 'object' && navigation &&
                  typeof navigation.addEventListener === 'function') ? navigation : null;
  // `scrollend` はブラウザが「止まった」と決めた瞬間に1回だけ来る。無い版のために
  // `scroll` も取り、そこから遅らせて1回にまとめる（→ onScrollSignal）。
  const SCROLL_SIGNALS = ('onscrollend' in window) ? ['scrollend'] : ['scroll'];

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
      // ⚠️ ここでは**必ず世代を進める**（第19回 RG-19-08 の門を、この経路には掛けない）。
      // 暇なときの確認は、属性にも DOM にも出ない変化（`checked` など property だけの
      // 書き換え）を拾うためにある。世代が進まないと「同じ世代で見た」として飛ばされ、
      // その変化に永久に気づかない（実測: 2,100件の控えのある見本と、上限で
      // こぼれた候補の見本が、どちらも後から見えた語を見つけられなくなった）。
      const run = () => { bumpEpoch(); dropStates(); schedule({ deep: true }); scheduleIdleCheck(); };
      if (canIdle) requestIdleCallback(run, { timeout: IDLE_GAP });
      else run();
    }, IDLE_GAP);
  }

  // 合図の出ない変化を、**もっと短い周期**で見に行く（第22回 RG-22-04）。
  //
  // CSSOM の書き換え（`sheet.cssRules[0].style.display = 'inline'`）は、DOM にも
  // 属性にも event にも出ない。実測: 選択子も規則の数も変えずに `none` → `inline`
  // にすると、650ms 後も印は0のままで、2秒ごとの確認でようやく1になった。
  //
  // ⚠️ **指紋を短い周期で取り直す形は採らなかった。** 宣言の中身まで混ぜた指紋は
  // 10,000規則で1回 23〜31ms かかり（→ styleFingerprint の注記に実測値）、
  // 400ms ごとに取るとそれだけで 6〜8% を使う。しかも指紋は「どこかが変わった」
  // としか言えない。**控えの見え方そのものを測り直すほうが安く、かつ広い**——
  // CSSOM に限らず、合図の出ない変化すべてに効く。
  //
  // 使いすぎの門（overBudget）を通すので、重いページでは自動的に見送られ、
  // 2秒ごとの確認へ落ちる。正しさは落ちず、遅れるだけ。
  // ⚠️ **間隔は控えの件数に合わせて空ける。** 1回の見直しの費用は件数に比例するので、
  // 件数が増えても一定の間隔で回すと、そのぶんだけ CPU を食い続ける。実測（控え
  // 5,000件・カーソル10移動）で `checkVisibility` が 35,042 → 46,844 回になった。
  // 1秒あたりに見る件数を頭打ちにする（＝件数が増えたら間隔を空ける）。
  const FAST_GAP = 400;
  const FAST_GAP_MAX = 2000;          // ここまで空けたら、2秒ごとの確認と同じ
  const FAST_RATE = 1250;             // 1秒あたりに見てよい候補数のめやす
  const fastGap = () => Math.min(FAST_GAP_MAX,
    Math.max(FAST_GAP, Math.round(latent.size / FAST_RATE * 1000)));
  let fastTimer = null;
  function scheduleFastCheck() {
    if (!observing || fastTimer !== null) return;
    fastTimer = setTimeout(() => {
      fastTimer = null;
      if (!observing) return;
      // 見に行く相手（あとで見えるかもしれない候補）が無いなら、何もしない。
      // ⚠️ **まとめ直し（runBatch）を予約しない。** ここは周期の見張りであって
      // ページの変更ではない。予約すると「1回のページ変更で、まとめ直しは1回」を
      // 守っている検査が、この見張りの分まで数えて落ちる（実測: 1 のはずが 3）。
      // 見たいのは控えの側だけなので、控えの見直しへ直接入る。使った時間は
      // `noteLatentCost` へ積まれるので、重ければ次から自動的に見送られる。
      // ⚠️ **`dropStates()` を呼んではいけない。** 擬似クラスの状態の memo を消すと、
      // 次のカーソルの合図が「まだ見ていない状態」として全件を回し直す。実測で
      // `checkVisibility` が 3,542 → 18,108 回（500件・カーソル10移動）に膨らんだ。
      // ここで見たいのは控えの側だけで、カーソルの状態は変わっていない。
      // stylesheet が変わったときの memo 破棄は `pageUsesHoverRules` が担当する。
      if (!document.hidden && latent.size > 0 && !overBudget()) {
        bumpEpoch();
        withRenderCache(() => discoverLatent());
      }
      scheduleFastCheck();
    }, fastGap());
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
    for (const t of SCROLL_SIGNALS) document.addEventListener(t, onScrollSignal, true);
    for (const t of NAV_SIGNALS) window.addEventListener(t, onNavState);
    if (navApi) navApi.addEventListener('navigatesuccess', onNavState);
    scheduleIdleCheck();
    scheduleFastCheck();
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
    for (const t of SCROLL_SIGNALS) document.removeEventListener(t, onScrollSignal, true);
    for (const t of NAV_SIGNALS) window.removeEventListener(t, onNavState);
    if (navApi) navApi.removeEventListener('navigatesuccess', onNavState);
    if (scrollTail !== null) { clearTimeout(scrollTail); scrollTail = null; }
    if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null; }
    if (fastTimer !== null) { clearTimeout(fastTimer); fastTimer = null; }
    if (latentResume !== null) { clearTimeout(latentResume); latentResume = null; }
    if (hoverTail !== null) { clearTimeout(hoverTail); hoverTail = null; }
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
    // ページの class は読みも書きもしない。自分の属性を1つ出し入れするだけにする。
    // 名前そのものが自分のものなので、ページの持ち物と重ならない（→ OFF_ATTR）。
    setOwnAttr(root, OFF_ATTR, enabled ? null : UID);
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
    btn.className = 'iiyaku-toggle ' + UID;
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
  // ページ側の同名要素から**自分の見た目だけ**を引き上げる規則。
  //
  // 以前は `styles.css` が与える性質すべてを `revert` していたが、それは
  // **ページ自身の author style まで打ち消して**いた（実測: ページの
  // `display:grid`・赤・140×30px が block・黒・740×24px になった）。
  // いまは2段構えにする:
  //   ① `styles.css` をカスケードレイヤーへ入れた。ページが同じ性質を指定していれば
  //      必ずページが勝つので、打ち消す必要がない
  //   ② ページが指定していない性質だけが残る。そのうち**画面を乗っ取るもの**
  //      （固定配置・重なり順・当たり判定・押せる形）を、ここで初期値へ戻す
  // 絞り込みの規則は **`repogloss` より後ろのレイヤー**へ入れる。順序は
  //   repogloss（自分の見た目） < repogloss-scope（この規則） < ページのレイヤー無し規則
  // なので、自分の見た目は確実に打ち消せて、**ページ自身の指定には必ず負ける**。
  // 以前はレイヤー無しで書いていたため、ページの指定まで打ち消していた（実測:
  // ページの `display:grid`・赤・140×30px が block・黒・740×24px になった）。
  let ownStyle = null;
  let ownStyleText = '';

  // `styles.css` は**雛形**で、そのままでは使わない。合言葉を埋めてから入れる。
  //   `@layer RG_LOOK, RG_SCOPE;`  … レイアウト名を読み込みごとの名前へ
  //   `[data-iiyaku-owner]`        … 値まで自分のものに限る
  // 値まで見るので、ページが同じ class と属性を持つ要素を作っても**一致しない**。
  // 打ち消す規則（revert）はもう要らない——与えなければ、打ち消す必要も無い。
  // 以前は打ち消す側で、ページ自身の指定まで巻き込んでいた（第14回・第19回）。
  function ownStyleRules() {
    const mine = `[data-iiyaku-owner="${CSS.escape(UID)}"]`;
    const body = CSS_TEXT
      .replace(SHADOW_SECTION, '')       // shadow 専用の区間はページへ入れない
      .replace(/\bRG_LOOK\b/g, MAIN_LAYER)
      .replace(/\bRG_SCOPE\b/g, SCOPE_LAYER)
      .replace(/\[data-iiyaku-owner\]/g, mine);
    // OFF のとき、**自分の印だけ**を隠す。目印はページと共有しない合言葉つきの属性
    // （以前は `<html>` の class を使い、ページの同名 class を消していた）。
    const off = `@layer ${SCOPE_LAYER}{` +
                `${document.documentElement.tagName.toLowerCase()}[${CSS.escape(OFF_ATTR)}] ` +
                `.${OWN_CLASSES[0]}${mine}{display:none}}`;
    return body + '\n' + off;
  }

  let ownStyleDigest = -1;

  function scopeOwnStyle() {
    try {
      const st = document.createElement('style');
      ownStyleText = ownStyleRules();
      st.textContent = ownStyleText;
      (document.head || document.documentElement).appendChild(st);
      ownStyle = st;
      // 入れた直後の**規則の中身**を控える（→ ensureOwnStyle が生きた規則と突き合わせる）
      ownStyleDigest = ruleDigest(st);
    } catch (e) {
      // 足せなくても本体の動作は変わらない（複製は sanitizeClones が無力化する）
      console.error('[iiyaku] 見た目を足せません:', e);
    }
  }

  // 生きている規則の**中身**をたどって1つの値にする。自分の style は3規則しかないので
  // 全量で構わない。⚠️ 規則の数だけでは足りない（第21回 RG-21-04。実測: 規則数も
  // `textContent` も変えずに `opacity:0!important` を1つ足されると、印は退役して
  // 消えたのに style は直されなかった）。
  function ruleDigest(st) {
    try {
      const sheet = st.sheet;
      if (!sheet || !sheet.cssRules) return -1;
      let h = 2166136261;
      const walk = rs => {
        h = (h * 33 ^ rs.length) >>> 0;
        for (const r of rs) { h = hashStr(h, r.cssText || ''); if (r.cssRules) walk(r.cssRules); }
      };
      walk(sheet.cssRules);
      return h;
    } catch (e) { return -1; }
  }

  // ページ側が消したら足し直す。消されたままだと、複製や同名要素へ自分の見た目が戻る。
  function ensureOwnStyle() {
    // 「在ること」「書いたとおりであること」に加えて、**生きた規則の数**も見る。
    // ⚠️ `sheet.deleteRule()` は `textContent` を変えない（第20回 RG-20-07。実測:
    // 自分の style の規則を3つとも消しても文字列は 7,943 文字のままで、
    // 規則0件の style を正常と判定していた。印は装飾を失い幅0になる）。
    if (ownStyle && ownStyle.isConnected && ownStyle.textContent === ownStyleText
        && (ownStyleDigest < 0 || ruleDigest(ownStyle) === ownStyleDigest)) return;
    if (ownStyle && ownStyle.isConnected) removeOwn(ownStyle);
    ownStyle = null;
    ownStyleDigest = -1;
    scopeOwnStyle();
  }

  /* ---------- 11. 実行 ---------- */
  scopeOwnStyle();
  bindTip();        // 監視の ON / OFF に関わらず、入口は一度だけ張る
  createToggle();
  applyEnabled(enabled);
})();
