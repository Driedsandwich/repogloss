# 監査のための資料（第15回監査用）

このファイルは、外部監査を受けるための入口です。**このリポジトリだけを読めば監査に必要な情報が揃う**ようにしてあります。

RepoGloss は、GitHub の画面に出てくる英語のうち Git / GitHub 固有の用語に印を付け、日本語の説明を出す Chrome 拡張です。作者は非エンジニアで、実装は AI エージェントとの共同作業によります。**そのため、外部監査に合格するまでウェブストアへ提出しない**という運用にしています。

> このファイルと `docs/audit/` は**配布物には入りません**（[`scripts/package-files.mjs`](scripts/package-files.mjs) が配布物の唯一の正本）。監査用の資料であり、拡張の動作には関係しません。

---

## 1. 監査対象

| 項目 | 値 |
|---|---|
| **監査対象** | **`v1.8.14` 候補（未コミット）**。基点は `v1.8.13` = コミット `54f98991b3bf3838012484e4a9c4ce1462fab8d5` |
| 直前の版 | `v1.8.13` = コミット `54f98991b3bf3838012484e4a9c4ce1462fab8d5`（**第15回監査の指摘により提出しない**） |
| 基点コミット | `50026b45934e79406fb8c7abbf17e5d4946568a4`（ここからの差分が今回の変更） |
| 現在の既定ブランチ | `main` |
| Manifest | v1.8.14 / Manifest V3 |
| **最低の Chrome** | **105**（`minimum_chrome_version`。v1.8.6 で追加） |
| Chrome API 権限 | `storage` のみ |
| サイトアクセス | `https://github.com/*` |
| `host_permissions` | 宣言なし |
| 実行されるコード | [`src/matcher.js`](src/matcher.js) と [`src/content.js`](src/content.js) の2本（同梱のみ・リモートコードなし） |
| 外部依存パッケージ | **なし**（`package.json` は検証用の scripts だけ。ZIP 生成も Node 標準の `zlib` で自作） |
| ストア公開中の版 | **v1.7.1**（v1.8.0〜v1.8.14 はいずれも未提出） |

差分は次のコマンドで確認できます。

```sh
git checkout v1.8.14                     # 監査対象を手元に出す
git diff --name-only v1.8.13 v1.8.14     # 直前の版との差分
# → 配布13ファイルのうち manifest.json・src/content.js・README.md・DESIGN.md・
#    PRIVACY.md が変わっている（辞書・matcher.js・styles.css・アイコン・LICENSE は無変更）
# → ほかに scripts/ と tests/ と docs/（配布物には入らない）
```

**この時点では commit も push もタグ付けもしていません。** 提出候補 ZIP は、タグを打ったあとに `main` の CI が作ります。ストアへは未提出です。

> **監査対象と `main` の関係について（第11回 RG-11-06 の是正）。** 前回まで、監査対象を「`main` の先頭」と**相対的に**書いていました。提出候補の SHA を記録するコミットを1つ積んだ時点で、その記述は事実でなくなります（実際にそうなりました）。いまは対象をタグとコミットだけで名乗り、**現在の `main` の SHA はここに書きません**——書けば、その値もまた次のコミットで古くなるためです。両者の関係は文章ではなく検査で担保します。`state` が `uncommitted` でないとき、`verify` が「ここが名乗るタグと、いまの配布13ファイルが同じか」を `git diff` で突き合わせ、タグを引けない環境では**通しません**。

### 1-1. 提出候補

**提出候補は、`main` の CI が作った成果物です。** 手元で作ったものは `--release` 検査で落ちるようにしてあり、提出するのは常に CI が出したものだけです。

現在版の事実を、機械で読める形で1か所にまとめます（**ここが正本**。他の節はここを引用します）。

```yaml
version:            1.8.14
state:              uncommitted        # commit / push / tag / CI・Release・ストア提出は未実施
base_commit:        50026b45934e79406fb8c7abbf17e5d4946568a4
commit:             null               # 未コミット
tag:                null               # 未作成
candidate_zip:      null               # タグ後に main の CI が作る
candidate_bytes:    null
candidate_sha256:   null
content_sha256:     null
combined_sha256:    null
workflow_run:       null
superseded:
  - version: 1.8.13
    tag: v1.8.13
    commit: 54f98991b3bf3838012484e4a9c4ce1462fab8d5
    zip: repogloss-1.8.13.zip
    sha256: f8ad0962f151b7c3bea3922c16bfcf8d821add065c0f926e2951b9dd022eefbf
    reason: 第15回監査の指摘により提出しない
  - version: 1.8.12
    tag: v1.8.12
    commit: 5afa0e284a199377902067df9c3cb582ec9b2051
    zip: repogloss-1.8.12.zip
    sha256: a107c2119ccc1c3b31b32699300d5ea73a1e85549339418ad31d543fb75018bd
    reason: 第14回監査の指摘により提出しない
  - version: 1.8.11
    tag: v1.8.11
    commit: 92bd593e35839b448f97b051ab427e7a1384c398
    zip: repogloss-1.8.11.zip
    sha256: a3da61d5083900da8e535e6ec346b6d8f76f85841339b090c2e03a5a4933ea3f
    reason: 第13回監査の指摘により提出しない
  - version: 1.8.10
    tag: v1.8.10
    commit: aaa770d687ed5861785f629e494662823ba7d875
    zip: repogloss-1.8.10.zip
    sha256: c194a9cbabd6496fc97d056b5713fcc2036e258745b43cfae29ecc874ce32fce
    reason: 第12回監査の指摘により提出しない
  - version: 1.8.9
    tag: v1.8.9
    commit: cea7a29590747f110d6cda68c162d339499c5fdf
    zip: repogloss-1.8.9.zip
    sha256: 4f1f3166c8ee35b76786f6062307a96a6ea25772fc0d51dfdb06a9623d70112f
    reason: 第11回監査の指摘により提出しない
  - version: 1.8.8
    tag: v1.8.8
    commit: 6c1351a5b98539a61e854310503fd92ad59a7d24
    zip: repogloss-1.8.8.zip
    sha256: d3a2786ba0f87ac51a75bcb6e9186a6ae3e86ea93ef804905da7fefebcf9bfac
    reason: 第10回監査の指摘により提出しない
  - version: 1.8.7
    tag: v1.8.7
    commit: 308bf038efe18f857bf5bb655bce65b991712a93
    zip: repogloss-1.8.7.zip
    sha256: 9f590f7c299d8c5f4bd62fc9cf87a5a9a2c8215945683faca76d0cf496afb93e
    reason: 第9回監査の指摘により提出しない
  - version: 1.8.6
    tag: v1.8.6
    commit: 3848b89a9cdc7df62dc2eaff8c4ae4b6e6e18086
    zip: repogloss-1.8.6.zip
    sha256: 6603ca7a2f7653f3786b197b4058bfc45c354a8c5692dcdd5e3cf2455018ba35
    reason: 第8回監査の指摘により提出しない
store_published:    1.7.1
```

取り下げた版のタグと ZIP は、すべて保存したまま動かしていません（`v1.8.13` を打った前後で、既存34 ref が1文字も動いていないことを `refs/tags` 一覧の突き合わせで確認済み。1件の改変なら検出できることも対照で確かめてあります）。

**提出候補は、タグの中身と1バイトも違いません。** CI の run `31490364915` の `release-zip` が出した成果物を落として展開し、13ファイルを `git show v1.8.13:<path>` と突き合わせて **13/13 一致**（対照の `v1.8.12` とは5ファイルで相違）。`--release` 検査にも合格しています（`EXIT=0`。中身に6バイト足した ZIP では `EXIT=1`・`NG: src/content.js の中身が今のファイルと違う` になることも同じ実行で確かめました）。

**ZIP は誰でも再現できます。** 日時を 1980-01-01 に固定し、並び順を配布一覧の順に固定してあるため、同じ内容からは1バイト違わない同じものができます。配布13ファイルの合算ハッシュは **ubuntu / macos / windows / 手元 macOS の4者で完全に一致**しています（`1386abe9…`）。

```sh
npm run package:zip -- --allow-uncommitted   # commit 前に試す場合。名前に UNCOMMITTED が入る
npm run package:verify-zip                   # 中身と身元の記録を検査する
```

---

## 2. 今回（v1.8.14）で直したこと

第15回監査の指摘 **P1 4件・P2 5件**のうち **7件**への対応。詳細と証拠は [`docs/audit/v1.8.14-changes.md`](docs/audit/v1.8.14-changes.md)。

| ID | 内容 | 対応 |
|---|---|---|
| RG-15-01（P1） | 同じ節点で1つ目が隠れていると、読める2つ目が候補から消える | 見え方で絞ってから、キーを1つにする（`findHits(..., {all:true})`） |
| RG-15-02（P1） | `inset(... round …)` の角ごとの半径を先頭1値へ縮約 | 1〜4値と `/` を角ごとの `rx`/`ry` へ展開（`cornerRadii`） |
| RG-15-03（P1） | 別々の断片が別々の形を通るだけで合格する | **同じ断片が全部の条件を通る**ことを要求 |
| RG-15-04（P1） | 画面外へ固定された語に、見えない Tab の停止点を作る | 画面／スクロールで出せる範囲との交差を要求（入れ子のスクロール領域は除く） |
| RG-15-05 | 透明な文字を可視として扱う | `color` / `-webkit-text-fill-color` が透明で縁取りが無ければ不可視 |
| RG-15-07 | 150ms の間引きに trailing が無い | 窓が明けたあとに最後の1回を必ず処理する |
| RG-15-08 | 名札を全部消された複製が停止点として残る | 自分が書く読み上げ名（`「…」の解説`）でも見分ける |
| RG-15-09 | 監査入口の表題・基点が前巡のまま | 第15回・基点 `50026b45…` へ |

**⚠️ 未対応が2件あります。** **RG-15-06**（カスケードレイヤーの名前衝突・`iiyaku-off` の衝突）と、**RG-15-05 の後半**（`filter` の並び順を解いていない）は、この版では直していません（本人の判断で次の版へ）。残る影響は [`docs/audit/v1.8.14-changes.md`](docs/audit/v1.8.14-changes.md) に書きました。

**7件すべて、直す前に v1.8.13 の実物で再現しました。** 通算15巡で 121 件の指摘があり、事実と異なるものは 0 件です。

### 2-0b. 直前（v1.8.12）で直したこと（履歴）

第13回監査の指摘 P1 1件・P2 6件への対応（[`docs/audit/v1.8.12-changes.md`](docs/audit/v1.8.12-changes.md)）。切り取りを矩形として積み上げ語の矩形と交わるかで決める／カーソルとフォーカスを合図にする／複製の判定を合言葉だけにする／「作ったことがある」記録の廃止／予定の1回消費と `<html>` の見張り／控えの時間予算と上限の旗。

### 2-0. 直前（v1.8.10）で直したこと（履歴）

第11回監査の指摘 P1 2件・P2 4件への対応（[`docs/audit/v1.8.10-changes.md`](docs/audit/v1.8.10-changes.md)）。

| ID | 内容 | 主な変更箇所 |
|---|---|---|
| RG-11-01 | 見え方の合図で、既にある印を確かめ直すだけ。最初に隠れていた語は永久に説明されない | 見えなかった節点を控え、合図のときにそこだけを見直す（`latent` / `discoverLatent`） |
| RG-11-02 | 退役で所有を取り消さず、合言葉も記録の不変条件でなかった | 退役時に所有を取り消す。合言葉の値を不変条件に。複製は自分の説明文で見分ける |
| RG-11-03 | 吹き出しと切替ボタンを class 名で見分けていた | `tip` / `toggleBtn` の要素同一性で見分ける。除外一覧と CSS も合わせる |
| RG-11-04 | 半径を省いた `circle()` と、参照ボックスだけの指定を取りこぼす | 行頭の `at` でも切る。既定の `closest-side` を計算。箱だけの指定も解く |
| RG-11-05 | 1回のページ変更で、まとめ直しが2回走る | 本文を割ったときの2つの変更を、自分のものとして受け取って消す |
| RG-11-06 | 監査入口が対象を「`main` の先頭」と相対的に名乗っていた | 相対表現をやめ、タグと配布物の一致を `verify` で突き合わせる |

見えなかった語を控えて探し、退役で所有を取り消し、複製を自分の説明文で見分け、吹き出しと切替ボタンを要素同一性で見分け、切り取りの半径省略と参照ボックス単独を解き、自分が起こした変更を数えないようにした。

### 2-0a. さらにその前（v1.8.9）で直したこと（履歴）

第10回監査の指摘 P1 3件・P2 4件への対応（[`docs/audit/v1.8.9-changes.md`](docs/audit/v1.8.9-changes.md)）。属性の絞り込みを撤廃し、子の追加でも見え方を確かめ直し、遷移・画面幅・`<head>` の変化を1つの予約口へ集め、自分の変更を「要素＋属性名＋値」の予定表で決め、切り取りに参照ボックスとキーワード半径を足した。

### 2-0a. さらにその前（v1.8.8）で直したこと（履歴）

第9回監査の指摘 P1 4件・P2 4件への対応（[`docs/audit/v1.8.8-changes.md`](docs/audit/v1.8.8-changes.md)）。記録の「形が整っている」と「まだ使える」を分け、`characterData` と見え方に関わる属性を見張り、語の末尾を固定し、入口の意味を解き直し、所有を内部の表へ移し、切り取りを箱の寸法で判定するようにした。

### 2-0b. さらにその前（v1.8.7）で直したこと（履歴）

第8回監査の指摘 **P1 3件・P2 2件**への対応です。詳細と証拠は [`docs/audit/v1.8.7-changes.md`](docs/audit/v1.8.7-changes.md) にあります。

| ID | 内容 | 主な変更箇所 |
|---|---|---|
| RG-8-01 | 最初の印を含む場所が消えても、既にページにある2番目の候補へ引き継がれなかった | 世代つき `handled` と `reselect` |
| RG-8-02 | 語と印の対応が壊れても、印だけを見て「説明済み」と抑止していた | `isCoherent` / `reconcileGlosses` |
| RG-8-03 | 切り取りの判定に取りこぼしがあり、`display:contents` では落としすぎていた | `rectClipsAll` / `insetClipsAll` |
| RG-8-04 | 注記済みの領域が複製されると、所有していない印と入口 ID が残っていた | `ownedIcons` / `sanitizeClones` |
| RG-8-05 | 文書に現在版との食い違いがあり、配布物の中でリンクが切れていた（実際は9件） | 文書一式＋`verify.mjs` |

さらにその前（v1.8.6）は、第7回監査の指摘 **P1 3件・P2 5件**への対応でした（[`docs/audit/v1.8.6-changes.md`](docs/audit/v1.8.6-changes.md)）。

| ID | 内容 | 主な変更箇所 |
|---|---|---|
| RG-7-01 | `display:contents` の可視性を、箱を持つ先祖の1つの答えで代用していた | `isVisibleContentsText` |
| RG-7-02 | 印を片づけるとき、隣にあるものを「自分が割った対」と推し量っていた | 注記時の記録と `retireGloss` |
| RG-7-03 | プライバシー文書が、本文に出た認証情報らしき文字列の一時処理を落としていた | [`PRIVACY.md`](PRIVACY.md) |
| RG-7-04 | legacy `clip` を `position` を見ずに判定し、読める文章を除外していた | `clipsAwayContent` |
| RG-7-05 | 動作に必要な最低の Chrome を宣言していなかった | [`manifest.json`](manifest.json) |
| RG-7-06 | 提出物の身元の検査が、項目の欠落を落とせなかった | [`scripts/provenance.mjs`](scripts/provenance.mjs) |
| RG-7-07 | 隔離世界の計測が「取り出し口を6つ塞ぐ」方式だった | [`tests/e2e/matcher-tap.js`](tests/e2e/matcher-tap.js) |
| RG-7-08 | `AUDIT.md` に旧版の記載が残り、検査で見つけられなかった | 文書一式＋`verify.mjs` |

### 2-1. 中心にあった誤り

**「先祖は確認済み」という前提が成り立っていませんでした。**

`isTarget()` が可視性を確認しているのは、辞書語を含むテキストノードの**直接の親**だけです。ところが入口を探すときは、そこから上へ `HOST_CANDIDATE` をたどります。先祖は別の要素なので、直接の親が見えていることは何の保証にもなりません。

- `display: contents` の先祖は箱を作らないため、子が見えていても Tab の順路に入らない
- `visibility: hidden` の先祖の中で、子だけ `visibility: visible` に戻すことができる

速度のために描画確認を省いた結果、**到達できない要素を「説明の入口」として扱い、印は `aria-hidden` の装飾のまま残していました。** キーボードからその説明へ到達する手段が無くなります。

省略をやめ、速度は**走査1回のあいだだけ有効な `WeakMap`** で回収しました。

### 2-2. roving tabindex の扱いを全廃した判断

`role` と容器と `tabindex` の 0/-1 の並びが揃っていても、実際に矢印キーで移動できるかは「keydown を受けて `focus()` を動かす実装があるか」で決まります。DOM の形からは判定できません。構造だけで認めていた版は、**構造は正しいのに矢印に応答しない部品**を到達可能と誤判定していました。

**この判断で注記が減らないことを、実際の github.com で測ってから決めました**（2026-08-06・拡張として読み込んだ状態・幅1600px）。

| ページ | 印 | roving 推定に依存していた注記 | `readme` の入口 |
|---|---:|---:|---|
| `octocat/Hello-World` | 20 | **0** | `a.Link--primary`（tabIndex 0） |
| `k88hudson/git-flight-rules` | 41 | **0** | `a.Link--secondary`（tabIndex 0） |
| `octocat/Spoon-Knife`（ファイル一覧あり） | 14 | **0** | `li#README.md-item[role=treeitem]`（**tabIndex 0**） |
| `octocat/Hello-World/tree/master` | 20 | **0** | `a.Link--primary`（tabIndex 0） |

ファイル一覧は確かに描画されています（`role=tree` あり・`treeitem` 3件・tabIndex は `[0,-1,-1]`）。**`readme` は roving の「入口側」に付いており、`-1` の項目ではありませんでした。**

> **過去の記録の訂正**: 2026-08-05 に「roving を除外したら `readme` の注記が落ちた」と記録し、そこから「構造が揃っていれば到達可能とみなす」という規則を作りました。測り直した結果、**その因果は成り立ちません**。誤った帰属から作った規則が RG-4-02 の原因です。[`DESIGN.md`](DESIGN.md) の 3-2 と 5 に訂正を書いてあります。

v1.8.2 と v1.8.3 で、**注記される語の集合は3ページとも完全に一致**します（件数ではなくキーの集合まで突き合わせ）。

---

## 3. キーボード到達性の不変条件

```text
入口（trigger）として使ってよいのは、次をすべて満たす要素だけ:
  1. el.isConnected
  2. input[type=hidden] でない
  3. el.matches(':disabled') でない   （fieldset[disabled] の継承と、最初の legend の例外を含む）
  4. el.closest('[inert]') が無い
  5. el.tabIndex >= 0                 （ブラウザが解釈した後の値を使う）
  6. getComputedStyle が display:none / visibility:hidden|collapse でない
  7. el.getClientRects().length > 0   （display:contents はここで落ちる）

  ※ 6 と 7 は「その要素自身」について必ず確認する。先祖・子孫から推し量らない。
  ※ label は自身を入口にせず、label.control を 1〜7 で判定する。
  ※ tabIndex < 0 は、role や容器が何であっても入口にしない。
```

入口が見つからなければ、その語には注記しません（`skip`）。**`aria-hidden` な印だけを残すことはしません。** 見送った語は、同じページの後方のふつうの文章で説明されます。

---

## 4. 検証の結果

### 4-1. 手元（macOS 26 / Google Chrome 151.0.7922.76 / Node.js v22.22.3・2026-08-11）

下は手元での実行結果です。**この版はまだ CI を通していません**（§4-2）。

| command | exit | 結果 |
|---|---:|---|
| `node --check src/matcher.js` / `src/content.js` | 0 | 構文 OK |
| `npm test` | 0 | 単体 **63件**全成功 / 構成検査 **284項目**・不一致0（辞書61語・version 1.8.13） |
| `npm run test:e2e` | 0 | **193件**全成功（v1.8.11 は 161件） |
| `npm run package:stage` / `:verify` | 0 | 13ファイル一致 |
| `npm run package:zip -- --allow-uncommitted` / `:verify-zip` | 0 | 13ファイル（名前に `UNCOMMITTED` が入る。**提出候補ではない**） |
| `npm run package:verify-zip -- --release` | **1** | **意図どおり落ちる**（手元ビルドは提出候補として通さない） |

**新しい試験に判別力があることも確かめています。** v1.8.11 の実装へぶつけると、**26件中18件が失敗**します。通る8件には理由があります——落としすぎを見張る対照3件（v1.8.11 も正しく振る舞う）、v1.8.10 で既に直っていた複製2件、付随の確認1件（印が付かない版では自明に成り立つ）、計装の陽性対照1件、時間の閾値1件（v1.8.11 の実測は 32.7〜60.6 ms とばらつき、50ms の線を下回る回がある）。

> **検査の件数は `state` によって変わります。** タグを打つ前は **284 件**、`tagged` へ進めるとタグとの突き合わせ4件が加わり **287 件**になります（代わりに「この状態では求めない」の1件が走らなくなります）。件数だけを見て「検査を足した／減らした」と読まないでください。

### 4-1b. 性能（2026-08-11）

初回走査を v1.8.12 と比べました（**実行順は交互に反転**）。切り取りだらけの最悪の形のページ（400行・全行 `overflow:hidden`・1/3 に `clip-path`）です。

| | v1.8.12 | v1.8.13 |
|---|---|---|
| 4組の実測 | 15.9 / 27.6 / 25.3 / 16.4 ms | 27.5 / 30.2 / 23.3 / 21.9 ms |
| 中央値 | **25.3 ms** | **27.5 ms** |

**4組中3組で新版が遅く出ました**（中央値 +2.2 ms）。ただし**同じ版の中のばらつき（15.9〜27.6 ms）が版差より大きい**ので、「何 ms 遅くなった」とは言い切れません。方向として遅い側に出ていることだけを事実として記します。

遅くなる理由は説明できます。可視性を**語の範囲**で見るようにしたため、一致ごとに Range を作って矩形を取ります（以前は親要素の箱の大きさで済ませる近道がありました）。その近道こそが RG-14-01 の原因だったので、戻せません。

控えの見直し（20,000件で8ms の予算）と、カーソルの合図の間引き（150ms）は v1.8.13 でも同じです。

### 4-2. CI（未実行）

**この版はまだ commit も push もしていないので、CI を通していません。** タグを打ったあとに `main` で8ジョブを走らせ、結果と提出候補 ZIP の SHA-256 をここへ記録します。

直前の v1.8.13 は run [`31490364915`](https://github.com/Driedsandwich/repogloss/actions/runs/31490364915) で8ジョブすべて success でした（当時）。

---

## 6. 権限・通信・保存データ（v1.8.13 → v1.8.14 の差分）

```text
permissions:                 ['storage'] → ['storage']（差分なし）
minimum_chrome_version:      なし → "105"（新規。配信先を絞るだけで、権限ではない）
host_permissions:            なし → なし
optional_permissions:        なし → なし
optional_host_permissions:   なし → なし
background:                  なし → なし
content_scripts.matches:     ['https://github.com/*'] → 同
content_scripts.js:          ['src/matcher.js','src/content.js'] → 同
web_accessible_resources:    差分なし（locales/dict.json のみ）
外部通信:                     追加なし。配布 JS 内の fetch は chrome.runtime.getURL の同梱辞書1件のみ
                             （eval / new Function / XMLHttpRequest / WebSocket / sendBeacon /
                              外部URL は 0件。陽性対照つきで走査）
保存データ:                   ON/OFF の真偽値 iiyakuEnabled のみ（変更なし）
辞書:                        61 → 61 語。キーの集合も説明文も完全に同一
外部依存パッケージ:            追加なし
```

**動作は変わっていません。変えたのは申告と説明です。**

---

## 7. 意図的に直していない既知の制約

「まだ確認していないこと」を「確認済み」と書かないための一覧です。

| # | 内容 | 理由 |
|---|---|---|
| 1 | **実スクリーンリーダー（NVDA / VoiceOver）未確認** | 環境がない。DOM とキーボードの E2E は実施しているが、実際の読み上げとは別物として扱い、成功扱いにしない |
| 2 | **Windows 実機の目視未確認** | CI で windows-latest の E2E は通っているが、**字形やレイアウトの見た目は確認していない**。CI の成功と目視確認は別のものとして区別する |
| 3 | **200% / 400% ズーム、高コントラスト系テーマ未確認** | 同上 |
| 4 | **`MutationObserver` が属性の変化だけでは再走査しない** | 見張っているのはノードの追加と URL の変化。要素が `display:none` や `inert` へ**変わっただけ**では、その場では追随しない。ただし**そのあと新しいノードが追加されれば、そこで使えなくなった古い印は片づけて付け直す**（3-2-3 の `usableGloss`）。第5回監査が必須とした「不可視化のあとに可視の候補が現れた場合」は直してある。属性変化だけの即時追従は、費用に見合わないため見送る |
| 4-b | **テキストノードの中身だけが差し替わる更新を追わない**（`characterData`） | 実害が再現していないため据え置き（前回監査の方針どおり） |
| 5 | **Developer Dashboard の実文言未読** | 提出者のログインが必要な画面。§5 のとおり転記欄を用意した |
| 6 | 実サイト計測は macOS の headless Chrome 151・幅1600px・4ページのみ | 他の画面幅やログイン状態では結果が変わりうる |
| 7 | ZIP の検査は自作の読み書き実装に依存 | 緩和として、Python の `zipfile` と `unzip -t`（いずれも無関係な実装）でも読めることを確認している |
| 8 | **ZIP のバイト再現性は、確認した Node/zlib の版でのみ実測** | deflate の出力は zlib の版に依存しうる。将来の任意の版で同一とは主張しない。作った版は成果物の `*.zip.json`（`environment.node` / `environment.zlib`）へ記録している |
| 9 | **1px＋`clip` 以外の視覚非表示は網羅していない** | 実サイトで確認できた形（1px 四方＋`clip`／`clip-path`）だけを狭く判定している。正規の小さな UI を巻き込まないことを優先した。「視覚的に隠された領域をすべて除外する」とは主張しない |

---

## 8. これまでの監査の履歴（履歴）

| 回 | 指摘 | 結果 | 対象版 |
|---|---:|---|---|
| 1 | 15件 | 全件が実在。対応して v1.8.0 へ | v1.7.1 |
| 2 | 12件 | 全件が実在。対応して v1.8.1 へ（v1.8.0 は提出見送り） | v1.8.0 |
| 3 | 6件 | 全件が実在。対応して v1.8.2 へ（v1.8.1 は提出見送り） | v1.8.1 |
| 4 | 8件 | 全件が実在。対応して v1.8.3 へ（v1.8.2 は提出見送り） | v1.8.2 |
| 5 | 8件 | 全件が実在。対応して v1.8.4 へ（v1.8.3 は提出見送り） | v1.8.3 |
| 6 | 7件 | 全件が実在。対応して v1.8.5 へ（v1.8.4 は提出見送り） | v1.8.4 |
| 7 | 8件 | 全件が実在。対応して v1.8.6 へ（v1.8.5 は提出見送り） | v1.8.5 |
| 8 | 5件 | 全件が実在。対応して v1.8.7 へ（v1.8.6 は提出見送り） | v1.8.6 |
| **合計** | **69件** | **69件連続で、事実と違う指摘は0件** | |

第4回の指摘のうち1件（RG-4-07）は、**該当が11件ではなく12件**でした。辞書で `s` で終わるキーを数え直すと `request changes` も該当し、`request changeses` が作られていました。指摘そのものは正しく、影響範囲がわずかに広かったものです。

提出しない版のタグ・Release・履歴は、いずれも**そのまま残しています**（付け替えも削除もしていません）。

---

## 9. 監査で特に見てほしいところ

0. **「その語が読めるか」の判定に穴がないか**（3-2-3 / `isVisibleOccurrence`）。`checkVisibility` に任せた部分と、自分で形を見ている部分（1px＋`clip`）の切り分けは妥当か。正規の小さな UI を巻き込む恐れはないか。
0-b. **`usableGloss` の判定と、古い印を取り除く処理**。本文を壊す経路や、同じキーの印が2つ残る経路が無いか。
0-c. **`EXTRA_FORMS` に残した30語の綴り**。GitHub の画面に実在しない形や、普通の英単語と衝突する形が混ざっていないか。
1. **§3 の不変条件に穴がないか。** とくに「先祖から推し量らない」を徹底できているか、`resolvePlacement` の祖先たどりに抜けがないか。
2. **roving を全廃した判断の副作用。** GitHub 以外の画面構成や、将来 GitHub が変わった場合に、説明が届かなくなる語が出ないか。実サイト4ページでの「0件」という測定で十分か。
3. **E2E の oracle が本当に独立か。** テストが本番の判定式を言い換えているだけになっていないか。
4. **§5 のデータ申告が公式定義と整合するか。** 「ウェブサイトのコンテンツ」だけを選ぶ範囲設定が妥当か（過小申告になっていないか）。
5. **自作の ZIP 実装。** [`scripts/zip.mjs`](scripts/zip.mjs) の読み書きに、配布物を壊しうる欠陥がないか。決定性の担保は十分か。
6. **CI がゲートとして閉じているか。** `continue-on-error` を外した以外に、失敗が隠れる経路が残っていないか。

---

## 10. 主なファイルの案内

| 内容 | 場所 |
|---|---|
| 判定ロジック本体（DOM を触る部分） | [`src/content.js`](src/content.js) |
| 用語の判定（DOM を触らない・Node からも呼べる） | [`src/matcher.js`](src/matcher.js) |
| 辞書（61語） | [`locales/dict.json`](locales/dict.json) |
| 設計の意図と実測の記録 | [`DESIGN.md`](DESIGN.md) |
| プライバシーポリシー | [`PRIVACY.md`](PRIVACY.md) |
| 拡張として読み込む E2E | [`tests/e2e/`](tests/e2e/) |
| 用語判定の単体テスト | [`tests/matcher.test.js`](tests/matcher.test.js) |
| 配布物の検査（壊した ZIP を9種ぶつける） | [`tests/package.test.js`](tests/package.test.js) |
| 提出物の身元の schema と、その検査（28件） | [`scripts/provenance.mjs`](scripts/provenance.mjs) / [`tests/provenance.test.js`](tests/provenance.test.js) |
| 配布物の一覧（唯一の正本） | [`scripts/package-files.mjs`](scripts/package-files.mjs) |
| 構成と文書の整合検査（284項目） | [`scripts/verify.mjs`](scripts/verify.mjs) |
| ZIP の読み書き（自作） | [`scripts/zip.mjs`](scripts/zip.mjs) |
| ZIP の検査 | [`scripts/verify-zip.mjs`](scripts/verify-zip.mjs) |
| CI | [`.github/workflows/ci.yml`](.github/workflows/ci.yml) |
| ストア掲載情報と提出記録 | [`STORE_LISTING.md`](STORE_LISTING.md) |
| **今回の変更の詳細と証拠** | [`docs/audit/v1.8.14-changes.md`](docs/audit/v1.8.14-changes.md) |

---

## 11. 監査の前提

- **提出はこの監査に合格してから**行います（[`STORE_LISTING.md`](STORE_LISTING.md) §8-2-3 に条文化）。
- 指摘は、**事実の裏取りができる形**（該当ファイル・行・再現手順）でいただけると助かります。過去4回はすべて実物と一致していたため、こちらでも1件ずつコードで確認しています。
- 「直していないこと」を「直した」と書かないようにしています。§7 の一覧に漏れがあれば、それ自体を指摘してください。
