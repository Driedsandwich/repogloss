# CLAUDE.md — このリポジトリで作業する AI への決まり

RepoGloss は、GitHub のページで Git / GitHub の用語に日本語の説明を添える Chrome 拡張（Manifest V3）です。**公開リポジトリ**です。仕組みは `docs/ARCHITECTURE.md`、用語は `docs/GLOSSARY.md` にあります。

ここに書いたことは、実際にファイルを読むかコマンドを実行して確かめたものだけです。

## 1. テストと検査

依存パッケージはありません。`npm install` は不要です（`package.json` に `dependencies` が無い）。Node.js 22 で確かめています（CI も Node 22：`.github/workflows/ci.yml`）。

```sh
npm test
```

これ 1 つで、次の 4 つを順に実行します（`package.json` の `scripts.test`）。

```sh
node --check src/matcher.js
node --check src/content.js
node --test "tests/**/*.test.js"   # 用語の判定・色の透明度・ZIP 検査・身元検査
node scripts/verify.mjs            # manifest・権限・content.js の約束事・文書の数字・監査資料の整合
```

通ったときの最後の行は `OK: <件数> 件を検査・不一致 0 件（辞書 61 語 / version <版>）` です。

**E2E**（本物の Chrome に拡張として読み込ませるテスト）:

```sh
npm run test:e2e
```

- Chrome（または Chromium）と `openssl` が要ります。Chrome が自動で見つからないときは、環境変数 `CHROME_PATH` に実行ファイルの場所を入れます（`tests/e2e/helpers/chrome.mjs` の `findChrome`）。
- テストは `github.com` を手元の HTTPS サーバへ向けます（`--host-resolver-rules`）。**HTTP(S) のプロキシが環境変数で設定されている環境では、Chrome がプロキシへ出てしまい、ページが空のまま大量に失敗します。** そのときは、その実行に限り `no_proxy` / `NO_PROXY` に `github.com` を足して実行します（プロキシ自体は外さない）。
- 時間がかかります（2026-10-26 にクラウドの Linux 環境で実行し、517 件が成功、約 8.5 分）。

配布物の検査（必要なときだけ）:

```sh
npm run package:stage        # dist/ へ配布 13 ファイルを並べ、合算ハッシュを出す
npm run package:zip          # 提出用 ZIP を作って検査する（配布の対象のファイルに commit していない変更があると止まる）
```

`dist/` と `*.zip` は Git に入れません（`.gitignore`）。

**変更したら、commit の前に `npm test` を通してください。** テストや検査を飛ばす・無効にする・条件を緩めることで通してはいけません。検査は「振る舞いが変わったら落ちる」ように作ってあります（`src/matcher.js` 冒頭の注記）。

## 2. 触ってはいけない物（頼まれない限り変えない）

次のものは、検査（`scripts/verify.mjs`）や監査の証拠として、値が固定・突き合わせされています。依頼に無いのに変えると、検査が落ちるか、監査の証拠が壊れます。

- **拡張の版と申告書**：`manifest.json`（`version`・`minimum_chrome_version`・`permissions`・`content_scripts`）。ページから読める同梱ファイル（`web_accessible_resources`）は持たない作りで、足すと検査が落ちます。形は `scripts/verify.mjs` 冒頭の `ALLOWED_*` で丸ごと固定されています。版を上げるのは持ち主の指示があるときだけです。
- **`src/dict.js`・`src/styles.js`**：辞書（`locales/dict.json`）と見た目（`styles.css`）の写しで、自動生成です。手で直さず、正本を直したら `node scripts/embed-assets.mjs` で作り直します（ずれると `verify.mjs` が落ちます）。
- **README などに書いた版と数字**：`README.md` の版のバッジや語数などは、`verify.mjs` が manifest や辞書と突き合わせています。
- **`AUDIT.md` の機械が読む欄**：`version:` `state:` `base_commit:` `commit:` `tag:` の行と、`# CHANGED:` / `# UNCHANGED:` の 2 行。`verify.mjs` が `git diff` の実測と突き合わせます。
- **`AUDIT.md` が名乗る検査件数**：`verify.mjs` が自分の件数と照合します。`verify.mjs` に検査を足したり減らしたりすると、`AUDIT.md` の件数も直さないと落ちます。
- **`docs/audit/v*-changes.md`**：版ごとの「何を直し、どう確かめたか」の記録（監査の証拠）。過去の版のものは書き換えません（機械が検査するのは、今の版の記録が在ることだけです。中身を守るのは決まりとしてです）。
- **`STORE_LISTING.md` の提出記録**：過去の提出物の大きさ・ハッシュ・日付などの記録。今の版が書かれていること、申告の書き方などを `verify.mjs` が一部検査します。過去の記録は書き換えません。
- **`scripts/package-files.mjs`**：配布物の唯一の正本（13 ファイル）。試験専用の JS（`tests/e2e/*.js`）を入れてはいけません（`verify.mjs` が検査）。
- **`.gitattributes`**（改行を LF に固定）：揺れると OS ごとに配布物のハッシュが変わり、CI の 3 OS 比較が落ちます。
- **`.github/workflows/ci.yml`** の actions は、コミットの SHA で固定してあります。版の名前（`@v7` など）へ戻さないでください。CI の権限は `contents: read` だけです。
- **`LICENSE`**：MIT。

## 3. 公開物としての注意

このリポジトリは公開されています。commit した内容は誰でも読めます。

- 個人の名前・メールアドレス・手元の絶対パス（`/Users/…` `/home/…` `C:\Users\…` など）・鍵・トークン・パスワード・Cookie を、ファイルにも commit メッセージにも書かないでください。例を書くときは架空の値にします。
- 再現に使うページは `github.com/octocat/Hello-World` のような公開ページにします（`SECURITY.md`）。private リポジトリの中身やそのスクリーンショットを入れません。
- 拡張は外部へ通信しません。外部の URL への `fetch` や、リモートのコードを読み込む書き方を足さないでください（`verify.mjs` が検査します）。
- 見つけた秘密情報は、値を書かずに「種類と場所」だけを報告します。

## 4. 変更の流儀

- **最小の差分**にします。頼まれたことだけを変え、ついでの整形・名前の変更・リファクタリングを混ぜません。
- 文書だけを頼まれたときは、コードを変えません。
- 既存のコメントの書き方（日本語・「なぜそうしたか」と「実測」を残す）に合わせます。
- 判定の規則を変えたら、それを確かめるテストが落ちる側に置きます（`src/matcher.js:4`）。
- 推測で「直った」「通った」と書きません。実行したことと推測を分けて報告します。
- 作業は作業用の枝で行い、`main` に直接 push しません。
