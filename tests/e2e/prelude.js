/*
 * テスト専用。配布物には入らない（scripts/package-files.mjs の一覧に無い）。
 *
 * content script は「隔離された世界」で動くので、ページ側から getter を差し替えても
 * 拡張の読み取りは観測できない。そこで、同じ拡張の content script として
 * **本体より先に**読み込ませ、同じ世界の中でテキストの取り出し口を計装する。
 *
 * 何を測るか: 除外されるはずの領域（編集中・フォーム・コード・aria-hidden・
 * inert・hidden）に置いた目印の文字列が、拡張から一度でも読まれたかどうか。
 * 読まれた目印だけを <html data-rg-reads> へ書き出す。
 *
 * この計測は「順序が正しいこと」を静的に見るのではなく、実際に読まれたかで見る。
 * 静的な検査は別名の変数・補助関数・bracket 記法などで迂回できるため。
 */
(() => {
  const PATTERN = /RGSENTINEL_[A-Z]+/g;
  const seen = new Set();

  function record(value) {
    if (typeof value !== 'string' || value.length === 0) return value;
    const hits = value.match(PATTERN);
    if (hits) {
      let added = false;
      for (const h of hits) if (!seen.has(h)) { seen.add(h); added = true; }
      // 属性へ書き出す。DOM は世界をまたいで共有されるので、テスト側から読める。
      if (added) document.documentElement.setAttribute('data-rg-reads', [...seen].sort().join(','));
    }
    return value;
  }

  function patch(proto, prop) {
    if (!proto) return;
    const d = Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || typeof d.get !== 'function') return;
    Object.defineProperty(proto, prop, {
      configurable: d.configurable,
      enumerable: d.enumerable,
      set: d.set,
      get() { return record(d.get.call(this)); }
    });
  }

  // テキストの中身を取り出せる口をすべて塞ぐ。どれか1つでも残すと、
  // そこを通れば計測をすり抜けられる。
  patch(Node.prototype, 'nodeValue');
  patch(Node.prototype, 'textContent');
  patch(CharacterData.prototype, 'data');
  patch(Text.prototype, 'wholeText');
  patch(HTMLTextAreaElement.prototype, 'value');
  patch(HTMLInputElement.prototype, 'value');

  document.documentElement.setAttribute('data-rg-prelude', 'ready');
})();
