// ストアへ出すファイルだけを dist/ へ並べ、1件ずつの大きさと SHA-256 を記録する。
//   node scripts/package-stage.mjs           … 並べ直す
//   node scripts/package-stage.mjs --verify  … 並べたものが今の中身と一致するか確かめる
//
// ZIP 自体はここでは作らない。ZIP の作り方と、作った後にハッシュを控える手順は
// 最後に表示する。dist/ は Git の管理外（.gitignore）。
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, cpSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { PACKAGE_FILES } from './package-files.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERIFY_ONLY = process.argv.includes('--verify');
const version = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8')).version;
const DIST = join(ROOT, 'dist');
const STAGE = join(DIST, `repogloss-${version}`);
const LIST = join(DIST, `repogloss-${version}.files.json`);   // 拡張の中には置かない

const sha256 = buf => createHash('sha256').update(buf).digest('hex');

function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, base));
    // 区切りは / に揃える。Windows は \ を返すので、配布一覧と突き合わない。
    else out.push(relative(base, p).split(sep).join('/'));
  }
  return out;
}

function describe(dirPath) {
  return walk(dirPath).sort().map(rel => {
    const buf = readFileSync(join(dirPath, rel));
    return { path: rel, bytes: buf.length, sha256: sha256(buf) };
  });
}

if (VERIFY_ONLY) {
  if (!existsSync(STAGE)) {
    console.error(`NG: ${relative(ROOT, STAGE)} がない。先に npm run package:stage を実行する`);
    process.exit(1);
  }
  const staged = describe(STAGE);
  const problems = [];
  const extra = staged.map(f => f.path).filter(p => !PACKAGE_FILES.includes(p));
  if (extra.length) problems.push(`配布一覧に無いファイルが混ざっている: ${extra.join(', ')}`);
  for (const rel of PACKAGE_FILES) {
    const s = staged.find(f => f.path === rel);
    if (!s) { problems.push(`並べたものに ${rel} が無い`); continue; }
    const now = sha256(readFileSync(join(ROOT, rel)));
    if (now !== s.sha256) problems.push(`${rel} が並べた後に変わっている`);
  }
  if (problems.length) {
    console.error(`NG: ${problems.length} 件\n` + problems.map(p => '  - ' + p).join('\n'));
    process.exit(1);
  }
  const combined = sha256(Buffer.from(staged.map(f => `${f.path} ${f.sha256}`).join('\n')));
  console.log(`OK: ${staged.length} ファイルが配布一覧と一致（version ${version}）`);
  console.log(`COMBINED_SHA256 ${combined}`);
  process.exit(0);
}

// 毎回作り直す。前回の残りが混ざると、余分なファイルごと ZIP にしてしまう。
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
for (const rel of PACKAGE_FILES) {
  const src = join(ROOT, rel);
  if (!existsSync(src)) { console.error(`NG: 配布対象の ${rel} が無い`); process.exit(1); }
  mkdirSync(dirname(join(STAGE, rel)), { recursive: true });
  cpSync(src, join(STAGE, rel));
}

const staged = describe(STAGE);
const extra = staged.map(f => f.path).filter(p => !PACKAGE_FILES.includes(p));
if (extra.length) { console.error(`NG: 余計なファイルがある: ${extra.join(', ')}`); process.exit(1); }
if (staged.length !== PACKAGE_FILES.length) {
  console.error(`NG: ${PACKAGE_FILES.length} 件のはずが ${staged.length} 件`);
  process.exit(1);
}

const HASH_FILE = join(DIST, 'COMBINED_SHA256.txt');

const total = staged.reduce((n, f) => n + f.bytes, 0);
// 配布物全体を1つの値にまとめる。OS をまたいで同じかどうかを1行で比べられる。
// 改行が OS で揺れると、ここが変わる（.gitattributes で揃えている）。
const combined = sha256(Buffer.from(staged.map(f => `${f.path} ${f.sha256}`).join('\n')));
writeFileSync(LIST, JSON.stringify({ version, files: staged, totalBytes: total, combinedSha256: combined }, null, 2) + '\n');
// CI が OS 間で突き合わせるための1行。ログを shell で切り出すと OS ごとに
// 書き方が変わるので、ファイルへ出しておく（改行は \n に固定する）。
writeFileSync(HASH_FILE, combined + '\n');

console.log(`並べた: ${relative(ROOT, STAGE)}`);
console.log(`  ${staged.length} ファイル / 合計 ${total.toLocaleString()} バイト`);
console.log(`  1件ずつの大きさとハッシュ: ${relative(ROOT, LIST)}`);
console.log(`COMBINED_SHA256 ${combined}`);   // CI が OS 間で突き合わせるための1行
console.log('');
console.log('ZIP にするとき（拡張の中身が最上位に来るように、フォルダの中で固める）:');
console.log(`  cd ${relative(ROOT, STAGE)} && zip -r -X ../repogloss-${version}.zip . && cd -`);
console.log(`  shasum -a256 dist/repogloss-${version}.zip   # 控えて STORE_LISTING へ書く`);
