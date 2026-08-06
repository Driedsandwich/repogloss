// リポジトリの整合を機械で確かめる。依存なしで動く。
//   node scripts/verify.mjs
// 目的は「文書に書いた数字・権限・ファイル構成が、実物とずれていないこと」の確認。
// 落ちたときは、直すべき場所が分かる形で出す。
//
// 権限まわりは「増えていないこと」ではなく「この形と完全に同じこと」を見る。
// 増分だけを見ると、2つ目の content_scripts を足すような広げ方に気づけない。
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { PACKAGE_FILES } from './package-files.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(ROOT, p), 'utf8');
const readJson = p => JSON.parse(read(p));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

let checks = 0;
const failures = [];
function check(label, condition, detail = '') {
  checks++;
  if (condition) return true;
  failures.push(detail ? `${label} — ${detail}` : label);
  return false;
}

/* ---------- manifest：形を丸ごと固定する ---------- */
const manifest = readJson('manifest.json');

// 増やすときは、ここと文書と審査の申告を同時に直す、と決めておく
const ALLOWED_TOP_KEYS = [
  'manifest_version', 'name', 'version', 'description',
  'permissions', 'action', 'icons', 'content_scripts', 'web_accessible_resources'
];
const ALLOWED_PERMISSIONS = ['storage'];
const ALLOWED_MATCHES = ['https://github.com/*'];
const ALLOWED_JS = ['src/matcher.js', 'src/content.js'];
const ALLOWED_CSS = ['styles.css'];
const ALLOWED_WAR_RESOURCES = ['locales/dict.json'];

check('manifest: Manifest V3', manifest.manifest_version === 3, `manifest_version=${manifest.manifest_version}`);
check('manifest: version が x.y.z', /^\d+\.\d+\.\d+$/.test(manifest.version), `version=${manifest.version}`);
const extraKeys = Object.keys(manifest).filter(k => !ALLOWED_TOP_KEYS.includes(k));
check('manifest: 想定外の項目が無い', extraKeys.length === 0, `増えた項目: ${extraKeys.join(', ')}`);
check('manifest: permissions は storage だけ', eq(manifest.permissions, ALLOWED_PERMISSIONS), `permissions=${JSON.stringify(manifest.permissions)}`);
check('manifest: host_permissions を持たない', !manifest.host_permissions);
check('manifest: optional_permissions を持たない', !manifest.optional_permissions);
check('manifest: optional_host_permissions を持たない', !manifest.optional_host_permissions);
check('manifest: background（常駐処理）を持たない', !manifest.background);
check('manifest: externally_connectable を持たない', !manifest.externally_connectable);
check('manifest: content_security_policy を持たない', !manifest.content_security_policy);

check('manifest: content_scripts はちょうど1つ', (manifest.content_scripts ?? []).length === 1,
  `件数=${(manifest.content_scripts ?? []).length}`);
const cs = manifest.content_scripts?.[0] ?? {};
check('manifest: content_scripts の対象は https の github.com だけ', eq(cs.matches, ALLOWED_MATCHES), `matches=${JSON.stringify(cs.matches)}`);
check('manifest: 読み込む JS が想定どおり（matcher.js が先）', eq(cs.js, ALLOWED_JS), `js=${JSON.stringify(cs.js)}`);
check('manifest: 読み込む CSS が想定どおり', eq(cs.css, ALLOWED_CSS), `css=${JSON.stringify(cs.css)}`);
check('manifest: content_scripts に想定外の設定が無い',
  Object.keys(cs).every(k => ['matches', 'js', 'css'].includes(k)),
  `項目=${Object.keys(cs).join(', ')}`);

const war = manifest.web_accessible_resources ?? [];
check('manifest: web_accessible_resources はちょうど1つ', war.length === 1, `件数=${war.length}`);
check('manifest: 公開する同梱ファイルは辞書だけ', eq(war[0]?.resources, ALLOWED_WAR_RESOURCES), `resources=${JSON.stringify(war[0]?.resources)}`);
check('manifest: 公開先も https の github.com だけ', eq(war[0]?.matches, ALLOWED_MATCHES), `matches=${JSON.stringify(war[0]?.matches)}`);

/* ---------- 参照ファイルの実在 ---------- */
const referenced = [
  ...(cs.js ?? []),
  ...(cs.css ?? []),
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
  ...war.flatMap(w => w.resources ?? [])
];
for (const f of referenced) {
  check(`manifest が参照する ${f} が実在する`, existsSync(join(ROOT, f)));
  check(`manifest が参照する ${f} が配布物の一覧に入っている`, PACKAGE_FILES.includes(f));
}

/* ---------- 配布物の一覧 ---------- */
for (const f of PACKAGE_FILES) check(`配布対象の ${f} が実在する`, existsSync(join(ROOT, f)));

/* ---------- 配布する JS 全部に、危ない書き方と外部通信が無いか ---------- */
// content.js だけを見ていると、2つ目の JS を足したときに素通りする。
const DANGEROUS = [
  [/\beval\s*\(/, 'eval'],
  [/new\s+Function\s*\(/, 'new Function'],
  [/\.innerHTML\b/, 'innerHTML'],
  [/\.outerHTML\b/, 'outerHTML'],
  [/insertAdjacentHTML/, 'insertAdjacentHTML'],
  [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
  [/\bWebSocket\b/, 'WebSocket'],
  [/\bEventSource\b/, 'EventSource'],
  [/sendBeacon/, 'sendBeacon'],
  [/\bimportScripts\s*\(/, 'importScripts']
];
const stripComments = s => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
for (const f of PACKAGE_FILES.filter(p => extname(p) === '.js')) {
  const body = stripComments(read(f));
  for (const [re, name] of DANGEROUS) {
    check(`${f} が ${name} を使っていない`, !re.test(body));
  }
  // 拡張の外へ出る URL が無いこと。github.com は説明用の記述にだけ出る。
  const urls = [...body.matchAll(/https?:\/\/[^\s'"`)]+/g)].map(m => m[0]);
  check(`${f} に外部の URL が埋め込まれていない`, urls.length === 0, urls.join(', '));
  // fetch は同梱辞書の読み込み1か所だけ
  const fetches = [...body.matchAll(/\bfetch\s*\(([^)]*)/g)].map(m => m[1].trim());
  const badFetch = fetches.filter(a => a !== 'DICT_URL');
  check(`${f} の fetch は同梱辞書の読み込みだけ`, badFetch.length === 0, badFetch.join(' / '));
}

/* ---------- 編集領域を触らない仕掛けが入っているか ---------- */
// 実際の保証は E2E（tests/e2e）で行う。ここは「消えていないこと」の見張り。
const content = read('src/content.js');
check('content.js が編集可能な領域を走査対象から外している',
  /contenteditable\]:not\(\[contenteditable="false"\]\)/.test(content));
check('content.js が入力欄も走査対象から外している', /'textarea', 'input', 'select'/.test(content));
check('content.js が inert の中も走査対象から外している', /'\[inert\]'/.test(content));

/* ---------- 除外を決める前に、テキストの中身を読まないこと（補助の検査） ---------- */
// 「書き換えない」と「読み取らない」は別のこと。除外対象（編集領域・フォーム・
// コード・aria-hidden・inert・hidden）の文字列は、除外が決まる前に取り出してはいけない。
//
// ⚠️ これは**補助**にすぎない。見ているのは isTarget の中の文字位置だけなので、
// 別名の変数・補助関数・bracket 記法・分割代入などを使えば迂回できる。
// **本命の担保は tests/e2e の「除外する領域のテキストを、拡張が一度も読んでいない」**
// で、同じ拡張の content script として計測用の prelude を先に読み込ませ、
// 隔離された世界の中で実際に読まれた回数を数えている。
// ここは、単純な後戻りを早く止めるためのものである。
{
  const m = content.match(/function isTarget\(node\)\s*\{([\s\S]*?)\n  \}/);
  check('content.js に isTarget がある', !!m);
  if (m) {
    const body = m[1];
    const skipAt = body.indexOf('closest(SKIP)');
    const valueAt = Math.min(
      ...['node.nodeValue', 'node.data', 'node.textContent', 'node.wholeText']
        .map(t => { const i = body.indexOf(t); return i === -1 ? Infinity : i; })
    );
    check('isTarget が SKIP 判定より前にテキストの値を読んでいない',
      skipAt !== -1 && skipAt < valueAt,
      `SKIP の位置=${skipAt} / 値を読む位置=${valueAt === Infinity ? 'なし' : valueAt}`);
  }
}

/* ---------- 可視性の判定が祖先まで見ているか ---------- */
check('content.js が checkVisibility で祖先まで可視性を見ている',
  /checkVisibility\(/.test(content) && /opacityProperty/.test(content));
// contentVisibilityAuto を true で渡すと、画面外の content-visibility:auto まで
// 不可視扱いになり、長いページの下が永久に注記されなくなる（実測）。
// 判定はコメントを除いた本体で行う（説明文で名前に触れることはあるため）
check('content.js が contentVisibilityAuto を渡していない',
  !/contentVisibilityAuto/.test(stripComments(content)));
check('content.js が、付けた印の有効性を isConnected だけで判断していない',
  /function usableGloss/.test(content) && !/prev\s*&&\s*prev\.isConnected/.test(content));

/* ---------- テスト専用のものが配布物へ混ざっていないこと ---------- */
// 計測用の prelude は同じ拡張の content script として読み込ませるが、
// それは E2E が並べた一時ディレクトリの中だけの話。配布物には入れない。
check('計測用の prelude が配布一覧に入っていない',
  !PACKAGE_FILES.some(f => f.includes('prelude')));
check('manifest が読み込む JS に prelude が入っていない',
  !(cs.js ?? []).some(f => f.includes('prelude')));

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
const store = read('STORE_LISTING.md');
const count = keys.length;
check(`README の語数が辞書と一致する（辞書=${count}）`, readme.includes(`**${count} 語**`) || readme.includes(`${count} 語`), 'README に語数の記載が見つからない');
check(`DESIGN の語数が辞書と一致する（辞書=${count}）`, design.includes(`${count} 語`) || design.includes(`全 ${count} キー`));
// 変更履歴には過去の語数（151語・45語）が載る。現在の説明部分だけを見る。
const readmeNow = readme.split('## 変更履歴')[0];
const wrongCounts = [...readmeNow.matchAll(/(\d+)\s*語/g)].map(mm => Number(mm[1])).filter(n => n !== count && n > 20);
check('README の説明部分に、辞書と違う語数が残っていない', wrongCounts.length === 0, `見つかった数字: ${wrongCounts.join(', ')}`);
check(`README のバッジが manifest の version と一致する（${manifest.version}）`, readme.includes(`version-${manifest.version}-`));
check(`README の変更履歴に ${manifest.version} の行がある`, readme.includes(`| ${manifest.version} |`));
check(`STORE_LISTING が今回の提出版 ${manifest.version} を指している`, store.includes(manifest.version),
  'ストア掲載メモに現在のバージョンが出てこない');

// 「この版 vX.Y.Z」のような現在版の言い切りが、manifest と食い違ったまま残らないようにする。
// v1.8.3 では manifest が 1.8.3 なのに README が「この版 v1.8.2」と書いていた。
// 「manifest の版がどこかに在る」という検査では、この取り残しを見つけられない。
{
  const stale = [...readme.matchAll(/この版\s*v?(\d+\.\d+\.\d+)/g)]
    .map(mm => mm[1]).filter(v => v !== manifest.version);
  check('README の「この版 …」が manifest の版と一致する', stale.length === 0,
    `古い版の記載: ${stale.join(', ')}`);
}

// Limited Use への準拠を明言する文が、公開されるプライバシーポリシーに在ること。
// 公式ポリシーが、拡張のサイトかプライバシーポリシーへ置くことを求めている。
{
  const privacy = read('PRIVACY.md');
  check('PRIVACY.md に Limited Use 準拠の明言がある（日本語）',
    /Chrome Web Store User Data Policy/.test(privacy) && /Limited Use/.test(privacy));
  check('PRIVACY.md に Limited Use 準拠の明言がある（英語）',
    /adhere to the Chrome Web Store User Data Policy/.test(privacy));
  check('PRIVACY.md が公式ポリシーへのリンクを持つ',
    privacy.includes('developer.chrome.com/docs/webstore/program-policies/limited-use'));
  // 走査は広いので、「個人情報を読み取らない」という言い切りは事実と合わない
  check('PRIVACY.md に、個人情報を一切読まないという言い切りが無い',
    !/(氏名・メール・ID のいずれも読み取らず|個人的な通信内容は一切読)/.test(privacy));
}

// CI が提出用 ZIP を作ることを、README が伏せていないこと
check('README が CI の成果物（提出用 ZIP）について書いている',
  /artifact/.test(readme) && /提出用 ZIP/.test(readme));

/* ---------- 監査資料が、現在の版を指しているか ---------- */
// 版を上げたのに監査資料が前の版のままだと、監査側が別のものを読む。
// commit SHA や CI run ID は commit 後にしか決まらないので、ここでは
// 「版」と「準備段階の言い切り」だけを見る。
{
  const audit = read('AUDIT.md');
  const v = manifest.version;
  check(`AUDIT.md が現在の版 ${v} を指している`, audit.includes(v),
    'AUDIT.md に現在のバージョンが出てこない');
  // 再現手順が古い版を checkout していないか
  const co = [...audit.matchAll(/git checkout (v\d+\.\d+\.\d+)/g)].map(m => m[1]);
  const staleCo = co.filter(t => t !== `v${v}`);
  check('AUDIT.md の再現手順が現在の版を checkout している', staleCo.length === 0,
    `古い版: ${staleCo.join(', ')}`);
  // 変更記録に、準備段階の言い切りが残っていないか
  const changes = existsSync(join(ROOT, `docs/audit/v${v}-changes.md`))
    ? read(`docs/audit/v${v}-changes.md`) : '';
  check(`docs/audit/v${v}-changes.md がある`, changes.length > 0);
  // 見るのは冒頭の「いまどういう状態か」を書く部分だけ。
  // 後ろの本文では、過去の版の記述を直した経緯として同じ言葉を引用することがある
  // （実際に誤検出した）。状態の宣言と、経緯の説明を区別する。
  const head = changes.split('\n---')[0];
  const prep = ['まだ commit していない', 'タグも成果物も無い']
    .filter(w => head.includes(w));
  check('変更記録の冒頭に、準備段階の言い切りが残っていない', prep.length === 0,
    `残っている表現: ${prep.join(' / ')}`);
}

/* ---------- 権限の説明が文書間でそろっているか ---------- */
// 「storage のみ」と書くと、github.com のページ本文を読むことが伝わらない。
for (const [name, body] of [['README.md', readme], ['PRIVACY.md', read('PRIVACY.md')], ['STORE_LISTING.md', store]]) {
  check(`${name} に古い対象サイトの書き方（*://）が残っていない`, !body.includes('*://github.com/*'));
  check(`${name} が API 権限とサイトアクセスを分けて書いている`,
    body.includes('サイトアクセス') && body.includes('https://github.com/*'));
}

/* ---------- CSS と JS のクラス名 ---------- */
const css = read('styles.css');
for (const cls of ['iiyaku-icon', 'iiyaku-toggle', 'iiyaku-tooltip', 'iiyaku-off']) {
  check(`CSS に .${cls} の定義がある`, css.includes(`.${cls}`));
  check(`content.js が ${cls} を使っている`, content.includes(cls));
}
check('content.js が保存キー iiyakuEnabled を変えていない', content.includes("'iiyakuEnabled'"));
check('ツールチップが狭い画面でも収まる指定を持つ',
  /max-width:\s*min\(/.test(css) && /box-sizing:\s*border-box/.test(css.split('.iiyaku-tooltip {')[1] ?? ''));

/* ---------- 結果 ---------- */
const label = `${checks} 件を検査`;
if (failures.length > 0) {
  console.error(`NG: ${label} — ${failures.length} 件が不一致\n`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`OK: ${label}・不一致 0 件（辞書 ${count} 語 / version ${manifest.version}）`);
