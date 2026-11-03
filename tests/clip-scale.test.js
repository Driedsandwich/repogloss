// 覆いを祖先の切り取りで狭める関数（solidCover）の、縮尺の扱いの単体テスト（第25回 RG-25-01）。
//
// content.js は拡張の中でしか動かない（即時関数の中に閉じている）ので、
// **その関数の文字列だけを切り出して**、作り物の要素の上で動かす。製品側に検査用の口は足さない。
// 切り出しに失敗したら、それ自体を失敗にする（「測れなかった」を「通った」と同じ顔にしない）。
//
// ⚠️ 以前は、切り取りの祖先に拡大縮小があると、縮尺を「外接矩形の幅 ÷ `offsetWidth`」で
//    求めていた。`offsetWidth` も `clientLeft`・`clientWidth` も整数に丸めた値なので、
//    端数の幅の箱を大きく拡大すると（監査の例: 幅 1.375px の箱を `scaleX(100)`）、
//    切り取りの範囲が両方向にずれた（狭く見積もる＝見落とす／広く見積もる＝見えている印を
//    覆われたと断定する）。
//
// 作り物の寸法の決め方（Chrome の丸めの**模型**。実測ではない）:
//   offsetWidth  = round(x + 幅) - round(x)                     （x は箱の左端の配置上の位置）
//   clientLeft   = 左の境界の太さ（整数の太さだけを使う）
//   clientWidth  = round(x + 左境界 + 内側の幅) - round(x + 左境界)
//   外接矩形     = 画面上の左端から、幅 × 縮尺
// 縦も同じ。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'content.js'), 'utf8');
const pick = (label, re) => {
  const m = re.exec(src);
  if (!m) throw new Error(`content.js から ${label} を切り出せない（書き方が変わった？）`);
  return m[0];
};
const body = [
  pick('angleToRad', /  function angleToRad\(v\) \{[\s\S]*?\n  \}\n/),
  pick('rotateLinear', /  function rotateLinear\(v\) \{[\s\S]*?\n  \}\n/),
  pick('scaleLinear', /  function scaleLinear\(v\) \{[\s\S]*?\n  \}\n/),
  pick('transformLinear', /  function transformLinear\(v\) \{[\s\S]*?\n  \}\n/),
  pick('ownLinear', /  function ownLinear\(cs\) \{[\s\S]*?\n  \}\n/),
  pick('isIdentity', /  const isIdentity = .*;\n/),
  pick('mul', /  const mul = [\s\S]*?\}\);\n/),
  pick('isNoneVal', /  const isNoneVal = .*;\n/),
  pick('paintEffect', /  function paintEffect\(s\) \{[\s\S]*?\n  \}\n/),
  pick('hasRadius', /  const hasRadius = [\s\S]*?;\n/),
  pick('clipsInside', /  const clipsInside = [\s\S]*?;\n/),
  pick('coordKind', /  const coordKind = s => \{[\s\S]*?\n  \};\n/),
  pick('solidCover', /  function solidCover\(el, cs, r\) \{[\s\S]*?\n  \}\n/)
].join('');

// ---- 作り物の要素 ----
const BASE = {
  visibility: 'visible', display: 'block', opacity: '1', position: 'static',
  filter: 'none', clipPath: 'none', offsetPath: 'none', maskImage: 'none', webkitMaskImage: 'none',
  webkitMaskBoxImageSource: 'none', mixBlendMode: 'normal', clip: 'auto',
  rotate: 'none', scale: 'none', transform: 'none', zoom: '1', perspective: 'none',
  borderTopLeftRadius: '0px', borderTopRightRadius: '0px',
  borderBottomRightRadius: '0px', borderBottomLeftRadius: '0px',
  backgroundClip: 'border-box', overflowX: 'visible', overflowY: 'visible',
  contain: 'none', contentVisibility: 'visible', scrollbarGutter: 'auto',
  borderLeftWidth: '0px', borderTopWidth: '0px', borderRightWidth: '0px', borderBottomWidth: '0px'
};
const node = (style, parent, geo = {}) => ({ _s: { ...BASE, ...style }, parentElement: parent, ...geo });

const html = node({}, null);
const bodyEl = node({}, html);
const document = { documentElement: html, body: bodyEl };
const getComputedStyle = n => n._s;
// eslint-disable-next-line no-new-func
const { solidCover } = new Function('document', 'getComputedStyle',
  'const HAS_CHECK_VISIBILITY = false, CHECK_VISIBILITY_OPTS = {};\n' + body +
  'return { solidCover };')(document, getComputedStyle);

const snap = (x, w) => Math.round(x + w) - Math.round(x);
const mat = (a, d) => (a === 1 && d === 1 ? 'none' : `matrix(${a}, 0, 0, ${d}, 0, 0)`);

// 切り取りの箱を1つ作り、その中の覆いで solidCover を呼ぶ。
//   w, h       … 配置上の border box の幅・高さ（端数可）
//   lx, ly     … 配置上の左端・上端（丸めの位置を変える）
//   bl,bt,br,bb… 境界の太さ（整数）
//   own        … 切り取り自身の縮尺 [x, y]、up … 親の縮尺 [x, y]
//   X, Y       … 画面上の外接矩形の左上
//   bar        … 縦のスクロールバーの幅（配置上）。0 なら無し
function run({ w, h, lx = 0, ly = 0, bl = 0, bt = 0, br = 0, bb = 0, own = [1, 1], up = [1, 1],
               X = 10, Y = 20, bar = 0, overflow = 'hidden', parentTransform }) {
  const SX = own[0] * up[0], SY = own[1] * up[1];
  const parent = node({ transform: parentTransform || mat(up[0], up[1]) }, bodyEl);
  const clip = node({
    overflowX: overflow, overflowY: overflow, transform: mat(own[0], own[1]),
    borderLeftWidth: `${bl}px`, borderTopWidth: `${bt}px`,
    borderRightWidth: `${br}px`, borderBottomWidth: `${bb}px`
  }, parent, {
    offsetWidth: snap(lx, w), offsetHeight: snap(ly, h),
    clientLeft: bl, clientTop: bt,
    clientWidth: snap(lx + bl, w - bl - br - bar), clientHeight: snap(ly + bt, h - bt - bb),
    scrollWidth: snap(lx + bl, w - bl - br - bar), scrollHeight: bar ? 10000 : snap(ly + bt, h - bt - bb),
    getBoundingClientRect: () => ({ left: X, top: Y, right: X + w * SX, bottom: Y + h * SY,
                                    width: w * SX, height: h * SY })
  });
  const cover = node({ position: 'absolute' }, clip);
  // 覆いの矩形は切り取りより十分に大きくする（狭めた結果がそのまま切り取りの範囲になる）
  const r = { left: -1e6, top: -1e6, right: 1e6, bottom: 1e6, width: 2e6, height: 2e6 };
  const truth = {
    left: X + bl * SX, top: Y + bt * SY,
    right: X + (w - br - bar) * SX, bottom: Y + (h - bb) * SY
  };
  return { got: solidCover(cover, cover._s, r), truth };
}

const near = (got, want, why) => {
  assert.ok(got, `${why}: 断定しなかった（null）。画面上の切り取りは ${JSON.stringify(want)}`);
  for (const k of ['left', 'top', 'right', 'bottom']) {
    assert.ok(Math.abs(got[k] - want[k]) < 1e-6,
      `${why}: ${k} が ${got[k]}（画面上の切り取りは ${want[k]}）`);
  }
};

// 印（14px 四方）が覆いの矩形に掛かるか。ghostsOver と同じ比べ方。
const ICON = 14;
const overlaps = (g, x, y) => !(g.right <= x || g.left >= x + ICON || g.bottom <= y || g.top >= y + ICON);

test('監査の例: 幅 1.375px・左境界 1px の箱を scaleX(100)。切り取りを狭く見積もらない', () => {
  // 画面上の padding box は X+100〜X+137.5。以前は縮尺を 137.5 と読み、範囲が消えていた
  const { got, truth } = run({ w: 1.375, h: 20, bl: 1, own: [100, 1] });
  near(got, truth, '1.375px × 100');
});

test('幅 1.6px・左境界 1px の箱を scaleX(100)。切り取りを広く見積もらない', () => {
  // 以前は縮尺を 80 と読み、X+80〜X+100（境界の上）まで覆いが広がった＝見えている印を覆われたと断定
  const { got, truth } = run({ w: 1.6, h: 20, bl: 1, own: [100, 1] });
  near(got, truth, '1.6px × 100');
  assert.equal(overlaps(got, truth.left - ICON - 1, 25), false, '切り取りの外の印を覆われたと断定した');
});

test('縦も同じ: 高さ 1.375px・上境界 1px の箱を scaleY(100)', () => {
  const { got, truth } = run({ w: 20, h: 1.375, bt: 1, own: [1, 100] });
  near(got, truth, '高さ 1.375px × 100');
});

test('縮尺が祖先に分かれていても同じ（親 scaleX(10) × 自身 scaleX(10)）', () => {
  const { got, truth } = run({ w: 1.6, h: 20, bl: 1, own: [10, 1], up: [10, 1] });
  near(got, truth, '10 × 10');
});

test('【対照】ふつうの縮尺（0.5〜2 倍）では、14px の印の判定が画面上の切り取りどおり', () => {
  for (const S of [0.5, 0.75, 1.25, 1.5, 2]) {
    for (const g of [
      { w: 100, h: 60, lx: 0.3, ly: 0.6 },
      { w: 100.4, h: 60.5, lx: 0.5, ly: 0.25, bl: 3, bt: 3, br: 3, bb: 3 },
      { w: 180, h: 140, lx: 0.7, bl: 40, bt: 40, br: 40, bb: 40 }      // 第24回 E2E の「境界 40px」に相当
    ]) {
      for (const where of ['own', 'up']) {
        const opt = { ...g, [where]: [S, S] };
        const { got, truth } = run(opt);
        const why = `${where} scale(${S}) ${JSON.stringify(g)}`;
        assert.ok(got, `${why}: 断定しなかった`);
        // 印を、切り取りの内側・各辺の 2px 外側に置いて、掛かるかどうかが真の範囲と一致すること
        const cx = (truth.left + truth.right) / 2 - ICON / 2, cy = (truth.top + truth.bottom) / 2 - ICON / 2;
        const spots = [
          [cx, cy, true],
          [truth.left - ICON - 2, cy, false], [truth.right + 2, cy, false],
          [cx, truth.top - ICON - 2, false], [cx, truth.bottom + 2, false]
        ];
        for (const [x, y, want] of spots) {
          assert.equal(overlaps(got, x, y), want, `${why}: 印 (${x}, ${y}) の判定`);
          assert.equal(overlaps(truth, x, y), want, '試験の前提');
        }
        // 丸めのずれは 1px 未満に収まる
        for (const k of ['left', 'top', 'right', 'bottom']) {
          assert.ok(Math.abs(got[k] - truth[k]) < 1, `${why}: ${k} ${got[k]} / ${truth[k]}`);
        }
      }
    }
  }
});

test('【対照】縮尺の無い切り取りは、従来どおり clientLeft・clientWidth の範囲', () => {
  const { got } = run({ w: 100.4, h: 60, lx: 0.3, bl: 2 });
  near(got, { left: 12, top: 20, right: 12 + snap(2.3, 98.4), bottom: 80 }, '縮尺なし');
});

test('【対照】縮尺があっても一律に断定をやめない（第24回の直しを後退させない）', () => {
  const { got } = run({ w: 100, h: 50, own: [0.5, 0.5] });
  assert.ok(got, '縮小された切り取りの中の覆いを、断定しなかった');
});

test('【対照】回転などの変形が上にあれば断定しない', () => {
  const { got } = run({ w: 100, h: 50, parentTransform: 'matrix(0.8, 0.6, -0.6, 0.8, 0, 0)' });
  assert.equal(got, null);
});

test('【対照】縮尺のある切り取りにスクロールバーが出ているとき、バーの上まで広げない', () => {
  const { got, truth } = run({ w: 100, h: 50, bar: 15, overflow: 'auto', own: [2, 2] });
  // 断定しない（null）か、断定するならバーの手前まで
  if (got) assert.ok(got.right <= truth.right + 1e-6, `バーの上まで覆いを広げた: ${got.right} > ${truth.right}`);
});
