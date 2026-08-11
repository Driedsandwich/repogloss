/*
 * まとめ直しが何回走ったかを、隔離された世界の中から数える。
 *
 * 予約は `queueMicrotask` 1か所だけを通る（`content.js` §8）。ページ側からは
 * 隔離された世界の中が見えないので、数えた結果は `<html>` の data 属性へ書く。
 * content.js より**先に**読み込むこと（manifest の順序を差し替える）。
 *
 * 陽性対照を同じ経路に入れてある——読み込んだ直後に自分で1回予約し、
 * `rgProbeSelftest` が 1 になることを確かめられる。0 のままなら包みが
 * 効いていない（＝「0回だった」と「数えられていない」を見分けるため）。
 */
/* 公表先は localStorage にする。**<html> の属性へ書いてはいけない。**
   content.js は `<html>` の属性を見張るので、計測器が書くたびにまとめ直しが
   予約され、その予約自体がまた計測器を動かす。実測では、これでページが完全に
   固まった（マイクロタスクが尽きない）。localStorage は同じ生成元を共有するので
   隔離された世界からでもページ側から読めて、DOM には何の痕跡も残さない。 */
(() => {
  const orig = queueMicrotask;
  let n = 0;
  const publish = () => {
    localStorage.setItem('rg-batches', String(n));
  };
  queueMicrotask = fn => orig(() => {
    n++;
    publish();
    fn();
  });
  publish();

  // 陽性対照: この包みを通した予約が、実際に数えられること
  queueMicrotask(() => {
    localStorage.setItem('rg-probe-selftest', String(n));
  });

  // 数え直しの起点も localStorage で受ける。DOM を合図に使うと、その合図自体が
  // content.js のまとめ直しを1回呼び、数えたい回数に混ざる。
  setInterval(() => {
    if (localStorage.getItem('rg-reset') === '1') {
      localStorage.removeItem('rg-reset');
      n = 0;
      publish();
    }
  }, 20);
})();
