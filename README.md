# 🧠 GitHub 意訳支援 – GitHub Term Translator (JP)

![Chrome Web Store Compatible](https://img.shields.io/badge/Chrome_Extension-Ready-brightgreen)
![Version](https://img.shields.io/badge/version-1.1-blue)
![License](https://img.shields.io/badge/license-MIT-lightgrey)

---

## 📝 概要 | Overview
**GitHub 意訳支援**は、GitHub 上に表示される英語の専門用語を  
文脈に即した「意訳」で日本語表示する Chrome 拡張機能です。  
This extension translates key technical terms on GitHub into natural Japanese explanations.

---

## 🎯 主な特徴 | Features

- GitHub UI に登場する英語用語を自動検出し、日本語ツールチップを表示  
- ユーザーインターフェースを壊さない 🛈 アイコン＋吹き出し  
- 軽量・高速（v1.1 で DOM 監視ループを最適化し大幅に高速化）  
- 辞書は `content.js` に直書き（20 語）—今後拡張予定  

---

## 💡 対象ユーザー | Intended Users

- GitHub を初めて使う日本の学生・文系ユーザー  
- 英語 UI に抵抗がある開発者・研究者  
- 技術文脈を日本語で把握したいユーザー  

---

## 🚀 インストール手順 | How to Install (Developer Mode)

1. 本リポジトリを **Clone** 又は **ZIP ダウンロード**  
2. Chrome で `chrome://extensions/` を開き「デベロッパーモード」を **ON**  
3. **「パッケージ化されていない拡張機能を読み込む」** → フォルダを選択  
4. GitHub を開くと、英語用語の横に 🛈 マークが表示されます  

> **アップデート (v1.1)**  
> 既に v1.0 を読み込んでいる場合は、拡張カードの「更新」ボタンを押してください。

---

## 🆕 変更履歴 | Changelog

| Version | Date | Highlights |
|---------|------|------------|
| **1.1** | 2025-06-28 | 🔹 MutationObserver 最適化で無限ループを解消<br>🔹 追加ノードのみを走査しパフォーマンス大幅改善<br>🔹 1 テキストノードに複数訳語があっても対応 |
| **1.0** | 2025-06-27 | 🎉 初回リリース (MVP)<br>英語用語に 🛈 アイコンと日本語意訳を表示 |

---

## 🔧 辞書カスタマイズ (開発者向け)

`content.js` の `const dict = { ... }` を編集して語彙を追加できます。

```js
"compare": "変更の比較"
