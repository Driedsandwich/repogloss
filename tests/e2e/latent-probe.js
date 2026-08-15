/*
 * 控えの見直しが `Element.checkVisibility` を何回呼ぶかを、**隔離された世界の中から**数える。
 *
 * ⚠️ ページ側の世界から `Element.prototype.checkVisibility` を包んでも数えられない。
 * content script は別の世界で動き、`Element.prototype` もそちらのものだからである
 * （最初これで数えて、v1.8.17 でも v1.8.18 でも 0 回という誤った値を得た）。
 * 世界の中へ入る経路は、同じ拡張の content script として読み込むことだけ。
 *
 * 結果は `localStorage` へ書く（世界をまたいで読めるのはここ）。
 * 陽性対照: 読み込んだ直後に自分で1回呼び、`rg-cv-selftest` が 1 になることを確かめられる。
 * 0 のままなら包みが効いていない。
 */
(() => {
  const orig = Element.prototype.checkVisibility;
  if (typeof orig !== 'function') {
    localStorage.setItem('rg-cv-selftest', 'no-api');
    return;
  }
  let n = 0;
  Element.prototype.checkVisibility = function (...a) {
    n++;
    localStorage.setItem('rg-cv', String(n));
    return orig.apply(this, a);
  };
  localStorage.setItem('rg-cv', '0');
  document.documentElement.checkVisibility();          // 陽性対照
  localStorage.setItem('rg-cv-selftest', String(n));
  setInterval(() => {
    if (localStorage.getItem('rg-cv-reset') === '1') {
      localStorage.removeItem('rg-cv-reset');
      n = 0;
      localStorage.setItem('rg-cv', '0');
    }
  }, 20);
})();
