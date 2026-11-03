// clip-path の形の署名（shapeKey）の単体テスト（第25回 RG-25-03）。
//
// shapeKey は「引き取った語を入れ直すか」（rejectSig）の比べる材料の1つ。
// 以前は計算後の `clip-path` の文字列（と傾き）だけで作っていたため、
// **百分率の基準になる枠の寸法だけが変わっても同じキー**になり、入れ直さなかった
// （例: `inset(0 round 50%)` で切り抜いた箱の幅が後から変わると、印が戻らないまま残る）。
//
// content.js は拡張の中でしか動かない（即時関数の中に閉じている）ので、
// **その関数の文字列だけを切り出して**ここで動かす。製品側に検査用の口は足さない。
// 切り出しに失敗したら、それ自体を失敗にする（「測れなかった」を「通った」と同じ顔にしない）。
// 形そのものを解く関数（shapeBoundsRect / shapeHitTest）はキーの作り方に関わらないので、
// ここでは置き換える（キーだけを見る）。
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
  pick('CLIP_POSITIONS', /const CLIP_POSITIONS = .*\n/),
  pick('intersectRect', /function intersectRect\(a, b\) \{[\s\S]*?\n  \}\n/),
  pick('px', /const px = .*;\n/),
  pick('isIdentity', /const isIdentity = .*;\n/),
  pick('GEOMETRY_BOX', /const GEOMETRY_BOX = .*;\n/),
  pick('splitGeometryBox', /function splitGeometryBox\(v\) \{[\s\S]*?\n  \}\n/),
  pick('localToViewport', /function localToViewport\(L, bw, bh, border\) \{[\s\S]*?\n  \}\n/),
  pick('refBoxLocal', /function refBoxLocal\(cs, bw, bh, box\) \{[\s\S]*?\n  \}\n/),
  pick('refBoxRect', /function refBoxRect\(cs, border, transformed, box\) \{[\s\S]*?\n  \}\n/),
  pick('ownClips', /function ownClips\(el, cs, L, flat\) \{[\s\S]*?\n  \}\n/),
  'const shapeBoundsRect = () => null;\n',
  "const shapeHitTest = () => 'rect';\n"
].join('');
// eslint-disable-next-line no-new-func
const { ownClips } = new Function(body + 'return { ownClips };')();

const IDENTITY = { a: 1, b: 0, c: 0, d: 1 };
const ROT = { a: Math.cos(0.3), b: Math.sin(0.3), c: -Math.sin(0.3), d: Math.cos(0.3) };

// 計算後のスタイルの写し（ownClips が読む項目だけ）
function style(over = {}) {
  return Object.assign({
    display: 'block', position: 'static', clip: 'auto',
    overflowX: 'visible', overflowY: 'visible', overflowClipMargin: '0px',
    scrollSnapType: 'none', writingMode: 'horizontal-tb',
    clipPath: 'inset(0px round 50%)',
    borderLeftWidth: '0px', borderRightWidth: '0px', borderTopWidth: '0px', borderBottomWidth: '0px',
    paddingLeft: '0px', paddingRight: '0px', paddingTop: '0px', paddingBottom: '0px',
    marginLeft: '0px', marginRight: '0px', marginTop: '0px', marginBottom: '0px'
  }, over);
}
// 要素の写し（border box の位置と寸法）
function elem(left, top, w, h) {
  return {
    offsetWidth: w, offsetHeight: h,
    getBoundingClientRect: () => ({ left, top, right: left + w, bottom: top + h, width: w, height: h })
  };
}
const key = (el, cs, L = IDENTITY, flat = true) => ownClips(el, cs, L, flat).shapeKey;

test('百分率の角丸で切り抜いた箱の幅だけが変わると、キーが変わる', () => {
  const cs = style();
  assert.notEqual(key(elem(10, 10, 200, 40), cs), key(elem(10, 10, 120, 40), cs));
  // 高さだけの変化も同じ
  assert.notEqual(key(elem(10, 10, 200, 40), cs), key(elem(10, 10, 200, 80), cs));
});

test('参照ボックスが content-box のとき、padding だけが変わってもキーが変わる', () => {
  const el = elem(0, 0, 200, 100);
  const a = style({ clipPath: 'circle(50%) content-box', paddingLeft: '0px' });
  const b = style({ clipPath: 'circle(50%) content-box', paddingLeft: '40px' });
  assert.notEqual(key(el, a), key(el, b));
});

test('回した箱（変形前の寸法で解く側）でも、幅だけが変わるとキーが変わる', () => {
  const cs = style({ clipPath: 'ellipse(50% 50%)' });
  assert.notEqual(key(elem(0, 0, 200, 40), cs, ROT), key(elem(0, 0, 120, 40), cs, ROT));
});

test('【対照】寸法が変わらなければキーは同じ（入れ直しを増やさない）', () => {
  const cs = style();
  // 同じ箱をもう一度
  assert.equal(key(elem(10, 10, 200, 40), cs), key(elem(10, 10, 200, 40), cs));
  // 位置だけが変わる（スクロールなど）。寸法は同じ
  assert.equal(key(elem(10, 10, 200, 40), cs), key(elem(10, 310, 200, 40), cs));
  // 1px 未満の揺れ（小数の配置）では変わらない
  assert.equal(key(elem(10, 10, 200, 40), cs), key(elem(10.3, 10, 200.2, 40.1), cs));
  // 回した箱でも同じ
  const e = style({ clipPath: 'ellipse(50% 50%)' });
  assert.equal(key(elem(0, 0, 200, 40), e, ROT), key(elem(0, 50, 200, 40), e, ROT));
});

test('【対照】clip-path が無ければキーは空', () => {
  assert.equal(key(elem(0, 0, 200, 40), style({ clipPath: 'none' })), '');
});
