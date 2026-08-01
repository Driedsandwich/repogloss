
# 🧠 GitHub 意訳支援 – GitHub‑enja‑Tooltip

![Version](https://img.shields.io/badge/version-1.5-blue)
![License](https://img.shields.io/badge/license-MIT-lightgrey)

---

## 🐣 はじめての方へ | For Beginners
「**GitHub は英語が多くて難しい…**」という人向けの _日本語訳補助ツール_ です。  
GitHub 上の英語用語に **🛈 マーク** を付け、**日本語の意訳ツールチップ** を表示します。  
ブラウザ拡張なので Git／PC 環境を汚さず導入できます。

> ❓ 例：「compare」→「変更の比較」、「ci」→「自動テスト実行」、「merge」→「コード統合」  
> 学生・初学者・文系出身の開発者・研究者に特におすすめです。

---

## 🚀 クイックスタート | Quick Start
1. 拡張をインストールして **GitHub を開くだけ**  
2. 英語用語に 🛈 が付き、日本語ヒントを吹き出し表示  
3. 画面右下 **「意訳 ON / OFF」ボタン** で即時切替（設定は保存）

> 🌙 **ダークモード対応** 済（v 1.4 以降）  
> 💡 コピー時に 🛈 が混ざる場合はボタンを OFF にするか、貼り付け後に削除してください。

---

## 📝 概要 | Overview
**GitHub‑enja‑Tooltip** は GitHub 上の技術用語を  
文脈に合わせた自然な日本語へ *意訳* し、ツールチップ表示する Chrome 拡張です.  
This extension shows natural Japanese explanations for key GitHub terms.

---

## 🧩 主な機能 | Main Features
| 機能 | 説明 |
|------|------|
| 🛈 アイコン付与 | ページ内の英語用語を自動検出し、日本語訳をマーク付き表示 |
| ワンクリック切替 | 右下トグルでリアルタイム ON/OFF（状態はローカル保存） |
| **151 語** 収録辞書 | `locales/dict.json` に 151 語（2026-08-01 実測） |
| 最小権限 & MV3 | `github.com/*` のみで動作、追加 API 権限なし |

---

## 📚 代表訳語サンプル | Sample Glossary
| 英語 UI | 日本語ツールチップ | 用途 |
|---------|------------------|------|
| pull request | 自分の変更を本体に取り込んでもらうお願い | 共同開発フロー |
| commit | ファイル変更の記録単位 | 何をいつ誰が変更 |
| merge | 別々の変更を 1 つにまとめる操作 | ブランチ統合 |
| fork | 他人の作業を自分用にコピー | OSS への貢献 |
| issues | 困りごと・やりたいことのカード | タスク管理 |

> 👉 **辞書は JSON 1 行追加で拡張可能** – `"英語キー": "日本語訳"` を追記→拡張機能一覧で **更新** を押すだけ

---

## 💡 対象ユーザー | Intended Users
* GitHub を初めて使う学生・文系ユーザー  
* 英語 UI が負担な開発者・研究者  
* 技術文脈を日本語で把握したいすべての人  

---

## 📦 インストール方法 | Installation
### A) Chrome Web Store
**未提出です。** 現時点の導入方法は下記 B) の手動読み込みのみです。

### B) 開発者モード手動導入
1. 本リポジトリを **Clone** または **Download ZIP** → 解凍  
2. `chrome://extensions/` → **デベロッパーモード ON**  
3. **「パッケージ化されていない拡張機能を読み込む」** → 解凍フォルダを選択  
4. GitHub を再読み込みすると 🛈 マークが表示されます

---

## 🖥️ 動作確認環境 | Confirmed Environment
* Windows 11 + Chrome 137.0.7151.120 (64‑bit)  
* GitHub 公式 Web & PWA (Chrome アプリ)  
その他環境でも動作する可能性があります。報告歓迎！

---

## 📁 ディレクトリ構成
```text
📁 src/           content.js           # メインスクリプト
📁 icons/         icon128.png          # 拡張アイコン
📁 locales/       dict.json            # 日本語訳辞書 (151語)
📄 manifest.json  MV3 定義
📄 styles.css     🛈 アイコン & トグル
📄 README.md
```

---

## 🆕 変更履歴 | Changelog
| Version | Date | Highlights |
|---------|------|------------|
| **1.5** | 2025‑06‑29 | 📚 辞書語彙を 150+ 語へ拡充 |
| **1.4** | 2025‑06‑29 | 🌙 ダーク/ライト自動切替・README 整理 |
| **1.3** | 2025‑06‑29 | 📚 辞書 50→100 語&nbsp;/ 🖱 トグルボタン追加 |
| **1.2** | 2025-06-29 | 📂 辞書を `locales/` へ統合 |
| **1.1** | 2025-06-28 | 🛠 DOM 監視最適化 |
| **1.0** | 2025-06-28 | 🎉 初版リリース |

---

## 🌱 用語追加・誤訳報告 | Contribute Translations
Issue / PR 大歓迎！新規単語、誤訳修正、改善提案などお待ちしています。

---

## 💬 Feedback
* GitHub Issues / Discussions / PR  
* （公開後）Chrome Web Store レビュー

---

## 🪪 License
MIT License

---

## 🤝 Credits & Acknowledgements
人間 + ChatGPT (OpenAI) + Gemini (Google) による共同開発。  
This project was co‑developed through iterative conversation.

---

## ⚠ Disclaimer
この拡張機能は GitHub 非公式の独立ツールです。

---

## 📝 Note
文系の素人が勢いだけで作っています。ミスがあればやさしくご指摘ください 😅
