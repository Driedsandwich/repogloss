// ストアへ出す ZIP に入れるファイル。ここが配布物の唯一の正本。
// テスト・CI・作業用の文書（tests/ scripts/ .github/ package.json など）は入れない。
// scripts/verify.mjs と tests/e2e/ の両方がこの一覧を使う。
export const PACKAGE_FILES = [
  'manifest.json',
  'styles.css',
  'src/matcher.js',
  'src/content.js',
  'locales/dict.json',
  'icons/icon16.png',
  'icons/icon32.png',
  'icons/icon48.png',
  'icons/icon128.png',
  'README.md',
  'DESIGN.md',
  'PRIVACY.md',
  'LICENSE'
];
