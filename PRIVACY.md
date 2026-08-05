# プライバシーポリシー / Privacy Policy — RepoGloss

最終更新: 2026-08-05

---

## 日本語

### 1. 収集・送信するもの

**ありません。** 本拡張は、利用者の情報を収集せず、外部へ送信せず、第三者へ提供しません。外部のサーバーとの通信を一切行いません（翻訳API・解析サービス・広告のいずれも使っていません）。

### 2. 読み取るもの

`github.com` のページを開いている間、**ページ上に表示されている文章を読み取ります。**

- 読み取った文章は、拡張に同梱された辞書（`locales/dict.json`）と照合するためだけに使います。
- 照合はすべて利用者の端末内（ブラウザの中）で完結します。
- 一致した用語の横に ⓘ を表示し、日本語の説明をツールチップとして出す以外の用途には使いません。
- 読み取った内容を保存しません。ページを閉じれば残りません。

読み取りの範囲は `github.com` に限られます。他のサイトでは動作しません（`manifest.json` の `content_scripts.matches` が `https://github.com/*` のみのため）。

> **お願い**: 本拡張は「表示されている文章」を区別なく走査します。private リポジトリのページでも動作しますが、内容は端末の外へ出ません。それでも取り扱いに配慮が必要な画面では、右下のトグルで OFF にしてご利用ください。

### 3. 保存するもの

**ON / OFF の設定（真偽値ひとつ）だけ**を、`chrome.storage.local` に保存します。

- 保存する値: `iiyakuEnabled`（`true` または `false`）
- 保存先: 利用者のブラウザ内。同期も外部送信もしません。
- 閲覧したページ、リポジトリ名、アカウント情報などは一切保存しません。

### 4. 要求する権限とその理由

Chrome の権限は、`permissions` に書く API の権限と、コンテンツスクリプトを差し込むサイトの範囲に分かれます。本拡張はどちらも最小限です。

| 区分 | 内容 | 用途 |
|---|---|---|
| Chrome API 権限 | `storage` | ON / OFF の設定を端末内に保存するため。これ以外に使いません |
| サイトアクセス | `content_scripts.matches` = `https://github.com/*` | GitHub のページ上で、表示中の文章を辞書と照合し、用語に ⓘ を表示するため |
| 同梱ファイルの読み込み | `web_accessible_resources`（`locales/dict.json`） | コンテンツスクリプトが、拡張機能に同梱された辞書を読み込むため。辞書は機密情報ではなく、外部サーバーから取得もしません |

ホスト権限（`host_permissions`）、`tabs`、`activeTab`、`scripting`、常駐処理（background）は要求していません。閲覧履歴も読み取りません。

### 5. 第三者への提供

行いません。共有する相手が存在しません。

### 6. 変更があった場合

本ポリシーを変更する場合は、このファイルを更新し、リポジトリの更新履歴に残します。データの取り扱いを変える変更を行う場合は、拡張の更新より前に記載します。

### 7. 連絡先

GitHub リポジトリの Issue でお願いします。脆弱性の報告のみ [SECURITY.md](./SECURITY.md) の宛先へお願いします。

---

## English

### 1. What we collect or transmit

**Nothing.** This extension does not collect, transmit, or share any user information. It makes no network requests to any external server (no translation API, no analytics, no ads).

### 2. What we read

While a `github.com` page is open, the extension **reads the text displayed on that page.**

- The text is used solely to match against a dictionary bundled with the extension (`locales/dict.json`).
- All matching happens locally, inside the user's browser.
- The only result is a small ⓘ marker next to a matched term, showing a Japanese explanation as a tooltip.
- Read text is never stored. Nothing remains once the page is closed.

Reading is limited to `github.com`. The extension does not run on any other site.

### 3. What we store

**Only an on/off setting (a single boolean)**, kept in `chrome.storage.local`.

- Stored value: `iiyakuEnabled` (`true` or `false`)
- Location: the user's own browser. Not synced, not transmitted.
- No browsing history, repository names, or account information is stored.

### 4. Permissions and why

Chrome separates API permissions from the sites a content script may be injected into. Both are kept minimal here.

| Category | Value | Purpose |
|---|---|---|
| Chrome API permission | `storage` | To remember the on/off setting. Nothing else |
| Site access | `content_scripts.matches` = `https://github.com/*` | To match visible text against the dictionary and place ⓘ markers on GitHub pages |
| Bundled file access | `web_accessible_resources` (`locales/dict.json`) | So the content script can load the dictionary bundled with the extension. The dictionary holds no secrets and is never fetched from a server |

No `host_permissions`, `tabs`, `activeTab`, `scripting`, or background service worker is requested. Browsing history is not read.

### 5. Sharing with third parties

None. There is no recipient.

### 6. Changes to this policy

Changes will be made in this file and recorded in the repository history. Any change to data handling will be documented before the corresponding extension update is published.

### 7. Contact

Please open an issue on the GitHub repository. For security reports, see [SECURITY.md](./SECURITY.md).

---

RepoGloss is not affiliated with, endorsed by, or sponsored by GitHub, Inc. GitHub is a trademark of GitHub, Inc.

本拡張は GitHub, Inc. とは無関係で、同社による承認・後援を受けていません。GitHub は GitHub, Inc. の商標です。
