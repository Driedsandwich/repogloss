/*
 * 実ブラウザで「拡張として読み込んだ状態」を作るためのヘルパ。
 *
 *  - `--load-extension` は現行 Chrome で無効化されているため、CDP の
 *    Extensions.loadUnpacked を使う。これには --remote-debugging-pipe と
 *    --enable-unsafe-extension-debugging が要る（ポート方式では話せない）。
 *  - github.com をローカルの HTTPS サーバへ向ける。外部通信もアカウントも要らない。
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, copyFileSync, readFileSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import { PACKAGE_FILES } from '../../../scripts/package-files.mjs';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export function findChrome() {
  if (process.env.CHROME_PATH) {
    if (!existsSync(process.env.CHROME_PATH)) {
      throw new Error(`CHROME_PATH が指す実行ファイルが無い: ${process.env.CHROME_PATH}`);
    }
    return process.env.CHROME_PATH;
  }
  const os = platform();
  const fixed = os === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
       '/Applications/Chromium.app/Contents/MacOS/Chromium']
    : os === 'win32'
      ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe']
      : [];
  for (const p of fixed) if (existsSync(p)) return p;
  if (os !== 'win32') {
    for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome']) {
      try {
        const p = execFileSync('which', [name], { encoding: 'utf8' }).trim();
        if (p && existsSync(p)) return p;
      } catch (e) { /* 次の候補へ */ }
    }
  }
  throw new Error('Chrome が見つからない。CHROME_PATH で実行ファイルを指定してください。');
}

/* 配布する分だけを別ディレクトリへ並べる。E2E は「出荷するものそのもの」を読み込む */
export function stageExtension() {
  const dir = mkdtempSync(join(tmpdir(), 'repogloss-ext-'));
  for (const rel of PACKAGE_FILES) {
    const dest = join(dir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(ROOT, rel), dest);
  }
  return dir;
}

function makeCert() {
  const dir = mkdtempSync(join(tmpdir(), 'repogloss-cert-'));
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '1', '-nodes',
      '-keyout', key, '-out', cert, '-subj', '/CN=localhost'
    ], { stdio: 'ignore' });
  } catch (e) {
    throw new Error('openssl で証明書を作れなかった。E2E には openssl が要る。');
  }
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

/* GitHub のページ構造をまねた差し替え先。用語がどこに出るかだけを再現する。
   同じ語はページで1回しか注記しないので、確かめたい場所ごとに別の語を割り当てる。
   DOM の順序に意味がある（編集領域を先に置き、同じ語を後の本文にも置く）。 */
const REPO_PAGE = `<!doctype html><html lang="en" data-color-mode="light">
<head><meta charset="utf-8"><title>octocat/Hello-World</title></head>
<body>
  <!-- 旧版が使っていた固定 ID。衝突しないことを確かめるために先に置く -->
  <span id="iiyaku-tooltip">ページ側にもともとある要素</span>

  <!-- ① 編集できる領域。ここには一切触れてはいけない -->
  <div contenteditable="true" id="ce-true">a fork of the project</div>
  <div contenteditable id="ce-empty">the upstream repo</div>
  <div contenteditable="plaintext-only" id="ce-plain">a webhook endpoint</div>
  <div contenteditable="true" id="ce-parent"><span id="ce-child">your token here</span></div>
  <textarea id="draft">書きかけ clone</textarea>

  <!-- ② 上と同じ語を、ふつうの文章にも置く。編集領域で消費されず、こちらへ付くこと -->
  <p id="prose-after">You can fork it, set an upstream, add a webhook, and rotate a token.</p>

  <!-- ③ 1つの操作要素に複数の用語 -->
  <nav><a href="/octocat/Hello-World/pulls" id="nav-multi">Merge pull request</a>
       <a href="/octocat/Hello-World/issues" id="nav-issues">Issues</a></nav>

  <!-- ④ 入口の境界。到達できる／できないを分ける -->
  <label id="lab-for" for="inp-for">artifact</label><input id="inp-for">
  <label id="lab-wrap">milestone <input id="inp-wrap"></label>
  <label id="lab-none">blame</label>
  <div role="button" id="role-only">diff</div>
  <button id="btn-disabled" disabled>conflict</button>
  <ul role="tree"><li role="treeitem" tabindex="-1" id="tree-item">release</li></ul>
  <div tabindex="-1" id="ti-minus1">insights</div>
  <div tabindex="-2" id="ti-minus2">packages</div>

  <!-- ④-2 フォーカスできる大きな容器（GitHub の本文はこの中にある）。
       ここを入口にすると中の印が全部1か所へ集まってしまう -->
  <div tabindex="0" id="scroll-region"><p>Notes about a commit and a remote.</p></div>

  <!-- ⑤ ④で入口が無かった語が、後のふつうの文章では説明されること -->
  <p id="prose-fallback">Notes on blame, diff, conflict, insights and packages.</p>

  <!-- ⑥ もともと aria-describedby を持つ入口 -->
  <a href="#" id="aria-host" aria-describedby="existing-help">workflow</a>
  <span id="existing-help">既存の説明</span>

  <!-- ⑦ ふつうの文章（単独の印） -->
  <p id="prose">Create a branch and ask for a review.</p>

  <!-- ⑧ 画面の右端に寄せた入口（はみ出しの確認用） -->
  <p id="edge" style="position:absolute; right:0; top:0; margin:0;">rebase</p>

  <!-- ⑨ コード表示 -->
  <pre id="code"><code>git push --force origin main</code></pre>
</body></html>`;

export function startTestServer() {
  const { key, cert } = makeCert();
  const server = https.createServer({ key, cert }, (req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(REPO_PAGE);
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: server.address().port, close: () => new Promise(r => server.close(r)) });
    });
  });
}

/* CDP をパイプ（fd3=送信 / fd4=受信、NUL 区切り JSON）で話す最小クライアント */
export class Cdp {
  constructor(proc) {
    this.proc = proc;
    this.id = 0;
    this.pending = new Map();
    this.buf = Buffer.alloc(0);
    proc.stdio[4].on('data', chunk => this._onData(chunk));
  }
  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    let i;
    while ((i = this.buf.indexOf(0)) !== -1) {
      const raw = this.buf.subarray(0, i).toString('utf8');
      this.buf = this.buf.subarray(i + 1);
      let m;
      try { m = JSON.parse(raw); } catch (e) { continue; }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(`${m.error.message} (${JSON.stringify(m.error)})`));
        else resolve(m.result);
      }
    }
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdio[3].write(JSON.stringify(payload) + '\0');
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP タイムアウト: ${method}`));
        }
      }, 20000);
    });
  }
}

export async function launchChrome({ port } = {}) {
  const bin = findChrome();
  const profile = mkdtempSync(join(tmpdir(), 'repogloss-profile-'));
  const args = [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--ignore-certificate-errors',
    '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
    `--user-data-dir=${profile}`,
    // CI（コンテナ内・非特権）ではサンドボックスと /dev/shm で Chrome が起動できない。
    // テスト専用の緩和で、配布物には影響しない。
    ...(platform() === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
    ...(port ? [`--host-resolver-rules=MAP github.com 127.0.0.1:${port}`] : []),
    'about:blank'
  ];
  const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', d => { stderr += d.toString(); });
  const cdp = new Cdp(proc);
  let ok = false;
  for (let i = 0; i < 40; i++) {
    try { await cdp.send('Browser.getVersion'); ok = true; break; } catch (e) { await sleep(250); }
  }
  if (!ok) throw new Error(`Chrome と CDP で接続できなかった: ${stderr.slice(0, 400)}`);
  return { cdp, proc, kill: () => { try { proc.kill('SIGKILL'); } catch (e) {} } };
}

/* ページを開き、そのページで式を評価できる関数を返す */
export async function openPage(cdp, url) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.navigate', { url }, sessionId);
  const evaluate = async expression => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result?.value;
  };
  return { targetId, sessionId, evaluate, close: () => cdp.send('Target.closeTarget', { targetId }) };
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 条件が満たされるまで待つ。満たされなければ理由つきで失敗させる */
export async function waitFor(label, fn, { timeout = 15000, interval = 200 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const v = await fn();
    if (v) return v;
    await sleep(interval);
  }
  throw new Error(`待ち時間内に成立しなかった: ${label}`);
}
