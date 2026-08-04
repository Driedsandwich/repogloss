// リポジトリの整合を機械で確かめる。依存なしで動く。
//   node scripts/verify.mjs
// 目的は「文書に書いた数字・権限・ファイル構成が、実物とずれていないこと」の確認。
// 落ちたときは、直すべき場所が分かる形で出す。
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PACKAGE_FILES } from './package-files.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(ROOT, p), 'utf8');
const readJson = p => JSON.parse(read(p));

let checks = 0;
const failures = [];
function check(label, condition, detail = '') {
  checks++;
  if (condition) return true;
  failures.push(detail ? `${label} — ${detail}` : label);
  return false;
}

/* ---------- manifest ---------- */
const manifest = readJson('manifest.json');
check('manifest: Manifest V3', manifest.manifest_version === 3, `manifest_version=${manifest.manifest_version}`);
check('manifest: version が x.y.z', /^\d+\.\d+\.\d+$/.test(manifest.version), `version=${manifest.version}`);

// 権限は増やさない。増やすときはここを意図的に書き換える（審査と説明文の同時更新が要る）。
const ALLOWED_PERMISSIONS = ['storage'];
const ALLOWED_MATCHES = ['https://github.com/*'];
check(
  'manifest: permissions は storage だけ',
  JSON.stringify(manifest.permissions) === JSON.stringify(ALLOWED_PERMISSIONS),
  `permissions=${JSON.stringify(manifest.permissions)}`
);
check('manifest: host_permissions を持たない', !manifest.host_permissions);
check('manifest: optional_permissions を持たない', !manifest.optional_permissions);
check('manifest: background（常駐処理）を持たない', !manifest.background);

const cs = manifest.content_scripts?.[0] ?? {};
check(
  'manifest: content_scripts の対象は https の github.com だけ',
  JSON.stringify(cs.matches) === JSON.stringify(ALLOWED_MATCHES),
  `matches=${JSON.stringify(cs.matches)}`
);
for (const war of manifest.web_accessible_resources ?? []) {
  check(
    'manifest: web_accessible_resources の対象も https の github.com だけ',
    JSON.stringify(war.matches) === JSON.stringify(ALLOWED_MATCHES),
    `matches=${JSON.stringify(war.matches)}`
  );
}

/* ---------- 参照ファイルの実在 ---------- */
const referenced = [
  ...(cs.js ?? []),
  ...(cs.css ?? []),
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
  ...(manifest.web_accessible_resources ?? []).flatMap(w => w.resources ?? [])
];
for (const f of referenced) {
  check(`manifest が参照する ${f} が実在する`, existsSync(join(ROOT, f)));
}
check('manifest: matcher.js が content.js より先に読み込まれる',
  (cs.js ?? []).indexOf('src/matcher.js') === 0,
  `js=${JSON.stringify(cs.js)}`);

/* ---------- 配布物の一覧 ---------- */
for (const f of PACKAGE_FILES) check(`配布対象の ${f} が実在する`, existsSync(join(ROOT, f)));
// manifest が参照するものが、配布物の一覧から漏れていないか（漏れると壊れた ZIP を出す）
for (const f of referenced) {
  check(`manifest が参照する ${f} が配布物の一覧に入っている`, PACKAGE_FILES.includes(f));
}

/* ---------- 辞書 ---------- */
const dict = readJson('locales/dict.json');
const keys = Object.keys(dict);
const norm = s => s.trim().toLowerCase().replace(/\s+/g, ' ');
const badKeys = keys.filter(k => k !== norm(k));
check('辞書: キーが小文字・前後空白なしで正規化されている', badKeys.length === 0, badKeys.join(', '));
const dupes = keys.filter((k, i) => keys.indexOf(norm(k)) !== i && keys.indexOf(norm(k)) !== -1 && keys.indexOf(norm(k)) < i);
check('辞書: 正規化すると重なるキーがない', dupes.length === 0, dupes.join(', '));
const emptyValues = keys.filter(k => typeof dict[k] !== 'string' || dict[k].trim() === '');
check('辞書: 説明が空の項目がない', emptyValues.length === 0, emptyValues.join(', '));
const tooShort = keys.filter(k => dict[k].trim().length < 20);
check('辞書: 説明が極端に短い項目がない（20字以上）', tooShort.length === 0, tooShort.join(', '));

/* ---------- 文書と実物の数字を合わせる ---------- */
const readme = read('README.md');
const design = read('DESIGN.md');
const count = keys.length;
check(`README の語数が辞書と一致する（辞書=${count}）`, readme.includes(`**${count} 語**`) || readme.includes(`${count} 語`), 'README に語数の記載が見つからない');
check(`DESIGN の語数が辞書と一致する（辞書=${count}）`, design.includes(`${count} 語`) || design.includes(`全 ${count} キー`));
// 変更履歴には過去の語数（151語・45語）が載る。現在の説明部分だけを見る。
const readmeNow = readme.split('## 変更履歴')[0];
const wrongCounts = [...readmeNow.matchAll(/(\d+)\s*語/g)].map(mm => Number(mm[1])).filter(n => n !== count && n > 20);
check('README の説明部分に、辞書と違う語数が残っていない', wrongCounts.length === 0, `見つかった数字: ${wrongCounts.join(', ')}`);
check(`README のバッジが manifest の version と一致する（${manifest.version}）`, readme.includes(`version-${manifest.version}-`));
check(`README の変更履歴に ${manifest.version} の行がある`, readme.includes(`| ${manifest.version} |`));

/* ---------- CSS と JS のクラス名 ---------- */
const css = read('styles.css');
const content = read('src/content.js');
for (const cls of ['iiyaku-icon', 'iiyaku-toggle', 'iiyaku-tooltip', 'iiyaku-off']) {
  check(`CSS に .${cls} の定義がある`, css.includes(`.${cls}`));
  check(`content.js が ${cls} を使っている`, content.includes(cls));
}
check('content.js が保存キー iiyakuEnabled を変えていない', content.includes("'iiyakuEnabled'"));
check('content.js に外部への通信がない', !/https?:\/\/(?!github\.com)/.test(content.replace(/^\s*\/\/.*$/gm, '')), '拡張の外へ出る URL が含まれている');
check('content.js が eval / new Function / innerHTML を使っていない',
  !/\beval\s*\(|new\s+Function\s*\(|innerHTML|insertAdjacentHTML|outerHTML/.test(content));

/* ---------- 結果 ---------- */
const label = `${checks} 件を検査`;
if (failures.length > 0) {
  console.error(`NG: ${label} — ${failures.length} 件が不一致\n`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`OK: ${label}・不一致 0 件（辞書 ${count} 語 / version ${manifest.version}）`);
