// 用語の判定の自動テスト。依存は無く、`node --test tests/` だけで動く。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createMatcher, norm } = require('../src/matcher.js');
const DICT = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'locales', 'dict.json'), 'utf8'));
const m = createMatcher(DICT);

// text の中で最初に見つかる辞書キーを返す（isGlossed を渡さない素の判定）
const firstKey = text => {
  const hits = m.findHits(text);
  return hits.length ? hits[0].key : null;
};
const keysOf = text => m.findHits(text).map(h => h.key);

test('辞書のキーは、それ自身の文字列に対して必ず当たる', () => {
  const missed = m.keys.filter(k => firstKey(k) !== k);
  assert.deepEqual(missed, [], `自己一致しないキー: ${missed.join(', ')}`);
});

test('辞書のキーは正規化済み（小文字・前後空白なし・空白の重なりなし）', () => {
  const bad = m.keys.filter(k => k !== norm(k));
  assert.deepEqual(bad, []);
});

test('大文字・小文字と、連続する空白を吸収する', () => {
  assert.equal(firstKey('Pull Request'), 'pull request');
  assert.equal(firstKey('PULL REQUEST'), 'pull request');
  assert.equal(firstKey('pull   request'), 'pull request');
  assert.equal(firstKey('pull\nrequest'), 'pull request');
});

test('複数形は同じ概念として扱う', () => {
  assert.equal(firstKey('repositories'), 'repository');   // y -> ies
  assert.equal(firstKey('branches'), 'branch');           // -es
  assert.equal(firstKey('commits'), 'commit');            // -s
  assert.equal(firstKey('Pull requests'), 'pull request');
});

test('長いキーが短いキーに食われない', () => {
  assert.equal(firstKey('draft pull request'), 'draft pull request');
  assert.equal(firstKey('force push'), 'force push');
  assert.equal(firstKey('squash merge'), 'squash merge');
  assert.equal(firstKey('workflow run'), 'workflow run');
  assert.equal(firstKey('draft release'), 'draft release');
  assert.equal(firstKey('request changes'), 'request changes');
});

test('短いキー単体は、これまでどおり短いキーとして当たる', () => {
  assert.equal(firstKey('pull'), 'pull');
  assert.equal(firstKey('push'), 'push');
  assert.equal(firstKey('merge'), 'merge');
  assert.equal(firstKey('workflow'), 'workflow');
});

test('同じテキストの中の複数の語に、すべて印が付く', () => {
  const keys = keysOf('Open a pull request from your branch and wait for review.');
  assert.deepEqual(keys, ['pull request', 'branch', 'review']);
});

test('同じ語がテキスト内で繰り返されても1回だけ', () => {
  const keys = keysOf('A branch is a branch. Another branch.');
  assert.deepEqual(keys, ['branch']);
});

test('単数形と複数形が混ざっても、同じ概念なら1回だけ', () => {
  const keys = keysOf('This repository links to other repositories.');
  assert.deepEqual(keys, ['repository']);
});

test('既に説明済みのキーは isGlossed で飛ばせる', () => {
  const done = new Set(['branch']);
  const keys = m.findHits('branch and merge', k => done.has(k)).map(h => h.key);
    assert.deepEqual(keys, ['merge']);
});

test('明示的な複数形キーは、単数形キーと食い合わない', () => {
  // fork/forks・release/releases・star/stars は別々のキーとして辞書にある
  for (const [singular, plural] of [['fork', 'forks'], ['release', 'releases'], ['star', 'stars']]) {
    assert.equal(firstKey(singular), singular, `${singular} が ${singular} に当たらない`);
    assert.equal(firstKey(plural), plural, `${plural} が ${plural} に当たらない`);
  }
});

test('一致位置は昇順で、元テキストの該当箇所を正しく指す', () => {
  const text = 'First commit, then push.';
  const hits = m.findHits(text);
  for (let i = 1; i < hits.length; i++) assert.ok(hits[i].index > hits[i - 1].index);
  for (const h of hits) assert.equal(text.slice(h.index, h.end), h.match);
});

test('単語の一部には当たらない', () => {
  assert.equal(firstKey('pushover'), null);
  assert.equal(firstKey('rebranch'), null);
  assert.equal(firstKey('gitlab'), null);
});

test('辞書に無いテキストでは足切り判定が false になる', () => {
  assert.equal(m.test('Hello world'), false);
  assert.equal(m.test('open a pull request'), true);
});

test('findHits を続けて呼んでも結果が変わらない（正規表現の状態が残らない）', () => {
  const text = 'branch and merge';
  assert.deepEqual(keysOf(text), keysOf(text));
});

test('説明文は空でなく、キー自身をそのまま返すだけの項目がない', () => {
  for (const k of m.keys) {
    assert.ok(DICT[k].trim().length > 0, `${k} の説明が空`);
    assert.notEqual(DICT[k].trim().toLowerCase(), k);
  }
});

test('綴りの誤った複数形は拾わない', () => {
  // 以前は語末へ一律に (?:e?s)? を足していたため、これらも候補になっていた
  for (const wrong of ['branchs', 'repositorys', 'pushs', 'mergs']) {
    assert.equal(firstKey(wrong), null, `${wrong} を拾っている`);
  }
});

test('正しい複数形は今までどおり当たる', () => {
  const pairs = [['branches', 'branch'], ['repositories', 'repository'], ['commits', 'commit'],
                 ['pull requests', 'pull request'], ['force pushes', 'force push'],
                 ['squash merges', 'squash merge'], ['ssh keys', 'ssh key'],
                 ['workflow runs', 'workflow run'], ['reviews', 'review'], ['tokens', 'token']];
  for (const [plural, key] of pairs) {
    assert.equal(firstKey(plural), key, `${plural} が ${key} にならない`);
  }
});
