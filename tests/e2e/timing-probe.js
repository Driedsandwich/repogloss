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
 *
 * ⚠️ **経路ごとに数える。**（第23回 RG-23-13）
 * 以前は包んだ `queueMicrotask` の中だけを数えていた。ところが控えの見直しは
 * 4 つの経路から入る:
 *   batch  … ページの変化の合図 → schedule() → queueMicrotask(runBatch) → discoverLatent
 *   idle   … setTimeout(IDLE_GAP) → requestIdleCallback → schedule() → queueMicrotask → …
 *   fast   … setTimeout(fastGap) から discoverLatent を**直接**呼ぶ（scheduleFastCheck）
 *   resume … 予算で区切った続きを setTimeout(0) から**直接**呼ぶ（scheduleLatentResume）
 * fast と resume は queueMicrotask を通らないので、**その経路の仕事は数えられていなかった**
 * （回答の反例: timeout の中で 20,000 回呼んでも記録は [1, 0]・最大 1）。
 * ここでは setTimeout / requestIdleCallback / queueMicrotask の予約のたびに「どの経路の
 * 中で予約されたか」を持ち越し、走った仕事をその経路へ付ける。fast・idle・resume の
 * 入口は、製品の予約する関数の**最初の文**（`fastTimer = null;` など）で見分ける。
 * 製品の書き方が変わって見分けられなくなったら、その経路の回数が 0 のままになるので、
 * 試験の側で「経路が一度も走っていない＝検査が素通り」として落とす（黙って通さない）。
 * 公表: `rg-paths` … 経路ごとの回数・合計・最大・直近12回（リセットから）
 *       `rg-inserts` … 印を差し込んだときの経路と場所（直近50件）。イベントの経路の
 *                      試験が、周期の確認に救われていないかを確かめるのに使う。
 */
(() => {
  const orig = queueMicrotask;
  const durations = [];
  const work = { checkVisibility: [], getComputedStyle: [], getBoundingClientRect: [] };
  let n = 0;
  let inPass = false;
  const tally = { checkVisibility: 0, getComputedStyle: 0, getBoundingClientRect: 0 };

  /* ---- 経路（第23回 RG-23-13）---- */
  const PATHS = ['batch', 'idle', 'fast', 'resume', 'other'];
  // freshPasses / freshMax … 区切った続き（resume）が1つも待っていない＝控えの一巡の
  // **頭から**入った回だけ。一巡の途中から入った回は残りしか見ないので、刻みを外しても
  // 大きくならないことがある（fast と idle は同じ 2 秒の周期で位相が揃いやすい）。
  const fresh = () => ({ passes: 0, freshPasses: 0, freshMax: 0,
    total: { checkVisibility: 0, getComputedStyle: 0, getBoundingClientRect: 0 },
    max: { checkVisibility: 0, getComputedStyle: 0, getBoundingClientRect: 0 },
    recent: [] });
  let paths = {};
  const resetPaths = () => { paths = {}; for (const k of PATHS) paths[k] = fresh(); };
  resetPaths();
  let current = null;            // いま走っている（包んだ）コールバックの経路
  const inserts = [];
  // 入口の予約が何回走ったか（仕事の有無によらない）。試験が「周期の確認が当分来ない
  // 瞬間」を選ぶのに使う（直後の 1 回の予約は、次の間隔だけ先になる）。
  const ticks = { fast: 0, idle: 0, resume: 0 };
  const pendingResume = new Set();   // 予約されてまだ走っていない resume の timer ID
  // 製品の予約する関数の最初の文で、入口の経路を見分ける
  const classify = fn => {
    let src = '';
    try { src = typeof fn === 'function' ? Function.prototype.toString.call(fn) : ''; } catch (e) {}
    if (/^\(\)\s*=>\s*\{\s*fastTimer = null;/.test(src)) return 'fast';
    if (/^\(\)\s*=>\s*\{\s*latentResume = null;/.test(src)) return 'resume';
    if (/^\(\)\s*=>\s*\{\s*idleTimer = null;/.test(src)) return 'idle';
    return null;
  };
  /* 包んだコールバックを1回走らせる。走っているあいだの仕事を、その経路へ付ける。
     microtask は呼び出し元が返ってから走るので、入れ子にはならない（念のため戻す）。 */
  const runAs = (path, fn, args, timed) => {
    const prev = current, prevIn = inPass;
    const head = path !== 'resume' && pendingResume.size === 0;
    current = path;
    const t0 = performance.now();
    inPass = true;
    tally.checkVisibility = 0; tally.getComputedStyle = 0; tally.getBoundingClientRect = 0;
    try { return fn(...args); } finally {
      inPass = false;
      const w = { checkVisibility: tally.checkVisibility, getComputedStyle: tally.getComputedStyle,
                  getBoundingClientRect: tally.getBoundingClientRect };
      const any = w.checkVisibility + w.getComputedStyle + w.getBoundingClientRect > 0;
      if (timed || any) {
        durations.push(Math.round((performance.now() - t0) * 100) / 100);
        work.checkVisibility.push(w.checkVisibility);
        work.getComputedStyle.push(w.getComputedStyle);
        work.getBoundingClientRect.push(w.getBoundingClientRect);
        const p = paths[path] || paths.other;
        p.passes++;
        if (head) { p.freshPasses++; if (w.checkVisibility > p.freshMax) p.freshMax = w.checkVisibility; }
        for (const k of Object.keys(w)) { p.total[k] += w[k]; if (w[k] > p.max[k]) p.max[k] = w[k]; }
        p.recent.push(w.checkVisibility);
        if (p.recent.length > 12) p.recent.shift();
      }
      current = prev; inPass = prevIn;
      publish();
    }
  };

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
  setTimeout = (fn, ms, ...rest) => {
    // 経路は予約した時点で決める: 入口なら入口の名前、そうでなければ予約した側の経路
    const entry = classify(fn);
    const path = entry || current;
    let id = null;
    id = origTimeout((...a) => {
      pendingResume.delete(id);
      if (typeof ms === 'number' && ms >= SLOW_MS) { slowTicks++; publish(); }
      if (entry) { ticks[entry]++; publish(); }
      if (typeof fn !== 'function') return undefined;
      return path ? runAs(path, fn, a, false) : fn(...a);
    }, ms, ...rest);
    if (entry === 'resume') pendingResume.add(id);
    return id;
  };
  const origClear = clearTimeout;
  clearTimeout = id => { pendingResume.delete(id); return origClear(id); };
  if (typeof requestIdleCallback === 'function') {
    const origIdle = requestIdleCallback;
    requestIdleCallback = (fn, opts) => {
      const path = current;
      return origIdle(dl => (path ? runAs(path, fn, [dl], false) : fn(dl)), opts);
    };
  }

  /* 印を差し込んだ瞬間の経路を控える。content.js は印を `insertBefore` で入れる（annotate）。
     包むのは隔離された世界の Node.prototype なので、ページ側の呼び出しには触れない。 */
  const origInsert = Node.prototype.insertBefore;
  Node.prototype.insertBefore = function (node, ref) {
    const r = origInsert.call(this, node, ref);
    try {
      if (node && node.nodeType === 1 && node.classList && node.classList.contains('iiyaku-icon')) {
        const host = this.nodeType === 1 ? this.closest('[id]') : null;
        inserts.push({ path: current || 'batch', key: node.dataset ? node.dataset.iiyakuKey || null : null,
                       at: host ? host.id : null, t: Math.round(performance.now()) });
        if (inserts.length > 50) inserts.shift();
        publish();
      }
    } catch (e) { /* 数えるだけ。製品の挙動は変えない */ }
    return r;
  };

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
    localStorage.setItem('rg-paths', JSON.stringify(paths));
    localStorage.setItem('rg-inserts', JSON.stringify(inserts));
    localStorage.setItem('rg-ticks', JSON.stringify(ticks));
  };

  // 経路の無い予約（ページの変化の合図・カーソルの合図）は batch。
  // 暇なときの確認の中で予約したものは idle を持ち越す。
  queueMicrotask = fn => {
    const path = current || 'batch';
    orig(() => {
      n++;                      // 先に数える（陽性対照が 0 と区別できるように）
      runAs(path, fn, [], true);
    });
  };
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
      resetPaths(); inserts.length = 0;
      publish();
    }
  }, 20);
})();
