# 🧠 GitHub 意訳支援 – Github-enja-Tooltip

![Chrome Extension](https://img.shields.io/badge/Chrome_Extension-Ready-brightgreen)
![Version](https://img.shields.io/badge/version-1.4-blue)
![License](https://img.shields.io/badge/license-MIT-lightgrey)

---

## 🐣 はじめての方へ | For Beginners
「**GitHub は英語が多くて難しい…**」という人向けの *日本語訳補助ツール* です。  
ブラウザに入れるだけで、英語 UI のキーワードに **🛈 マーク** が付き、日本語の説明（意訳）がツールチップで表示されます。

文系・学生・初学者の方に特におすすめです。

---

## 🚀 クイックスタート | Quick Start
1. 拡張をインストールして **GitHub を開くだけ**  
2. 英語用語に 🛈 が付き、日本語ヒントを吹き出し表示  
3. 画面右下の **「意訳 ON / OFF」ボタン** で即時切替（状態は保存）

> ⚠  ダークモードでも見えるようにスタイルを自動切替対応（v 1.4）  
> 💡  🛈 がコピーに混ざる場合は、ボタンを OFF にしてコピーするか、ペースト後に 🛈 を削除してください。

---

## 📝 概要 | Overview
**GitHub 意訳支援** は、GitHub 上の英語技術用語を  
文脈に応じた自然な日本語に“意訳”し、ツールチップで表示する Chrome 拡張です.  
This extension translates key technical terms on GitHub into natural-sounding Japanese explanations.

---

## 🧩 主な機能 | Main Features
| 機能 | 説明 |
|------|------|
| 🛈 アイコン付与      | ページ内の英語用語を自動検出し、日本語訳をマーク付きで表示 |
| ワンクリック切替     | 右下トグルでリアルタイム ON/OFF（ローカル保存） |
| 約 100 語収録辞書    | `locales/dict.json` に 100 語以上（随時拡充） |
| 最小権限 & MV3      | `github.com/*` だけで動作、追加 API 権限なし |

---

## 📚 代表訳語サンプル | Sample Glossary

| 英語 UI           | 日本語ツールチップ                         | 用途のヒント       |
|-------------------|-------------------------------------------|--------------------|
| **pull request**  | 自分の変更を本体に取り込んでもらうお願い   | 共同開発フロー      |
| **commit**        | ファイル変更の記録単位                   | 何をいつ誰が変更   |
| **merge**         | 別々の変更を一つにまとめる操作           | ブランチ統合        |
| **fork**          | 他人の作業を自分用にコピー               | OSS への貢献        |
| **issues**        | 困りごと・やりたいことのカード           | タスク管理          |

> 👉 **辞書は JSON 1 行追加で拡張可能**  
> `locales/dict.json` の `"英語キー": "日本語訳"` を増やせば反映されます。

---

## 💡 対象ユーザー | Intended Users
* GitHub を初めて使う学生・文系ユーザー  
* 英語 UI に抵抗がある開発者・研究者  
* 技術文脈を日本語で把握したいすべての人  

---

## 📦 インストール方法 | Installation
### A) Chrome Web Store（準備中）
> **Coming Soon** – ストア公開後に URL を追記します <!-- TODO: store-link -->

### B) 開発者モード手動導入
1. リポジトリを **Clone** または **Download ZIP** → 解凍  
2. `chrome://extensions/` → **デベロッパーモード ON**  
3. 「**パッケージ化されていない拡張機能を読み込む**」→ 解凍フォルダを選択  
4. GitHub を再読み込みで 🛈 マークが表示

---

## 🖥️ 動作確認環境 | Confirmed Environment
- Windows 11 + Chrome 137.0.7151.120 (64-bit)  
- GitHub 公式 Web / PWA (Chrome アプリ) で確認済み  
> ※ macOS / Linux / Edge など他環境でも動作する可能性があります。動作報告をお待ちしています！

---

## 📁 ディレクトリ構成
```
📁 src/
  └─ content.js          # メインスクリプト
📁 icons/
  └─ icon128.png         # 拡張アイコン
📁 locales/
  └─ dict.json           # 日本語訳辞書 (~100 entries)
📄 manifest.json         # MV3 定義
📄 styles.css            # 🛈 アイコン & トグルボタン
📄 README.md
```

---

## 🆕 変更履歴 | Changelog
| Version | Date       | Highlights |
|---------|------------|------------|
| **1.4** | 2025-06-29 | 🌙 ダーク/ライト自動切替&nbsp;/&nbsp;README 整理 |
| **1.3** | 2025-06-29 | 📚 辞書 50→100 語&nbsp;/ 🖱 トグルボタン追加 |
| **1.2** | 2025-06-29 | 📂 辞書を `locales/` へ統合 |
| **1.1** | 2025-06-28 | 🛠 DOM 監視最適化 |
| **1.0** | 2025-06-28 | 🎉 初版リリース |

---

## 🌱 用語追加・誤訳報告 | Contribute Translations
> **Issue / Pull Request 大歓迎！**  
> 「この英単語も訳したい」「説明が違うかも？」と思ったらお気軽にご提案ください。

---

## 💬 Feedback / 不具合・フィードバック
* GitHub *Issues* / *Discussions* / *Pull Request*  
* （公開後）Chrome Web Store レビュー  
バグ・要望・動作報告など何でも OK です！

---

## 🪪 License | MIT
本リポジトリ全体は [MIT](LICENSE) ライセンスです。商用・改変・再配布すべて自由。

---

## 🤝 Credits & Acknowledgements
本プロジェクトは **人間 + ChatGPT (OpenAI) + Gemini (Google)** の協働で開発しました。  
設計・実装・テストを対話しながら進めています。  
This project was co-developed by a human and ChatGPT / Gemini through iterative design and testing.

---

## ⚠ Disclaimer / 免責事項
この拡張機能は **GitHub 非公式** の独立ツールです。  
It is *not* affiliated with GitHub, Inc.

---

## 📝 Note / 備考
文系の素人が勢いだけで作っています。説明ミスなどあれば **やさしく** 教えてください 😊
