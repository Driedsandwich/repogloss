// 提出候補の「身元」の検査が、実際に壊れているものを落とせるかを確かめる。
//
// 正しい記録が通ることだけを見ても、検査が働いている証明にはならない
// （何も見ていない検査も同じように通る）。1件ずつ壊してぶつけ、必ず落ちること、
// そして**壊していないものは通ること**の両方を見る。
const test = require('node:test');
const assert = require('node:assert/strict');

let validateProvenance;
test.before(async () => {
  ({ validateProvenance } = await import('../scripts/provenance.mjs'));
});

const SHA = 'a'.repeat(64);
const CONTENT = 'b'.repeat(64);
const COMMIT = 'c'.repeat(40);
const FILES = ['manifest.json', 'src/content.js'];

/* CI が作った提出候補の、正しい記録 */
function good() {
  return {
    name: 'repogloss-9.9.9.zip', version: '9.9.9', bytes: 1234,
    fileCount: FILES.length, sha256: SHA, contentSha256: CONTENT, files: [...FILES],
    source: {
      repository: 'Driedsandwich/repogloss', commit: COMMIT,
      ref: 'refs/heads/main', workflowRunId: '123456', workflowRunAttempt: '1', builtInCI: true
    },
    environment: { node: '22.23.1', zlib: '1.3.1', platform: 'linux' }
  };
}

const actual = () => ({
  name: 'repogloss-9.9.9.zip', version: '9.9.9', bytes: 1234,
  fileCount: FILES.length, sha256: SHA, contentSha256: CONTENT, files: [...FILES],
  headCommit: COMMIT
});

const run = (mutate, opts = { release: true }) => {
  const rec = good();
  if (mutate) mutate(rec);
  return validateProvenance(rec, actual(), opts);
};

test('正しい記録は通る（対照）', () => {
  assert.deepEqual(run(null), [], '正しいはずのものが落ちている');
});

test('手元で作ったものは、提出候補としては通さないが、記録としては通る', () => {
  const local = r => {
    r.name = 'repogloss-9.9.9-UNCOMMITTED.zip';
    r.source = { repository: null, commit: COMMIT, ref: null,
                 workflowRunId: null, workflowRunAttempt: null, builtInCI: false };
    r.environment.platform = 'darwin';
  };
  const asLocal = run(local, { release: false });
  const asRelease = run(r => { local(r); }, { release: true });
  // 名前が実物と違うので、そこは落ちる。出どころの厳しい検査には掛からない
  assert.ok(!asLocal.some(p => p.includes('builtInCI')), `手元の記録が出どころで落ちた: ${asLocal.join(' / ')}`);
  assert.ok(asRelease.some(p => p.includes('CI で作ったものに限る')),
    `提出候補として通してしまう: ${asRelease.join(' / ')}`);
});

/* ---- 1件ずつ壊す。すべて落ちること ---- */
const cases = [
  ['source を丸ごと消す',        r => { delete r.source; },                       'source が無い'],
  ['source.commit を消す',       r => { delete r.source.commit; },                'source.commit'],
  ['source.commit を短くする',   r => { r.source.commit = 'abc'; },               'source.commit'],
  ['repository を書き換える',    r => { r.source.repository = 'evil/repo'; },     'source.repository'],
  ['ref を書き換える',           r => { r.source.ref = 'refs/heads/attack'; },    'source.ref'],
  ['run ID を数字でなくする',    r => { r.source.workflowRunId = 'なりすまし'; }, 'workflowRunId'],
  ['run ID の項目を消す',        r => { delete r.source.workflowRunId; },         'workflowRunId'],
  ['run attempt を消す',         r => { delete r.source.workflowRunAttempt; },    'workflowRunAttempt'],
  ['builtInCI を false にする',  r => { r.source.builtInCI = false; },            'CI で作ったものに限る'],
  ['builtInCI を消す',           r => { delete r.source.builtInCI; },             'builtInCI'],
  ['name を書き換える',          r => { r.name = 'repogloss-9.9.9-x.zip'; },      'name'],
  ['name と version をずらす',   r => { r.name = 'repogloss-1.0.0.zip'; },        'name'],
  ['environment を消す',         r => { delete r.environment; },                  'environment が無い'],
  ['environment.node を消す',    r => { delete r.environment.node; },             'environment.node'],
  ['environment.zlib を消す',    r => { delete r.environment.zlib; },             'environment.zlib'],
  ['platform を書き換える',      r => { r.environment.platform = 'win32'; },      'platform'],
  ['ZIP の SHA を書き換える',    r => { r.sha256 = 'd'.repeat(64); },             'SHA-256'],
  ['中身の SHA を書き換える',    r => { r.contentSha256 = 'e'.repeat(64); },      '合算ハッシュ'],
  ['SHA を 16進でなくする',      r => { r.sha256 = 'ここにハッシュ'; },           'sha256'],
  ['大きさを書き換える',         r => { r.bytes = 1; },                           '大きさ'],
  ['ファイル数を書き換える',     r => { r.fileCount = 99; },                      'ファイル数'],
  ['ファイル一覧を書き換える',   r => { r.files = ['manifest.json']; },           'ファイルの一覧'],
  ['version を書き換える',       r => { r.version = '1.0.0'; },                   'version'],
  ['記録が object でない',       null,                                            'object でない']
];

for (const [label, mutate, expect] of cases) {
  test(`落ちる: ${label}`, () => {
    const problems = mutate === null
      ? validateProvenance('壊れた文字列', actual(), { release: true })
      : run(mutate);
    assert.ok(problems.length > 0, `${label} を素通りさせている`);
    assert.ok(problems.some(p => p.includes(expect)),
      `落ちた理由が違う（${expect} を含まない）: ${problems.join(' / ')}`);
  });
}

test('いま checkout している内容と出どころが違えば落ちる', () => {
  const problems = validateProvenance(good(), { ...actual(), headCommit: 'f'.repeat(40) },
    { release: true });
  assert.ok(problems.some(p => p.includes('checkout')), problems.join(' / '));
});

test('記録のどの項目を消しても、検査が気づく（総当たり）', () => {
  // 上の一覧は手で書いたものなので、項目が増えたときに書き忘れる。
  // ここは記録そのものから項目を数え、1つずつ消して総当たりする。
  // 新しい項目を足したのに検査していなければ、ここが落ちる。
  const rec0 = good();
  const paths = [...Object.keys(rec0).filter(k => !['source', 'environment'].includes(k)),
                 ...Object.keys(rec0.source).map(k => 'source.' + k),
                 ...Object.keys(rec0.environment).map(k => 'environment.' + k)];
  assert.ok(paths.length >= 15, `項目が少なすぎる＝数え方が壊れている: ${paths.length}`);
  const survived = [];
  for (const p of paths) {
    const rec = good();
    const seg = p.split('.');
    let o = rec;
    for (let i = 0; i < seg.length - 1; i++) o = o[seg[i]];
    delete o[seg[seg.length - 1]];
    if (validateProvenance(rec, actual(), { release: true }).length === 0) survived.push(p);
  }
  assert.deepEqual(survived, [], `消しても気づかない項目: ${survived.join(', ')}`);
});
