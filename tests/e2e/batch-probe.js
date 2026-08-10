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
(() => {
  const orig = queueMicrotask;
  let n = 0;
  const publish = () => {
    document.documentElement.setAttribute('data-rg-batches', String(n));
  };
  queueMicrotask = fn => orig(() => {
    n++;
    publish();
    fn();
  });
  publish();

  // 陽性対照: この包みを通した予約が、実際に数えられること
  queueMicrotask(() => {
    document.documentElement.setAttribute('data-rg-probe-selftest', String(n));
  });

  // 数え直しの起点をテスト側から動かせるようにする（ページ側から呼べるよう属性で受ける）
  const obs = new MutationObserver(() => {
    if (document.documentElement.getAttribute('data-rg-reset') === '1') {
      document.documentElement.removeAttribute('data-rg-reset');
      n = 0;
      publish();
    }
  });
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-rg-reset'] });
})();
