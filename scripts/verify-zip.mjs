// 提出用 ZIP の中身を検査する。落ちる条件をテストから直接ぶつけられるよう、
// ファイルの読み書きから切り離し、見つけた問題の一覧を返すだけにしてある。
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PACKAGE_FILES } from './package-files.mjs';
import { readZip } from './zip.mjs';

const sha256 = buf => createHash('sha256').update(buf).digest('hex');

// 配布物として入っていてはいけないもの。配布一覧の突き合わせとは別に持つ
// （一覧そのものへ誤って足してしまった場合に、こちらで止めるため）。
const FORBIDDEN = /(^|\/)(\.git|node_modules|tests?|scripts|\.github)\//i;
const SECRETISH = /(^|\/)(\.env|.*\.pem|.*\.key|.*\.p12|.*\.crx|package(-lock)?\.json)$/i;

/* root を渡さなければ、手元のファイルとの1件ずつの突き合わせは省く */
export function verifyZipBuffer(raw, { version = null, root = null } = {}) {
  const problems = [];
  const fail = msg => problems.push(msg);

  let entries;
  try {
    entries = readZip(raw);
  } catch (e) {
    return { problems: [`ZIP を読めない: ${e.message}`], names: [], contentSha: null };
  }
  const names = entries.map(e => e.name);

  // ① 入っているものが配布一覧と過不足なく一致するか
  const extra = names.filter(n => !PACKAGE_FILES.includes(n));
  const missing = PACKAGE_FILES.filter(n => !names.includes(n));
  if (extra.length) fail(`配布一覧に無いものが入っている: ${extra.join(', ')}`);
  if (missing.length) fail(`入っていないものがある: ${missing.join(', ')}`);
  if (names.length !== new Set(names).size) fail('同じ名前が二重に入っている');

  // ② 余分な親フォルダで包まれていないか（包むと Chrome が manifest を見つけられない）
  if (!names.includes('manifest.json')) fail('manifest.json が最上位に無い（親フォルダで包まれている疑い）');
  for (const n of names) {
    if (n.startsWith('/') || n.includes('..')) fail(`名前が不正: ${n}`);
    if (n.endsWith('/')) fail(`フォルダの項目が入っている: ${n}`);
  }

  // ③ 1件ずつ、今のファイルと1バイトも違わないか
  if (root) {
    for (const e of entries) {
      const src = join(root, e.name);
      if (!existsSync(src)) { fail(`${e.name} が手元に無く、突き合わせられない`); continue; }
      if (sha256(readFileSync(src)) !== sha256(e.data)) fail(`${e.name} の中身が今のファイルと違う`);
    }
  }

  // ④ ZIP の中の manifest が、リリースする version と一致するか
  const inZip = entries.find(e => e.name === 'manifest.json');
  if (inZip) {
    let mv = null;
    try { mv = JSON.parse(inZip.data.toString('utf8')).version; }
    catch (e) { fail('ZIP の中の manifest.json が JSON として読めない'); }
    if (mv && version && mv !== version) fail(`ZIP の中の version が ${mv}、手元は ${version}`);
  }

  // ⑤ 開発用・秘密らしきものが混ざっていないか
  for (const n of names) {
    if (FORBIDDEN.test(n)) fail(`開発用のものが入っている: ${n}`);
    if (SECRETISH.test(n)) fail(`配布してはいけない種類のファイル: ${n}`);
  }

  // 中身だけを1つの値にまとめる。ZIP の器のバイト列ではなく、入っているものを比べる。
  const contentSha = sha256(Buffer.from(
    entries.map(e => `${e.name} ${sha256(e.data)}`).join('\n')));
  return { problems, names, contentSha, entries };
}
