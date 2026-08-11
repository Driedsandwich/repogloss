/*
 * テスト専用。配布物には入らない（scripts/package-files.mjs の一覧に無い）。
 *
 * 何を測るか: 触れないと約束した領域（編集中・コード・aria-hidden・inert・hidden）の
 * **本文そのもの**を、拡張が一度でも取り出したか。
 *
 * matcher-tap.js は「辞書の照合まで届いたか」を測る。これは目的が違う。
 * 辞書へ渡さずに本文を読むだけなら、tap には何も映らない——実際、
 * 第9回監査はその差を突いた（記録の整合を確かめる処理が、除外の判定より先に
 * nodeValue を読んでいた）。ここでは照合ではなく **読み取りそのもの**を見る。
 *
 * 仕掛け方: 隔離世界の Node.prototype.nodeValue / CharacterData.prototype.data の
 * getter を包む。content.js より先に読み込ませるので、本体が読むときは必ずここを通る。
 * ページ側の世界とは別なので、ページからこの計装は見えない。
 * 配布する src/ には一切手を入れない。
 */
/* 公表先は localStorage にする。**<html> の属性へ書いてはいけない。**
   content.js は `<html>` の属性を見張るので、計測器が書くたびにまとめ直しが
   予約され、その予約自体がまた計測器を動かす。実測では、これでページが完全に
   固まった（マイクロタスクが尽きない）。localStorage は同じ生成元を共有するので
   隔離された世界からでもページ側から読めて、DOM には何の痕跡も残さない。 */
(() => {
  const PATTERN = /RGSENTINEL_[A-Z]+/;
  const seen = new Set();

  function record(value) {
    if (typeof value !== 'string' || !PATTERN.test(value)) return;
    const hit = value.match(PATTERN)[0];
    if (seen.has(hit)) return;
    seen.add(hit);
    // DOM は世界をまたいで共有されるので、テスト側から読める
    localStorage.setItem('rg-raw', [...seen].sort().join(','));
  }

  let wrapped = 0;
  for (const [proto, prop] of [[Node.prototype, 'nodeValue'],
                               [Node.prototype, 'textContent'],
                               [CharacterData.prototype, 'data']]) {
    const d = Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || typeof d.get !== 'function') continue;
    const get = d.get;
    Object.defineProperty(proto, prop, {
      ...d,
      get() { const v = get.call(this); record(v); return v; }
    });
    wrapped++;
  }
  // substringData のような取り出し口も、同じ sentinel で捕まえる
  const sub = CharacterData.prototype.substringData;
  if (typeof sub === 'function') {
    CharacterData.prototype.substringData = function (...a) {
      const v = sub.apply(this, a); record(v); return v;
    };
    wrapped++;
  }
  localStorage.setItem('rg-rawtap', wrapped === 4 ? 'ready' : `partial:${wrapped}`);

  // 陽性対照。包んだ getter が本当に効いていることを、**同じ実行の中で**示す。
  // これが記録されていなければ、「読まれていない」は計測の失敗と区別が付かない。
  // 本物の判定は「この1件だけが記録されていること」で行う。
  document.createTextNode('RGSENTINEL_SELFTEST').nodeValue;
})();
