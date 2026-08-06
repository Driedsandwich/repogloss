// 提出候補の「身元」（provenance）の形と中身を検査する。
//
// ZIP のバイト列が合っていることと、その ZIP がどこから出てきたかが分かることは
// 別のこと。中身のハッシュだけを見ていると、誰がどの実行で作ったか分からないもの、
// あるいは出どころの記録を後から書き換えたものを、提出候補として通してしまう。
//
// ここは判定だけを行い、ファイルの読み書きはしない（tests から直接ぶつけるため）。
export const RELEASE = {
  repository: 'Driedsandwich/repogloss',
  // 提出候補を作るのは main への push だけ（.github/workflows/ci.yml の release-zip）
  refs: ['refs/heads/main'],
  platform: 'linux'   // release-zip は ubuntu-latest で走る
};

const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const DIGITS = /^\d+$/;
const isStr = v => typeof v === 'string' && v.length > 0;
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const escapeRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @param rec     身元ファイル（dist/<zip>.json）を読んだもの
 * @param actual  いま実物から測り直した値
 *                { name, version, bytes, fileCount, sha256, contentSha256, files, headCommit }
 * @param release true なら「ストアへ出す候補」として、CI 由来であることまで求める
 * @returns       問題の一覧（空なら合格）
 */
export function validateProvenance(rec, actual, { release = false } = {}) {
  const out = [];
  const bad = m => out.push(m);
  if (!isObj(rec)) { bad('身元の記録が object でない'); return out; }

  /* ---- 1. 形（欠けていたら落とす。「無い」と「合っている」を区別する） ---- */
  if (!isStr(rec.name)) bad('name が無い');
  if (!isStr(rec.version)) bad('version が無い');
  if (!Number.isInteger(rec.bytes)) bad('bytes が整数でない');
  if (!Number.isInteger(rec.fileCount)) bad('fileCount が整数でない');
  if (!HEX64.test(String(rec.sha256))) bad('sha256 が 64桁の16進でない');
  if (!HEX64.test(String(rec.contentSha256))) bad('contentSha256 が 64桁の16進でない');
  if (!Array.isArray(rec.files) || !rec.files.every(isStr)) bad('files が文字列の配列でない');

  /* ---- 2. 実物と一致するか ---- */
  if (rec.name !== actual.name) bad(`name が実物と違う（記録 ${rec.name} / 実物 ${actual.name}）`);
  if (rec.version !== actual.version) bad(`version が違う（記録 ${rec.version} / 実物 ${actual.version}）`);
  if (rec.bytes !== actual.bytes) bad(`大きさが違う（記録 ${rec.bytes} / 実物 ${actual.bytes}）`);
  if (rec.fileCount !== actual.fileCount) bad(`ファイル数が違う（記録 ${rec.fileCount} / 実物 ${actual.fileCount}）`);
  if (rec.sha256 !== actual.sha256) bad(`ZIP の SHA-256 が違う（記録 ${rec.sha256} / 実物 ${actual.sha256}）`);
  if (rec.contentSha256 !== actual.contentSha256) bad('中身の合算ハッシュが実物と違う');
  if (JSON.stringify(rec.files) !== JSON.stringify(actual.files)) bad('ファイルの一覧が実物と違う');
  if (Array.isArray(rec.files) && rec.fileCount !== rec.files.length) bad('fileCount が files の数と合っていない');
  // 名前と version が食い違っていないか（別の版の記録を貼り替えられないように）
  if (isStr(rec.name) && isStr(rec.version)
      && !new RegExp(`^repogloss-${escapeRe(rec.version)}(-UNCOMMITTED)?\\.zip$`).test(rec.name)) {
    bad(`name が repogloss-<version>.zip の形になっていない: ${rec.name}`);
  }

  /* ---- 3. どこから出てきたか ---- */
  const s = rec.source;
  if (!isObj(s)) bad('source が無い（どの実行から出た ZIP か分からない）');
  else {
    if (!HEX40.test(String(s.commit))) bad(`source.commit が 40桁の16進でない: ${s.commit}`);
    for (const k of ['repository', 'ref', 'workflowRunId', 'workflowRunAttempt']) {
      if (!(k in s)) bad(`source.${k} の項目が無い`);
    }
    if (typeof s.builtInCI !== 'boolean') bad(`source.builtInCI が true/false でない: ${s.builtInCI}`);
    if (actual.headCommit && HEX40.test(String(s.commit)) && s.commit !== actual.headCommit) {
      bad(`出どころのコミットが、いま checkout している内容と違う（記録 ${s.commit} / HEAD ${actual.headCommit}）`);
    }
    // CI で作ったと名乗るなら、そこは固定の値でなければならない
    if (s.builtInCI === true) {
      if (s.repository !== RELEASE.repository) bad(`source.repository が違う: ${s.repository}`);
      if (!RELEASE.refs.includes(s.ref)) bad(`source.ref が違う: ${s.ref}`);
      if (!DIGITS.test(String(s.workflowRunId))) bad(`source.workflowRunId が数字でない: ${s.workflowRunId}`);
      if (!DIGITS.test(String(s.workflowRunAttempt))) bad(`source.workflowRunAttempt が数字でない: ${s.workflowRunAttempt}`);
    }
  }

  /* ---- 4. 作った環境（ハッシュが変わったとき、何が違ったかを言えるように） ---- */
  const e = rec.environment;
  if (!isObj(e)) bad('environment が無い');
  else {
    for (const k of ['node', 'zlib', 'platform']) {
      if (!isStr(e[k])) bad(`environment.${k} が無い`);
    }
    if (isObj(s) && s.builtInCI === true && e.platform !== RELEASE.platform) {
      bad(`CI で作ったはずなのに platform が ${e.platform}（${RELEASE.platform} のはず）`);
    }
  }

  /* ---- 5. ストアへ出す候補として見るとき ---- */
  if (release) {
    if (!isObj(s) || s.builtInCI !== true) bad('提出候補は CI で作ったものに限る（builtInCI が true でない）');
    if (isStr(rec.name) && rec.name.includes('UNCOMMITTED')) bad('commit していない内容から作られている');
  }
  return out;
}
