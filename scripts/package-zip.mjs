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

/* いま作っている中身が、どのコミットのものか（CI の外で作ったときの記録用） */
function gitRev() {
  try {
    return execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch (e) {
    return null;
  }
}

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
// どのコミットの、どの実行から出たものかを、この1枚だけで特定できるようにする
// （成果物だけ手元に残ったときに出どころを追えないと、提出物を取り違える）。
//
// **作るときだけ書く。** 検査のときに書き直してはいけない。CI が作った成果物を
// 別の環境で検証すると、正本に入っている CI の run・commit・環境の記録が、
// 検証した側のローカル情報へ置き換わってしまう（実測で再現した）。
const env = process.env;
const PROVENANCE = join(DIST, `${zipName}.json`);
const provenance = {
  name: zipName, version, bytes: raw.length, fileCount: names.length,
  sha256: sha256(raw), contentSha256: contentSha, files: names,
  source: {
    repository: env.GITHUB_REPOSITORY ?? null,
    commit: env.GITHUB_SHA ?? gitRev(),
    ref: env.GITHUB_REF ?? null,
    workflowRunId: env.GITHUB_RUN_ID ?? null,
    workflowRunAttempt: env.GITHUB_RUN_ATTEMPT ?? null,
    builtInCI: !!env.GITHUB_RUN_ID
  },
  // deflate の出力は zlib の版に依存しうる。将来ハッシュが変わったときに
  // 「何が違ったのか」を後から言えるよう、作った環境を残す。
  environment: {
    node: process.versions.node,
    zlib: process.versions.zlib ?? null,
    platform: process.platform
  }
};

if (VERIFY_ONLY) {
  // 検査だけ。正本には触れず、記録が実物と合っているかを確かめる。
  if (!existsSync(PROVENANCE)) {
    console.error(`NG: 正本の身元ファイルが無い: ${relative(ROOT, PROVENANCE)}`);
    console.error('提出物の検証では、どの実行から出たものか分からない ZIP を通さない');
    process.exit(1);
  }
  let rec;
  try { rec = JSON.parse(readFileSync(PROVENANCE, 'utf8')); }
  catch (e) { console.error(`NG: 身元ファイルが JSON として読めない: ${e.message}`); process.exit(1); }
  const mismatch = [];
  if (rec.sha256 !== provenance.sha256) mismatch.push(`ZIP の SHA-256（記録 ${rec.sha256} / 実物 ${provenance.sha256}）`);
  if (rec.contentSha256 !== provenance.contentSha256) mismatch.push('中身の合算ハッシュ');
  if (rec.version !== provenance.version) mismatch.push(`version（記録 ${rec.version} / 実物 ${provenance.version}）`);
  if (rec.bytes !== provenance.bytes) mismatch.push(`大きさ（記録 ${rec.bytes} / 実物 ${provenance.bytes}）`);
  if (rec.fileCount !== provenance.fileCount) mismatch.push('ファイル数');
  if (JSON.stringify(rec.files) !== JSON.stringify(provenance.files)) mismatch.push('ファイルの一覧');
  // 出どころは、記録側だけが知っている（別環境で検証するときは env が空になる）。
  // 今の HEAD と食い違っていたら、別のコミットの成果物を見ている可能性がある。
  const here = provenance.source.commit;
  if (rec.source && rec.source.commit && here && rec.source.commit !== here) {
    mismatch.push(`出どころのコミット（記録 ${rec.source.commit} / いまの HEAD ${here}）`);
  }
  if (mismatch.length) {
    console.error(`NG: 正本の記録と実物が食い違う\n` + mismatch.map(m => '  - ' + m).join('\n'));
    process.exit(1);
  }
  // ローカルで検証した記録を残したい場合は、正本と別の名前へ出す
  writeFileSync(join(DIST, `${zipName}.verified-local.json`),
    JSON.stringify({ verifiedAt: 'local', ...provenance }, null, 2) + '\n');
} else {
  writeFileSync(PROVENANCE, JSON.stringify(provenance, null, 2) + '\n');
}

console.log(`OK: ${names.length} ファイル / ${raw.length.toLocaleString()} バイト（version ${version}）`);
console.log(`ZIP_NAME        ${zipName}`);
console.log(`ZIP_BYTES       ${raw.length}`);
console.log(`ZIP_FILE_COUNT  ${names.length}`);
console.log(`ZIP_SHA256      ${sha256(raw)}`);
console.log(`ZIP_CONTENT_SHA ${contentSha}`);
