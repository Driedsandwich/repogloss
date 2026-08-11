# プライバシーポリシー / Privacy Policy — RepoGloss

最終更新: 2026-08-11（v1.8.13）

---

## 日本語

### 0. Chrome ウェブストアのユーザーデータポリシーへの準拠

**RepoGloss によるユーザーデータの利用は、Chrome Web Store User Data Policy（Limited Use 要件を含む）に従います。** データは本拡張の単一目的（GitHub の英語用語に日本語の説明を表示すること）の提供にのみ使い、販売、広告、与信判断、目的外利用、第三者への移転、開発者や人による閲覧には使用しません。

- Limited Use: <https://developer.chrome.com/docs/webstore/program-policies/limited-use/>
- User Data FAQ: <https://developer.chrome.com/docs/webstore/program-policies/user-data-faq/>

### 1. 取り扱うデータの一覧

「取り扱う（handle）」には、集める・送る・**使う**・共有する、のすべてが含まれます。端末の中だけで処理し、どこへも送らない場合でも、**使っていること自体は開示が必要**です。そのため、以下では動作を5つに分けて書きます。

| データ | 処理（使う） | 端末内に保存 | 外部へ送信 | 第三者と共有 | 開発者が閲覧 |
|---|---|---|---|---|---|
| GitHub のページ上の**文章**（下の除外領域を除く。CSS で見えなくなっているものを含む） | **する**（同梱辞書との照合と、見えるかどうかの判定） | しない | しない | しない | しない |
| 開いている GitHub ページの**URL** | **する**（画面が切り替わったことの検知にだけ使う） | しない | しない | しない | しない |
| ON / OFF の設定（真偽値 `iiyakuEnabled` ひとつ） | する | **する**（`chrome.storage.local`） | しない | しない | しない |
| **取得元として触れないもの**: Cookie（`cookies` 権限なし）・認証 API・入力欄やフォーム（`input` / `textarea` / `select`）・編集中の領域（`contenteditable`） | **しない**（走査の前に除外し、値そのものを取り出しません） | しない | しない | しない | しない |
| **通常の本文に表示されている**、認証情報らしき文字列・氏名・投稿済みのコメントなど | **する**（上の「ページ上の文章」の一部として、辞書照合のあいだだけ） | しない | しない | しない | しない |

外部のサーバーとの通信は一切行いません（翻訳API・解析サービス・広告のいずれも使っていません）。

> **「認証情報を扱わない」とは書きません。**
> 取得元として触れないもの（Cookie・認証 API・入力欄・編集中の領域）と、通常の本文として一時的に処理し得るものは、別のことです。
>
> **Cookie やフォームの入力値は取得しません。** 一方、通常のページ本文に token やパスワードらしき文字列が**表示されている**場合、その文字列は「ウェブサイトのコンテンツ」の一部として、端末内の辞書照合へ一時的に渡り得ます。**それを認証情報として抽出・識別・保存・送信・共有・人手で閲覧することはありません。**

> **「個人情報は読み取らない」とは書きません。**
> 本拡張は、表示されている文章を広く走査します。そこに氏名・ユーザー名・メールアドレス・Issue や Pull Request のコメントが含まれていれば、**その文字列も一時的な照合の対象になります**。
>
> 正確には次のとおりです。**それらを個人情報として抽出・識別・保存・送信・共有・人手で閲覧することはありません。** 文章は端末の中で辞書と照らし合わせるためだけに一瞬使われ、その場で捨てられます。意味のカテゴリ（これは氏名、これはトークン、といった区別）としての抽出は一切行いません。判定に使うのは同梱辞書の 61 語との一致だけです。
>
> 一方、**入力欄・フォーム・編集中の領域・コード表示は、文字列を取り出す前に除外**します。「書き換えない」だけでなく「読み取らない」という意味です（`src/content.js` の `isTarget` が、除外を決めてからでないと文字列に触れない作りになっており、実際に辞書照合まで届いていないことを、拡張と同じ隔離世界の中で計測しています）。

### 2. ページの文章の扱い（くわしく）

`github.com` のページを開いている間、**ページ上の文章を読み取り、利用します。**

**正確な範囲**: 下の「触れない領域」を除いた文章が対象です。そこには、**CSS で見えなくなっている文章も含まれます**（`display:none`、`opacity:0`、`content-visibility:hidden` など）。見えるかどうかは、文字列を読んで辞書に当たった後で判定するためです。先に全部の可視性を測ると、ページが目に見えて重くなります。

**印を付けるのは、見えると判定できた一致だけ**です。見えない場所の一致には印を付けません。

- 用途は、拡張に同梱された辞書（`locales/dict.json`）と照合し、見える場所かどうかを判定することだけです。
- 照合はすべて利用者の端末内（ブラウザの中）で完結します。ネットワークへは出ません。
- 結果として、一致した用語の横に ⓘ を表示し、日本語の説明をツールチップとして出します。それ以外の用途はありません。
- 読み取った内容を保存しません。ページを閉じれば残りません。
- **触れない領域**（下記）は、**文字列を取り出す前に**除外します。読み取りも書き換えもしません。
  - 編集中の領域（`contenteditable`）
  - 入力欄・フォーム（`textarea` / `input` / `select`）
  - コード表示（`<pre>` `<code>` と GitHub のコードビューア）
  - 読み上げから隠された領域（`aria-hidden="true"`・`.sr-only`・`.visually-hidden`）
  - 操作できない領域（`inert`）
  - `hidden` 属性が付いた領域（`hidden="until-found"` を含む）

読み取りの範囲は `github.com` に限られます。他のサイトでは動作しません（`manifest.json` の `content_scripts.matches` が `https://github.com/*` のみのため）。

> **お願い**: 本拡張は「表示されている文章」を区別なく走査します。private リポジトリのページでも動作しますが、内容は端末の外へ出ません。それでも取り扱いに配慮が必要な画面では、右下のトグルで OFF にしてご利用ください。

### 2-2. 開いているページの URL の扱い

GitHub は、ページを読み直さずに画面だけを差し替えることがあります（リポジトリのタブを切り替えたときなど）。それを見つけるために、**開いている GitHub ページの URL を読み取り、直前の値と一致するかだけを比べます。**

- 用途: 画面が切り替わったことの検知だけです。切り替わったら、新しい画面をもう一度走査します。
- **保存しません。** 端末内のメモリで直前の値と比べるだけで、`chrome.storage` にもどこにも残しません。
- **外部送信も第三者提供もしません。** 開発者が閲覧することもありません。
- 対象は `github.com` を開いている間だけです。他のサイトでは拡張自体が動きません。
- 閲覧履歴を読む権限（`tabs` / `history`）は要求していません。読めるのは「いま自分が動いているページ自身の URL」だけです。

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

GitHub リポジトリの Issue でお願いします。脆弱性の報告のみ [SECURITY.md](https://github.com/Driedsandwich/repogloss/blob/main/SECURITY.md) の宛先へお願いします。

---

## English

### 0. Compliance with the Chrome Web Store User Data Policy

**RepoGloss's use of user data will adhere to the Chrome Web Store User Data Policy, including the Limited Use requirements.** User data is used only to provide the extension's single purpose — showing Japanese explanations for English Git/GitHub terms — and is not sold, used for advertising or creditworthiness, used for any unrelated purpose, transferred to third parties, or viewed by the developer or any human.

- Limited Use: <https://developer.chrome.com/docs/webstore/program-policies/limited-use/>
- User Data FAQ: <https://developer.chrome.com/docs/webstore/program-policies/user-data-faq/>

### 1. What data is handled

"Handling" user data covers collecting, transmitting, **using**, and sharing it. Processing that happens entirely on the user's own device, and is never transmitted anywhere, still counts as *use* and is disclosed here. The table separates the five actions.

| Data | Processed (used) | Stored on device | Transmitted off device | Shared with third parties | Viewed by the developer |
|---|---|---|---|---|---|
| **Text on** GitHub pages, excluding the regions listed below (this includes text hidden by CSS) | **Yes** (dictionary matching and a visibility check) | No | No | No | No |
| **URL** of the GitHub page being viewed | **Yes** (compared with the previous value to detect in-page navigation) | No | No | No | No |
| On/off setting (a single boolean, `iiyakuEnabled`) | Yes | **Yes** (`chrome.storage.local`) | No | No | No |
| **Sources never touched**: cookies (no `cookies` permission), authentication APIs, form fields (`input` / `textarea` / `select`), editable regions (`contenteditable`) | **No** (excluded before any value is read) | No | No | No | No |
| Credential-like strings, names, or posted comments **displayed in ordinary page text** | **Yes** (as part of "text on GitHub pages" above, only while dictionary matching runs) | No | No | No | No |

No network requests are made to any external server (no translation API, no analytics, no ads).

> **We do not claim that credentials are "never handled".**
> Not reading a *source* and not processing *content* are different claims.
>
> **Cookies and form input values are never read.** However, if a credential-like string such as a token or password is **displayed in ordinary page text**, that string may transiently reach the on-device dictionary matching as part of Website content. **It is never extracted, identified, stored, transmitted, shared, or viewed by a human as a credential.**

> **We do not claim that personal information is "never read".**
> The extension scans displayed text broadly. If a page shows a name, username, email address, or an issue/PR comment, **those strings are also part of the transient matching.**
>
> Precisely: **such content is never extracted as personal information, identified, stored, transmitted, shared, or viewed by a human.** Text is used for a moment, in the browser, only to compare against the bundled dictionary, and is then discarded. No semantic category is ever derived from it (nothing is labelled "this is a name", "this is a token"); the only judgement made is whether the text matches one of the 61 bundled dictionary terms.
>
> Separately, **form fields, editable regions, and code views are excluded before their text is read at all** — not merely left unmodified. `isTarget` in `src/content.js` cannot touch a text value until the exclusion check has passed, and an automated test measures, inside the extension's own isolated world, that such text never reaches the dictionary matcher.

### 2. Page text, in detail

While a `github.com` page is open, the extension **reads and uses text on that page.**

**Exact scope**: everything except the excluded regions listed below — **including text that CSS has made invisible** (`display:none`, `opacity:0`, `content-visibility:hidden`, and so on). Visibility is decided *after* the string has been read and matched against the dictionary, because measuring visibility for every text node first makes the page noticeably slower.

**Markers are only placed on matches judged to be visible.** Invisible matches get no marker.

- The text is used solely to match against the bundled dictionary (`locales/dict.json`) and to decide whether the spot is visible.
- All matching happens locally, inside the user's browser. Nothing leaves the device.
- The only result is a small ⓘ marker next to a matched term, showing a Japanese explanation as a tooltip.
- Read text is never stored. Nothing remains once the page is closed.
- **Excluded regions are skipped before any text is read** — neither read nor modified:
  - editable regions (`contenteditable`)
  - form fields (`textarea` / `input` / `select`)
  - code views (`<pre>`, `<code>`, GitHub's code viewer)
  - regions hidden from assistive technology (`aria-hidden="true"`, `.sr-only`, `.visually-hidden`)
  - non-interactive regions (`inert`)
  - anything carrying the `hidden` attribute (including `hidden="until-found"`)

Reading is limited to `github.com`. The extension does not run on any other site.

### 2-2. The page URL

GitHub often swaps the view without reloading the page. To notice that, the extension **reads the URL of the page it is running on and compares it with the previous value.**

- Purpose: detecting in-page navigation, so the new view can be scanned. Nothing else.
- **Not stored.** The comparison happens in memory; nothing is written to `chrome.storage` or anywhere else.
- **Not transmitted, not shared, never viewed by the developer.**
- Only while a `github.com` page is open. No `tabs` or `history` permission is requested, so only the extension's own page URL is visible to it.

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

Please open an issue on the GitHub repository. For security reports, see [SECURITY.md](https://github.com/Driedsandwich/repogloss/blob/main/SECURITY.md).

---

RepoGloss is not affiliated with, endorsed by, or sponsored by GitHub, Inc. GitHub is a trademark of GitHub, Inc.

本拡張は GitHub, Inc. とは無関係で、同社による承認・後援を受けていません。GitHub は GitHub, Inc. の商標です。
