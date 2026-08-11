/*
 * まとめ直し1回の所要時間を、隔離された世界の中から測る。
 * 予約は `queueMicrotask` 1か所だけを通る（content.js §8）ので、その呼び出しを包む。
 * 結果は `<html>` の data 属性へ書く（ページ側からは中が見えないため）。
 *
 * 陽性対照: 読み込んだ直後に自分で1回予約し、`rgTimeSelftest` が 1 になることを
 * 確かめられる。0 のままなら包みが効いていない。
 */
(() => {
  const orig = queueMicrotask;
  const durations = [];
  let n = 0;
  const publish = () => {
    localStorage.setItem('rg-times', JSON.stringify(durations.slice(-12)));
    localStorage.setItem('rg-count', String(n));
  };
  queueMicrotask = fn => orig(() => {
    n++;                      // 先に数える（陽性対照が 0 と区別できるように）
    const t0 = performance.now();
    try { fn(); } finally {
      durations.push(Math.round((performance.now() - t0) * 100) / 100);
      publish();
    }
  });
  publish();
  queueMicrotask(() => {
    localStorage.setItem('rg-time-selftest', String(n));
  });
  setInterval(() => {
    if (localStorage.getItem('rg-reset') === '1') {
      localStorage.removeItem('rg-reset');
      durations.length = 0; n = 0; publish();
    }
  }, 20);
})();
