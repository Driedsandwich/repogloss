// 計算済みの色の alpha を読む関数（第23回 RG-23-03）の単体テスト。
//
// content.js は拡張の中でしか動かない（即時関数の中に閉じている）ので、
// **その関数の文字列だけを切り出して**ここで動かす。製品側に検査用の口は足さない。
// 切り出しに失敗したら、それ自体を失敗にする（「測れなかった」を「通った」と同じ顔にしない）。
//
// ⚠️ 以前の判定は `/^rgba\([^)]*,\s*0(\.0+)?\)$/` だけで、Chrome がその形のまま返す
//    `color(srgb 0 0 0 / 0)`・`oklch(… / 0)` などを「透明でない」と読んでいた
//    （実測: 印が 0 画素のまま前方に残った）。
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
  pick('COLOR_FN', /const COLOR_FN = .*;\n/),
  pick('ALPHA_NUM', /const ALPHA_NUM = .*;\n/),
  pick('colorAlpha', /function colorAlpha\(c\) \{[\s\S]*?\n  \}\n/),
  pick('isClearColor', /const isClearColor = .*;\n/),
  pick('isInkColor', /const isInkColor = .*;\n/)
].join('');
// eslint-disable-next-line no-new-func
const { colorAlpha, isClearColor, isInkColor } =
  new Function(body + 'return { colorAlpha, isClearColor, isInkColor };')();

test('従来の書き方（transparent・rgba・rgb）を読む', () => {
  assert.equal(colorAlpha('transparent'), 0);
  assert.equal(colorAlpha('rgba(0, 0, 0, 0)'), 0);
  assert.equal(colorAlpha('rgba(0, 0, 0, 0.0)'), 0);
  assert.equal(colorAlpha('rgba(37, 99, 235, 0.5)'), 0.5);
  assert.equal(colorAlpha('rgb(37, 99, 235)'), 1);
});

test('`/ a` の付く書き方を読む（color・hsl・hwb・lab・lch・oklab・oklch）', () => {
  assert.equal(colorAlpha('color(srgb 0 0 0 / 0)'), 0);
  assert.equal(colorAlpha('color(display-p3 1 0 0 / 0.25)'), 0.25);
  assert.equal(colorAlpha('oklch(0.6 0.15 250 / 0)'), 0);
  assert.equal(colorAlpha('oklab(0.5 0.1 0.1 / 0.3)'), 0.3);
  assert.equal(colorAlpha('lab(50 20 30 / 50%)'), 0.5);
  assert.equal(colorAlpha('lch(50 30 200 / 0)'), 0);
  assert.equal(colorAlpha('hsl(120 50% 50% / 0)'), 0);
  assert.equal(colorAlpha('hwb(0 0% 0% / 0)'), 0);
  // alpha が `none` のときは、描くときに 0 として扱われる
  assert.equal(colorAlpha('rgb(0 0 0 / none)'), 0);
});

test('【対照】alpha を書かない書き方は不透明', () => {
  assert.equal(colorAlpha('color(srgb 1 0 0)'), 1);
  assert.equal(colorAlpha('oklch(0.6 0.15 250)'), 1);
  assert.equal(colorAlpha('lab(50 20 30)'), 1);
});

test('読めない形は null（透明とも不透明とも断定しない）', () => {
  for (const c of ['currentcolor', 'color-mix(in srgb, red, blue)', 'rgb(0 0 0 / calc(0.5))',
                   '', 'url(x)', 'rgba(1, 2)', null, undefined]) {
    assert.equal(colorAlpha(c), null, JSON.stringify(c));
  }
});

test('印の実測では、読めない形を「塗れている」と断定しない', () => {
  // 確実に透明か（文字の塗りの判定で使う。読めない形は従来どおり「透明でない」側）
  assert.equal(isClearColor('color(srgb 0 0 0 / 0)'), true);
  assert.equal(isClearColor('currentcolor'), false);
  // 確実に塗るか（印の実測で使う。読めない形は不合格の側）
  assert.equal(isInkColor('color(srgb 0 0 0 / 0)'), false);
  assert.equal(isInkColor('rgb(37, 99, 235)'), true);
  assert.equal(isInkColor('currentcolor'), false);
  assert.equal(isInkColor('rgb(0 0 0 / calc(0.5))'), false);
});
