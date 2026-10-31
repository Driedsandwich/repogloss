// 辞書（locales/dict.json）と見た目（styles.css）を、content script として読み込める
// JS（src/dict.js・src/styles.js）へ写す。正本は元の2ファイルで、写しは手で直さない。
//
// web_accessible_resources から fetch していた頃は、ページ側のスクリプトも
// chrome-extension://<ID>/styles.css を読めて、拡張の有無と版が分かった。
// content_scripts の JS は隔離された世界で動くので、ページからは読めない。
//
//   node scripts/embed-assets.mjs           … 写しを作り直す
//   node scripts/embed-assets.mjs --check   … 写しが正本と一致するかだけを見る
// verify も同じ突き合わせを行う（写しの作り直し忘れで落ちる）。
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const HEADER = src =>
  `// 自動生成。手で直さない。正本は ${src}（作り直しは node scripts/embed-assets.mjs）。\n`;

// テンプレートリテラルの中で意味を持つ3つだけを逃がす
const asTemplate = s => s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

export function embeddedFiles(root = ROOT) {
  const dict = JSON.parse(readFileSync(join(root, 'locales/dict.json'), 'utf8'));
  const css = readFileSync(join(root, 'styles.css'), 'utf8');
  return {
    'src/dict.js': HEADER('locales/dict.json') +
      `globalThis.RepoGlossDict = ${JSON.stringify(dict, null, 2)};\n`,
    'src/styles.js': HEADER('styles.css') +
      `globalThis.RepoGlossCss = \`${asTemplate(css)}\`;\n`
  };
}

// 写しが正本と食い違っている（または無い）ものの一覧。空なら一致。
// 梱包の入口（package-stage・package-zip）は、作るときも検査するときも最初にこれを呼び、
// 空でなければ止める。npm test を通さずに梱包だけを実行すると、正本だけを直して
// 写しを作り直し忘れたまま、古い辞書や見た目を詰められたため（2026-10-30 の点検 F03）。
export function staleCopies(root = ROOT) {
  const stale = [];
  for (const [rel, body] of Object.entries(embeddedFiles(root))) {
    let now = null;
    try { now = readFileSync(join(root, rel), 'utf8'); } catch (e) { /* 無い＝食い違い */ }
    if (now !== body) stale.push(rel);
  }
  return stale;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const check = process.argv.includes('--check');
  let stale = 0;
  for (const [rel, body] of Object.entries(embeddedFiles())) {
    const p = join(ROOT, rel);
    let now = null;
    try { now = readFileSync(p, 'utf8'); } catch (e) { /* 無ければ作る */ }
    if (now === body) continue;
    if (check) { console.error(`NG: ${rel} が正本と一致しない`); stale++; }
    else { writeFileSync(p, body); console.log(`書き直した: ${rel}`); }
  }
  if (stale) process.exit(1);
  if (check) console.log('OK: 写しは正本と一致');
}
