/*
 * テスト専用。配布物には入らない（scripts/package-files.mjs の一覧に無い）。
 *
 * Element.checkVisibility が無い環境を、隔離された世界の中で作る。
 * 本体より先に読み込ませ、拡張から見える prototype からだけ取り除く
 * （隔離世界の prototype なので、ページ側の JS には影響しない）。
 *
 * 何のためか: manifest の minimum_chrome_version を「付けるか、付けずに
 * 代替手段で支えるか」を決めるための材料。祖先の opacity / content-visibility /
 * 全面 clip は、この API が無いと直接の親を見るだけでは見抜けない。
 * その差を、推測ではなく印の付き方の差として出す。
 */
delete Element.prototype.checkVisibility;
document.documentElement.setAttribute('data-rg-no-checkvisibility', 'ready');
