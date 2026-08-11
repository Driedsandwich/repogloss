/*
 * 実ブラウザで「拡張として読み込んだ状態」を作るためのヘルパ。
 *
 *  - `--load-extension` は現行 Chrome で無効化されているため、CDP の
 *    Extensions.loadUnpacked を使う。これには --remote-debugging-pipe と
 *    --enable-unsafe-extension-debugging が要る（ポート方式では話せない）。
 *  - github.com をローカルの HTTPS サーバへ向ける。外部通信もアカウントも要らない。
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
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

/* 計測用の変種。配布ファイルはそのままに、テスト専用の JS を同じ拡張の
   content script として読み込ませる manifest へ差し替える。
   content script は「隔離された世界」で動くので、ページ側からは中を見られない。
   同じ世界に入るには、この経路しかない。
   触るのは並べた一時ディレクトリだけで、リポジトリの配布物は変えない。

   extra … 置き先のファイル名 -> リポジトリ内のパス
   order … 読み込み順を作り直す関数（既定はそのまま） */
export function stageExtensionWith(extra = {}, order = js => js) {
  const dir = stageExtension();
  for (const [dest, src] of Object.entries(extra)) {
    copyFileSync(join(ROOT, src), join(dir, dest));
  }
  const mfPath = join(dir, 'manifest.json');
  const mf = JSON.parse(readFileSync(mfPath, 'utf8'));
  mf.content_scripts[0].js = order(mf.content_scripts[0].js);
  writeFileSync(mfPath, JSON.stringify(mf, null, 2) + '\n');
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
  <a href="#" id="before">before</a>

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

  <!-- ④ 入口の境界：到達できる -->
  <label id="lab-for" for="inp-for">artifact</label><input id="inp-for">
  <label id="lab-wrap">milestone <input id="inp-wrap"></label>
  <fieldset disabled id="fs">
    <legend id="fs-legend"><button id="btn-legend">license</button></legend>
    <button id="btn-in-fs">sync</button>
  </fieldset>
  <details id="det"><summary id="sum-first">remote</summary><summary id="sum-second">packages</summary></details>

  <!-- ⑤ 入口の境界：到達できない（印を付けてはいけない） -->
  <label id="lab-none">blame</label>
  <div role="button" id="role-only">diff</div>
  <button id="btn-disabled" disabled>conflict</button>
  <label id="lab-hidden">visibility <input type="hidden" id="inp-hidden"></label>
  <label id="lab-dnone" for="inp-dnone">collaborator</label><input id="inp-dnone" style="display:none">
  <label id="lab-vhidden" for="inp-vhidden">contributors</label><input id="inp-vhidden" style="visibility:hidden">
  <div role="button" tabindex="" id="ti-empty">watch</div>
  <div role="button" tabindex="   " id="ti-space">watching</div>
  <summary id="orphan-summary">origin</summary>

  <!-- ⑥ 矢印キーで移動する部品：壊れている（容器も入口も無い／入口が無い） -->
  <ul role="tree" id="broken-tree"><li role="treeitem" tabindex="-1" id="broken-item">insights</li></ul>
  <li role="treeitem" tabindex="-1" id="orphan-item">forks</li>

  <!-- ⑦ 矢印キーで移動する部品：正しい（Tab の入口があり、矢印で移動する） -->
  <ul role="tree" id="good-tree">
    <li role="treeitem" tabindex="0" id="tree-entry">star</li>
    <li role="treeitem" tabindex="-1" id="tree-target">release</li>
  </ul>

  <!-- ⑦-b 構造だけ正しく、矢印に応答する実装が無い部品。
       role も容器も tabindex 0/-1 の並びも ⑦ と同じだが、keydown handler が無い。
       静的な構造から到達可能と決めつけると、ここで誤る（第4回監査の反例）。 -->
  <ul role="tree" id="nohandler-tree">
    <li role="treeitem" tabindex="0" id="nh-entry">tags</li>
    <li role="treeitem" tabindex="-1" id="nh-target">projects</li>
  </ul>

  <!-- ⑦-c 描画されない入口。語を含むテキストの「直接の親」は描画されているが、
       操作要素である先祖のほうが箱を持たない。子から先祖の描画を推し量ると誤る。 -->
  <a href="#" id="dc-link" style="display:contents"><span id="dc-link-text">topic</span></a>
  <button id="dc-btn" style="display:contents"><span id="dc-btn-text">security</span></button>
  <a href="#" id="vh-host" style="visibility:hidden"><span id="vh-child" style="visibility:visible">wiki</span></a>

  <!-- ⑧ フォーカスできるだけの容器／できない容器 -->
  <div tabindex="0" id="scroll-region"><p>Notes about a commit and a fetch.</p></div>
  <div tabindex="-1" id="ti-minus1">draft release</div>

  <!-- ⑨ ④〜⑦で入口が無かった語が、後のふつうの文章では説明されること -->
  <p id="prose-fallback">Notes on blame, diff, conflict, visibility, collaborator, contributors,
     sync, watch, watching, origin, packages, forks and insights.
     Also release, projects, topic, security and wiki.</p>

  <!-- ⑩ もともと aria-describedby を持つ入口 -->
  <a href="#" id="aria-host" aria-describedby="existing-help">workflow</a>
  <span id="existing-help">既存の説明</span>

  <!-- ⑪ ふつうの文章（単独の印） -->
  <p id="prose">Create a branch and ask for a review.</p>

  <!-- ⑫ 画面の右端に寄せた入口（はみ出しの確認用） -->
  <p id="edge" style="position:absolute; right:0; top:0; margin:0;">rebase</p>

  <!-- ⑬ コード表示 -->
  <pre id="code"><code>git push --force origin main</code></pre>

  <!-- ⑮ 見えていない場所。ここに印を付けると、その語の「ページで最初の1回」を
       使い切ってしまい、後ろにある読める同じ語へ説明が付かなくなる。
       いずれも「隠れている側は0個・後ろの本文が1個」になるのが正しい。 -->
  <div inert id="inert-box"><p>Notes about actions here.</p></div>
  <p id="after-inert">Later visible actions paragraph.</p>

  <div id="op-host" style="opacity:0"><p id="op-p">Run the checks now.</p></div>
  <p id="after-op">Later visible checks paragraph.</p>

  <div id="cv-host" style="content-visibility:hidden"><p id="cv-p">Read the readme first.</p></div>
  <p id="after-cv">Later visible readme paragraph.</p>

  <!-- 読み上げ専用テキストの定番の書き方（1px 四方＋clip）。GitHub も使っている -->
  <span id="clip-box" style="position:absolute;width:1px;height:1px;overflow:hidden;
        clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap">this repository navigation</span>
  <p id="after-clip">Later visible repository paragraph.</p>

  <!-- ⑯ 後から隠される印（古い印が後続を抑止しないかの確認に使う） -->
  <p id="stale-a">Do not reset it lightly.</p>
  <p id="stale-b">Add an ssh key first.</p>
  <div id="sink"></div>

  <!-- ⑭ 画面の外にある印。実際に Tab を押し続けて到達する（focus() を呼ばない）。
       ここへ止まるとブラウザが自動でスクロールするので、説明が消えないことを確かめる。 -->
  <div style="height:1800px"></div>
  <p id="far-below">Undo it with a revert.</p>

  <a href="#" id="after">after</a>

  <script>
    // 正しい roving tabindex の実装。矢印で対象を移し、tabindex も入れ替える。
    document.getElementById('good-tree').addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      var items = Array.prototype.slice.call(this.querySelectorAll('[role="treeitem"]'));
      var i = items.indexOf(document.activeElement);
      if (i < 0) return;
      var next = items[e.key === 'ArrowDown' ? Math.min(i + 1, items.length - 1) : Math.max(i - 1, 0)];
      items.forEach(function (it) { it.tabIndex = -1; });
      next.tabIndex = 0;
      next.focus();
      e.preventDefault();
    });
  </script>
</body></html>`;

/* 除外されるはずの領域それぞれへ目印を置いたページ。
   拡張がその目印の文字列を一度でも取り出したかを、prelude が記録する。
   目印は辞書語（repository / commit）と一緒に置く——語が無いと、そもそも
   読む理由が無くなり「読まれなかった」が意味を失うため。 */
export const SENTINEL_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>sentinel</title></head><body>
  <div contenteditable="true" id="s-editable">RGSENTINEL_EDITABLE a repository draft</div>
  <textarea id="s-textarea">RGSENTINEL_TEXTAREA a commit message</textarea>
  <input id="s-input" value="RGSENTINEL_INPUT a branch name">
  <select id="s-select"><option>RGSENTINEL_SELECT a remote</option></select>
  <pre id="s-code"><code>RGSENTINEL_CODE git commit</code></pre>
  <div class="blob-code" id="s-blob">RGSENTINEL_BLOB a merge here</div>
  <div aria-hidden="true" id="s-ariahidden">RGSENTINEL_ARIAHIDDEN a repository note</div>
  <div inert id="s-inert">RGSENTINEL_INERT a commit note</div>
  <div hidden id="s-hidden">RGSENTINEL_HIDDEN a branch note</div>
  <div hidden="until-found" id="s-untilfound">RGSENTINEL_UNTILFOUND a merge note</div>
  <p id="s-visible">RGSENTINEL_VISIBLE open a pull request</p>
</body></html>`;

/* 見えない場所の直接テキストと、印の付け直し（ライフサイクル）を確かめるページ。
   語が重ならないよう、確認したい場所ごとに別の辞書語を割り当てる。 */
export const LIFECYCLE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>lifecycle</title></head><body>
  <!-- 直接テキストを持つ隠し方。子ではなく、その要素自身が文字を持つ形 -->
  <div id="cvd" style="content-visibility:hidden">Make a commit now.</div>
  <p id="after-cvd">Later visible commit paragraph.</p>
  <div id="hd" hidden>Open the issues tab.</div>
  <p id="after-hd">Later visible issues paragraph.</p>
  <div id="huf" hidden="until-found">Look at the checks tab.</div>
  <p id="after-huf">Later visible checks paragraph.</p>

  <!-- 大きな箱に全面の切り取りを掛けた読み上げ専用テキスト -->
  <div id="bigclip" style="position:absolute;width:400px;height:200px;overflow:hidden;clip:rect(0 0 0 0)">A milestone groups work.</div>
  <p id="after-bigclip">Later visible milestone paragraph.</p>

  <!-- 箱を作らないが文字は見えている（display:contents の直接テキスト） -->
  <div id="dcd" style="display:contents">A webhook fires here.</div>

  <!-- 印の付け直し。単独の印と、リンクの中の印の両方で往復させる -->
  <p id="life-plain">Do not reset it lightly.</p>
  <p><a href="#" id="life-link">Add an ssh key</a></p>
  <div id="sink"></div>
</body></html>`;

/* 箱を作らない要素（display:contents）と、切り取りによる非表示。
   どちらも「先祖に1回聞いた答え」を子へ転用すると両方向に誤る場所なので、
   見えている側と見えていない側を対にして置き、同じ語を後ろの本文にも用意する。
   「隠れている側 0・後ろ 1」か「見えている側 1・後ろ 0」のどちらが正しいかは、
   その場所が実際に読めるかで決まる。 */
export const VISIBILITY_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>visibility</title></head><body>
  <!-- ① 中身を飛ばす先祖の中の display:contents。先祖自身は描画されたままなので、
       先祖に聞くと「見えている」と答える。Range の矩形も出る。だが読めない -->
  <div id="cv-host" style="content-visibility:hidden"><span id="cv-dc" style="display:contents">branch</span></div>
  <p id="cv-later">Later visible branch paragraph.</p>

  <!-- ② visibility:hidden の中で、子が visible に戻している。先祖に聞くと
       「見えていない」。だが子の文字は見えている（visibility は継承する） -->
  <div id="vh-host" style="visibility:hidden"><span id="vh-dc" style="display:contents;visibility:visible">fork</span></div>
  <p id="vh-later">Later visible fork paragraph.</p>

  <!-- ③ ふつうの display:contents。箱は無いが文字は見えている -->
  <div id="plain-dc" style="display:contents">A token lives here.</div>

  <!-- ④ 先祖が opacity:0 の display:contents -->
  <div id="op-host" style="opacity:0"><span id="op-dc" style="display:contents">upstream</span></div>
  <p id="op-later">Later visible upstream paragraph.</p>

  <!-- ⑤ 先祖が display:none の display:contents -->
  <div id="dn-host" style="display:none"><span id="dn-dc" style="display:contents">release</span></div>
  <p id="dn-later">Later visible release paragraph.</p>

  <!-- ⑥ 画面外の content-visibility:auto。画面外というだけで除外してはいけない -->
  <div style="height:2400px"></div>
  <div id="cva-host" style="content-visibility:auto"><p id="cva-p">Try a rebase later.</p></div>

  <!-- ⑦ legacy clip は絶対配置にしか効かない。static / relative では見えている -->
  <div id="clip-static" style="position:static;clip:rect(0 0 0 0)">Give it a star today.</div>
  <div id="clip-relative" style="position:relative;clip:rect(0 0 0 0)">Browse the tags list.</div>

  <!-- ⑧ 絶対配置／固定配置なら効く -->
  <div id="clip-abs" style="position:absolute;clip:rect(0 0 0 0)">Pick a topic here.</div>
  <p id="abs-later">Later visible topic paragraph.</p>
  <div id="clip-fixed" style="position:fixed;clip:rect(0 0 0 0)">Open the wiki page.</div>
  <p id="fixed-later">Later visible wiki paragraph.</p>

  <!-- ⑨ clip-path は配置に関係なく効く -->
  <div id="clippath-static" style="position:static;clip-path:inset(50%)">Read the license file.</div>
  <p id="clippath-later">Later visible license paragraph.</p>

  <!-- ⑩ Primer の読み上げ専用（1px 四方＋絶対配置＋clip） -->
  <span id="primer" style="position:absolute;width:1px;height:1px;overflow:hidden;
        clip:rect(0 0 0 0);white-space:nowrap">Open insights now.</span>
  <p id="primer-later">Later visible insights paragraph.</p>

  <!-- ⑨-b 面積は0だが座標が0でない legacy clip。決まった書き方の照合では取りこぼす -->
  <div id="clip-nonzero" style="position:absolute;clip:rect(5px,5px,5px,5px)">Make a commit here.</div>
  <p id="nonzero-later">Later visible commit paragraph.</p>
  <div id="clip-fixed2" style="position:fixed;clip:rect(10px,8px,10px,3px)">Do a merge here.</div>
  <p id="fixed2-later">Later visible merge paragraph.</p>

  <!-- ⑨-c clip-path の inset は 50% 以外にも面積0になる書き方がある -->
  <div id="clip-inset100" style="clip-path:inset(100%)">Set the origin here.</div>
  <p id="inset100-later">Later visible origin paragraph.</p>

  <!-- ⑨-d 面積が残る書き方は、見えているので除外してはいけない -->
  <div id="clip-positive" style="position:absolute;clip:rect(0px,200px,40px,0px)">Add a remote here.</div>
  <div id="clip-inset10" style="clip-path:inset(10%)">Check the blame view.</div>

  <!-- ⑨-e display:contents 自身の clip-path。箱が無いので効かない（見えている） -->
  <span id="dc-clip" style="display:contents;clip-path:inset(50%)">Undo with a revert.</span>

  <!-- ⑪ 一度描かれてから中身を飛ばす形。ここが本命の反例で、
       Range は**古い矩形を返し続ける**（実測: 隠す前も後も 1 個）。
       つまり「文字に矩形があるか」では見抜けず、先祖を名指しで見るしかない。
       ⑦ のように最初から隠れている場合は矩形が 0 になるので、両方を置く。 -->
  <div id="late-host"><span id="late-dc" style="display:contents">Try to fetch it.</span></div>
  <div id="late-sink"></div>
</body></html>`;

/* 印の片づけと付け直し。ページ側が印の隣へ節点を挿す／印だけを外す／
   親ごと差し替える、といった動きの中で、こちらが何を壊さないかを見る。 */
export const RETIRE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>retire</title></head><body>
  <p id="solo">Undo it with a revert now.</p>
  <p id="tail-end">Look at the blame</p>
  <p><a href="#" id="hosted">Open the diff</a></p>
  <p id="two">A remote and an origin differ.</p>
  <p id="replaceable">Check the packages list.</p>
  <p id="selectable">Ask for a careful review of the code.</p>
  <div id="sink"></div>
</body></html>`;

/* 正規の印が居なくなったときに、**既にページにある候補**へ引き継げるか。
   記録と DOM の食い違い、複製された印の扱いも、ここでまとめて見る。 */
export const RESELECT_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>reselect</title></head><body>
  <!-- 再選出: 最初を消したら2番目へ。隠れている候補は選ばない -->
  <p id="first">A push first.</p>
  <p id="second">A push second.</p>
  <p id="third" style="display:none">A push hidden.</p>
  <p id="fourth">A push fourth.</p>

  <!-- 記録の整合 -->
  <p id="gone">A conflict here.</p>
  <p id="rewritten">Some checks here.</p>
  <p id="inserted">Open the issues tab.</p>
  <p id="moved">List the packages here.</p>
  <p id="selectable">Ask about the projects board.</p>
  <p><a href="#" id="lnk">Open the security tab</a></p>
  <p id="two">A sync and a watch differ.</p>

  <!-- 複製 -->
  <div id="clone-src"><p>Add a label here.</p></div>
  <div id="clone-host"><p><a href="#" id="hlnk">Open the workflow view</a></p></div>

  <div id="elsewhere"></div>
  <div id="sink"></div>
</body></html>`;

/* 記録が「整合している」だけでは足りない場面。隠された・無効にされた・
   語の後ろに文字が増えた・入口の意味が変わった、のいずれでも、
   読める同じ語へ説明が移ること。 */
export const USABILITY_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>usability</title></head><body>
  <!-- ① 不可視化: 最初を display:none にしたら、既にある2番目へ -->
  <p id="u-hide1">A branch first.</p>
  <p id="u-hide2">A branch second.</p>

  <!-- ② 入口が無効になる: button を disabled にしたら、後ろの読める語へ -->
  <p><button id="u-btn">Open the fetch view</button></p>
  <p id="u-btn-later">A fetch later.</p>

  <!-- ③ 語のうしろに文字が増える -->
  <p id="u-suffix">A rebase first.</p>
  <div id="u-suffix-sink"></div>

  <!-- ④ label の for が別の control を指す -->
  <label id="u-lab" for="u-ia">squash merge</label><input id="u-ia"><input id="u-ib">
  <p id="u-lab-later">squash merge later.</p>

  <!-- ⑥ 語そのものが書き換わる -->
  <p id="u-cd1">A revert first.</p>
  <p id="u-cd2">A revert second.</p>

  <div id="sink"></div>
</body></html>`;

/* 名前が衝突したときに、ページ側のものを壊さないか。
   と、面積0の切り取りを取りこぼさないか。 */
export const NAMESPACE_CLIP_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>namespace and clip</title><style>.box100{width:100px;height:100px}</style></head><body>
  <!-- ⑦ ページ側が同じ class・同じ属性名を使っている -->
  <a id="page-icon" href="#dest" class="iiyaku-icon">PAGE LINK</a>
  <p><a href="#" id="ns-a" data-iiyaku-trigger="shared">Open the milestone</a></p>
  <p><a href="#" id="ns-b" data-iiyaku-trigger="shared">Open the wiki</a></p>
  <p><a href="#" id="ns-c" data-iiyaku-trigger='bad"]sel'>Open the blame</a></p>
  <div id="ns-sink"></div>

  <!-- ⑧ 面積0の切り取り。後ろに読める同じ語を置いて、そちらへ回るかを見る -->
  <div id="c-pct" style="clip-path:inset(50% 0 50% 0)">A webhook hidden.</div>
  <p id="c-pct-later">A webhook later.</p>
  <div id="c-px" class="box100" style="clip-path:inset(50px)">A topic hidden.</div>
  <p id="c-px-later">A topic later.</p>
  <div id="c-side" style="clip-path:inset(0 100% 0 0)">A fork hidden.</div>
  <p id="c-side-later">A fork later.</p>
  <div id="c-circle" style="clip-path:circle(0px)">A clone hidden.</div>
  <p id="c-circle-later">A clone later.</p>
  <!-- 面積が残るものは可視のまま扱う（落としすぎの対照） -->
  <div id="c-part" style="clip-path:inset(10%)">A tags partly.</div>
  <p id="c-part-later">A tags later.</p>
  <div id="c-dc" style="display:contents; clip-path:inset(50%)">A sync shown.</div>
  <p id="c-dc-later">A sync later.</p>
</body></html>`;

/* 注記したあとで、その場所が「触れない領域」へ変わる。
   本文を読む前に手を引けているかを、生の読み取りで測る。 */
export const PROTECTED_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>protected</title></head><body>
  <p id="pr-ce">A branch here.</p>
  <p id="pr-ah">A commit here.</p>
  <p id="pr-in">A merge here.</p>
  <p id="pr-hd">A fetch here.</p>
  <div id="sink"></div>
</body></html>`;

/* 退役と選び直しが、変更のたびに収束するか。 */
export const CONVERGE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>converge</title></head><body>
  <p id="cv1">A conflict first.</p>
  <p id="cv2">A conflict second.</p>
  <p id="cv3">A conflict third.</p>
  <p id="cv-sel">Ask for a careful review of the code.</p>
  <div id="cv-sink"></div>
</body></html>`;

/* 見え方を変える合図が、DOM の変更として出ないもの。
   属性の絞り込み・子の追加・CSS の遷移・media query・head の stylesheet。 */
export const SIGNALS_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>signals</title>
<style>
  [data-state=closed]{display:none}
  #has-box:has(.hider){display:none}
  #checked-box:has(#toggle:checked){display:none}
  #fade{opacity:1;transition:opacity .08s linear}
  #fade.gone{opacity:0}
  @media(min-width:700px){#wide{display:block}#narrow{display:none}}
  @media(max-width:699px){#wide{display:none}#narrow{display:block}}
</style></head><body>
  <!-- 属性の絞り込みでは拾えないもの -->
  <label id="lab" for="ctrl">branch</label><input id="ctrl"><p id="lab-later">A branch later.</p>
  <p id="ds" data-state="open">A commit first.</p><p id="ds-later">A commit later.</p>
  <div id="checked-box"><input id="toggle" type="checkbox">A merge first.</div>
  <p id="checked-later">A merge later.</p>

  <!-- 子を足すだけで祖先が消える -->
  <div id="has-box">A rebase first.</div><p id="has-later">A rebase later.</p>

  <!-- CSS の遷移 -->
  <p id="fade">A revert first.</p><p id="fade-later">A revert later.</p>

  <!-- 画面幅で入れ替わる -->
  <p id="wide">A fetch wide.</p><p id="narrow">A fetch narrow.</p>

  <!-- head の stylesheet で隠される -->
  <p id="hs">A webhook first.</p><p id="hs-later">A webhook later.</p>

  <div id="sink"></div>
</body></html>`;

/* 所有と自己変更。ページ側が同じ class を使う／複製する／こちらの印へ手を出す。
   と、切り取りの文法（参照ボックス・キーワード半径）。 */
export const OWNERSHIP_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>ownership</title>
<style>#clip-box{box-sizing:border-box;width:100px;height:100px;padding:40px;clip-path:inset(50%) content-box}</style>
</head><body>
  <p id="orig">A branch first.</p><p id="orig-later">A branch later.</p>
  <p id="hide-me">A commit first.</p><p id="hide-later">A commit later.</p>
  <div id="clip-box">A webhook hidden.</div><p id="clip-later">A webhook later.</p>
  <div id="ellipse" style="width:100px;height:100px;clip-path:ellipse(0 closest-side)">A topic hidden.</div>
  <p id="ellipse-later">A topic later.</p>
  <div id="sink"></div>
</body></html>`;

/* 初回の走査では見えていない語。あとから見えるようになったときに、
   **まだ印の無い語**を見つけられるか（第11回 RG-11-01）。
   見えている語を1つ置いてあるのは、記録が0件のときに暇なときの確認が
   止まる形にしないため（止まる形だと、何を測っているか分からなくなる）。 */
export const LATENT_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>latent</title>
<style>
  @media(min-width:700px){#narrow-only{display:none}}
  @media(max-width:699px){#narrow-only{display:block}}
  #fade-in{opacity:0;transition:opacity .08s linear}
  #fade-in.shown{opacity:1}
  #checked-only{display:none}
  body:has(#tgl:checked) #checked-only{display:block}
</style>
<style id="hide-style">#style-only{display:none}</style>
</head><body>
  <p id="keep">A repository stays visible.</p>
  <p id="narrow-only">A clone appears when narrow.</p>
  <p id="style-only">A fork appears when the sheet goes.</p>
  <p id="fade-in">A milestone appears by fading in.</p>
  <input id="tgl" type="checkbox">
  <p id="checked-only">An artifact appears when ticked.</p>
  <!-- 同じ語が既に読める場所にある。あとで見えても増やしてはいけない -->
  <p id="dup-shown">A webhook is already readable.</p>
  <p id="dup-hidden" style="display:none">A webhook is hidden here.</p>
</body></html>`;

/* 自分の署名を持つ複製、退役した印の作り直し、ページ側の同名 class、
   そして切り取りの残り2形（第11回 RG-11-02 / RG-11-03 / RG-11-04）。 */
export const SIGNATURE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>signature</title>
<style>
  #circle-box{width:100px;height:100px;clip-path:circle(closest-side at 0 50%)}
  #box-only{box-sizing:border-box;width:100px;height:100px;padding:50px;clip-path:content-box}
  #box-normal{box-sizing:border-box;width:100px;height:100px;padding:10px;clip-path:content-box}
</style></head><body>
  <a href="#" id="before">before</a>
  <p id="retire-src">A branch first.</p><p id="retire-dst">A branch later.</p>
  <p id="strip">A commit first.</p><p id="strip-later">A commit later.</p>
  <p id="tip-class">A merge first.</p><p id="tip-class-later">A merge later.</p>
  <div id="circle-box">A rebase hidden.</div><p id="circle-later">A rebase later.</p>
  <div id="box-only">A revert hidden.</div><p id="box-later">A revert later.</p>
  <div id="box-normal">A fetch shown.</div><p id="normal-later">A fetch later.</p>
  <p id="clone-src">A milestone first.</p>
  <!-- ページ側が同じ class を自分の本文へ使っている。ここは走査してよい -->
  <p id="page-tip" class="iiyaku-tooltip">An upstream inside a page element.</p>
  <p id="tip-later">An upstream later.</p>
  <!-- ページ側が同じ class と属性を自分で使っている。中身は自分のものではない -->
  <span id="page-own" class="iiyaku-icon" data-iiyaku-owner="page">page</span>
  <div id="sink"></div>
  <a href="#" id="after">after</a>
</body></html>`;

/* 控えてある候補を見直すとき、**本文へ触れる前に**触れてよい場所かを確かめるか
   （第12回 RG-12-01）。目印は最初は置かず、保護領域へ変えるのと同時に入れる——
   初回走査の時点で読まれるのは正しい（そのときは保護領域ではない）ので、
   それを数えてしまうと何を測っているか分からなくなる。 */
export const LATENT_GUARD_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>latent-guard</title><style>.hid{display:none}</style></head><body>
  <p id="anchor">A repository stays visible.</p>
  <p id="lat-edit" class="hid">a branch here.</p>
  <p id="lat-aria" class="hid">a commit here.</p>
  <p id="lat-inert" class="hid">a merge here.</p>
  <p id="lat-hidden" class="hid">a rebase here.</p>
  <p id="lat-open" class="hid">a revert here.</p>
</body></html>`;

/* いまは入口が無いだけの候補（第12回 RG-12-02）。
   どれも見えてはいるが、そのままでは印を入れる場所（入口）が決まらない。 */
export const DEFERRED_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>deferred</title></head><body>
  <a href="#" id="before">before</a>
  <p id="anchor">A repository stays visible.</p>
  <button id="btn" disabled>branch</button>
  <div id="roving" tabindex="-1" role="treeitem">commit</div>
  <label id="lab">merge</label><input id="ctrl">
  <a id="anchorless">rebase</a>
</body></html>`;

/* ページ側が自分と同じ class 名を使う場所（第12回 RG-12-06）。
   本文は走査してよく、吹き出しの中と誤認してもいけない。 */
export const SKIPNAME_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>skipname</title></head><body>
  <p id="src">A branch first.</p>
  <p id="page-icon" class="iiyaku-icon">A commit in ordinary page text.</p>
  <div id="page-tip" class="iiyaku-tooltip">page owned</div>
  <div id="page-toggle" class="iiyaku-toggle">page owned too</div>
</body></html>`;

/* 参照ボックスが潰れているときの切り取り（第12回 RG-12-05）。
   既知の 0 と、寸法が分からないことを混ぜない。負の inset で外へ広がる形も対照に置く。 */
export const CLIPZERO_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>clipzero</title><style>
  .box{box-sizing:border-box;width:100px;height:100px}
  #zero{padding:50px;clip-path:inset(0) content-box}
  #zero-neg{padding:50px;clip-path:inset(-20px) content-box}
  #nonzero{padding:10px;clip-path:inset(0) content-box}
</style></head><body>
  <div id="zero" class="box">A branch hidden.</div><p id="zero-later">A branch later.</p>
  <div id="zero-neg" class="box">A commit shown.</div><p id="neg-later">A commit later.</p>
  <div id="nonzero" class="box">A merge shown.</div><p id="nonzero-later">A merge later.</p>
</body></html>`;

export function startTestServer(html = REPO_PAGE) {
  const { key, cert } = makeCert();
  const server = https.createServer({ key, cert }, (req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(html);
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
        const { resolve, reject, timer } = this.pending.get(m.id);
        this.pending.delete(m.id);
        clearTimeout(timer);   // 応答が来たタイマーを残すと、終了まで待たされる
        if (m.error) reject(new Error(`${m.error.message} (${JSON.stringify(m.error)})`));
        else resolve(m.result);
      }
    }
  }
  rejectAll(err) {
    for (const [, { reject, timer }] of this.pending) { clearTimeout(timer); reject(err); }
    this.pending.clear();
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP タイムアウト: ${method}`));
        }
      }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdio[3].write(JSON.stringify(payload) + '\0');
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
  // Chrome が落ちたら、待っている呼び出しを timeout まで放置しない
  const abort = () => cdp.rejectAll(new Error(`Chrome が終了した: ${stderr.slice(-300)}`));
  proc.on('exit', abort);
  proc.on('error', abort);
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

/* 実際のキー入力を送る。合成イベントではなくブラウザが解釈する入力にする */
const KEYS = {
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 }
};

export async function pressKey(cdp, sessionId, name, { shift = false } = {}) {
  const k = KEYS[name];
  if (!k) throw new Error(`未対応のキー: ${name}`);
  const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk,
                 modifiers: shift ? 8 : 0 };
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base }, sessionId);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, sessionId);
}

/* Tab を押し続けて、ブラウザが実際に止まった要素の id を順に集める。
   到達できるかどうかを自分の式で計算し直さないための「別の物差し」。 */
export async function collectTabOrder(cdp, page, steps = 60, startId = 'before', { shift = false } = {}) {
  // 開始位置を決めないと、前のテストが残したフォーカス位置から続いてしまい、
  // 何周目を見ているのか分からなくなる。開始位置の固定にだけ focus() を使い、
  // 「到達できるか」の判定そのものには使わない（それでは実装の式の言い換えになる）。
  await page.evaluate(`(() => {
    const s = document.getElementById(${JSON.stringify(startId)});
    if (s) s.focus(); else { document.body.focus(); document.activeElement && document.activeElement.blur(); }
  })(); true`);
  const seen = [];
  for (let i = 0; i < steps; i++) {
    await pressKey(cdp, page.sessionId, 'Tab', { shift });
    seen.push(await page.evaluate(
      `document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : null`));
  }
  return seen;
}

/* Tab を押し続けて、条件を満たす要素へ実際に止まるまで進む。
   到達できなければ null を返す（失敗の理由をテスト側で書けるようにする）。 */
export async function tabUntil(cdp, page, testExpr, { steps = 120, shift = false, startId = 'before' } = {}) {
  await page.evaluate(`(() => {
    const s = document.getElementById(${JSON.stringify(startId)});
    if (s) s.focus(); else { document.body.focus(); document.activeElement && document.activeElement.blur(); }
  })(); true`);
  for (let i = 0; i < steps; i++) {
    await pressKey(cdp, page.sessionId, 'Tab', { shift });
    const hit = await page.evaluate(`(() => { const el = document.activeElement;
      return el && (${testExpr}) ? (el.id || el.tagName) : null; })()`);
    if (hit) return hit;
  }
  return null;
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

/* ===================== 第13回監査（v1.8.12）の反例 ===================== */

/* 語が実際に描かれている場所だけへ注記する（RG-13-01）。
   隠れている側と、後ろの読める側に同じ語を置く。落としすぎの対照も並べる。 */
export const PAINT_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>paint</title><style>
  .clipbox{position:relative;width:120px;height:40px}
  .out{position:absolute;left:160px;top:5px;white-space:nowrap}
  .scroller{width:120px;height:40px;overflow:auto}
  .tall{height:400px}
</style></head><body>
  <a href="#" id="before">before</a>
  <div id="h-ovh"><div class="clipbox" style="overflow:hidden"><span class="out">A branch away.</span></div></div>
  <p id="l-ovh">A branch later.</p>
  <div id="h-ovc"><div class="clipbox" style="overflow:clip"><span class="out">A commit away.</span></div></div>
  <p id="l-ovc">A commit later.</p>
  <div id="h-cpi"><div class="clipbox" style="width:240px;clip-path:inset(0 120px 0 0)"><span class="out" style="left:150px">A merge away.</span></div></div>
  <p id="l-cpi">A merge later.</p>
  <div id="h-flt" style="filter:opacity(0)">A fetch away.</div>
  <p id="l-flt">A fetch later.</p>
  <div id="h-trs" style="transform:scale(0)">A rebase away.</div>
  <p id="l-trs">A rebase later.</p>
  <div id="h-msk" style="mask-image:linear-gradient(transparent,transparent);-webkit-mask-image:linear-gradient(transparent,transparent)">A webhook away.</div>
  <p id="l-msk">A webhook later.</p>
  <!-- ここから下は「落としてはいけない」対照 -->
  <div id="h-neg" style="position:relative;width:1px;height:1px;overflow:visible;white-space:nowrap;clip-path:inset(-100px)">A token painted.</div>
  <p id="l-neg">A token later.</p>
  <div id="h-part"><div class="clipbox" style="overflow:hidden;width:400px"><span class="out" style="left:20px">A wiki partly.</span></div></div>
  <p id="l-part">A wiki later.</p>
  <!-- 絶対配置は、包含ブロックでない祖先の切り取りからは逃げる -->
  <div id="h-esc" style="position:static;width:120px;height:40px;overflow:hidden">
    <span style="position:absolute;left:400px;top:0;white-space:nowrap">A release escaped.</span></div>
  <p id="l-esc">A release later.</p>
  <!-- スクロールできる領域の画面外は、読めるので落とさない -->
  <div id="h-scr" class="scroller"><div class="tall"><p style="margin-top:300px">A milestone below.</p></div></div>
  <p id="l-scr">A milestone later.</p>
</body></html>`;

/* 生成した印の生命周期（RG-13-04） */
export const SIGNATURE13_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>sig13</title></head><body>
  <a href="#" id="before">before</a>
  <p id="clone-src">A milestone first.</p>
  <div id="sink"></div>
  <span id="page-data" data-iiyaku-key="fetch" data-iiyaku="PLACEHOLDER">PAGE DATA</span>
  <div id="page-tip" class="iiyaku-tooltip" data-iiyaku-owner="page">PAGE TOOLTIP</div>
  <div id="page-toggle" class="iiyaku-toggle" data-iiyaku-owner="page">PAGE TOGGLE</div>
</body></html>`;

/* CSS だけで短時間ひらくメニュー（RG-13-02） */
