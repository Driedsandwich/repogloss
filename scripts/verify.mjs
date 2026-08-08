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
  'manifest_version', 'name', 'version', 'description', 'minimum_chrome_version',
  'permissions', 'action', 'icons', 'content_scripts', 'web_accessible_resources'
];
// 動作に必要な最低の Chrome。Element.checkVisibility が入った版。
// これが無い環境では、祖先の opacity と content-visibility を見抜けず、
// 見えない場所へ印が付く（実測: 8 つの場面のうち 2 つで逆の答えになった）。
const MIN_CHROME = '105';
const ALLOWED_PERMISSIONS = ['storage'];
const ALLOWED_MATCHES = ['https://github.com/*'];
const ALLOWED_JS = ['src/matcher.js', 'src/content.js'];
const ALLOWED_CSS = ['styles.css'];
const ALLOWED_WAR_RESOURCES = ['locales/dict.json'];

check('manifest: Manifest V3', manifest.manifest_version === 3, `manifest_version=${manifest.manifest_version}`);
check('manifest: version が x.y.z', /^\d+\.\d+\.\d+$/.test(manifest.version), `version=${manifest.version}`);
const extraKeys = Object.keys(manifest).filter(k => !ALLOWED_TOP_KEYS.includes(k));
check('manifest: 想定外の項目が無い', extraKeys.length === 0, `増えた項目: ${extraKeys.join(', ')}`);
check(`manifest: minimum_chrome_version が ${MIN_CHROME}`, manifest.minimum_chrome_version === MIN_CHROME,
  `minimum_chrome_version=${manifest.minimum_chrome_version}`);
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
// 計測用の JS は同じ拡張の content script として読み込ませるが、それは E2E が
// 並べた一時ディレクトリの中だけの話。配布物にも、正本の manifest にも入れない。
{
  const TEST_ONLY_JS = ['matcher-tap.js', 'leak-probe.js', 'no-checkvisibility.js'];
  // 名前を並べた検査は、ファイルの名前が変わると黙って何も見なくなる。
  // まず「その名前のものが実在する」ことを確かめてから、混入を見る。
  for (const f of TEST_ONLY_JS) {
    check(`テスト専用の tests/e2e/${f} が実在する`, existsSync(join(ROOT, 'tests/e2e', f)),
      '名前が変わったなら、この一覧も直す');
  }
  const isTestOnly = f => f.startsWith('tests/') || TEST_ONLY_JS.some(t => f.endsWith(t));
  check('テスト専用の JS が配布一覧に入っていない',
    !PACKAGE_FILES.some(isTestOnly), PACKAGE_FILES.filter(isTestOnly).join(', '));
  check('manifest が読み込む JS にテスト専用のものが入っていない',
    !(cs.js ?? []).some(isTestOnly), (cs.js ?? []).filter(isTestOnly).join(', '));
}

/* ---------- 配布する文書の相対リンクが、配布物の中で解決するか ---------- */
// 提出 ZIP の中には tests/ も scripts/ も .github/ も入らない。相対リンクのまま
// 書くと、配布された文書の中でリンクが切れる（実測: 9件が解決しなかった。
// 外部監査は README の画像1件を指摘したが、数え直したら同じ形が9件あった）。
// 相対で書いてよいのは配布物に入っているものだけ。それ以外は絶対 URL にする。
{
  const LINK = /\[[^\]]*\]\((?!https?:|mailto:|#)([^)#]+)(?:#[^)]*)?\)/g;
  const resolve = (from, target) => {
    const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : '';
    const parts = (dir + target).split('/');
    const out = [];
    for (const p of parts) {
      if (p === '.' || p === '') continue;
      if (p === '..') out.pop(); else out.push(p);
    }
    return out.join('/');
  };
  const mds = PACKAGE_FILES.filter(f => extname(f) === '.md');
  check('配布物に文書が含まれている（この検査の前提）', mds.length > 0, `件数=${mds.length}`);
  const outsidePkg = [], missingInRepo = [];
  let links = 0;
  for (const f of mds) {
    for (const m of read(f).matchAll(LINK)) {
      links++;
      const t = resolve(f, m[1].trim());
      if (!PACKAGE_FILES.includes(t)) outsidePkg.push(`${f} -> ${m[1]}`);
      if (!existsSync(join(ROOT, t))) missingInRepo.push(`${f} -> ${m[1]}`);
    }
  }
  check('配布する文書の相対リンクが、配布物の中だけを指している',
    outsidePkg.length === 0, outsidePkg.join(' / '));
  check('配布する文書の相対リンクが、リポジトリでも解決する',
    missingInRepo.length === 0, missingInRepo.join(' / '));
  // 陽性対照: この検査が、実際に配布物の外を指すリンクを捕まえること
  const probe = resolve('README.md', './docs/screenshot.png');
  check('相対リンクの検査が、配布物の外を指すものを捕まえる（陽性対照）',
    probe === 'docs/screenshot.png' && !PACKAGE_FILES.includes(probe), `解決結果=${probe}`);
  check('相対リンクの検査が、配布物の中のものは通す（陽性対照）',
    PACKAGE_FILES.includes(resolve('README.md', './PRIVACY.md')));
  check('相対リンクを実際に数えている（0件で素通りしていない）', links >= 5, `件数=${links}`);
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

  // 「取得元として触れない」ことと「本文として一時処理し得る」ことを混ぜない。
  // v1.8.5 は Cookie・認証情報・入力欄・編集中の文章を1行にまとめて「しない」と
  // 書いていたが、通常の本文に出た token らしき文字列は一時処理される。
  // 一括りにした断定が戻ってきたら落とす。
  //
  // ⚠️ 「〜とは書きません」という打ち消しの文にも同じ言葉が出る。polarity を見ずに
  // 語だけを探すと、打ち消しているほうを断定と取り違える（実際に誤検出した）。
  // 打ち消し文を先に取り除いてから探す。
  const claims = privacy.replace(/「[^」]*」とは書きません。?/g, '');
  const LUMPED = [
    [/Cookie[・･]認証情報[・･]入力欄/, '日本語: Cookie・認証情報・入力欄… を1行にまとめている'],
    [/Cookies,\s*credentials,\s*form fields/i, '英語: Cookies, credentials, form fields … をまとめている'],
    [/認証情報[^\n|「」]{0,30}(?:扱わない|取り扱わない|読み取りません)/, '日本語: 認証情報を扱わない、という言い切り']
  ];
  for (const [re, label] of LUMPED) {
    check(`PRIVACY.md に一括りの断定が無い（${label}）`, !re.test(claims));
  }
  // 陽性対照: この検査が、実際に v1.8.5 の書き方を落とせること。
  // 「見つからなかった」が、探し方が壊れているせいでないことを同じ実行で示す。
  const OLD_WORDING = [
    '| Cookie・認証情報・入力欄やフォームの中身・編集中の文章 | **しない** |',
    '| Cookies, credentials, form fields, editable content | **No** |',
    '本拡張は認証情報を扱わないため、開示は不要です。'
  ];
  for (let i = 0; i < LUMPED.length; i++) {
    check(`一括りの断定を探す検査が、実際に v1.8.5 の書き方を捕まえる（陽性対照 ${i + 1}）`,
      LUMPED[i][0].test(OLD_WORDING[i]), `この文を捕まえられない: ${OLD_WORDING[i]}`);
  }
  // 分けて書けていること（否定の検査だけだと、丸ごと消しても通ってしまう）
  check('PRIVACY.md が、取得元と本文の一時処理を分けて書いている（日本語）',
    /取得元として触れない/.test(privacy) && /通常の本文に表示されている/.test(privacy));
  check('PRIVACY.md が、取得元と本文の一時処理を分けて書いている（英語）',
    /Sources never touched/.test(privacy) && /displayed in ordinary page text/i.test(privacy));
}

// ストアの申告は、Dashboard の実画面を人が読むまで確定させない。
// 冒頭で「他の項目は選択しない」と言い切ると、そのあとの「要確認」が効かなくなる。
{
  check('STORE_LISTING が申告を冒頭で言い切っていない',
    !/他の項目は選択しない/.test(store) && !/Website content以外は選択しない/.test(store));
  check('STORE_LISTING が、確定と要確認を分けて書いている',
    /\*\*確定\*\*/.test(store) && /\*\*要確認\*\*/.test(store));
  // 認証情報は「要確認」側にあること（取得元と本文の一時処理を分けたため）
  const credRow = store.split('\n').find(l => l.startsWith('| 認証情報'));
  check('STORE_LISTING の認証情報の行が要確認になっている',
    !!credRow && credRow.includes('要確認'), credRow ?? '認証情報の行が見つからない');
  // Dashboard の定義文を書き写す欄が残っていること
  for (const w of ['確認日', '添えられていた定義文', '外部送信', '人手閲覧']) {
    check(`STORE_LISTING の転記欄に「${w}」がある`, store.includes(w));
  }
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

  /* ---- 現在の版を名乗る場所に、古い版が残っていないか ---- */
  // 「版がどこかに在るか」だけを見る検査では、見出しやリンクの取り残しに気づけない。
  // v1.8.5 の時点で、§2 の見出しが「今回（v1.8.4）」、§2-0 が「直前（v1.8.3）」、
  // §6 が「v1.8.2 → v1.8.3 の差分」、再現手順の SHA が v1.8.3 のもの、のまま残っていた。
  //
  // 過去を書いている節まで落とすと、正しい記述まで直させることになる。
  // **見出しに「履歴」を含む節だけを対象外**にし、そこは明示的に履歴だと書かせる。
  const lines = audit.split('\n');
  let inHistory = false;
  const currentLines = [];
  for (const line of lines) {
    const h = /^#{2,4}\s+(.*)$/.exec(line);
    if (h) inHistory = h[1].includes('履歴');
    if (!inHistory) currentLines.push(line);
  }
  // `superseded:` の下（より深いインデント）は「取り下げた過去の版」の記録なので、
  // 現在版を名乗る場所ではない。ここまで落とすと、正しい履歴まで直させることになる。
  const stripSuperseded = t => t.replace(/^superseded:\n(?:[ \t]+.*\n?)*/gm, '');
  const current = stripSuperseded(currentLines.join('\n'));
  check('AUDIT.md に、現在版を名乗る節が残っている', current.length > 500,
    `履歴でない部分が ${current.length} 文字しかない＝節の切り分けが壊れている`);
  // 陽性対照: 取り下げ版の記録だけが落ち、現在版の記載は残ること
  check('取り下げ版の除外が、現在版の記載まで落としていない（陽性対照）',
    current.includes(`version:            ${v}`) || current.includes(v),
    '現在版の記載ごと落ちている');
  check('取り下げ版の除外が、実際に効いている（陽性対照）',
    stripSuperseded('superseded:\n  - zip: repogloss-0.0.1.zip\nnext: keep\n') === 'next: keep\n');

  // それぞれ「ここに書かれた版は、いまの版と同じはず」という場所
  const SLOTS = [
    [/今回（v?(\d+\.\d+\.\d+)）/g, '「今回（…）」の見出し',
     '## 2. 今回（v1.8.4）で直したこと'],
    [/\|\s*Manifest\s*\|\s*v(\d+\.\d+\.\d+)/g, '「Manifest」の行',
     '| Manifest | v1.8.5 / Manifest V3 |'],
    [/docs\/audit\/v(\d+\.\d+\.\d+)-changes\.md/g, '変更記録へのリンク',
     '| **今回の変更の詳細と証拠** | [`docs/audit/v1.8.3-changes.md`](docs/audit/v1.8.3-changes.md) |'],
    [/（v\d+\.\d+\.\d+ → v(\d+\.\d+\.\d+) の差分）/g, '「vA → vB の差分」の見出し',
     '## 6. 権限・通信・保存データ（v1.8.2 → v1.8.3 の差分）'],
    [/repogloss-(\d+\.\d+\.\d+)(?:-UNCOMMITTED)?\.zip/g, '提出候補の ZIP 名',
     '| ZIP | `repogloss-1.8.5.zip`・**80,004 バイト**・**13ファイル** |']
  ];
  for (const [re, label, staleSample] of SLOTS) {
    const found = [...current.matchAll(re)].map(mm => mm[1]).filter(x => x !== v);
    check(`AUDIT.md の${label}が現在の版を指している`, found.length === 0,
      `古い版: ${[...new Set(found)].join(', ')}`);
    // 陽性対照: この探し方が、実際に v1.8.5 時点の取り残しを捕まえること。
    // 「見つからなかった」が、探し方が壊れているせいでないことを同じ実行で示す。
    re.lastIndex = 0;
    const hit = re.exec(staleSample);
    check(`${label}を探す検査が、実際に古い記載を捕まえる（陽性対照）`,
      !!hit && hit[1] !== v, `この行を捕まえられない: ${staleSample}`);
    re.lastIndex = 0;
  }

  // 既に取り下げた提出候補の SHA は、履歴か「参考」と書いた行にしか出てこないこと
  const SUPERSEDED_SHA = ['e76c9245', '8abc340d', 'c8bdbe3d'];
  for (const sha of SUPERSEDED_SHA) {
    const bad = current.split('\n')
      .filter(l => l.includes(sha) && !l.includes('参考') && !l.includes('提出しない'));
    check(`AUDIT.md の現在版の説明に、取り下げた候補の SHA（${sha}…）が紛れていない`,
      bad.length === 0, bad.map(l => l.trim().slice(0, 70)).join(' / '));
  }
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
