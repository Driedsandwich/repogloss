# 監査のための資料（第5回監査用）

このファイルは、外部監査を受けるための入口です。**このリポジトリだけを読めば監査に必要な情報が揃う**ようにしてあります。

RepoGloss は、GitHub の画面に出てくる英語のうち Git / GitHub 固有の用語に印を付け、日本語の説明を出す Chrome 拡張です。作者は非エンジニアで、実装は AI エージェントとの共同作業によります。**そのため、外部監査に合格するまでウェブストアへ提出しない**という運用にしています。

> このファイルと `docs/audit/` は**配布物には入りません**（[`scripts/package-files.mjs`](scripts/package-files.mjs) が配布物の唯一の正本）。タグ `v1.8.3` を打った後に追加したものなので、タグには含まれていません。

---

## 1. 監査対象

| 項目 | 値 |
|---|---|
| **監査対象タグ** | **`v1.8.3`** |
| **対象コミット** | **`33b107856722ba713b45043e47307a464c50ea18`** |
| 現在の既定ブランチ | `main` |
| main とタグの差分 | **配布する13ファイルは差分ゼロ。** 違うのは `STORE_LISTING.md`（提出物の記録）と、このファイルおよび `docs/audit/`（監査用の資料）だけ |
| Manifest | v1.8.3 / Manifest V3 |
| Chrome API 権限 | `storage` のみ |
| サイトアクセス | `https://github.com/*` |
| `host_permissions` | 宣言なし |
| 実行されるコード | [`src/matcher.js`](src/matcher.js) と [`src/content.js`](src/content.js) の2本（同梱のみ・リモートコードなし） |
| 外部依存パッケージ | **なし**（`package.json` は検証用の scripts だけ。ZIP 生成も Node 標準の `zlib` で自作） |
| ストア公開中の版 | **v1.7.1**（v1.8.0〜v1.8.3 はいずれも未提出） |

差分は次のコマンドで確認できます。

```sh
git diff --name-only v1.8.3 main
# → STORE_LISTING.md / AUDIT.md / docs/audit/... のみ。配布13ファイルは出てこない
```

### 1-1. 提出物（まだ提出していない）

| 項目 | 値 |
|---|---|
| ZIP | `repogloss-1.8.3.zip`・**69,230 バイト**・**13ファイル** |
| **SHA-256** | **`e76c924522339941fd6397c66302446d13046e92f0687a26d1ca068ba338f4fa`** |
| 中身の合算ハッシュ | `66a08bea5e89dbfca77c0998757630565bffe06deee8d55dd704abbb7c348c3c` |
| 出どころ | **CI が生成した artifact `repogloss-store-zip`**（`release-zip` ジョブ）。手元でビルドしたものは使っていない |
| 3 OS の配布物合算ハッシュ | **`f076ac6de81e53c4d6d6656fa927babfd5cb0433e92d46ec202d75564d575245`**（Windows / Ubuntu / macOS の3つとも同一） |

**この ZIP は誰でも再現できます。** 日時を 1980-01-01 に固定し、並び順を配布一覧の順に固定してあるため、同じコミットからは1バイト違わない同じものができます。

```sh
git checkout v1.8.3
npm run package:zip          # → ZIP_SHA256 e76c9245... が出る
npm run package:verify-zip   # → 中身が13ファイルと一致することを検査
```

前回の監査で「記録された ZIP を独立に照合できない」と指摘されたため、CI の artifact としても取得できるようにしました。

```sh
gh run download <run-id> -R Driedsandwich/repogloss -n repogloss-store-zip
```

---

## 2. 今回（v1.8.3）で直したこと

第4回監査の指摘 **P1 5件・P2 3件**への対応です。詳細と証拠は [`docs/audit/v1.8.3-changes.md`](docs/audit/v1.8.3-changes.md) にあります。

| ID | 内容 | 主な変更箇所 |
|---|---|---|
| RG-4-01 | 描画されていない先祖を、キーボードの入口と誤認していた | [`src/content.js`](src/content.js) `isRendered` / `renderCache` |
| RG-4-02 | 矢印キーで動く部品を、構造だけで到達可能と認定していた | `rovingEntry` と `COMPOSITE_OF` を**削除** |
| RG-4-03 | E2E に反例が無く、到達性の判定に `focus()` を使っていた | [`tests/e2e/`](tests/e2e/) |
| RG-4-04 | データ取り扱いの申告が、公式の "handle" の定義と合っていなかった | [`PRIVACY.md`](PRIVACY.md) / [`STORE_LISTING.md`](STORE_LISTING.md) §3-4 |
| RG-4-05 | Windows の E2E が `continue-on-error` で、失敗しても CI が緑だった | [`.github/workflows/ci.yml`](.github/workflows/ci.yml) |
| RG-4-06 | OS 間のハッシュ比較と、提出物 ZIP の検証が CI で完結していなかった | `hash-compare` / `release-zip` ジョブ、[`scripts/zip.mjs`](scripts/zip.mjs) |
| RG-4-07 | 既に複数形のキーを、さらに複数形にしていた（`actionses` 等） | [`src/matcher.js`](src/matcher.js) |
| RG-4-08 | 文書と実装・検証の記述が食い違っていた | 各文書 |

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

### 4-1. 手元（macOS / Google Chrome 151.0.7922.72 / Node.js v22.22.3）

| command | exit | 結果 |
|---|---:|---|
| `npm test` | 0 | 単体 **34件**全成功 / 構成 **107項目**・不一致0（辞書61語・version 1.8.3） |
| `npm run test:e2e` | 0 | **32件**全成功（拡張として実際に読み込み・実キー送信） |
| `npm run package:stage` / `:verify` | 0 | 13ファイル一致 |
| `npm run package:zip` / `:verify-zip` | 0 | 13ファイル・69,230バイト・`e76c9245…` |

### 4-2. CI（8ジョブすべて success）

| job | 中身 |
|---|---|
| `verify` | 構文検査・単体テスト・構成と文書の整合 |
| `e2e` | ubuntu で、配布ファイルだけを拡張として読み込んで実行 |
| `e2e-windows` | **windows-latest で 32件全成功** |
| `package-hash` × 3 OS | 各 OS で配布物の合算ハッシュを出し、artifact として持ち出す |
| `hash-compare` | 3件そろい、3つとも同じ値であることを**機械的に**確認（割れると落ちる） |
| `release-zip` | 提出用 ZIP を生成・検査し、artifact として持ち出す |

**Windows のゲートが本当に働くことを実測しました。** 前回「ジョブの成功表示だけでは step の成功を証明しない」と指摘された点です。使い捨ての PR で **Windows でだけ落ちる assertion** を1つ入れたところ:

| | `e2e-windows` | 他7ジョブ | run 全体の結論 |
|---|---|---|---|
| わざと壊した検証用 PR | **failure** | success | **failure** |
| 対照（無傷の PR #11） | success | success | **success** |

確認後、その PR は閉じてブランチをローカル・リモート両方から削除しました。現在のコードに痕跡はありません。

### 4-3. テストに判別力があることの確認

**通るだけのテストは、何も見ていないテストと区別できません。** そこで、直す前のコードへぶつけて落ちることを確かめています。

```text
src/content.js を v1.8.2 へ戻す → E2E 32件中 6件が失敗
  境界18件 / 後続の文章での説明 / 前向き Tab / Shift+Tab / 矢印の応答の見分け

src/matcher.js を v1.8.2 へ戻す → 単体 21件中 3件が失敗
  再複数形化 / 複数形キー自身の一致 / s で終わるキーの分類
```

再現方法:

```sh
git checkout v1.8.3
git show v1.8.2:src/content.js > src/content.js
npm run test:e2e            # → 6件落ちる
git checkout src/content.js # 戻す
```

ZIP の検査は、**壊した ZIP 9種類**を1件ずつぶつけて必ず落ちることを確認しています（[`tests/package.test.js`](tests/package.test.js) の13件のうち9件が「壊れたものを落とす」試験、残り4件は対照＝正しい ZIP が通る／読み書きで中身が変わらない／同じ中身なら毎回同じバイト列になる／配布一覧そのものに配布禁止のものが載っていない）。余分なファイル・開発用ファイル・鍵らしきファイル・不足・version 不一致・親フォルダで包む・中身の1バイト書き換え（CRC）・末尾のごみ・先頭の切り詰め。**壊し方は、検査が持っている一覧の外側からも入れています。**

### 4-4. E2E で実際に送っているキー

到達可能性の判定に、対象要素への `.focus()` を**使いません**（開始位置の固定にだけ使います）。テスト側で本番の判定式を再実装しない方針です。ブラウザが実際に止まった要素だけを「到達できる」とみなします。

| テスト | 送るキー |
|---|---|
| 装飾扱いの印の入口は、すべて前向き Tab の順路に出てくる | **Tab ×90** |
| 装飾扱いの印の入口は、Shift+Tab の順路にも出てくる | **Shift+Tab ×90** |
| 到達できない要素が Tab 順路に現れない（対照） | **Tab ×90** |
| 矢印に応答する部品としない部品を、実キーで見分ける（対照） | **ArrowDown / ArrowUp** |
| 画面の外にある印へ実際に Tab で移っても説明が出る | **Tab（最大150回）** |

E2E は `--remote-debugging-pipe` と `--enable-unsafe-extension-debugging` を使い、CDP の `Extensions.loadUnpacked` で**配布ファイルだけを実際の Chrome へ拡張として読み込んで**います（`--load-extension` は現行 Chrome で無効化されているため）。`github.com` は `--host-resolver-rules` でローカルの HTTPS サーバへ向けており、外部通信もアカウントも要りません。

### 4-5. 性能

**測定条件**: macOS / Google Chrome 151.0.7922.72 の headless / 幅1600px / 各5回の中央値 / **ページの中で `performance.now()` を使い、初期走査だけを測定**（CDP の往復を含めない）。v1.8.2 と v1.8.3 を同じ手順・同じ日に測定。

| ページ | v1.8.2 | v1.8.3 | 印 | 語の集合 | 50ms 超 |
|---|---:|---:|---:|---|---|
| `octocat/Hello-World` | 9 ms | 11 ms | 20 / 20 | 完全一致 | なし |
| `k88hudson/git-flight-rules` | 16 ms | 26 ms | 41 / 41 | 完全一致 | なし |
| `Spoon-Knife`（コード表示） | 9 ms | 10 ms | 14 / 14 | 完全一致 | なし |

省いていた描画確認を戻したぶん、大きなページで増えています。しきい値の 50ms には収まっており、**正しさを戻すことと引き換えの増加なので、速度を理由に戻しません。**

> [`README.md`](README.md) の過去の節にある「10〜13ms」は v1.7.1 を別の条件で測ったもので、この表とは比べられません（版・幅・回数・計測位置がすべて違う）。前回この不一致を指摘されたため、数値には条件を必ず添えるようにしました。

---

## 5. データ取り扱いの申告

**「ウェブサイトのコンテンツ」を選択する（＝収集または使用する）。他の8項目は選択しない。**

| 項目 | 申告 | 根拠 |
|---|---|---|
| 個人を特定できる情報 | 選択しない | 氏名・メール・IDを読み取らず、保持しない |
| 健康情報 / 金融・決済情報 / 位置情報 | 選択しない | 扱わない |
| 認証情報 | 選択しない | Cookie・トークン・パスワードを読まない |
| 個人的な通信内容 | 選択しない | 入力欄・`contenteditable` に触れない（コードで除外し、E2E で確認） |
| ウェブ閲覧履歴 | 選択しない | 訪問先を記録・保存・送信しない。`tabs` / `history` 権限も持たない |
| ユーザーの操作 | 選択しない | クリック等を記録・集計しない |
| **ウェブサイトのコンテンツ** | **選択する** | github.com の表示文章を読み取り、同梱辞書との照合に**使う**（端末内のみ・保存なし・送信なし・共有なし・人手閲覧なし） |

**改めた理由**: 公式 FAQ は user data の "handle" に collecting・transmitting・**using**・sharing を含め、ウェブサイトのコンテンツを user data の例に挙げたうえで、**端末内のみで処理し外部送信しない場合でも開示が必要**としています。v1.8.2 までの「collect＝デバイスからの転送」という解釈は、「使う」を取りこぼしていました。

**⚠️ 未確定**: Developer Dashboard の実際の定義文は読んでいません（提出者のログインが必要な画面のため）。[`STORE_LISTING.md`](STORE_LISTING.md) §3-4 に定義文の転記欄を用意し、**外部への転送だけを明確に問う項目だった場合に限り**選択しない、という条件を明記しています。最終判断は提出時に人が行います。

---

## 6. 権限・通信・保存データ（v1.8.2 → v1.8.3 の差分）

```text
permissions:                 ['storage'] → ['storage']（差分なし）
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
| 4 | **`MutationObserver` が `characterData` を見ない** | 実害が再現していないため据え置き（前回監査の方針どおり）。テキストノードの中身だけが差し替わる更新は追わない |
| 5 | **Developer Dashboard の実文言未読** | 提出者のログインが必要な画面。§5 のとおり転記欄を用意した |
| 6 | 実サイト計測は macOS の headless Chrome 151・幅1600px・4ページのみ | 他の画面幅やログイン状態では結果が変わりうる |
| 7 | ZIP の検査は自作の読み書き実装に依存 | 緩和として、Python の `zipfile` と `unzip -t`（いずれも無関係な実装）でも読めることを確認している |

---

## 8. これまでの監査の履歴

| 回 | 指摘 | 結果 | 対象版 |
|---|---:|---|---|
| 1 | 15件 | 全件が実在。対応して v1.8.0 へ | v1.7.1 |
| 2 | 12件 | 全件が実在。対応して v1.8.1 へ（v1.8.0 は提出見送り） | v1.8.0 |
| 3 | 6件 | 全件が実在。対応して v1.8.2 へ（v1.8.1 は提出見送り） | v1.8.1 |
| 4 | 8件 | 全件が実在。対応して v1.8.3 へ（v1.8.2 は提出見送り） | v1.8.2 |
| **合計** | **41件** | **41件連続で、事実と違う指摘は0件** | |

第4回の指摘のうち1件（RG-4-07）は、**該当が11件ではなく12件**でした。辞書で `s` で終わるキーを数え直すと `request changes` も該当し、`request changeses` が作られていました。指摘そのものは正しく、影響範囲がわずかに広かったものです。

提出しない版のタグ・Release・履歴は、いずれも**そのまま残しています**（付け替えも削除もしていません）。

---

## 9. 監査で特に見てほしいところ

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
| 配布物の検査（壊した ZIP を11種ぶつける） | [`tests/package.test.js`](tests/package.test.js) |
| 配布物の一覧（唯一の正本） | [`scripts/package-files.mjs`](scripts/package-files.mjs) |
| 構成と文書の整合検査（107項目） | [`scripts/verify.mjs`](scripts/verify.mjs) |
| ZIP の読み書き（自作） | [`scripts/zip.mjs`](scripts/zip.mjs) |
| ZIP の検査 | [`scripts/verify-zip.mjs`](scripts/verify-zip.mjs) |
| CI | [`.github/workflows/ci.yml`](.github/workflows/ci.yml) |
| ストア掲載情報と提出記録 | [`STORE_LISTING.md`](STORE_LISTING.md) |
| **今回の変更の詳細と証拠** | [`docs/audit/v1.8.3-changes.md`](docs/audit/v1.8.3-changes.md) |

---

## 11. 監査の前提

- **提出はこの監査に合格してから**行います（[`STORE_LISTING.md`](STORE_LISTING.md) §8-2-3 に条文化）。
- 指摘は、**事実の裏取りができる形**（該当ファイル・行・再現手順）でいただけると助かります。過去4回はすべて実物と一致していたため、こちらでも1件ずつコードで確認しています。
- 「直していないこと」を「直した」と書かないようにしています。§7 の一覧に漏れがあれば、それ自体を指摘してください。
