# 用語集

RepoGloss のコード・コメント・文書に出てくる言葉を、やさしく説明します。全体の流れは [ARCHITECTURE.md](./ARCHITECTURE.md) を見てください。

- 「根拠」の欄は、その言葉が実際に使われている場所（ファイル：おおよその行）です。行番号は v1.8.22 時点のおおよその位置です。
- 「（推測）」と書いたものは、コードから確かめられず、状況から考えた説明です。

---

## 1. この拡張の中だけで使う言葉

コードのコメントは、独自の日本語の言い回しで書かれています。

| 言葉 | やさしい説明 | 根拠 |
|---|---|---|
| 印（いん） | 用語の右に付く小さな ⓘ。中身が空の `<span>` で、丸と "i" は CSS で描く（文字の記号はフォントによって豆腐 □ になるため使わない） | `src/content.js:2498-2501`, `2703-2716`；`styles.css:36-41` |
| 吹き出し | 印に乗ったときに出る説明の箱（ツールチップ） | `src/content.js:2759-2766`, `2887-2908` |
| 切替ボタン | 画面右下の「解説 ON / 解説 OFF」のボタン | `src/content.js:4327-4370` |
| 入口（trigger） | キーボードで Tab を押して止まれる場所で、そこに止まると説明が出るもの。印そのもののこともあれば、印を含むリンクやボタンのこともある | `src/content.js:2154-2242` |
| standalone / hosted / skip | 印を入れる場所の 3 種類。standalone＝ふつうの文章（印そのものが押せる）、hosted＝リンクやボタンの中（そのリンクが入口で、印は飾り）、skip＝操作部品の中だが止まれない（今は付けない） | `src/content.js:2228-2242` |
| 注記 | 印を入れること | `src/content.js:3363-3369` |
| 走査 | ページの文章を端から順に調べること | `src/content.js:3469-3514` |
| 処理済み | 「この文章のかたまりはもう調べた」という目印。世代つきで覚えている | `src/content.js:111-122` |
| 世代（generation） | 処理済みの目印の通し番号。印が退役したときだけ進め、ページ全体を選び直す | `src/content.js:119-122`, `3303-3306` |
| 見え方の世代（visEpoch） | 「見え方が変わったかもしれない」たびに進める別の通し番号。同じ世代で一度見た控えは測り直さない | `src/content.js:3801-3818` |
| 控え（latent） | 辞書の語は含むが、そのときは見えなかった（または入口が無かった）文章の一覧。見え方が変わったときにここだけを見直す。上限 20,000 件で、上限でも捨てずに増やすのをやめるだけ | `src/content.js:124-159`, `3516-3606` |
| 控えの見直し | 控えの中で、見えるようになったものに印を付ける処理。候補 16 個ごとに経過時間を確かめ、8ms を超えていれば区切る（厳密な上限ではなく、1 回が 8ms を超えることはある） | `src/content.js:3523`, `3551-3606` |
| 記録（glossed） | 印を付けた語ごとに「どの文章を割り、何を作ったか」を覚えたもの。辞書の語数（61）が上限 | `src/content.js:160-169`, `3454-3459` |
| 整合（isCoherent） | 記録と今のページが食い違っていないか（印がまだ語の直後にあるか、ページに書き換えられていないか） | `src/content.js:3070-3171` |
| 使える（isUsable） | 印がまだ見えて、Tab で止まれるか | `src/content.js:3173-3224` |
| 退役（retire） | 使えなくなった印を片づけ、その語をまた印を付けられる状態に戻すこと | `src/content.js:3233-3275` |
| 引き取る | 入れた直後に「描かれていない」と分かった印を、押せなくしてから取り外すこと | `src/content.js:3418-3447`, `2619-2636` |
| 手放す（relinquish） | 印の「自分のもの」という記録を消し、中のボタンを押せなくすること。どの経路でもここ 1 か所を通る | `src/content.js:2619-2636` |
| 断定できない（'unknown'） | 見えるかどうかを確実に言えない状態。この場合は印を付けない（見えない押せる点を作らないため） | `src/content.js:2122-2138`, `1375` |
| 合言葉（UID） | 読み込むたびにランダムに作る名前（`iiyaku-` ＋ 8 文字）。ページ側や他の拡張と名前がぶつからないよう、印・属性・CSS のレイヤー名に混ぜる | `src/content.js:9-25`, `2711-2713` |
| 名札 | 印に付けている `data-iiyaku-…` の属性 | `src/content.js:2402-2404` |
| 予定表（expectedAttrs） | 自分がこれから書く「要素＋属性＋値」の控え。ページの変化を見張るとき、予定と完全に一致したものだけを自分が起こした変化として無視する | `src/content.js:2304-2380` |
| 複製（clone） | ページが、印を含む部分を丸ごとコピーしたもの。自分の印のふりをしたまま残らないよう、無力化する | `src/content.js:2431-2496` |
| まとめ直し（runBatch） | 同じ瞬間に来た変化の合図を 1 回にまとめて行う見直し | `src/content.js:3608-3688` |
| 合図 | 「見え方が変わったかもしれない」きっかけ（ページの変化・画面の大きさ・スクロール・カーソル・遷移など） | `src/content.js:3608-3612`, `3957-3977`, `4156-4167` |
| 暇なときの確認 | 合図が出ない変化に気づくための、約 2 秒ごとの確認 | `src/content.js:4169-4193` |
| 短い周期の見直し | 控えの件数に応じて 0.4〜2 秒ごとに控えだけを見直す確認 | `src/content.js:4195-4247` |
| 使いすぎの門（overBudget） | カーソルによる見直しが 2 秒のうち 200ms を超えたら、しばらくカーソルでは動かないようにする上限 | `src/content.js:3991-4009` |
| 覆い（ghost） | `pointer-events: none` などで当たり判定に出ないまま、印の上にかぶさって隠す箱。断定できるものだけを覆いと数える | `src/content.js:1436-1475`；細部（`1494-1853`）は未確認 |
| 指紋（fingerprint） | stylesheet の形（選択子・条件・宣言の本数など）を 1 つの数にまとめたもの。変わったかどうかを素早く見るため | `src/content.js:3850-3919` |
| 塗り直し | ページ側の色の指定で印のボタンが透明にならないよう、shadow の中だけで色を付け直すこと | `src/content.js:2641-2701` |
| 陽性対照 | 「検査がちゃんと働いている」ことを示すため、わざと悪い例をぶつけて、検査が落とすことを確かめること | `scripts/verify.mjs:221-223`, `1135-1142`；`tests/package.test.js:1-5` |
| 前方／後方 | 監査の記録で使う物差し。読めないはずの場所（前方）と、確実に読める場所（後方）に、それぞれ印がいくつ付くか | `docs/audit/v1.8.21-changes.md:9-12` |
| 第 N 回・RG-NN-MM | 外部監査の回と、その回の指摘番号。例：RG-23-01＝第 23 回監査の 1 番目の指摘 | `AUDIT.md:1-20`；`src/content.js` の各所（例 `2619`） |
| P1 / P2 | 監査の指摘の重さの区分（数字が小さいほど重いと読める（推測）） | `docs/audit/v1.8.21-changes.md:5` |
| `iiyaku` という接頭辞 | 属性名や保存の鍵に残る名前（`iiyakuEnabled` など）。改名前の名残と思われる（推測。README の 1.6.0 の行に「RepoGloss へ改名」とあり、`content.js` には「『意訳』とは書かない」という注記がある） | `src/content.js:8`, `4332`；`README.md:151` |

## 2. 配布と検査の言葉

| 言葉 | やさしい説明 | 根拠 |
|---|---|---|
| 配布物（配布 13 ファイル） | ストアへ出す ZIP に入れるファイル。一覧は `scripts/package-files.mjs` だけが決める | `scripts/package-files.mjs:1-18` |
| 提出用 ZIP / 提出候補 | ストアへ出すための ZIP。CI が作って検査したものだけを提出候補とする | `.github/workflows/ci.yml:129-160` |
| 合算ハッシュ（COMBINED_SHA256） | 配布物全部の中身を 1 つの値にまとめたもの。OS が違っても同じになるかを比べる | `scripts/package-stage.mjs:85-93` |
| SHA-256 / ハッシュ | ファイルの中身から作る「指紋」の値。1 文字でも違えば別の値になる | `scripts/package-stage.mjs:19` |
| 身元（provenance） | その ZIP が、どのコミットの、どの CI 実行から出たかの記録（`dist/<zip名>.json`） | `scripts/package-zip.mjs:94-125`；`scripts/provenance.mjs:1-8` |
| UNCOMMITTED | 配布の対象のファイルに commit していない変更があるまま、試しに ZIP を作ったとき（`--allow-uncommitted`）、名前に付く印。提出物と取り違えないため | `scripts/package-zip.mjs:6-8`, `46-48` |
| `dist/` | 配布物を並べる作業場所。Git には入れない | `.gitignore:13-15` |
| 監査入口 | `AUDIT.md` のこと。外部監査に必要な情報をここに集める | `AUDIT.md:1-7` |
| 監査対象のタグ | `AUDIT.md` の `tag:` 欄。値が入っていると、`verify.mjs` がそのタグと今の配布物が同じかを確かめる（今は `null`） | `AUDIT.md:53-57`；`scripts/verify.mjs:1530-1560` |
| `# CHANGED:` / `# UNCHANGED:` | `AUDIT.md` に書く「前の版から変わった／変わらない配布ファイル」の一覧。`verify.mjs` が `git diff` の実測と突き合わせる | `AUDIT.md:33-34`；`scripts/verify.mjs:1490-1528` |

## 3. 一般の技術用語

| 言葉 | やさしい説明 | 根拠 |
|---|---|---|
| Chrome 拡張 / Manifest V3 | Chrome に機能を足す小さなプログラムと、その申告書（`manifest.json`）の今の形式 | `manifest.json:2` |
| content script | 拡張が、開いているページの中で動かす JavaScript。この拡張では `matcher.js` と `content.js` | `manifest.json:22-27` |
| 隔離された世界（isolated world） | content script が動く、ページ自身の JavaScript とは別の空間。ページからは中の変数が見えない | `tests/e2e/latent-probe.js:1-12`；`tests/e2e/helpers/chrome.mjs:54-60` |
| web_accessible_resources | 拡張に同梱したファイルのうち、ページの中から読めるようにするもの。ここでは辞書と CSS だけ | `manifest.json:29-34` |
| `chrome.storage.local` | 拡張用の、端末の中だけにある保存場所。ON/OFF の真偽値だけを入れる | `src/content.js:5-8`, `4362` |
| DOM | ページを形づくる部品（要素や文字）の木のような並び。JavaScript から読み書きできる | `src/matcher.js:2-3` |
| テキストノード | DOM の中の「文字だけの部品」 | `src/content.js:3500-3510` |
| MutationObserver | DOM が変わったことを知らせてくれるブラウザの仕組み | `src/content.js:3716-3779` |
| `checkVisibility` | 要素が見えるかどうかを、祖先の透明度なども含めて答えるブラウザの機能。Chrome 105 以降にある | `src/content.js:172-193`；`README.md:24` |
| shadow root / closed shadow root | 要素の中に作る、外から見えない小部屋。closed だとページの JavaScript から中を取り出せず、コピーしても中身は写らない | `src/content.js:2502-2520` |
| カスケードレイヤー（`@layer`） | CSS の優先順位をまとめて決める仕組み。この拡張がページへ入れる見た目（`styles.css` の `RG_SHADOW_BEGIN` より前）はレイヤーに入れてあり、ページが同じ性質を指定すればページが勝つ。例外として、closed shadow root の中で使う区間（`RG_SHADOW_BEGIN`〜`RG_SHADOW_END`）はレイヤーに入れない（ページの規則が届かず、譲る相手がいないため） | `styles.css:1-27`, `258-268`；`src/content.js:18-25`, `2527-2543`, `4413-4418` |
| CSSOM | CSS を JavaScript から読み書きする仕組み。ここで値だけを書き換えると DOM には何も出ない | `src/content.js:4195-4206` |
| adoptedStyleSheets | JavaScript で作った stylesheet を、`<style>` タグなしで文書や shadow root に付ける仕組み | `src/content.js:1477-1484`, `2557-2560` |
| `aria-*` / `role` / `tabindex` | 読み上げソフトやキーボード操作のための属性。「これはボタン」「Tab で止まれる」などを伝える | `src/content.js:2718-2757` |
| `isTrusted` | その操作が本物の利用者によるものか（ページのスクリプトが作ったものではないか）を示す印 | `src/content.js:4346-4358` |
| `inert` / `hidden` / `aria-hidden` | ページが「ここは操作できない」「表示しない」「読み上げない」と示す属性。この拡張はその中を調べない | `src/content.js:74-94` |
| E2E（End to End） | 本物のブラウザで、利用者と同じ形で動かして確かめるテスト | `tests/e2e/extension.e2e.mjs:1-10` |
| CDP（Chrome DevTools Protocol） | テストのプログラムから Chrome を外から操作する通り道。E2E で拡張を読み込ませるのに使う | `tests/e2e/helpers/chrome.mjs:1-8` |
| headless | 画面を出さずに動かすブラウザ | `src/content.js:2986` |
| CI / GitHub Actions | GitHub 上で、push のたびに検査を自動で走らせる仕組み | `.github/workflows/ci.yml:1-12` |
| artifact（成果物） | CI の実行が残すファイル（ここでは提出用 ZIP やハッシュの値） | `.github/workflows/ci.yml:70-76`, `152-160` |
| `node --test` | Node.js に入っている標準のテストの道具 | `package.json:5` |
| ZIP / deflate | ファイルをまとめて縮める形式と、その縮め方。この拡張は自前の小さな実装で作る | `scripts/zip.mjs:1-12` |
| MIT ライセンス | 著作権表示とライセンス文を残せば、自由に使い・変え・配ってよいという許可 | `LICENSE:1-21` |
