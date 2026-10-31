/*
 * 隔離された世界の中で、**`Set` がいちばん大きくなったときの要素数**と、`Set.add` の
 * 呼び出し回数を数える（第24回 RG-24-06）。
 *
 * 覆いの候補（content.js の ghostPool）は `Set` に集める。候補の数の上限（20,000）を
 * 「全部足した後」で見ていたため、30,000 要素に当たる選択子 1 つで 30,000 件を足してから
 * 諦めていた。`getComputedStyle` の回数（timing-probe.js）は、諦めた後のループの手間しか
 * 映さないので、この見落としを捕まえない。ここでは**集める段そのもの**を見る。
 *
 * ⚠️ 数えるのは、この世界の**すべての** `Set` の `add` で、候補の集合だけではない。
 *    製品が他に大きな `Set` を作れば、それも最大値に入る（＝上限の約束を破る向きにしか
 *    動かないので、試験が甘くなることはない）。`new Set(並び)` も内部で `add` を呼ぶので
 *    数えられる。
 * content.js より**先に**読み込むこと（manifest の順序を差し替える）。
 *
 * 陽性対照: 読み込んだ直後に自分で 3 件の `Set` を作り、`rg-set-selftest` に最大値を
 * 書く。3 にならなければ包みが効いていない（「小さかった」と「数えられていない」を分ける）。
 * 公表先は localStorage（<html> の属性へ書くと content.js のまとめ直しを呼ぶ → batch-probe.js）。
 *   `rg-set` … { max: いちばん大きな Set の要素数, adds: add の回数 }（リセットから）
 *   `rg-set-reset` に '1' を書くと数え直す
 */
(() => {
  const orig = Set.prototype.add;
  let max = 0, adds = 0, dirty = true;
  Set.prototype.add = function (v) {
    const r = orig.call(this, v);
    adds++;
    if (this.size > max) max = this.size;
    dirty = true;
    return r;
  };
  const publish = () => {
    if (!dirty) return;
    dirty = false;
    localStorage.setItem('rg-set', JSON.stringify({ max, adds }));
  };

  // 陽性対照
  const self = new Set([1, 2, 3]);
  localStorage.setItem('rg-set-selftest', String(self.size === 3 ? max : -1));
  max = 0; adds = 0;
  publish();

  setInterval(() => {
    if (localStorage.getItem('rg-set-reset') === '1') {
      localStorage.removeItem('rg-set-reset');
      max = 0; adds = 0; dirty = true;
    }
    publish();
  }, 20);
})();
