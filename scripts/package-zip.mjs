// ストアへ出す ZIP を作り、作ったものを開き直して中身を確かめる。
//   node scripts/package-zip.mjs           … 作る（作った直後に検査もする）
//   node scripts/package-zip.mjs --verify  … 既にある ZIP を検査するだけ
//
// 警告では止めない。合わなければ終了コードを 0 以外にして落とす。
// 逃げ道は --allow-uncommitted だけで、その場合はファイル名へ UNCOMMITTED が入る
// （提出物と取り違えられないようにするため）。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { PACKAGE_FILES } from './package-files.mjs';
import { writeZip } from './zip.mjs';
import { verifyZipBuffer } from './verify-zip.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERIFY_ONLY = process.argv.includes('--verify');
const ALLOW_DIRTY = process.argv.includes('--allow-uncommitted');
const sha256 = buf => createHash('sha256').update(buf).digest('hex');

const version = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8')).version;

/* 作業ツリーと HEAD が食い違っていないか。食い違ったまま提出物を作らない。 */
function dirtyFiles() {
  try {
    const out = execFileSync('git', ['-C', ROOT, 'status', '--porcelain', '--', ...PACKAGE_FILES],
      { encoding: 'utf8' });
    return out.split('\n').map(l => l.slice(3).trim()).filter(Boolean);
  } catch (e) {
    return null;   // git が無い／リポジトリでない
  }
}

const dirty = dirtyFiles();
const suffix = dirty && dirty.length ? '-UNCOMMITTED' : '';
const zipName = `repogloss-${version}${suffix}.zip`;
const DIST = join(ROOT, 'dist');
const zipPath = join(DIST, zipName);

if (!VERIFY_ONLY) {
  if (dirty === null) {
    console.error('NG: git で作業ツリーの状態を確認できない。提出物は commit 済みの内容から作る');
    process.exit(1);
  }
  if (dirty.length && !ALLOW_DIRTY) {
    console.error(`NG: 配布対象に commit していない変更がある（${dirty.length} 件）`);
    for (const f of dirty) console.error('  - ' + f);
    console.error('提出用に作るなら先に commit する。試すだけなら --allow-uncommitted を付ける');
    process.exit(1);
  }
  if (dirty.length) {
    console.log(`※ commit していない変更が ${dirty.length} 件あるため、UNCOMMITTED 付きの名前で作る`);
  }

  const entries = [];
  for (const rel of PACKAGE_FILES) {
    const src = join(ROOT, rel);
    if (!existsSync(src)) { console.error(`NG: 配布対象の ${rel} が無い`); process.exit(1); }
    entries.push({ name: rel, data: readFileSync(src) });
  }
  mkdirSync(DIST, { recursive: true });
  writeFileSync(zipPath, writeZip(entries));
  console.log(`作った: ${relative(ROOT, zipPath)}`);
}

if (!existsSync(zipPath)) {
  console.error(`NG: ${relative(ROOT, zipPath)} が無い。先に npm run package:zip を実行する`);
  process.exit(1);
}

const raw = readFileSync(zipPath);
const { problems, names, contentSha } = verifyZipBuffer(raw, { version, root: ROOT });

if (problems.length) {
  console.error(`NG: ${problems.length} 件\n` + problems.map(p => '  - ' + p).join('\n'));
  process.exit(1);
}

// 提出物の身元を1つのファイルにまとめておく。報告や CI の成果物へそのまま添える。
writeFileSync(join(DIST, `${zipName}.json`), JSON.stringify({
  name: zipName, version, bytes: raw.length, fileCount: names.length,
  sha256: sha256(raw), contentSha256: contentSha, files: names
}, null, 2) + '\n');

console.log(`OK: ${names.length} ファイル / ${raw.length.toLocaleString()} バイト（version ${version}）`);
console.log(`ZIP_NAME        ${zipName}`);
console.log(`ZIP_BYTES       ${raw.length}`);
console.log(`ZIP_FILE_COUNT  ${names.length}`);
console.log(`ZIP_SHA256      ${sha256(raw)}`);
console.log(`ZIP_CONTENT_SHA ${contentSha}`);
