/*
 * テスト専用。配布物には入らない（scripts/package-files.mjs の一覧に無い）。
 *
 * 何を測るか: 除外されるはずの領域（編集中・フォーム・コード・aria-hidden・
 * inert・hidden）の文字列が、辞書の照合まで届いていないか。
 *
 * 以前は「文字を取り出せる口」を1つずつ塞いで数えていた。しかし取り出し口は
 * innerText / Range.toString() / substringData() / select の value /
 * defaultValue / getAttribute('value') …と際限がなく、6つ塞いだだけで
 * 「全部塞いだ」とは言えない。塞ぎ忘れた口を1つ通れば、計測をすり抜ける。
 *
 * そこで、**出口ではなく入口**を測る。読み取りの方法が何であれ、その文字列で
 * 辞書を照合しようとすれば必ず matcher を通る。matcher は content.js が唯一
 * 語を判定する場所なので、ここを1か所押さえれば、取り出し方が変わっても効く。
 *
 * 仕掛け方: matcher.js が globalThis へ置いた createMatcher を包む。
 * content.js より先に読み込ませるので、content.js が受け取る matcher は
 * この包んだ側になる。配布する src/ には一切手を入れない。
 */
/* 公表先は localStorage にする。**<html> の属性へ書いてはいけない。**
   content.js は `<html>` の属性を見張るので、計測器が書くたびにまとめ直しが
   予約され、その予約自体がまた計測器を動かす。実測では、これでページが完全に
   固まった（マイクロタスクが尽きない）。localStorage は同じ生成元を共有するので
   隔離された世界からでもページ側から読めて、DOM には何の痕跡も残さない。 */
(() => {
  const PATTERN = /RGSENTINEL_[A-Z]+/g;
  const seen = new Set();

  function record(value) {
    if (typeof value !== 'string' || value.length === 0) return;
    const hits = value.match(PATTERN);
    if (!hits) return;
    let added = false;
    for (const h of hits) if (!seen.has(h)) { seen.add(h); added = true; }
    // 属性へ書き出す。DOM は世界をまたいで共有されるので、テスト側から読める。
    if (added) localStorage.setItem('rg-reads', [...seen].sort().join(','));
  }

  const api = globalThis.RepoGlossMatcher;
  if (!api || typeof api.createMatcher !== 'function') {
    localStorage.setItem('rg-tap', 'matcher が見つからない');
    return;
  }

  const original = api.createMatcher;
  api.createMatcher = function (dict) {
    const m = original.call(this, dict);
    if (!m) return m;
    const test = m.test.bind(m);
    const findHits = m.findHits.bind(m);
    // 判定に使われた文字列そのものを見る。足切り（test）も本判定（findHits）も、
    // どちらを通っても記録する。片方だけだと、もう片方で通り抜けられる。
    m.test = text => { record(text); return test(text); };
    m.findHits = (text, isGlossed) => { record(text); return findHits(text, isGlossed); };
    localStorage.setItem('rg-tap', 'ready');
    return m;
  };
})();
