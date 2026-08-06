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
  // 受け付ける綴り（surface form）を、綴りの規則から**生成しない**。
  //
  // 以前は全キーへ英語の複数形規則を一律に掛けていた。そのせいで
  // security -> securities（金融商品）、ci -> cis、git -> gits、main -> mains
  // のような、意味の違う普通の英単語まで一致していた（外部監査が実測で指摘）。
  // 普通の文章に出た "securities" へ GitHub Security の説明が付いてしまう。
  //
  // 生成をやめ、実際に必要な形だけをここに書く。判断の基準は2つ。
  //   1. GitHub の画面か Git の文書に、その複数形が実際に出るか
  //   2. 無関係な意味の普通の英単語と衝突しないか
  // 2を満たさないものは、たとえ文法的に正しくても入れない
  // （approves / blames / origins / resets / syncs / watches / pulls / fetches など）。
  //
  // 表示用のキー（辞書の見出し）と、ここで受け付ける綴りは別物として扱う。
  const EXTRA_FORMS = {
    artifact: ['artifacts'],                     // Actions の成果物一覧
    branch: ['branches'],
    clone: ['clones'],                           // Insights > Traffic の「Clones」
    collaborator: ['collaborators'],
    commit: ['commits'],
    conflict: ['conflicts'],
    diff: ['diffs'],
    'draft pull request': ['draft pull requests'],
    'draft release': ['draft releases'],
    'force push': ['force pushes'],
    label: ['labels'],                           // Issues の Labels
    license: ['licenses'],
    merge: ['merges'],
    milestone: ['milestones'],                   // Issues の Milestones
    'pull request': ['pull requests'],           // 画面上でいちばん目立つ複数形
    push: ['pushes'],
    readme: ['readmes'],
    rebase: ['rebases'],
    remote: ['remotes'],                         // git remote -v の説明で複数形になる
    repository: ['repositories'],
    revert: ['reverts'],
    review: ['reviews'],
    'squash merge': ['squash merges'],
    'ssh key': ['ssh keys'],                     // Settings > SSH keys
    token: ['tokens'],
    topic: ['topics'],                           // リポジトリの Topics
    webhook: ['webhooks'],                       // Settings > Webhooks
    wiki: ['wikis'],
    workflow: ['workflows'],
    'workflow run': ['workflow runs']
  };

  // 綴り -> 辞書のキー。辞書のキー自身が最優先で、追加の綴りでは上書きしない
  // （fork と forks のように、単数形と複数形が別々のキーとして辞書にあるため）。
  function buildSurfaceMap(keys) {
    const map = new Map();
    for (const k of keys) map.set(k, k);
    for (const [key, forms] of Object.entries(EXTRA_FORMS)) {
      if (!keys.includes(key)) continue;            // 辞書から消えたキーの取り残し
      for (const f of forms) {
        const n = norm(f);
        if (map.has(n)) continue;                   // キー自身とぶつかるものは足さない
        map.set(n, key);
      }
    }
    return map;
  }

  function buildPattern(surfaces) {
    return [...surfaces]
      .sort((a, b) => b.length - a.length)
      .map(k => esc(k).replace(/ /g, '\\s+'))
      .join('|');
  }

  function createMatcher(dict) {
    const keys = Object.keys(dict);
    if (keys.length === 0) return null;
    const surfaces = buildSurfaceMap(keys);
    const pattern = buildPattern(surfaces.keys());
    // GitHub の画面は "Pull requests" のように複数形で出る語が多いので、
    // 必要な複数形は EXTRA_FORMS に明示して候補へ入れてある。
    const scanRe = new RegExp(`\\b(?:${pattern})\\b`, 'gi');
    const testRe = new RegExp(`\\b(?:${pattern})\\b`, 'i');

    // 一致した綴りから辞書のキーを引く。綴りの推測（語尾の s を落とす等）はしない。
    // 表に無い綴りは、たとえ辞書のキーに似ていても採らない。
    function lookupKey(word) {
      return surfaces.get(norm(word)) || null;
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
      surfaces,        // 綴り -> キー（テストが衝突と網羅を検査する）
      lookupKey,
      findHits,
      // 辞書に当たらないテキストで重い処理へ進まないための足切り。状態を持たない方を使う。
      test(text) { return testRe.test(text); }
    };
  }

  return { esc, norm, buildPattern, buildSurfaceMap, createMatcher, EXTRA_FORMS };
});
