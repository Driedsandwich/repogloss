// gradient の色の止まりを読む判定（第25回 RG-25-02）の単体テスト。
//
// content.js は拡張の中でしか動かない（即時関数の中に閉じている）ので、
// color-alpha.test.js と同じく**その関数の文字列だけを切り出して**ここで動かす。
// 製品側に検査用の口は足さない。切り出しに失敗したら、それ自体を失敗にする。
//
// ⚠️ 以前の `isFullyTransparentGradient` は色を `rgba?()` だけから取り出していた。
//    そのため `color()`／`oklch()` の透明な gradient を「透明でない」と読み
//    （`background-clip: text` で抜いた透明な文字を可視と判定）、透明な rgba と
//    不透明な `color()` が混ざると「透明」と読んでいた。
//    mask 側（maskLayerState）も同じ関数を最初に呼ぶので、その判定もここで確かめる。
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
// 直しで足した部品（GRADIENT_COLOR・GRADIENT_WORD・gradientColors）は、直す前の
// content.js には無い。直す前にも同じファイルで「どの試験が落ちるか」を数えられるよう、
// これらだけは無くても切り出しを止めない（無ければ、使う側が ReferenceError で落ちる）。
const pickOpt = re => (re.exec(src) || [''])[0];
const body = [
  pick('COLOR_FN', /const COLOR_FN = .*;\n/),
  pick('ALPHA_NUM', /const ALPHA_NUM = .*;\n/),
  pick('colorAlpha', /function colorAlpha\(c\) \{[\s\S]*?\n  \}\n/),
  pickOpt(/const GRADIENT_COLOR = .*;\n/),
  pickOpt(/const GRADIENT_WORD = .*;\n/),
  pickOpt(/function gradientColors\(v\) \{[\s\S]*?\n  \}\n/),
  pick('isFullyTransparentGradient', /function isFullyTransparentGradient\(v\) \{[\s\S]*?\n  \}\n/),
  pick('GRADIENT', /const GRADIENT = .*;\n/),
  pick('isGradientLayer', /const isGradientLayer = .*;\n/),
  pick('luminanceOf', /function luminanceOf\(c\) \{[\s\S]*?\n  \}\n/),
  pick('maskLayerState', /function maskLayerState\(layer, mode\) \{[\s\S]*?\n  \}\n/)
].join('');
// eslint-disable-next-line no-new-func
const { isFullyTransparentGradient, maskLayerState } =
  new Function(body + 'return { isFullyTransparentGradient, maskLayerState };')();

const CLEAR_COLOR = 'linear-gradient(color(srgb 0 0 0 / 0), color(srgb 0 0 0 / 0))';
const CLEAR_OKLCH = 'linear-gradient(90deg, oklch(0 0 0 / 0) 0%, oklch(0.6 0.15 250 / 0) 100%)';
const MIXED = 'linear-gradient(to right, rgba(0, 0, 0, 0) 0%, color(srgb 1 1 1) 100%)';
const MIXED_OKLCH = 'radial-gradient(circle at center, rgba(0, 0, 0, 0), oklch(0.6 0.15 250))';

test('【RG-25-02】color()／oklch() の透明な gradient は透明', () => {
  assert.equal(isFullyTransparentGradient(CLEAR_COLOR), true);
  assert.equal(isFullyTransparentGradient(CLEAR_OKLCH), true);
});

test('【RG-25-02】透明な rgba と不透明な color()／oklch() が混ざれば透明ではない', () => {
  assert.equal(isFullyTransparentGradient(MIXED), false);
  assert.equal(isFullyTransparentGradient(MIXED_OKLCH), false);
});

test('【RG-25-02】読めない色の止まりが1つでもあれば、透明と断定しない', () => {
  for (const v of ['linear-gradient(rgba(0, 0, 0, 0), color-mix(in srgb, red, blue))',
                   'linear-gradient(rgba(0, 0, 0, 0), rgb(calc(255) 0 0))',
                   'linear-gradient(rgba(0, 0, 0, 0), currentcolor)',
                   'linear-gradient(rgba(0, 0, 0, 0), red)']) {
    assert.equal(isFullyTransparentGradient(v), false, v);
  }
});

test('色空間の指定（`in display-p3` など）や位置・角度は、読めない止まりと数えない', () => {
  for (const v of ['linear-gradient(in display-p3, rgba(0, 0, 0, 0), rgba(0, 0, 0, 0))',
                   'linear-gradient(in xyz-d50 to left, rgba(0, 0, 0, 0), rgba(0, 0, 0, 0))',
                   'linear-gradient(in oklch longer hue, oklch(0 0 0 / 0), oklch(1 0 0 / 0))',
                   'conic-gradient(from 1.5e1deg at 10px 20%, transparent, rgba(0, 0, 0, 0) 50%)',
                   'radial-gradient(farthest-corner at -5px .5em, color(display-p3 0 0 0 / 0), rgba(0, 0, 0, 0))']) {
    assert.equal(isFullyTransparentGradient(v), true, v);
  }
});

test('【対照】rgb/rgba だけの gradient は従来どおり', () => {
  assert.equal(isFullyTransparentGradient('linear-gradient(rgba(0, 0, 0, 0), rgba(255, 0, 0, 0))'), true);
  assert.equal(isFullyTransparentGradient('linear-gradient(rgba(0, 0, 0, 0) 0%, rgba(0, 0, 0, 0) 100%)'), true);
  assert.equal(isFullyTransparentGradient('linear-gradient(rgba(0, 0, 0, 0), rgb(255, 0, 0))'), false);
  assert.equal(isFullyTransparentGradient('linear-gradient(rgba(0, 0, 0, 0), rgba(0, 0, 0, 0.5))'), false);
  assert.equal(isFullyTransparentGradient('url("x.png")'), false);
  assert.equal(isFullyTransparentGradient('none'), false);
});

test('【mask・RG-25-02】透明な color() の gradient の覆いは、その場所を消す', () => {
  assert.equal(maskLayerState(CLEAR_COLOR, 'alpha'), 'hidden');
  assert.equal(maskLayerState(CLEAR_OKLCH, 'luminance'), 'hidden');
});

test('【mask・RG-25-02】透明な rgba と不透明な color() が混ざる覆いは断定しない', () => {
  // 直す前は「全部透明」と読んで 'hidden'。rgba だけを見る一様判定へ落とすと
  // 'shown' になってしまう（場所で値が変わる覆いを「残る」と言う＝第20回 RG-20-04 の型）。
  for (const mode of ['alpha', 'match-source', 'luminance']) {
    assert.equal(maskLayerState(MIXED, mode), 'unknown', mode);
    assert.equal(maskLayerState(MIXED_OKLCH, mode), 'unknown', mode);
  }
});

test('【mask】一様な不透明の color()／oklch() は、alpha では残り、luminance では断定しない', () => {
  const u = 'linear-gradient(oklch(0.6 0.15 250), oklch(0.6 0.15 250))';
  assert.equal(maskLayerState(u, 'alpha'), 'shown');
  // 明るさを読む関数（luminanceOf）は rgb/rgba の数字しか正しく読めない
  assert.equal(maskLayerState(u, 'luminance'), 'unknown');
});

test('【mask・対照】rgb/rgba だけの覆いは従来どおり', () => {
  assert.equal(maskLayerState('linear-gradient(rgba(0, 0, 0, 0), rgba(0, 0, 0, 0))', 'alpha'), 'hidden');
  assert.equal(maskLayerState('linear-gradient(rgb(255, 255, 255), rgb(255, 255, 255))', 'luminance'), 'shown');
  assert.equal(maskLayerState('linear-gradient(rgb(0, 0, 0), rgb(0, 0, 0))', 'luminance'), 'hidden');
  assert.equal(maskLayerState('linear-gradient(rgb(0, 0, 0), rgb(0, 0, 0))', 'alpha'), 'shown');
  assert.equal(maskLayerState('linear-gradient(rgba(0, 0, 0, 0), rgb(0, 0, 0))', 'alpha'), 'unknown');
  assert.equal(maskLayerState('url("m.png")', 'alpha'), 'unknown');
});
