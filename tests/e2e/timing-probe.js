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

  /*
   * **遅い周期（2秒ごとの確認）が何回まわったか**を数える（2026-08-16）。
   *
   * ⚠️ 「2秒を待たずに拾う」を `sleep(320)` で確かめている試験がある。これは壁時計なので、
   * 機械が遅いと「まだ来ていない」ところを見て赤くなる。見たいのは時間ではなく
   * **どちらの経路が届けたか**——速い経路か、2秒ごとの確認か。
   * 遅い周期の回数を数えておけば、「その回数が増えないうちに付いた」と言える。
   *
   * ⚠️ 1500ms 以上の待ちだけを数える。短い間引きの窓（120ms など）まで数えると、
   * 速い経路の側の回数が混ざって、区別にならない。
   *
   * ⚠️ **`setInterval` ではなく `setTimeout` を包む。** 実測: `src/content.js` の
   * `setInterval` は **0件**で、暇なときの確認は `setTimeout(…, IDLE_GAP=2000)` を
   * 自分で繋ぎ直す形だった（`scheduleIdleCheck`）。`setInterval` を包んでいたら
   * 回数は永久に 0 のままで、**当たるものが無いまま通る検査**になっていた。
   */
  const SLOW_MS = 1500;
  let slowTicks = 0;
  const origTimeout = setTimeout;
  setTimeout = (fn, ms, ...rest) => origTimeout((...a) => {
    if (typeof ms === 'number' && ms >= SLOW_MS) { slowTicks++; publish(); }
    return typeof fn === 'function' ? fn(...a) : undefined;
  }, ms, ...rest);

  const publish = () => {
    localStorage.setItem('rg-times', JSON.stringify(durations.slice(-12)));
    localStorage.setItem('rg-count', String(n));
    localStorage.setItem('rg-slowticks', String(slowTicks));
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
  /*
   * 陽性対照: 遅い周期の計数器そのものが効いているか。
   * ⚠️ これが無いと、「回数が増えなかった」と「そもそも数えられていない」が
   * 同じ顔になる。包んだ側で 2000ms の予約を1つ入れ、**包んでいない側**で
   * その後に読む（読む側まで数えてしまわないように `origTimeout` を使う）。
   */
  setTimeout(() => {}, 2000);
  origTimeout(() => {
    localStorage.setItem('rg-slowtick-selftest', String(slowTicks));
  }, 2600);

  setInterval(() => {
    if (localStorage.getItem('rg-reset') === '1') {
      localStorage.removeItem('rg-reset');
      durations.length = 0; n = 0;
      slowTicks = 0;
      work.checkVisibility.length = 0; work.getComputedStyle.length = 0;
      work.getBoundingClientRect.length = 0;
      publish();
    }
  }, 20);
})();
