// 提出候補の検査（--verify --release）が、GitHub の側の記録で出どころを確かめるかを見る。
//
// 手元のファイル（ZIP・身元の記録・checkout）だけを見る検査は、手元のファイルがそろえば
// 通ってしまう。出どころは GitHub の側（CI の実行の記録と、その実行が持ち出した成果物）と
// 突き合わせて初めて言える。ここでは 2 つの層で確かめる。
//   1. 突き合わせの判定（scripts/release-origin.mjs）を、GitHub の答えの代役でぶつける。
//      1 件ずつ食い違わせて必ず落ちること、食い違わせなければ通ることの両方を見る。
//   2. CLI（scripts/package-zip.mjs --verify --release）を、手元で作った包みにぶつけて
//      終了コードを見る。網がつながらない・gh が無いときも、通らずに落ちること。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

let origin;
test.before(async () => {
  origin = await import('../scripts/release-origin.mjs');
});

/* ---------- 1. 突き合わせの判定 ---------- */

const COMMIT = 'c'.repeat(40);
const ZIP = Buffer.from('提出候補の ZIP の代役');

const rec = () => ({
  name: 'repogloss-9.9.9.zip', version: '9.9.9',
  source: {
    repository: 'Driedsandwich/repogloss', commit: COMMIT, ref: 'refs/heads/main',
    workflowRunId: '123456', workflowRunAttempt: '1', builtInCI: true
  }
});

// GitHub の REST の「ワークフローの実行」の答えのうち、判定に使う項目だけ
const run = () => ({
  id: 123456, run_attempt: 1,
  repository: { full_name: 'Driedsandwich/repogloss' },
  path: '.github/workflows/ci.yml',
  event: 'push', head_branch: 'main', head_sha: COMMIT,
  status: 'completed', conclusion: 'success'
});

function deps({ runMut, artifact = ZIP, runThrows = false, artifactThrows = false } = {}) {
  const calls = { getRun: [], getArtifactZip: [] };
  return {
    calls,
    getRun: async id => {
      calls.getRun.push(id);
      if (runThrows) throw new Error('つながらない');
      const r = run();
      if (runMut) runMut(r);
      return r;
    },
    getArtifactZip: async (id, artifactName, zipName) => {
      calls.getArtifactZip.push([id, artifactName, zipName]);
      if (artifactThrows) throw new Error('取れない');
      return artifact;
    }
  };
}

const check = (d, r = rec(), zip = ZIP) => origin.verifyReleaseOrigin(r, zip, d);

test('GitHub の記録と成果物が合えば通る（対照）', async () => {
  const d = deps();
  const problems = await check(d);
  assert.deepEqual(problems, [], problems.join(' / '));
  // 記録に書かれた実行を聞き、その実行の決まった名前の成果物を取りに行っている
  assert.deepEqual(d.calls.getRun, ['123456']);
  assert.equal(d.calls.getArtifactZip.length, 1);
  assert.equal(d.calls.getArtifactZip[0][1], 'repogloss-store-zip');
  assert.equal(d.calls.getArtifactZip[0][2], 'repogloss-9.9.9.zip');
});

const breaks = [
  ['別の repository の実行', { runMut: r => { r.repository.full_name = 'someone/repogloss'; } }],
  ['別のワークフローの実行', { runMut: r => { r.path = '.github/workflows/other.yml'; } }],
  ['push でない実行', { runMut: r => { r.event = 'pull_request'; } }],
  ['main でない実行', { runMut: r => { r.head_branch = 'feature'; } }],
  ['違う commit の実行', { runMut: r => { r.head_sha = 'd'.repeat(40); } }],
  ['終わっていない実行', { runMut: r => { r.status = 'in_progress'; r.conclusion = null; } }],
  ['失敗した実行', { runMut: r => { r.conclusion = 'failure'; } }],
  ['聞いた番号と違う実行が返る', { runMut: r => { r.id = 999; } }],
  ['成果物が無い（期限切れなど）', { artifact: null }],
  ['成果物の ZIP が 1 バイト違う', { artifact: Buffer.concat([ZIP, Buffer.from('x')]) }],
  ['実行の記録を取れない', { runThrows: true }],
  ['成果物を取れない', { artifactThrows: true }]
];

for (const [label, opts] of breaks) {
  test(`落ちる: ${label}`, async () => {
    let problems;
    try { problems = await check(deps(opts)); }
    catch (e) { problems = ['例外: ' + e.message]; }
    assert.ok(Array.isArray(problems) && problems.length > 0, `${label} を素通りさせている`);
  });
}

test('落ちる: 記録の実行の番号が数字でない', async () => {
  const r = rec(); r.source.workflowRunId = '../123';
  const d = deps();
  const problems = await check(d, r);
  assert.ok(problems.length > 0, '数字でない番号を素通りさせている');
  assert.equal(d.calls.getRun.length, 0, '数字でない番号で GitHub に聞きに行っている');
});

test('落ちる: 記録が CI で作ったと名乗っていない', async () => {
  const r = rec(); r.source.builtInCI = false;
  const problems = await check(deps(), r);
  assert.ok(problems.length > 0);
});

test('記録の repository の欄ではなく、決まった repository を聞く', async () => {
  // 記録の値で聞き先を決めると、聞き先ごとそろえた記録が通る
  const r = rec(); r.source.repository = 'someone/repogloss';
  const problems = await check(deps(), r);
  assert.ok(problems.length > 0, '記録の repository を信じている');
});

/* ---------- 2. CLI の終了コード ---------- */

// いまの作業ツリーの、git が追う物とまだ追っていない物（無視の物は除く）を、
// 使い捨ての repository へ写して 1 回 commit する。試験する道具は作業ツリーの物。
function scratchRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repogloss-origin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const list = execFileSync('git', ['-C', ROOT, 'ls-files', '-co', '--exclude-standard', '-z'])
    .toString('utf8').split('\0').filter(Boolean);
  for (const rel of list) {
    const src = path.join(ROOT, rel);
    if (!fs.existsSync(src)) continue;                // 消した物
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 't');
  return { dir, head: git('rev-parse', 'HEAD').toString().trim() };
}

// 試験を走らせる側の GitHub の値（CI の中では入っている）を、子へ漏らさない
function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GITHUB_')) env[k] = v;
  return { ...env, ...extra };
}

test('手元で CI を名乗って作った包みは、--release で落ちる', t => {
  const { dir, head } = scratchRepo(t);
  const zipScript = path.join(dir, 'scripts', 'package-zip.mjs');
  // 実在する repository・main・番号の形で、CI の実行を名乗って作る
  const made = spawnSync(process.execPath, [zipScript], {
    env: cleanEnv({
      GITHUB_REPOSITORY: 'Driedsandwich/repogloss', GITHUB_REF: 'refs/heads/main',
      GITHUB_RUN_ID: '44486576760', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: head
    }),
    encoding: 'utf8'
  });
  assert.equal(made.status, 0, `前提が崩れている（作れない）: ${made.stderr}`);
  const version = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).version;
  const json = path.join(dir, 'dist', `repogloss-${version}.zip.json`);
  const rec = JSON.parse(fs.readFileSync(json, 'utf8'));
  rec.environment.platform = 'linux';                 // CI の環境の名も名乗る
  fs.writeFileSync(json, JSON.stringify(rec, null, 2));

  // 対照: 出どころを問わない検査では、この組は形として通る
  const plain = spawnSync(process.execPath, [zipScript, '--verify'], { env: cleanEnv(), encoding: 'utf8' });
  assert.equal(plain.status, 0, `前提が崩れている（--verify で落ちる）: ${plain.stderr}`);

  const rel = spawnSync(process.execPath, [zipScript, '--verify', '--release'],
    { env: cleanEnv(), encoding: 'utf8', timeout: 120000 });
  assert.notEqual(rel.status, 0, '手元で作った包みを提出候補として通している');
  assert.match(rel.stderr, /NG/, `落とした訳が出ていない: ${rel.stderr}`);
});
