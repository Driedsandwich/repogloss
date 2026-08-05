// RepoGloss – matcher.js
// 「どの語に、どこで印を付けるか」だけを決める部分。DOM を触らないので、
// ブラウザ（content.js）と Node（tests/matcher.test.js）の両方から同じものを呼べる。
// 判定の規則を変えたら、必ず tests/matcher.test.js が落ちる側に置いておく。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RepoGlossMatcher = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const norm = s => s.trim().toLowerCase().replace(/\s+/g, ' ');

  // 長いキーから順に並べる。正規表現の | は左から先に当たるので、
  // 'pull' が 'pull request' より前にあると「Pull requests」に
  // pull（取り込む操作）の説明が付いてしまう。
  // repository -> repositories のように y で終わる語は s を足すだけでは
  // 複数形にならないので、綴りの変わる形も候補に並べておく。
  // 綴りの決まりに沿った複数形だけを作る。以前は語末に (?:e?s)? を足していたが、
  // それだと branchs や repositorys のような誤った綴りまで拾っていた。
  function pluralsOf(key) {
    if (/[^aeiou]y$/.test(key)) return [key, key.slice(0, -1) + 'ies'];  // repository -> repositories
    if (/(s|x|z|ch|sh)$/.test(key)) return [key, key + 'es'];            // branch -> branches
    return [key, key + 's'];                                             // commit -> commits
  }

  function buildPattern(keys) {
    return keys
      .flatMap(pluralsOf)
      .sort((a, b) => b.length - a.length)
      .map(k => esc(k).replace(/ /g, '\\s+'))
      .join('|');
  }

  function createMatcher(dict) {
    const keys = Object.keys(dict);
    if (keys.length === 0) return null;
    const pattern = buildPattern(keys);
    // 複数形は buildPattern が綴りの決まりに沿って作るので、ここでは足さない。
    // GitHub の画面は "Pull requests" のように複数形で出る語が多いので、
    // 複数形そのものを候補に入れておかないと最も目立つタブで当たらない。
    const scanRe = new RegExp(`\\b(?:${pattern})\\b`, 'gi');
    const testRe = new RegExp(`\\b(?:${pattern})\\b`, 'i');

    // 複数形で一致した語は、そのままでは辞書に無い。単数形へ戻して引き直し、
    // 辞書のキーを返す。"Pull requests" と "pull request" は同じキーになる。
    function lookupKey(word) {
      const n = norm(word);
      if (dict[n]) return n;
      if (n.endsWith('ies') && dict[n.slice(0, -3) + 'y']) return n.slice(0, -3) + 'y';  // repositories -> repository
      if (n.endsWith('es') && dict[n.slice(0, -2)]) return n.slice(0, -2);   // branches -> branch
      if (n.endsWith('s') && dict[n.slice(0, -1)]) return n.slice(0, -1);    // commits  -> commit
      return null;
    }

    // text の中の一致を前から順に返す。同じキーは1つ目だけ残す（説明は一度読めば足りる）。
    // isGlossed(key) が true を返したキーは、既にページのどこかで説明済みとみなして飛ばす。
    function findHits(text, isGlossed) {
      const hits = [];
      const seen = new Set();
      scanRe.lastIndex = 0;
      let m;
      while ((m = scanRe.exec(text)) !== null) {
        const key = lookupKey(m[0]);
        if (key && !seen.has(key) && !(isGlossed && isGlossed(key))) {
          seen.add(key);
          hits.push({ index: m.index, end: m.index + m[0].length, key, match: m[0] });
        }
        if (m.index === scanRe.lastIndex) scanRe.lastIndex++;   // 空一致での無限ループ防止
      }
      return hits;
    }

    return {
      keys,
      pattern,
      lookupKey,
      findHits,
      // 辞書に当たらないテキストで重い処理へ進まないための足切り。状態を持たない方を使う。
      test(text) { return testRe.test(text); }
    };
  }

  return { esc, norm, pluralsOf, buildPattern, createMatcher };
});
