/*
 * まとめ直し1回の所要時間と、**1回あたりの仕事量**を、隔離された世界の中から測る。
 * 予約は `queueMicrotask` 1か所だけを通る（content.js §8）ので、その呼び出しを包む。
 *
 * ⚠️ **時間だけでは、機械の忙しさと区別がつかない。**（2026-08-16）
 * `performance.now()` は壁時計なので、OS にCPUを取り上げられていた時間まで入る。
 * 実測では、負荷の高い機械で 50ms の予算に対し 58.6ms が出た——刻まずに 20,000件を
 * さらったなら桁が変わるはずで、これは「忙しかった」の姿。
 * そこで**1パスで見た候補の数**も数える。忙しい機械ほど予算に収まる件数は**減る**ので、
 * 過負荷でしきい値を超える向きには動かない。刻みを外せば1パスで全件をさらうので、
 * そのときだけ増える。
 *
 * 陽性対照:
 *   `rg-time-selftest` … 読み込んだ直後に自分で1回予約し、1 になる（包みが効いている）
 *   `rg-work-selftest` … その予約の中で自分で1回ずつ呼び、各カウンタが 1 以上になる
 *                        （0 のままなら、そのAPIは数えられていない）
 */
(() => {
  const orig = queueMicrotask;
  const durations = [];
  const work = { checkVisibility: [], getComputedStyle: [], getBoundingClientRect: [] };
  let n = 0;
  let inPass = false;
  const tally = { checkVisibility: 0, getComputedStyle: 0, getBoundingClientRect: 0 };

  /* 数えるだけ。挙動は変えない（元をそのまま呼んで、返り値をそのまま返す） */
  const countWith = (holder, name, key) => {
    const target = holder[name];
    if (typeof target !== 'function') return false;
    holder[name] = function (...a) {
      if (inPass) tally[key]++;
      return target.apply(this, a);
    };
    return true;
  };
  const wrapped = {
    checkVisibility: countWith(Element.prototype, 'checkVisibility', 'checkVisibility'),
    getComputedStyle: countWith(globalThis, 'getComputedStyle', 'getComputedStyle'),
    getBoundingClientRect: countWith(Element.prototype, 'getBoundingClientRect', 'getBoundingClientRect')
  };

  const publish = () => {
    localStorage.setItem('rg-times', JSON.stringify(durations.slice(-12)));
    localStorage.setItem('rg-count', String(n));
    localStorage.setItem('rg-work', JSON.stringify({
      checkVisibility: work.checkVisibility.slice(-12),
      getComputedStyle: work.getComputedStyle.slice(-12),
      getBoundingClientRect: work.getBoundingClientRect.slice(-12)
    }));
    localStorage.setItem('rg-wrapped', JSON.stringify(wrapped));
  };

  queueMicrotask = fn => orig(() => {
    n++;                      // 先に数える（陽性対照が 0 と区別できるように）
    const t0 = performance.now();
    inPass = true;
    tally.checkVisibility = 0; tally.getComputedStyle = 0; tally.getBoundingClientRect = 0;
    try { fn(); } finally {
      inPass = false;
      durations.push(Math.round((performance.now() - t0) * 100) / 100);
      work.checkVisibility.push(tally.checkVisibility);
      work.getComputedStyle.push(tally.getComputedStyle);
      work.getBoundingClientRect.push(tally.getBoundingClientRect);
      publish();
    }
  });
  publish();
  queueMicrotask(() => {
    localStorage.setItem('rg-time-selftest', String(n));
    /* ここで自分から1回ずつ呼ぶ。数えられていれば、このパスの仕事量が 1 以上になる */
    const el = document.documentElement;
    if (typeof el.checkVisibility === 'function') el.checkVisibility();
    getComputedStyle(el).color;
    el.getBoundingClientRect();
    localStorage.setItem('rg-work-selftest', JSON.stringify({
      checkVisibility: tally.checkVisibility,
      getComputedStyle: tally.getComputedStyle,
      getBoundingClientRect: tally.getBoundingClientRect
    }));
  });
  setInterval(() => {
    if (localStorage.getItem('rg-reset') === '1') {
      localStorage.removeItem('rg-reset');
      durations.length = 0; n = 0;
      work.checkVisibility.length = 0; work.getComputedStyle.length = 0;
      work.getBoundingClientRect.length = 0;
      publish();
    }
  }, 20);
})();
