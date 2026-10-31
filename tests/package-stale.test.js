// 梱包の入口が、正本（locales/dict.json・styles.css）と写し（src/dict.js・src/styles.js）の
// 食い違いを止めるかを確かめる（2026-10-30 の点検 F03）。
//
// npm test は verify.mjs で同じ突き合わせをするが、梱包の台本だけを直に実行すると
// それを通らない。正本だけを直して写しを作り直し忘れると、古い辞書や見た目が
// ZIP に入っていた。ここでは本物の台本を一時フォルダへ写し、正本を1文字だけ
// 変えてから実行して、必ず落ちることを見る。対照として、変えなければその理由では
// 落ちないことも見る（何も見ていない検査でも「落ちる」側は通ってしまうため）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, cpSync, readFileSync, writeFileSync, rmSync, readdirSync } = require('node:fs');
const { join, dirname } = require('node:path');
const { tmpdir } = require('node:os');

const ROOT = join(__dirname, '..');
const STALE_MESSAGE = '写しが正本と一致しない';

let files;
test.before(async () => {
  files = (await import('../scripts/package-files.mjs')).PACKAGE_FILES;
});

// 台本・正本・配布一覧のファイルを、git の外の一時フォルダへ写す
function makeTree(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rg-stale-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const rels = [
    ...readdirSync(join(ROOT, 'scripts')).filter(n => n.endsWith('.mjs')).map(n => `scripts/${n}`),
    'locales/dict.json', 'styles.css', ...files
  ];
  for (const rel of new Set(rels)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    cpSync(join(ROOT, rel), join(dir, rel));
  }
  return dir;
}

const run = (dir, script, ...args) =>
  spawnSync(process.execPath, [join(dir, 'scripts', script), ...args], { encoding: 'utf8' });

// 正本だけを1文字変える（写しは作り直さない）
function touchSource(dir, rel) {
  const p = join(dir, rel);
  const s = readFileSync(p, 'utf8');
  writeFileSync(p, rel.endsWith('.json')
    ? JSON.stringify({ ...JSON.parse(s), 'stale-probe': 'x' }, null, 2) + '\n'
    : s + '\n/* stale-probe */\n');
}

test('写しが正本と合っていれば、並べる台本はその理由で止まらない（対照）', t => {
  const dir = makeTree(t);
  const r = run(dir, 'package-stage.mjs');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stderr.includes(STALE_MESSAGE), r.stderr);
});

for (const [source, copy] of [['styles.css', 'src/styles.js'], ['locales/dict.json', 'src/dict.js']]) {
  test(`${source} だけを直して写しを作り直さないと、並べる台本が止まる`, t => {
    const dir = makeTree(t);
    touchSource(dir, source);
    const r = run(dir, 'package-stage.mjs');
    assert.notEqual(r.status, 0, '古い写しのまま並べた');
    assert.ok(r.stderr.includes(STALE_MESSAGE) && r.stderr.includes(copy), r.stderr);
  });
}

test('正本だけを直したままだと、並べたものの検査（--verify）も止まる', t => {
  const dir = makeTree(t);
  assert.equal(run(dir, 'package-stage.mjs').status, 0);
  touchSource(dir, 'styles.css');
  const r = run(dir, 'package-stage.mjs', '--verify');
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes(STALE_MESSAGE), r.stderr);
});

// ZIP の台本は git の状態も見る。一時フォルダは git の外なので、対照では
// 「git で確かめられない」で落ちる。見るのは、写しの理由で落ちるかどうかだけ。
test('写しが合っていれば、ZIP の台本は写しの理由では止まらない（対照）', t => {
  const dir = makeTree(t);
  for (const args of [[], ['--verify']]) {
    const r = run(dir, 'package-zip.mjs', ...args);
    assert.ok(!r.stderr.includes(STALE_MESSAGE), `${args.join(' ')}: ${r.stderr}`);
  }
});

test('正本だけを直したままだと、ZIP の台本は作るときも検査するときも止まる', t => {
  const dir = makeTree(t);
  touchSource(dir, 'styles.css');
  for (const args of [[], ['--allow-uncommitted'], ['--verify'], ['--verify', '--release']]) {
    const r = run(dir, 'package-zip.mjs', ...args);
    assert.notEqual(r.status, 0, `${args.join(' ')}: 古い写しのまま通った`);
    assert.ok(r.stderr.includes(STALE_MESSAGE), `${args.join(' ')}: ${r.stderr}`);
  }
});

test('写しが無いときも止まる', t => {
  const dir = makeTree(t);
  rmSync(join(dir, 'src/dict.js'));
  const r = run(dir, 'package-stage.mjs');
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes(STALE_MESSAGE) && r.stderr.includes('src/dict.js'), r.stderr);
});
