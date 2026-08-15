// リポジトリの整合を機械で確かめる。依存なしで動く。
//   node scripts/verify.mjs
// 目的は「文書に書いた数字・権限・ファイル構成が、実物とずれていないこと」の確認。
// 落ちたときは、直すべき場所が分かる形で出す。
//
// 権限まわりは「増えていないこと」ではなく「この形と完全に同じこと」を見る。
// 増分だけを見ると、2つ目の content_scripts を足すような広げ方に気づけない。
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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
// 判定を関数へ切り出したので、その関数が本当に SKIP を見ていることを先に確かめる。
// ここを確かめずに名前だけで順序を測ると、中身が空でも通ってしまう。
{
  const m = content.match(/function inSkip\(el\)\s*\{([\s\S]*?)\n  \}/);
  check('content.js に inSkip がある', !!m);
  check('inSkip が closest(SKIP) で判定している', !!m && m[1].includes('closest(SKIP)'));
}
{
  const m = content.match(/function isTarget\(node\)\s*\{([\s\S]*?)\n  \}/);
  check('content.js に isTarget がある', !!m);
  if (m) {
    const body = m[1];
    const skipAt = body.indexOf('inSkip(');
    const valueAt = Math.min(
      ...['node.nodeValue', 'node.data', 'node.textContent', 'node.wholeText']
        .map(t => { const i = body.indexOf(t); return i === -1 ? Infinity : i; })
    );
    check('isTarget が SKIP 判定より前にテキストの値を読んでいない',
      skipAt !== -1 && skipAt < valueAt,
      `SKIP の位置=${skipAt} / 値を読む位置=${valueAt === Infinity ? 'なし' : valueAt}`);
  }
}

// 走査の入口だけでは足りなかった。注記した**あとで**その場所が編集領域などへ
// 変わることがあり、記録の整合を確かめる側が、除外を見る前に本文を読んでいた
// （第9回監査 RG-9-04。実測で再現）。同じ順序を isCoherent にも要求する。
{
  const m = content.match(/function isCoherent\(rec\)\s*\{([\s\S]*?)\n  \}/);
  check('content.js に isCoherent がある', !!m);
  if (m) {
    const body = m[1];
    const skipAt = body.indexOf('inSkip(');
    // 探すのは**本文の文字**を読む書き方だけ。`.dataset`（自分が書いた名札）は
    // 本文ではないので、`.data` の部分一致で拾ってしまわないよう境界を付ける。
    const TEXT_READ = /\.nodeValue|\.textContent|\.wholeText|substringData\(|\.data\b(?!set)/;
    const found = TEXT_READ.exec(body);
    const valueAt = found ? found.index : Infinity;
    check('isCoherent が SKIP 判定より前にテキストの値を読んでいない',
      skipAt !== -1 && skipAt < valueAt,
      `SKIP の位置=${skipAt} / 値を読む位置=${valueAt === Infinity ? 'なし' : valueAt}`);
    // 陽性対照/陰性対照: 本文を読む書き方は捕まえ、名札の読み出しは捕まえないこと
    check('この順序検査が、本文を読む書き方を捕まえる（陽性対照）',
      TEXT_READ.test('const v = rec.termNode.nodeValue;'));
    check('この順序検査が、名札の読み出しを誤って捕まえない（陰性対照）',
      !TEXT_READ.test('if (rec.icon.dataset.iiyakuKey !== rec.key) return false;'));
    // 記録の中身と意味も、毎回確かめていること（RG-13-04）
    check('isCoherent が、説明文・用語・役割まで記録どおりか確かめている',
      /dataset\.iiyaku !== DICT\[rec\.key\]/.test(body) &&
      /dataset\.iiyakuTerm !== rec\.term/.test(body) &&
      /getAttribute\('role'\) !== 'button'/.test(body),
      'ページ側が説明文や役割を書き換えても、正規の記録として残り続ける');
    // 語のうしろに文字が増えたら整合でないこと（RG-9-02）
    check('isCoherent が、語が節点の末尾で終わることを要求している',
      /termNode\.length\s*!==\s*rec\.splitOffset/.test(body),
      '末尾の固定が無いと、印が別の文字列の直後に残ったまま整合と見なされる');
  }
}

/* ---------- 所有していないものへ手を出していないか（RG-9-05） ---------- */
// class だけで「自分のもの」と決めると、ページ側が同じ class を使っただけで
// その要素を消したりクリックを横取りしたりする（実測で両方起きた）。
{
  check('複製の除去が、class 単独ではなく自分の合言葉で判定している',
    /data-iiyaku-owner/.test(content) && !/pick\('\.iiyaku-icon'\)/.test(content),
    '.iiyaku-icon を class だけで拾って消している');
  check('印の当たり判定が、自分が作ったものに限定されている',
    /function ownedIconAt/.test(content) && /ownedIconAt\(el\)/.test(content));
  check('click の横取りが closest(\'.iiyaku-icon\') ではなくなっている',
    !/closest\('\.iiyaku-icon'\)/.test(content),
    'ページ側の同名 class のリンクまで既定動作を止めてしまう');
  // ページ側の値を selector へ埋めない（埋めると SyntaxError にもなる）
  const badSelector = /querySelector(All)?\(\s*[`'"][^`'"]*\[\s*data-[^`'"]*=\s*"?\s*['"]\s*\+/;
  check('外から来た値を CSS selector へ埋めていない', !badSelector.test(content));
  // 陽性対照: この探し方が、実際に v1.8.7 の書き方を捕まえる
  check('selector 埋め込みの検査が、実際に古い書き方を捕まえる（陽性対照）',
    badSelector.test(`document.querySelector('[data-iiyaku-trigger="' + id + '"]')`));
}

/* ---------- 変更の見張りが、見え方を変える入力まで見ているか（RG-9-01 / RG-9-06 / RG-10-01〜03） ---------- */
{
  check('MutationObserver が文字の書き換えを見ている', /characterData:\s*true/.test(content));
  check('MutationObserver が属性の変化を見ている', /attributes:\s*true/.test(content));
  // 属性を絞り込むと、列挙していない属性（type や任意の data-*）で隠されたことに
  // 気づけない（第10回 RG-10-01。実測で3通り再現）。絞り込みは置かない。
  check('見張る属性を絞り込んでいない', !/attributeFilter/.test(content),
    'attributeFilter があると、列挙外の属性で隠されたことに気づけない');
  check('記録の確かめ直しに、見え方まで見る深い経路がある',
    /function isUsable\(rec\)/.test(content) && /reconcileGlosses\(deep\)/.test(content));

  // DOM の変更として出ない合図（CSS の遷移・画面幅・head の stylesheet）も拾うこと
  for (const sig of ['transitionend', 'animationend', 'resize', 'orientationchange']) {
    check(`見え方の合図に ${sig} が入っている`, content.includes(sig));
  }
  check('head の stylesheet の変化を見ている', /headObserver/.test(content));
  check('利用者の操作（input / change / click）も合図にしている',
    /'input', 'change', 'click'/.test(content));
  // 子が増えただけでも祖先が消えることがある（:has）ので、追加でも深く確かめる。
  // 判定はコードだけを見る。**コメントの文言を条件にすると、説明を書いた側が
  // 自分の検査に引っかかる**（実際にここで一度そうなった）。
  {
    const code = stripComments(content);
    // 中に別の if を挟んでも見つかるよう、範囲を区切って探す（`[^}]*` だと
    // 最初の閉じ括弧で止まり、書き方を足した瞬間に**黙って何も見なくなる**）。
    const ADDED_DEEP = /for \(const n of mu\.addedNodes\)[\s\S]{0,300}?deep = true/;
    check('childList の追加でも deep になる（追加だけを安全とみなさない）', ADDED_DEEP.test(code),
      '子の追加で deep にならない書き方に戻っている');
    // 陽性対照: 古い書き方と、いまの書き方の両方を捕まえること
    check('childList の検査が、単純な書き方を捕まえる（陽性対照）',
      ADDED_DEEP.test('for (const n of mu.addedNodes) { if (!x(n)) { deep = true; } }'));
    check('childList の検査が、入れ子のある書き方も捕まえる（陽性対照）',
      ADDED_DEEP.test('for (const n of mu.addedNodes) {\n if (s.has(n)) { s.delete(n); continue; }\n if (!x(n)) { deep = true; }\n}'));
    // 陰性対照: 追加を無条件に安全とみなす書き方は、捕まえないこと
    check('childList の検査が、安全とみなす書き方を通さない（陰性対照）',
      !ADDED_DEEP.test('for (const n of mu.addedNodes) { roots.push(n); }'));
  }
}

/* ---------- 自分の変更かどうかを、所有ではなく予定表で決めているか（RG-10-05） ---------- */
{
  check('自分が書く属性の予定表がある',
    /let expectedAttrs = new WeakMap\(\)/.test(content) && /function setOwnAttr/.test(content));
  check('自分の仕業かどうかを、予定表との一致で決めている',
    /function consumeExpectedAttr/.test(content) &&
    /consumeExpectedAttr\(t, mu\.attributeName, mu\.oldValue\)/.test(content));
  // 予定は**1回だけ**受け取って消すこと。消さないと、ページが同じ値へ書き戻した
  // 変更まで自分の仕業として捨てる（RG-13-05）。
  check('属性の予定を、1回受け取ったら消している',
    /q\.splice\(i, 1\)/.test(content),
    '予定が残り続けると、ページが同じ値へ戻した変更に気づけない');
  check('変更前の値で突き合わせるため、oldValue を受け取っている',
    /attributeOldValue: true/.test(content));
  check('見張っていない間の予定を持ち越していない',
    /function clearExpectations/.test(content) && /clearExpectations\(\);/.test(content));
  // 所有だけで無視すると、ページ側が自分の印へ加えた変更まで見落とす
  check('所有だけを根拠に属性変更を無視していない',
    !/if \(isOurNode\(mu\.target\)\) continue;[\s\S]{0,80}attributes/.test(content));
  // 自分が書く属性は、すべて予定表を通ること（素の setAttribute を残さない）
  const rawWrites = [...content.matchAll(/^\s*(icon|trigger|el|t|root|toggleBtn)\.(setAttribute|removeAttribute)\(/gm)];
  check('自分が書く属性に、予定表を通らない書き込みが無い', rawWrites.length === 0,
    rawWrites.map(m => m[0].trim()).join(' / '));
  // 陽性対照: この探し方が、実際に素の書き込みを捕まえる
  check('素の書き込みを探す検査が、実際に捕まえる（陽性対照）',
    /^\s*(icon|trigger|el|t|root|toggleBtn)\.(setAttribute|removeAttribute)\(/m.test('    icon.setAttribute("role", "button");'));
}

/* ---------- 複製の後始末と、印の見た目の条件（RG-10-04） ---------- */
{
  check('ON へ戻すときに、ページ全体から複製を取り除く',
    /sanitizeClones\(document\.body\)/.test(content));
  check('印の見た目に、自分の合言葉を要求している',
    /\.iiyaku-icon\[data-iiyaku-owner\]/.test(read('styles.css')),
    '合言葉を消した複製が、印として描かれてしまう');
}

/* ---------- 見えるようになった語を探す仕掛け（RG-11-01） ---------- */
// 見え方の合図で「既にある印を確かめ直す」だけだと、初回に隠れていた語は
// そのタブを開いているあいだ永久に説明されない（4通りで実測）。
{
  check('初回に見えなかった節点を控えている',
    /const latent = new Set\(\)/.test(content) && /function rememberLatent/.test(content));
  check('見えるようになった語を探す経路がある', /function discoverLatent/.test(content));
  const code = stripComments(content);
  check('見え方が変わったまとめ直しで、その経路を通る',
    /if \(deep\) found \+= discoverLatent\(\)/.test(code),
    'deep なのに控えを見直していない');
  // 見つかった件数は、カーソルの合図の間隔を決めるのに使う（第18回 RG-18-08）
  check('見直しで何件見つかったかを、間隔の判断へ返している',
    /function noteHoverFound/.test(code) && /hoverTriggered = true/.test(code) &&
    /noteHoverFound\(found\)/.test(code),
    '何も見つからなくても同じ間隔で走り続ける');
  check('間隔を空ける上限が、短時間ひらくメニューを取りこぼさない範囲である',
    /const HOVER_GAP_MAX = 300/.test(code),
    '上限を伸ばしすぎると、第15回 RG-15-07 で直した取りこぼしが戻る');
  check('印が0件でも、控えがあれば暇なときの確認を止めない',
    /glossed\.size === 0 && latent\.size === 0/.test(code),
    '印が0件になった時点で、あとから見えた語を拾えなくなる');
  // 控えを見直す前に、文字列だけで足切りしていること（見え方の測定は高い）
  check('控えの見直しが、見え方を測る前に文字列で足切りしている',
    /matcher\.findHits\(v, key => usableGloss\(key\) !== null\)\.length === 0\) continue/.test(code),
    '控えが多いページで、毎回すべての見え方を測ることになる');

  // 第12回 RG-12-01: 控えを見直すときも、**本文へ触れる前に**除外を確かめること。
  // 初回走査（isTarget）は先に見ているのに、見直しの経路だけ順序が逆だった（実測）。
  {
    const fn = /function discoverLatent\(\)[\s\S]*?\n  \}/.exec(code);
    check('控えの見直しの本体を取り出せる', !!fn, '関数名を変えたなら、この検査も直す');
    const body = fn ? fn[0] : '';
    const iSkip = body.indexOf('inSkip(el)');
    const iRead = body.indexOf('node.nodeValue');
    check('控えの見直しが、本文を読む前に除外を確かめている',
      iSkip > -1 && iRead > -1 && iSkip < iRead,
      `inSkip の位置 ${iSkip} / 本文を読む位置 ${iRead}（前者が先でなければならない）`);
    // 陽性対照: この並び順の見方が、逆の書き方を実際に捕まえること
    check('順序を見る検査が、逆の書き方を捕まえる（陽性対照）',
      (s => { const a = s.indexOf('inSkip(el)'), b = s.indexOf('node.nodeValue');
              return !(a > -1 && b > -1 && a < b); })('const v = node.nodeValue; if (inSkip(el)) return;'));
  }

  // 第12回 RG-12-02: 入口がまだ無いだけの候補を、永久に処理済みにしない
  check('入口が無いだけの候補を、控えへ入れて見直している',
    /placement\.kind === 'skip'\) \{[\s\S]{0,400}?rememberLatent\(node\)/.test(code),
    '入口ができても、同じ世代では二度と見なくなる');

  // 第12回 RG-12-04: 控えに既にあるものを数え直して上限を踏まないこと
  check('控えへ入れる前に、既に控えてあるかを見ている',
    /function rememberLatent[\s\S]{0,200}?latent\.has\(node\)\) return/.test(code),
    '見直すたびに上限へ達し、控えを丸ごと捨ててしまう');
  check('上限に達しても、控えを捨てていない',
    !/latent\.clear\(\)/.test(code),
    '捨てると「候補0件」に見え、二度と探さなくなる');
}

/* ---------- 退役で所有を取り消しているか（RG-11-02） ---------- */
{
  check('退役のときに、印の所有を取り消している',
    /ownedIcons\.delete\(rec\.icon\)/.test(content),
    'ページが退役した領域を戻すと、古い印が正規のまま生き返る');
  check('記録の不変条件に、合言葉の値が入っている',
    /rec\.icon\.getAttribute\('data-iiyaku-owner'\) !== UID/.test(content),
    '合言葉を外された印が、見えない停止点として残る');
  // 辞書の説明文を所有の証明に使うと、**ページ側がたまたま同じ data 属性を持つ
  // 要素**まで本文ごと消す（第13回 RG-13-03。実測で再現）。判定は自分の側の証拠だけで行う。
  check('複製の判定に、辞書の説明文との一致を使っていない',
    !/dataset\.iiyaku === DICT\[/.test(stripComments(content)),
    'ページ側の要素を、その本文ごと消す');
  check('複製の判定が、今回の合言葉そのもので行われている',
    /pick\(`\[data-iiyaku-owner="\$\{CSS\.escape\(UID\)\}"\]`\)/.test(content));
  check('中身のある節点は消さず、名札を外すだけにしている',
    /!hasPageContent\(el\)\) removeOwn\(el\);\s*\n\s*else stripOwnIdentity\(el\)/.test(content),
    'ページが使い回している節点を、その本文ごと消す');
  // 「空」を childNodes 0 で見ると、Comment や空の Text を1つ足すだけで抜けられる
  check('「中身が無い」を、Comment や空の Text を数えずに判定している',
    /function hasPageContent/.test(content) && !/childNodes\.length === 0/.test(stripComments(content)),
    '複製に空の Text を足すだけで、見えない Tab の停止点が残る');
  // 名札の**数**で複製かどうかを当てていた（2つ以上そろっていたら自分の複製）。
  // 名札を全部消された複製は見分けられず、見えない Tab の停止点として残った
  // （第16回 RG-16-08。実測: 実際に Tab で 0×0 の要素へフォーカスが移った）。
  // いまは、自分が作る要素へ**読み込みごとに変わる合言葉を class として**付け、
  // それが付いているかどうかだけで決める（class は cloneNode でそのまま複製される）。
  check('自分が作る要素に、合言葉の class を付けている',
    /icon\.className = 'iiyaku-icon ' \+ UID/.test(content) &&
    /tip\.className = 'iiyaku-tooltip ' \+ UID/.test(content) &&
    /btn\.className = 'iiyaku-toggle ' \+ UID/.test(content),
    'これが無いと、名札を全部消された複製を見分けられない');
  check('複製の判定を、名札の数の当て推量でしていない',
    !/OWN_DATA_ATTRS\.filter\(a => el\.hasAttribute\(a\)\)\.length < 2/.test(content),
    '数え上げでは、名札を全部消された複製が素通りする');
  check('合言葉の class を持つ他人の要素だけを、複製として無力化している',
    /pick\('\.' \+ CSS\.escape\(UID\)\)/.test(content),
    'ページ側の要素から class や role を剥がしてしまう');
  check('無力化するとき、合言葉の class も外している',
    /classList\.remove\(\.\.\.OWN_CLASSES, UID\)/.test(content),
    '外し忘れると、同じ要素を毎回つかみ直す');
  check('見た目の側で、印・吹き出し・切替ボタンの3つとも合言葉の値まで見ている',
    /function scopeOwnStyle/.test(content) && /:not\(\$\{mine\}\)/.test(content) &&
    /OWN_CLASSES\.map\(c => `\.\$\{c\}\[data-iiyaku-owner\]:not\(\$\{mine\}\)`\)/.test(content),
    'ページ側の同名 class へ、自分の見た目が乗る');
  // 「作ったことがある」という永久の記録は持たない（持つと、退役した節点を
  // ページが戻したときにも自分のものとして扱う）
  check('「作ったことがある」という永久の記録を持っていない',
    !/madeIcons/.test(stripComments(content)),
    '退役した印をページが使い回すと、その中が走査されない');
  check('自分が外す削除だけを、1回受け取って自分のものとしている',
    /const expectedRemovals = new WeakSet\(\)/.test(content) &&
    /function isOwnRemoval/.test(content) &&
    /expectedRemovals\.delete\(node\)/.test(content),
    'ページが正規の印を外したことに気づけない');
}

/* ---------- 自分の起こした変更を数えていないか（RG-11-03 / RG-11-05） ---------- */
{
  const code = stripComments(content);
  check('吹き出しと切替ボタンを、class 名ではなく要素そのもので見分けている',
    /function isOurChrome/.test(content) && !/closest\('\.iiyaku-tooltip, \.iiyaku-toggle'\)/.test(code),
    'ページ側が同じ class を使うと、その要素を自分のものとして扱ってしまう');
  check('除外一覧に、自分の UI の class 名を並べていない',
    !/'\.iiyaku-toggle', '\.iiyaku-tooltip'/.test(code) && !/^\s*'\.iiyaku-icon',/m.test(code),
    'ページ側の同名 class の中を、永久に走査しなくなる');
  // 陽性対照: この探し方が、実際に並べた書き方を捕まえること
  check('除外一覧の検査が、class 名を並べた書き方を捕まえる（陽性対照）',
    /^\s*'\.iiyaku-icon',/m.test("    '.iiyaku-icon',\n"));
  check('自分の印は、いま正規のものだけを要素そのもので除外している',
    /isOurChrome\(el\) \|\| !!ownedIconAt\(el\)/.test(code),
    'class 名を外したのに、自分の印を除外する経路が無い');
  check('吹き出しの中かどうかを、いま出している吹き出しそのもので見ている',
    /const inTooltip = target =>[\s\S]{0,200}?tip && \(el === tip \|\| tip\.contains\(el\)\)/.test(code),
    'ページ側の同名 class へカーソルが移っても、説明が閉じない');
  check('本文を割ったときの変更を、自分のものとして数えていない',
    /const expectedSplit = new WeakSet\(\)/.test(content) &&
    /expectedSplit\.has\(n\)\) \{ expectedSplit\.delete\(n\)/.test(code) &&
    /expectedTrim\.has\(mu\.target\)\) \{ expectedTrim\.delete\(mu\.target\)/.test(code),
    '印を1つ動かすたびに、空のまとめ直しがもう1回走る');
  // 読まれない旗を残さない（守っているつもりの不変条件が誰も見ていない状態になる）
  check('読まれない再入防止の旗が残っていない', !/inBatch/.test(code));
}

/* ---------- 走査より先に見張り始めているか（RG-12-03） ---------- */
// 走査の途中で自分が起こす変更は「次に1回だけ起きるはず」として控えてある。
// 見張る前に走査すると、その控えが消費されないまま残り、**そのあとページが起こした
// 最初の文字変更を自分のものとして捨てる**（実測）。
{
  const code = stripComments(content);
  const iObs = code.indexOf('observer.observe(document.body, OBSERVE_OPTS)');
  const iScan = code.indexOf('scan(document.body);\n', code.indexOf('function startRuntime'));
  check('見張り始める場所と、初回走査の場所が両方ある', iObs > -1 && iScan > -1,
    `observe: ${iObs} / scan: ${iScan}`);
  check('走査より先に見張り始めている', iObs > -1 && iScan > -1 && iObs < iScan,
    '残った「予定」が、ページの最初の文字変更を食べる');
}

/* ---------- 参照ボックスの 0 と、寸法不明を分けているか（RG-12-05） ---------- */
{
  const code = stripComments(content);
  // 面積が 0 かどうかだけを見ていては足りない。**切り取りに面積があっても、
  // 語がその外**にあることがある（第13回 RG-13-01。画素を数えて実測）。
  check('一致した語の範囲で、積み上げた切り取りとの交わりを決めている',
    /function isPaintedRange/.test(code) && /function intersectRect/.test(code) &&
    /function paintChain/.test(code) && /function visibleHits/.test(code),
    '親要素まるごとで測ると、同じ親に見えている文字があるだけで切り取りの外の語まで可視になる');
  check('可視性を、要素だけを鍵にして覚えていない',
    !/visibleCache/.test(code),
    '語ごとに答えが変わるので、要素を鍵にした覚え書きは誤答を配る');
  // 形そのものとの交差（外接矩形だけでは、円や角丸の外を落とせない）
  check('円・楕円・角丸の外側を、形そのもので落としている',
    /function polyHitsEllipse/.test(code) && /function polyHitsRounded/.test(code) &&
    /function shapeHitTest/.test(code),
    '外接矩形だけでは、円の角に置かれた語を可視と答える');
  // 回った場所では、語の矩形を戻すと平行四辺形になる。外接矩形で当ててはいけない
  check('形との交差を、矩形ではなく多角形で当てている',
    /function clipPolyToBox/.test(code) && /backPoly/.test(code) && !/rectHitsRounded/.test(code),
    '回転した場所で、形の外にある語まで拾う');
  check('変形前の箱を、外接矩形の寸法から復元している',
    /const D = Math\.abs\(L\.a\) \* Math\.abs\(L\.d\) - Math\.abs\(L\.b\) \* Math\.abs\(L\.c\)/.test(code),
    '4隅を戻しただけでは元より大きくなる');
  // 逃げてよいのは overflow だけ。clip と clip-path は子孫の描画そのものを制限する
  check('包含ブロックの例外を、overflow だけに掛けている',
    /if \(applies && own\.overflow && !isRoot\) clip = intersectRect\(clip, own\.overflow\)/.test(code) &&
    /if \(own\.shape\) clip = intersectRect\(clip, own\.shape\)/.test(code),
    '絶対配置が祖先の clip-path まで逃れてしまう');
  check('文字の矩形は、面積のあるものだけを数えている',
    /x\.width > 0 && x\.height > 0/.test(code),
    'transform:scale(0) は箱の寸法を変えないので、面積を見ないと落とせない');
  check('描画効果（完全に透明な filter / mask）も不可視として見ている',
    /function paintState/.test(code) && /FILTER_OPACITY_ZERO/.test(code) &&
    /isFullyTransparentGradient/.test(code));
  // filter は最後まで見る。最初の opacity(0) で打ち切ると、後ろの opacity(0) を見落とす
  check('filter の並びを最後までたどっている',
    /for \(const f of fns\) \{\s*\n\s*if \(FILTER_OPACITY_ZERO\.test\(f\)\) zero = true;/.test(code),
    '`opacity(0) url(#f) opacity(0)` を可視と答える');
  // 合成の演算は解かない。足し合わせ以外は「断定できない」として後回しにする
  check('mask の合成が足し合わせ以外なら、断定しない',
    /function maskState/.test(code) && /allAdd/.test(code) && /'unknown'/.test(code),
    '打ち消し合って消えている語を可視と答える');
  check('断定できない候補で、その語を使い切らない',
    /let acceptUnknown = false/.test(code) && /unknownNodes/.test(code),
    '前方の断定できない候補が、後ろの確実に見える語を抑止する');

  /* ---------- 第19回で足した不変条件 ---------- */
  // RG-19-01 複数語の用語は、**全部の並び**が読めるときだけ可視
  check('語の矩形を、並びごとに分けて持っている',
    /function rangeRuns/.test(code) && !/function rangeRects/.test(code),
    '1つへ潰すと「どれか1つ見えれば可視」になる');
  check('全部の並びが読めることを求めている',
    /for \(const rects of runs\) \{[\s\S]{0,200}?const s = runState\(rects\);[\s\S]{0,120}?if \(s === false\) return false;/.test(code) &&
    !/rects\.some\(r => inClip\(r\)/.test(code),
    '`pull request` の `pull` だけ見えていても用語全体を可視と答える');
  // RG-19-01 印そのものも、切り取りの中に描かれていること（実物を測る）
  check('入れた印が描かれているかを、実物で測っている',
    /function iconIsPainted/.test(code) && /if \(!iconIsPainted\(icon\)\) \{/.test(code) &&
    /if \(!iconIsPainted\(rec\.icon\)\) return false;/.test(code),
    '語は読めても、印だけが切り取りの外に出て見えない停止点になる');
  // RG-19-02 mandatory な吸い寄せでは、止まれない位置を到達可能としない
  check('吸い寄せのある軸を見ている',
    /function snapAxes/.test(code) && /mandatory/.test(code) && /snapX/.test(code) && /snapY/.test(code),
    '連続区間のどこでも止まれるとして、読めない語へ印を付ける');
  check('吸い寄せがあるときは、いまの位置でしか断定しない',
    /feasible\(r, doms, 'x', true\)/.test(code) && /pinSnap/.test(code) &&
    /return \(feasible\(r, doms, 'x', false\) && feasible\(r, doms, 'y', false\)\) \? 'unknown' : false;/.test(code),
    '止まり位置を解かないまま、到達できると断定してしまう');
  check('スクロールが落ち着いたら、控えを見直している',
    /const SCROLL_SIGNALS/.test(code) && /scrollend/.test(code) && /function onScrollSignal|const onScrollSignal/.test(code),
    '吸い寄せで止まったあと、読めるようになった語が説明されない');
  check('絶対配置が切り取りから逃げることを見ている',
    /function establishesContainingBlock/.test(code) && /function positionEscape/.test(code),
    '包含ブロックでない祖先の切り取りで、読める語を落とす');
  // スクロールで読める領域を切り取りに数えると、長い一覧の下が説明されなくなる
  // 文の終わりまで見る。前方一致で済ませると、`|| v === 'auto'` を足した書き方も
  // 通ってしまう（この緩さは、下の陰性対照が実際に捕まえた）。
  const CLIPS_ONLY = /const clips = v => v === 'hidden' \|\| v === 'clip';/;
  check('overflow の auto / scroll を切り取りに数えていない', CLIPS_ONLY.test(code),
    '画面外というだけの語を、永久に除外してしまう');
  check('この検査が、auto を足した書き方を捕まえる（陰性対照）',
    !CLIPS_ONLY.test("const clips = v => v === 'hidden' || v === 'clip' || v === 'auto';"));
  check('この検査が、いまの書き方は通す（陽性対照）',
    CLIPS_ONLY.test("const clips = v => v === 'hidden' || v === 'clip';"));
  // 1px 四方まで潰す書き方は、切り取りの指定を持たないこともある
  check('読める幅が残らない帯を不可視としている',
    /function rectIsEmpty/.test(code) && /<= 1/.test(code));
  check('大きさの目安だけで不可視と決めていない',
    !/\btiny\b/.test(code),
    '1px の箱でも、負の inset で外へ描かれていれば読める（実測で362画素）');
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

  // 同じ取り残しが AUDIT.md でも起きた（第9回のあと、タグを打って CI が全ジョブ
  // 成功したのに §4 が「commit していないため CI は回っていません」のままだった）。
  // 変更記録だけを見ていては見つからないので、監査入口も同じ言葉で見る。
  // `state:` が tagged 以上なら、準備段階の言い切りは残っていてはいけない。
  {
    const st = (/^state:\s*(\S+)/m.exec(audit) || [])[1];
    check('AUDIT.md §1-1 に state がある', !!st, `state=${st}`);
    const PREP = ['commit していないため', 'まだ commit していない', '今回は未実行',
                  'commit・push をしていないため'];
    const left = PREP.filter(w => audit.includes(w));
    if (st && st !== 'uncommitted') {
      check(`AUDIT.md に準備段階の言い切りが残っていない（state=${st}）`, left.length === 0,
        `残っている表現: ${left.join(' / ')}`);
    } else {
      check('state=uncommitted のときは準備段階の言い切りを許す', true);
    }
    // 陽性対照: この探し方が、実際に取り残しの文を捕まえること
    check('準備段階の言い切りを探す検査が、実際に捕まえる（陽性対照）',
      PREP.some(w => 'commit していないため CI は回っていません。'.includes(w)));
  }

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
  // 「|| current.includes(v)」のような逃げ道を付けると、正本の行が消えても通ってしまう。
  const VERSION_LINE = new RegExp(`^version:[ \\t]+${v.replace(/\./g, '\\.')}\\s*$`, 'm');
  check('取り下げ版の除外が、現在版の記載まで落としていない（陽性対照）',
    VERSION_LINE.test(current), '現在版の記載ごと落ちている');
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

  /* ---- §1-1 の機械可読ブロック（AUDIT.md 自身が「ここが正本」と書いている場所） ---- */
  // v1.8.7 を打った直後に測ったところ、この yaml の version と commit を古い値へ
  // 戻しても検査は素通りした。正本と名乗る場所が検査の外に在ると、他の節をいくら
  // 直しても取り残しが残る（第7回 RG-7-08・第8回 RG-8-05 と同じ型）。
  {
    const block = /```yaml\n([\s\S]*?)```/.exec(current);
    check('AUDIT.md §1-1 に機械可読ブロックがある', !!block);
    const yaml = block ? block[1] : '';
    const field = (t, k) => (new RegExp(`^${k}:[ \\t]+(\\S+)`, 'm').exec(t) || [])[1];

    check('§1-1 の version が manifest と一致する', field(yaml, 'version') === v,
      `yaml: ${field(yaml, 'version')} / manifest: ${v}`);
    // 陽性対照: この読み取りが、古い値を実際に読み分けられること
    check('§1-1 の version を読む検査が、古い値を捕まえる（陽性対照）',
      field(`version:            1.0.0\n`, 'version') === '1.0.0');

    const tag = field(yaml, 'tag');
    check('§1-1 の tag が、未記入か現在の版のタグである',
      tag === 'null' || tag === `v${v}`, `tag: ${tag}`);

    const commit = field(yaml, 'commit');
    // 「未記入」の書き方は tag と揃える（2つの綴りを許すと、どちらかしか見ない経路ができる）
    check('§1-1 の commit が、未記入か 40 桁の hex である',
      commit === undefined || commit === 'null' || /^[0-9a-f]{40}$/.test(commit), `commit: ${commit}`);

    // 取り下げた版のコミットを、現在版の commit として書いてしまう取り違えを止める。
    // `superseded:` の中は上で落としてあるので、元の全文から拾う。
    const supersededCommits =
      [...audit.matchAll(/^[ \t]+commit:[ \t]+([0-9a-f]{40})/gm)].map(mm => mm[1]);
    check('§1-1 の commit が、取り下げた版のコミットと同じでない',
      !commit || !supersededCommits.includes(commit),
      `${commit} は superseded にも載っている`);
    // 陽性対照: 比較の相手が空だと、上の検査は必ず通ってしまう
    check('取り下げた版のコミットを、実際に1件以上拾えている（陽性対照）',
      supersededCommits.length > 0, 'superseded の commit を1件も拾えていない');

    // 提出候補の SHA を書くなら、ZIP 名・バイト数と揃っていること
    const zip = field(yaml, 'candidate_zip');
    const sha = field(yaml, 'candidate_sha256');
    check('§1-1 の candidate_zip と candidate_sha256 が、両方あるか両方無いか',
      (zip === 'null') === (sha === 'null'), `zip: ${zip} / sha: ${sha}`);
    check('§1-1 の candidate_sha256 が、未記入か 64 桁の hex である',
      sha === 'null' || /^[0-9a-f]{64}$/.test(sha ?? ''), `sha: ${sha}`);
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
for (const cls of ['iiyaku-icon', 'iiyaku-toggle', 'iiyaku-tooltip']) {
  check(`CSS に .${cls} の定義がある`, css.includes(`.${cls}`));
  check(`content.js が ${cls} を使っている`, content.includes(cls));
}
// OFF の目印は、ページの class ではなく自分の属性で持つ（第16回 RG-16-06）。
// 説明の文章に出てくる名前まで数えないよう、**コメントを外してから**見る
// （たまたま通っているだけの検査にしない）。
const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, '');
check('OFF の目印が、名前ごと読み込みごとに変わる',
  /const OFF_ATTR = 'data-' \+ UID \+ '-off'/.test(content) && !/iiyaku-off/.test(stripComments(content)),
  '固定名だと、ページが同じ名前を使っているときに上書き・削除してしまう');
check('OFF の目印を探す検査が、実際に捕まえる（陽性対照）',
  /iiyaku-off/.test(stripComments("const OFF_ATTR = 'data-iiyaku-off';")));
check('OFF の規則を styles.css に固定で置いていない', !/\.iiyaku-off/.test(cssCode),
  '合言葉つきの属性で絞るので、規則は content.js が走り出しに足す');
check('OFF の規則を探す検査が、実際に捕まえる（陽性対照）',
  /\.iiyaku-off/.test('.iiyaku-off .iiyaku-icon[data-iiyaku-owner] { display: none }'));
check('content.js が保存キー iiyakuEnabled を変えていない', content.includes("'iiyakuEnabled'"));
// 選択子を書き換えたときに、この検査が黙って何も見なくなることがあった
// （`.iiyaku-tooltip {` で切っていたので、合言葉を足した瞬間に空文字列を見ていた）。
// 規則の本体を取り出す形にし、取り出せたこと自体も確かめる。
{
  const body = (/\.iiyaku-tooltip\[data-iiyaku-owner\]\s*\{([^}]*)\}/.exec(css) || [])[1];
  check('CSS からツールチップの規則本体を取り出せる', !!body,
    'styles.css の選択子を変えたなら、この検査も直す');
  check('ツールチップが狭い画面でも収まる指定を持つ',
    /max-width:\s*min\(/.test(css) && /box-sizing:\s*border-box/.test(body ?? ''));
}

/* ---------- 監査対象のタグと、いまの配布物がずれていないか（RG-11-06） ---------- */
// 「main の先頭」のような**相対的な言い方**は、次のコミットを積んだ瞬間に嘘になる
// （実測: 提出候補の SHA を記録した1件で、監査入口の対象行が事実と食い違った）。
// 対象はタグとコミットだけを名乗り、いまの main との関係は
// 「配布13ファイルが同じか」という、機械で確かめられる形にする。
{
  const audit = read('AUDIT.md');
  const RELATIVE = /main の先頭/;
  check('AUDIT.md が、対象を「main の先頭」と相対的に名乗っていない', !RELATIVE.test(audit),
    'main へ1つ commit した瞬間に、この記述は事実でなくなる');
  check('相対表現を探す検査が、実際に捕まえる（陽性対照）',
    RELATIVE.test('| 監査対象 | v1.8.9（main の先頭。タグ済み） |'));

  // 監査回は毎回変わるのに、表題へ焼き込んでいたため**3巡続けて古いまま**出した
  // （第14回 RG-14-09 → 第15回 RG-15-09 → 第16回 RG-16-10）。直す場所を毎回
  // 探すのをやめ、変わる値を表題から追い出す。
  const TITLE = (/^#\s+(.*)$/m.exec(audit) || [])[1] || '';
  const ROUND = /第\s*\d+\s*回/;
  check('AUDIT.md の表題に監査回を書いていない', !ROUND.test(TITLE),
    '毎回変わる値を表題へ置くと、更新し忘れが繰り返される');
  check('監査回を探す検査が、実際に捕まえる（陽性対照）',
    ROUND.test('監査のための資料（第15回監査用）'));

  const st = (/^state:\s*(\S+)/m.exec(audit) || [])[1];
  const tag = (/^tag:\s*(\S+)/m.exec(audit) || [])[1];
  if (st && st !== 'uncommitted' && tag && tag !== 'null') {
    const git = args => {
      try {
        return { ok: true, out: execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' }) };
      } catch (e) { return { ok: false, out: String(e.message || e) }; }
    };
    const has = git(['rev-parse', '--verify', `${tag}^{commit}`]);
    // タグが引けない環境では**通さない**。ここを素通りにすると、
    // 「一致していた」と「確かめていない」が同じ見た目になる。
    check(`監査対象のタグ ${tag} が手元に在る`, has.ok,
      '浅いクローンにはタグが入らない（`git clone --depth 1` は既定でも0本。実測）。' +
      '通常の `git clone` を使うか、CI では checkout に fetch-tags を付ける。' +
      '**`npm test` を走らせるジョブすべて**に付ける（1つ忘れて3 OS とも赤にした）');
    if (has.ok) {
      const diff = git(['diff', '--name-only', `${tag}`, '--', ...PACKAGE_FILES]);
      check('配布物の diff を取れている', diff.ok, diff.out.slice(0, 120));
      const changed = diff.ok ? diff.out.split('\n').filter(Boolean) : ['(取れていない)'];
      check(`配布13ファイルが、タグ ${tag} と同じ`, changed.length === 0,
        `違うファイル: ${changed.join(', ')}（監査対象を打ち直すか、AUDIT.md の tag を直す）`);
      // 陽性対照: この突き合わせが、実際に差を見つけられること
      const ctrl = git(['diff', '--name-only', `${tag}~1`, `${tag}`, '--', ...PACKAGE_FILES]);
      check('配布物の突き合わせが、実際に差を見つけられる（陽性対照）',
        ctrl.ok && ctrl.out.trim().length > 0,
        'ひとつ前との差が0件＝比較が効いていない可能性がある');
    }
  } else {
    check('state が uncommitted のときは、タグとの突き合わせを求めない', true);
  }
}

/* ---------- 監査入口が名乗る検査件数が、実際の件数と合っているか（RG-9-08） ---------- */
// 版・SHA・タグは検査していたのに、**検査の件数だけ**が同期の外に在った。
// その結果、`AUDIT.md` が古い件数（158・166）を名乗ったまま残った（実測）。
// 自分の件数を自分で名乗る以上、そこも突き合わせる。
// この検査自身が最後の1件なので、いまの checks に 1 を足したものが最終の件数になる。
/* ---------- 第13回監査（v1.8.12）で足した約束 ---------- */
{
  const code = stripComments(content);

  // `<html>` の属性は、body を見張っていても1件も届かない（実測: 表示が消えても
  // まとめ直しは1回も走らず、暇なときの確認まで約2秒かかった）。
  check('`<html>` の属性も見張っている',
    /observer\.observe\(document\.documentElement, ROOT_OPTS\)/.test(code) &&
    /const ROOT_OPTS = \{ attributes: true, attributeOldValue: true \}/.test(code),
    '見た目を切り替える指定は `<html>` に置かれることが多い');
  // ただし走査し直す場所には入れない（1回の書き換えでページ全体を歩き直すため）
  check('`<html>` の属性変更で、ページ全体を走査し直していない',
    /if \(mu\.target !== document\.documentElement\) roots\.push\(mu\.target\)/.test(code));

  // カーソルとフォーカスも合図にする（CSS だけで開くメニューは他の合図に乗らない）
  check('カーソルとフォーカスを、控えの見直しの合図にしている',
    /const HOVER_SIGNALS = \['pointerover', 'pointerout', 'focusin', 'focusout'\]/.test(code) &&
    /addEventListener\(t, onPointerOrFocus, true\)/.test(code));
  check('見直す先が無いときは、その合図で何もしない',
    /if \(latent\.size === 0 \|\| hoverPending\) return/.test(code),
    'カーソルを動かすたびにまとめ直しが走る');
  check('カーソルの合図を、1フレームに1回へまとめている',
    /requestAnimationFrame\(fire\)/.test(code));
  check('切り替えのときに、その合図も外している',
    /removeEventListener\(t, onPointerOrFocus, true\)/.test(code));

  // 控えの見直しに時間の予算があること（20,000件で毎回 30〜60ms 掛かっていた）
  check('控えの見直しに、時間の予算と続きの持ち越しがある',
    /const LATENT_BUDGET_MS/.test(code) && /latentCursor/.test(code) &&
    /function scheduleLatentResume/.test(code),
    '控えが多いページで、2秒ごとに長い処理が走る');
  check('続きは、マイクロタスクではなく一度ブラウザへ返してから走る',
    /latentResume = setTimeout\(/.test(code),
    'マイクロタスクで続けると、区切った意味が無くなる');

  // 上限の旗が、実際の処理につながっていること（読まれない旗を残さない）
  const truncReads = (code.match(/latentTruncated/g) || []).length;
  check('上限の旗が、書くだけでなく読まれている', truncReads >= 3 &&
    /if \(latentTruncated\) reindexLatent\(\)/.test(code),
    `latentTruncated の出現 ${truncReads} 箇所。旗を立てるだけでは「もう探さない」が黙って続く`);
  check('入れ直す前に旗を下ろしていない',
    /if \(latent\.size >= LATENT_MAX\) return;\s*\n\s*latentTruncated = false;/.test(code),
    '空きが無くて引き返した1回で旗が消え、あとで空きができても入れ直さない');
  check('満杯のときは、まず死んだ控えを落として空きを作る',
    /function pruneLatent/.test(code) && /pruneLatent\(\);/.test(code));

  // 見た目の絞り込みが外されたら足し直す
  check('見た目の絞り込みが外されたら足し直す',
    /function ensureOwnStyle/.test(code) && /ensureOwnStyle\(\);/.test(code));

  // ページ側の指定を打ち消さないこと。styles.css をカスケードレイヤーへ入れ、
  // 走り出しの規則は「画面を乗っ取る3つ」だけへ絞る（第14回 RG-14-07）。
  {
    const css = read('styles.css');
    check('styles.css がカスケードレイヤーに入っている',
      /^@layer repogloss-e7b41d \{/m.test(css.replace(/\/\*[\s\S]*?\*\//g, '').trim()),
      'ページ側が同じ性質を指定していても、自分の見た目が勝ってしまう');
    check('レイヤーの順序を、styles.css で先に宣言している',
      /@layer repogloss-e7b41d, repogloss-e7b41d-scope;/.test(css),
      '絞り込みの規則がページ側の指定より強くなってしまう');
    check('絞り込みの規則が、後ろのレイヤーに入っている',
      /@layer \$\{SCOPE_LAYER\}\{/.test(content),
      'レイヤー無しで書くと、ページ自身の author style まで打ち消す');
    // 名前は2つのファイルに分かれて書かれる。ずれると絞り込みが黙って効かなくなる。
    check('レイヤー名が styles.css と content.js で揃っている',
      content.includes("const SCOPE_LAYER = 'repogloss-e7b41d-scope'"),
      'styles.css が宣言した名前と違うレイヤーへ書くと、順序が付かない');
    // ページと共有する名前は、偶然のぶつかりを生む（第16回 RG-16-06）。
    check('レイヤー名にページが使いそうな綴りを使っていない',
      !/@layer\s+repogloss\s*[,{]/.test(css),
      'ページ側の @layer repogloss と合流すると、ページ自身の規則の順序が入れ替わる');
    // 戻す性質の一覧は、styles.css が与えるものを網羅していること
    const want = new Set();
    for (const m of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/\.iiyaku-(icon|tooltip|toggle)\[data-iiyaku-owner\]/.test(m[1])) continue;
      for (const d of m[2].split(';')) if (d.includes(':')) want.add(d.split(':')[0].trim());
    }
    const listed = new Set((/const OWN_STYLE_PROPS = \[([\s\S]*?)\];/.exec(content) || [, ''])[1]
      .split(',').map(x => x.replace(/['\s\n]/g, '')).filter(Boolean));
    const missing = [...want].filter(x => !listed.has(x));
    check('戻す性質の一覧が、styles.css と一致している',
      want.size >= 10 && missing.length === 0 && [...listed].every(x => want.has(x)),
      `styles.css にあって一覧に無い: ${missing.join(',') || 'なし'}（抜き出せた数 ${want.size}）`);
    check('走り出しの規則の中身も見て、書き換えられたら足し直す',
      /ownStyle\.textContent === ownStyleText/.test(content));
  }

  // 配布する DESIGN.md が、現行の実装と食い違っていないこと（RG-13-07）
  {
    const design = read('DESIGN.md');
    const stale = [
      ['DOM の監視をまとめていない', /監視をまとめていない|呼び出しごとに走査しており/],
      ['characterData を捕捉していない', /characterData`?\)?や、?\s*`?hidden`?\s*\/\s*`?aria-hidden`?\s*の解除だけで表示された要素は捕捉していない/]
    ];
    for (const [name, re] of stale) {
      check(`DESIGN.md に、現行と食い違う旧仕様（${name}）が残っていない`, !re.test(design),
        '配布物の設計説明を根拠に監査・保守する人へ、旧仕様を伝えてしまう');
    }
    // 陽性対照: この探し方が、実際の旧文言を捕まえること
    check('旧仕様の探し方が、当時の文言を捕まえる（陽性対照）',
      stale[0][1].test('- **DOM の監視をまとめていない。** MutationObserver の呼び出しごとに走査しており、'));
    check('DESIGN.md が、いまの仕組み（まとめ直し・属性の見張り・控えの上限）を書いている',
      /queueMicrotask/.test(design) && /characterData/.test(design) && /20,000/.test(design));
  }
}

{
  const auditText = read('AUDIT.md');
  // 過去の run の結果を書いた行は、その時点の事実なので現在の値と一致しなくてよい。
  // ただし**黙って除外しない**——「当時」と自分で名乗った行だけを対象外にする。
  const lines = auditText.split('\n').filter(l => !l.includes('当時'));
  const cur = lines.join('\n');
  const claimed = [...cur.matchAll(/検査\s*[（(]\s*(\d+)\s*項目\s*[）)]/g)].map(m => Number(m[1]));
  const claimed2 = [...cur.matchAll(/構成検査\s*\*{0,2}(\d+)\s*項目/g)].map(m => Number(m[1]));
  const all = [...claimed, ...claimed2];
  // 陽性対照: 「当時」と書いていない行の古い件数は、いまも捕まえること
  check('検査件数の突き合わせが、古い記載を捕まえる（陽性対照）',
    [...'構成検査 **111項目**'.matchAll(/構成検査\s*\*{0,2}(\d+)\s*項目/g)].map(m => Number(m[1]))[0] === 111);
  const total = checks + 1;
  check(`AUDIT.md が名乗る検査件数が、実際の ${total} 件と一致する`,
    all.length > 0 && all.every(n => n === total),
    all.length === 0 ? 'AUDIT.md に検査件数の記載が見つからない（書き方を変えたなら、この検査も直す）'
                     : `AUDIT.md の記載: ${[...new Set(all)].join(', ')} / 実際: ${total}`);
}

/* ---------- 結果 ---------- */
const label = `${checks} 件を検査`;
if (failures.length > 0) {
  console.error(`NG: ${label} — ${failures.length} 件が不一致\n`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`OK: ${label}・不一致 0 件（辞書 ${count} 語 / version ${manifest.version}）`);
