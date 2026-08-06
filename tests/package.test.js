// 提出用 ZIP の検査が、実際に「壊れているもの」を落とせるかを確かめる。
//
// 正しい ZIP が通ることだけを見ても、検査が働いている証明にはならない
// （何も見ていない検査も同じように通る）。ここでは 1件ずつ壊してぶつけ、
// 必ず落ちることを確かめる。壊し方は、検査が並べている一覧の外からも入れる。
const test = require('node:test');
const assert = require('node:assert/strict');

let zipMod, verifyMod, files;
test.before(async () => {
  zipMod = await import('../scripts/zip.mjs');
  verifyMod = await import('../scripts/verify-zip.mjs');
  files = (await import('../scripts/package-files.mjs')).PACKAGE_FILES;
});

const buf = s => Buffer.from(s, 'utf8');

// 実物を読まずに、配布一覧と同じ形の最小の中身を組み立てる。
// 検査の対象は「並び・名前・version・余分なもの」なので、これで足りる。
function goodEntries(version = '9.9.9') {
  return files.map(name => ({
    name,
    data: name === 'manifest.json' ? buf(JSON.stringify({ version })) : buf('中身 ' + name)
  }));
}

const check = (entries, opts = {}) =>
  verifyMod.verifyZipBuffer(zipMod.writeZip(entries), { version: '9.9.9', ...opts });

test('正しく作った ZIP は通る（対照）', () => {
  const r = check(goodEntries());
  assert.deepEqual(r.problems, [], `正しいはずのものが落ちている: ${r.problems.join(' / ')}`);
  assert.equal(r.names.length, files.length);
});

test('読み書きした中身が1バイトも変わらない', () => {
  const entries = goodEntries();
  const back = zipMod.readZip(zipMod.writeZip(entries));
  assert.deepEqual(back.map(e => e.name), entries.map(e => e.name));
  for (let i = 0; i < entries.length; i++) {
    assert.ok(back[i].data.equals(entries[i].data), `${entries[i].name} の中身が変わった`);
  }
});

test('同じ中身なら、何度作っても同じバイト列になる', () => {
  // 作った時刻などが混ざると、OS や実行のたびにハッシュが変わってしまう
  const a = zipMod.writeZip(goodEntries());
  const b = zipMod.writeZip(goodEntries());
  assert.ok(a.equals(b), '同じ中身から違う ZIP ができている');
});

test('余分なファイルが入っていたら落ちる', () => {
  const entries = goodEntries();
  entries.push({ name: 'icons/メモ.txt', data: buf('作業用のメモ') });
  const r = check(entries);
  assert.ok(r.problems.some(p => p.includes('配布一覧に無いもの')), r.problems.join(' / '));
});

test('開発用のファイルが入っていたら落ちる', () => {
  const entries = goodEntries();
  entries.push({ name: 'scripts/verify.mjs', data: buf('x') });
  const r = check(entries);
  assert.ok(r.problems.some(p => p.includes('開発用')), r.problems.join(' / '));
});

test('鍵らしきファイルが入っていたら落ちる', () => {
  const entries = goodEntries();
  entries.push({ name: 'key.pem', data: buf('x') });
  const r = check(entries);
  assert.ok(r.problems.length > 0, '鍵らしきファイルを素通りさせている');
});

test('ファイルが足りなければ落ちる', () => {
  const r = check(goodEntries().slice(0, -1));
  assert.ok(r.problems.some(p => p.includes('入っていないもの')), r.problems.join(' / '));
});

test('version が食い違っていたら落ちる', () => {
  const r = check(goodEntries('1.2.3'));
  assert.ok(r.problems.some(p => p.includes('version')), r.problems.join(' / '));
});

test('親フォルダで包まれていたら落ちる', () => {
  const entries = goodEntries().map(e => ({ ...e, name: 'repogloss/' + e.name }));
  const r = check(entries);
  assert.ok(r.problems.some(p => p.includes('最上位')), r.problems.join(' / '));
});

test('中身を1バイト書き換えたら落ちる（CRC で気づく）', () => {
  const raw = zipMod.writeZip(goodEntries());
  // 圧縮された本体のどこかを1バイト変える。名前も一覧も変えないので、
  // 名前の突き合わせだけしている検査では気づけない。
  const broken = Buffer.from(raw);
  broken[40] = broken[40] ^ 0xff;
  const r = verifyMod.verifyZipBuffer(broken, { version: '9.9.9' });
  assert.ok(r.problems.length > 0, '中身の書き換えを素通りさせている');
});

test('末尾にごみを足したら落ちる', () => {
  // unzip -t はこれを素通りさせる。終端record が末尾にあることまで見る。
  const raw = zipMod.writeZip(goodEntries());
  const r = verifyMod.verifyZipBuffer(Buffer.concat([raw, buf('あとから足した文字列')]),
    { version: '9.9.9' });
  assert.ok(r.problems.some(p => p.includes('後ろに何か足されている')), r.problems.join(' / '));
});

test('先頭を削ったら落ちる', () => {
  const raw = zipMod.writeZip(goodEntries());
  const r = verifyMod.verifyZipBuffer(raw.subarray(10), { version: '9.9.9' });
  assert.ok(r.problems.length > 0, '切り詰めを素通りさせている');
});

test('配布一覧そのものに、配布してはいけないものが載っていないか', () => {
  // 一覧との突き合わせは、一覧が正しいことを前提にしている。
  // その前提を、一覧の外側の規則で確かめる。
  const bad = files.filter(n => /(^|\/)(\.git|node_modules|tests?|scripts|\.github)\//i.test(n)
    || /(^|\/)(\.env|.*\.pem|.*\.key|package(-lock)?\.json)$/i.test(n));
  assert.deepEqual(bad, [], `配布一覧に載せてはいけないもの: ${bad.join(', ')}`);
});
