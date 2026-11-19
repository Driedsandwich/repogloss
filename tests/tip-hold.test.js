// 説明（吹き出し）を支えている hover とフォーカスの扱い（第25回 RG-25-04）の単体テスト。
//
// content.js は拡張の中でしか動かない（即時関数の中に閉じている）ので、
// **吹き出しの開閉に関わる部分（状態の変数・hideTip・leaveTip・「…HoldsTip」の関数・
// mouseover / mouseout / focusin / focusout の listener）の文字列だけを切り出して**、
// 偽の document と要素の上で動かす。製品側に検査用の口は足さない。
// 吹き出しを作る showTip は DOM を組むので、同じ判定（同じ説明なら出し直さない・
// 違えば hideTip してから出す）だけを持つ代役にする。
// 切り出しに失敗したら、それ自体を失敗にする（「測れなかった」を「通った」と同じ顔にしない）。
//
// ⚠️ 指摘: 印 A にフォーカス・印 B に hover で B の説明を出している間に、フォーカスが A から
//    説明の無い場所へ移ると、B の説明が消えていた（focusout の hideTip と、focusin の
//    `else hideTip()`）。B の説明を支えている hover は残っているので、WCAG 1.4.13 の
//    Persistent に合わない。
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
const fn = name => pick(name, new RegExp(`\\n  function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}\\n`));
const listener = type =>
  pick(`${type} の listener`,
       new RegExp(`document\\.addEventListener\\('${type}', e => \\{[\\s\\S]*?\\n    \\}, true\\);\\n`));

// 吹き出しの状態の変数（`let tip… = …;`）は、あるだけ持ってくる。
const tipVars = [...src.matchAll(/^  let tip\w* = [^\n]*\n/gm)].map(m => m[0]);
if (!tipVars.some(v => /let tip = /.test(v))) throw new Error('content.js から let tip を切り出せない');
// 「説明が支えられているか」を見る関数（名前が `…HoldsTip` のもの）をすべて持ってくる。
const holdFns = [...src.matchAll(/\n  function (\w+HoldsTip)\([^)]*\) \{[\s\S]*?\n  \}\n/g)];
if (!holdFns.some(m => m[1] === 'focusHoldsTip')) {
  throw new Error('content.js から focusHoldsTip を切り出せない（書き方が変わった？）');
}
const body = [
  pick('asElement', /const asElement = .*;\n/),
  ...tipVars,
  pick('TIP_GRACE_MS', /const TIP_GRACE_MS = .*;\n/),
  fn('cancelTipClose'),
  fn('hideTip'),
  pick('requestKey', /const requestKey = .*;\n/),
  pick('inTooltip', /const inTooltip = target => \{[\s\S]*?\n  \};\n/),
  fn('inTipCorridor'),
  ...holdFns.map(m => m[0]),
  fn('leaveTip'),
  pick('escClosedAt', /let escClosedAt = null;\n/),
  listener('mouseover'),
  listener('mouseout'),
  listener('focusin'),
  listener('focusout')
].join('');

let pending = [];
function makeEnv() {
  const env = { windowFocused: true, reqs: new Map() };
  // 偽の要素。位置は四角（x, y から 20px 四方）。
  env.el = (name, x = 1000, y = 1000) => {
    const el = {
      name, nodeType: 1, isConnected: true, dataset: { iiyakuKey: name },
      getBoundingClientRect: () => ({ left: x, top: y, right: x + 20, bottom: y + 20 }),
      contains: o => o === el
    };
    return el;
  };
  env.body = env.el('body');
  env.html = env.el('html');
  const make = new Function('env', 'pending', `
    const Node = { ELEMENT_NODE: 1 };
    const handlers = {};
    const document = {
      activeElement: env.body, body: env.body, documentElement: env.html,
      hasFocus: () => env.windowFocused,
      addEventListener(t, f) { handlers[t] = f; }
    };
    const setTimeout = (f, ms) => { pending.push(f); return pending.length; };
    const clearTimeout = () => {};
    const TIP_ID = 'iiyaku-tip';
    const removeDescribedBy = () => {}, setExpanded = () => {}, removeOwn = () => {};
    const requestFrom = t => env.reqs.get(t) || null;
    ${body}
    // showTip の代役（同じ説明なら出し直さない・違えば hideTip してから出す）
    function showTip(icons, anchor, describe) {
      cancelTipClose();
      if (tip && tipAnchor === anchor && tipIcons.map(i => i.name).join() === icons.map(i => i.name).join()) return;
      hideTip();
      tip = env.el('tip:' + icons.map(i => i.name).join(','), anchor.getBoundingClientRect().left,
                   anchor.getBoundingClientRect().bottom + 6);
      tipAnchor = anchor; tipIcons = icons; tipDescribed = describe || anchor;
    }
    var show = req => req && showTip(req.icons, req.anchor, req.describe);
    return {
      handlers, document, hide: hideTip,
      get tip() { return tip; },
      get shown() { return tip ? tipIcons.map(i => i.name).join(',') : null; },
      set escClosedAt(v) { escClosedAt = v; },
      get escClosedAt() { return escClosedAt; }
    };
  `);
  env.ui = make(env, pending);
  // 単独の印（入口＝印そのもの）
  env.icon = (name, x, y) => {
    const ic = env.el(name, x, y);
    env.reqs.set(ic, { icons: [ic], anchor: ic, describe: ic });
    return ic;
  };
  // フォーカスの移動。focusout（移る前の相手）→ focusin（移った先）の順で、
  // その間 activeElement は body（Chrome の順序）。
  env.moveFocus = (from, to) => {
    env.ui.document.activeElement = env.body;
    if (from) env.ui.handlers.focusout({ target: from, relatedTarget: to || null });
    if (to) {
      env.ui.document.activeElement = to;
      env.ui.handlers.focusin({ target: to, relatedTarget: from || null });
    }
  };
  // 本物のポインタの移動（mouseout → mouseover）。座標は移った先の要素の中。
  env.pointer = null;
  env.movePointer = to => {
    const from = env.pointer;
    const q = to.getBoundingClientRect();
    const ev = (target, relatedTarget) =>
      ({ target, relatedTarget, clientX: q.left + 1, clientY: q.top + 1 });
    if (from) env.ui.handlers.mouseout(ev(from, to));
    env.ui.handlers.mouseover(ev(to, from));
    env.pointer = to;
  };
  return env;
}

// 印 A にフォーカス（A の説明）→ ポインタを印 B へ（B の説明）。
function focusAhoverB() {
  const env = makeEnv();
  const A = env.icon('A', 100, 100), B = env.icon('B', 300, 300);
  env.movePointer(env.el('far-away', 900, 900));
  env.moveFocus(null, A);
  assert.equal(env.ui.shown, 'A');
  env.movePointer(B);
  assert.equal(env.ui.shown, 'B');
  return { env, A, B };
}

test('RG-25-04: フォーカスが A から説明の無い要素へ移っても、hover している B の説明は残る', () => {
  const { env, A } = focusAhoverB();
  env.moveFocus(A, env.el('plain-link', 500, 500));
  assert.equal(env.ui.shown, 'B');
});

test('RG-25-04: フォーカスが A から外れて body に戻っても（文書はフォーカスを保つ）、B の説明は残る', () => {
  const { env, A } = focusAhoverB();
  env.moveFocus(A, null);
  assert.equal(env.ui.shown, 'B');
});

test('RG-25-04: 説明の無い要素どうしでフォーカスが移っても（focusin だけが来る形）、B の説明は残る', () => {
  const env = makeEnv();
  const B = env.icon('B', 300, 300);
  const x = env.el('x', 500, 500), y = env.el('y', 600, 600);
  env.moveFocus(null, x);
  env.movePointer(B);
  env.moveFocus(x, y);
  assert.equal(env.ui.shown, 'B');
});

test('RG-25-04: ポインタを B の吹き出しの上へ移していても、フォーカスの移動で消さない', () => {
  const { env, A } = focusAhoverB();
  env.movePointer(env.ui.tip);
  assert.equal(env.ui.shown, 'B');
  env.moveFocus(A, env.el('plain-link', 500, 500));
  assert.equal(env.ui.shown, 'B');
});

test('RG-25-04: 同じ印 A にフォーカスと hover があるとき、フォーカスだけが去っても A の説明は残る', () => {
  const env = makeEnv();
  const A = env.icon('A', 100, 100);
  env.moveFocus(null, A);
  env.movePointer(A);
  env.moveFocus(A, env.el('plain-link', 500, 500));
  assert.equal(env.ui.shown, 'A');
});

test('【対照】フォーカスだけで出した説明は、フォーカスが説明の無い要素へ移れば閉じる', () => {
  const env = makeEnv();
  const A = env.icon('A', 100, 100);
  env.movePointer(env.el('far-away', 900, 900));
  env.moveFocus(null, A);
  env.moveFocus(A, env.el('plain-link', 500, 500));
  assert.equal(env.ui.shown, null);
});

test('【対照】フォーカスだけで出した説明は、ウィンドウから本当にフォーカスが去れば閉じる', () => {
  const env = makeEnv();
  const A = env.icon('A', 100, 100);
  env.moveFocus(null, A);
  env.windowFocused = false;
  env.moveFocus(A, null);
  assert.equal(env.ui.shown, null);
});

test('【対照】Escape で閉じた後、同じ印へ focusout → focusin が来ても出し直さない（ポインタが印の上でも）', () => {
  const env = makeEnv();
  const A = env.icon('A', 100, 100);
  env.movePointer(A);
  env.moveFocus(null, A);
  assert.equal(env.ui.shown, 'A');
  // keydown の Escape がすること（escClosedAt を覚えて閉じる）
  env.ui.escClosedAt = A;
  env.ui.hide();
  // content.js の注記にある headless Chrome の順序:
  // focusout（relatedTarget = null・hasFocus = false）→ focusin（同じ印）
  env.windowFocused = false;
  env.moveFocus(A, null);
  assert.equal(env.ui.escClosedAt, A, 'ウィンドウの一瞬の blur では忘れない');
  env.windowFocused = true;
  env.moveFocus(null, A);
  assert.equal(env.ui.shown, null);
});

test('【対照】hover で B を出していても、フォーカスが別の印 C へ移れば C の説明を出す', () => {
  const { env, A } = focusAhoverB();
  const C = env.icon('C', 700, 100);
  env.moveFocus(A, C);
  assert.equal(env.ui.shown, 'C');
});

test('【対照】ポインタが B から遠くへ去れば、B の説明はその場で閉じる', () => {
  const { env } = focusAhoverB();
  env.movePointer(env.el('far-away', 900, 900));
  assert.equal(env.ui.shown, null);
});

test('【対照】hover の記録が残って、フォーカスで出した別の説明を引き留めない', () => {
  const { env, A } = focusAhoverB();
  const C = env.icon('C', 700, 100);
  env.moveFocus(A, C);                      // ポインタは B の上のまま、C の説明に替わる
  assert.equal(env.ui.shown, 'C');
  env.moveFocus(C, env.el('plain-link', 500, 500));
  assert.equal(env.ui.shown, null);
});
