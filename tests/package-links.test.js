// 包みを作る道具（package-zip・package-stage）が、配布ファイルの場所にあるシンボリックリンクを
// たどって、repository の外の中身を運ばないかを見る。
//
// 配布の一覧は決まった 13 件だが、その 1 件がリンクとして commit されると、
// ファイルを読む手はリンクの先を読む。作り手の機械の、一覧と関係のないファイルが包みに入る。
// 使い捨ての repository の中でリンクを作り、作る道具が落ちること・外の中身が出ないことを見る。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CANARY = 'REPOGLOSS-OUTSIDE-CANARY';

function scratchRepo(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'repogloss-links-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dir = path.join(base, 'repo');
  const outside = path.join(base, 'outside.txt');
  fs.writeFileSync(outside, CANARY + '\n');
  const list = execFileSync('git', ['-C', ROOT, 'ls-files', '-co', '--exclude-standard', '-z'])
    .toString('utf8').split('\0').filter(Boolean);
  for (const rel of list) {
    const src = path.join(ROOT, rel);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  // 配布の一覧の 1 件（LICENSE）を、repository の外のファイルへのリンクに替えて commit する
  fs.rmSync(path.join(dir, 'LICENSE'));
  fs.symlinkSync(outside, path.join(dir, 'LICENSE'));
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 't');
  return dir;
}

const env = () => {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GITHUB_')) e[k] = v;
  return e;
};

// dist の下の物を全部読み、外の中身が入っていないかを見る（ZIP は deflate なので、
// 中身は zip.mjs で開いて見る）
async function distHasCanary(dir) {
  const { readZip } = await import(path.join(dir, 'scripts', 'zip.mjs'));
  const dist = path.join(dir, 'dist');
  if (!fs.existsSync(dist)) return false;
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  for (const f of walk(dist)) {
    const raw = fs.readFileSync(f);
    if (raw.includes(CANARY)) return true;
    if (f.endsWith('.zip')) {
      try { if (readZip(raw).some(e => e.data.includes(CANARY))) return true; } catch (_) {}
    }
  }
  return false;
}

test('配布ファイルがリンクなら、ZIP を作る道具は落ち、外の中身を運ばない', async t => {
  const dir = scratchRepo(t);
  const r = spawnSync(process.execPath, [path.join(dir, 'scripts', 'package-zip.mjs')],
    { env: env(), encoding: 'utf8' });
  assert.notEqual(r.status, 0, 'リンクの先を読んで ZIP を作っている');
  assert.equal(await distHasCanary(dir), false, 'repository の外の中身が dist に入った');
});

test('配布ファイルがリンクなら、並べる道具は落ち、外の中身を運ばない', async t => {
  const dir = scratchRepo(t);
  const r = spawnSync(process.execPath, [path.join(dir, 'scripts', 'package-stage.mjs')],
    { env: env(), encoding: 'utf8' });
  assert.notEqual(r.status, 0, 'リンクの先を読んで並べている');
  assert.equal(await distHasCanary(dir), false, 'repository の外の中身が dist に入った');
});
