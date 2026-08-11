/*
 * テスト専用。配布物には入らない（scripts/package-files.mjs の一覧に無い）。
 *
 * matcher-tap.js が「本当に取り逃がさないか」を確かめるための、わざとの漏れ。
 * 除外領域の文字列を、これまで計装していなかった3通りの取り出し方で
 * 辞書の照合へ渡す。tap がこの3つとも記録できれば、取り出し方を変えても
 * すり抜けられないと言える。
 *
 * ① innerText              ② Range.toString()      ③ CharacterData.substringData()
 *
 * 本体（src/content.js）は一切書き換えない。content.js と同じ matcher
 * （globalThis.RepoGlossMatcher.createMatcher の返り値）を使うので、
 * 本体が同じ取り出し方をした場合と、tap から見える形は同じになる。
 */
/* 公表先は localStorage にする。**<html> の属性へ書いてはいけない。**
   content.js は `<html>` の属性を見張るので、計測器が書くたびにまとめ直しが
   予約され、その予約自体がまた計測器を動かす。実測では、これでページが完全に
   固まった（マイクロタスクが尽きない）。localStorage は同じ生成元を共有するので
   隔離された世界からでもページ側から読めて、DOM には何の痕跡も残さない。 */
(() => {
  const api = globalThis.RepoGlossMatcher;
  if (!api || typeof api.createMatcher !== 'function') return;

  function run() {
    const m = api.createMatcher({ repository: '説明', commit: '説明', branch: '説明' });
    if (!m) return;
    const el = id => document.getElementById(id);

    const a = el('s-editable');                       // ① innerText
    if (a) m.test(a.innerText);

    const b = el('s-code');                           // ② Range.toString()
    if (b) { const r = document.createRange(); r.selectNodeContents(b); m.test(r.toString()); }

    const c = el('s-inert');                          // ③ substringData()
    const t = c && c.firstChild;
    if (t && typeof t.substringData === 'function') m.test(t.substringData(0, t.length));

    localStorage.setItem('rg-leak', 'done');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
