/*
 * 拡張として実際に読み込んだ状態での検証。
 *   node --test tests/e2e/extension.e2e.mjs
 *
 * ここでしか確かめられないのは、肩代わりの効かない部分:
 *   manifest が Chrome に受理されるか / 読み込み順（matcher.js が先か）/
 *   web_accessible_resources を通した辞書の読み込み / 本物の chrome.storage /
 *   タブをまたいだ設定の同期 / 実際の DOM とフォーカスの挙動。
 * Chrome が無い環境では openssl か Chrome の不在で失敗する。CI では両方入っている。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { launchChrome, startTestServer, stageExtension, stageExtensionWith,
         SENTINEL_PAGE, LIFECYCLE_PAGE, VISIBILITY_PAGE, RETIRE_PAGE, RESELECT_PAGE,
         openPage, sleep, waitFor,
         pressKey, collectTabOrder, tabUntil } from './helpers/chrome.mjs';

const PAGE = 'https://github.com/octocat/Hello-World';

test('拡張として読み込んだ状態で動く', async t => {
  const srv = await startTestServer();
  const chrome = await launchChrome({ port: srv.port });
  const { cdp } = chrome;
  t.after(async () => { chrome.kill(); await srv.close(); });

  // ① Chrome が manifest を受理して読み込めること（アイコン・権限・参照ファイルが妥当）
  const dir = stageExtension();
  const loaded = await cdp.send('Extensions.loadUnpacked', { path: dir });
  assert.match(loaded.id, /^[a-p]{32}$/, `拡張IDが返らない: ${JSON.stringify(loaded)}`);

  const tab = await openPage(cdp, PAGE);

  // ② 印が付く＝matcher.js が content.js より先に読み込まれ、辞書も読めている
  //    （web_accessible_resources と content_scripts.matches が実際に効いている）
  const icons = await waitFor('印が付く', async () =>
    await tab.evaluate(`document.querySelectorAll('.iiyaku-icon').length`));
  assert.ok(icons > 0, '印が1つも付いていない');

  /* ---------- 編集できる領域を変えない ---------- */

  await t.test('編集できる領域には印を入れない（属性の書き方4通り）', async () => {
    assert.deepEqual(
      await tab.evaluate(`['ce-true','ce-empty','ce-plain','ce-parent','ce-child','draft']
        .map(id => document.getElementById(id).querySelectorAll?.('.iiyaku-icon').length ?? 0)`),
      [0, 0, 0, 0, 0, 0]
    );
  });

  await t.test('編集できる領域の中身が1文字も変わっていない', async () => {
    assert.deepEqual(
      await tab.evaluate(`[
        document.getElementById('ce-true').innerHTML,
        document.getElementById('ce-empty').textContent,
        document.getElementById('ce-plain').childNodes.length,
        document.getElementById('ce-parent').innerHTML,
        document.getElementById('draft').value
      ]`),
      ['a fork of the project', 'the upstream repo', 1, '<span id="ce-child">your token here</span>', '書きかけ clone']
    );
  });

  await t.test('編集領域にあった語は、後のふつうの文章で説明される', async () => {
    // 編集領域で「使った」ことにされず、次の出現へ回っていること
    assert.deepEqual(
      await tab.evaluate(`[...document.querySelectorAll('#prose-after .iiyaku-icon')]
        .map(i => i.dataset.iiyakuKey).sort()`),
      ['fork', 'token', 'upstream', 'webhook']
    );
  });

  /* ---------- 入口（キーボードで到達できる要素）の解決 ---------- */

  await t.test('label は、関連付いた入力欄が入口になる', async () => {
    const id = await tab.evaluate(`document.querySelector('#lab-for .iiyaku-icon')?.dataset.iiyakuFor ?? null`);
    assert.ok(id, 'label 内に印が無い');
    assert.equal(await tab.evaluate(`document.getElementById('inp-for').getAttribute('data-iiyaku-trigger')`), id);
  });

  await t.test('label が入力欄を含む場合も、その入力欄が入口になる', async () => {
    const id = await tab.evaluate(`document.querySelector('#lab-wrap .iiyaku-icon')?.dataset.iiyakuFor ?? null`);
    assert.ok(id);
    assert.equal(await tab.evaluate(`document.getElementById('inp-wrap').getAttribute('data-iiyaku-trigger')`), id);
  });

  await t.test('到達できない場所には印を付けない（境界18件）', async () => {
    // label（対応する入力欄なし）／role だけ／disabled／隠れた入力欄／display:none／
    // visibility:hidden／空の tabindex／空白だけの tabindex／details の外の summary／
    // details の2番目の summary／無効な fieldset の中／入口の無い矢印ウィジェット／
    // 矢印で動く部品の -1 の項目／実装の無い部品の -1 の項目／
    // display:contents のリンクとボタン／visibility:hidden の先祖（子は可視）
    const ids = ['lab-none', 'role-only', 'btn-disabled', 'lab-hidden', 'lab-dnone', 'lab-vhidden',
                 'ti-empty', 'ti-space', 'orphan-summary', 'sum-second', 'btn-in-fs',
                 'broken-item', 'orphan-item',
                 'tree-target', 'nh-target', 'dc-link', 'dc-btn', 'vh-host'];
    const counts = await tab.evaluate(`${JSON.stringify(ids)}
      .map(id => document.getElementById(id).querySelectorAll('.iiyaku-icon').length)`);
    assert.deepEqual(counts, ids.map(() => 0), `印が付いた場所: ${ids.filter((_, i) => counts[i] > 0)}`);
  });

  await t.test('到達できる入口には印を付ける（境界6件）', async () => {
    // label→入力欄／label が包む入力欄／無効な fieldset でも最初の legend の中は例外／
    // details の最初の summary／矢印ウィジェットの Tab 入口（実装の有無によらず 0 は入口）
    const map = await tab.evaluate(`(() => {
      const pairs = { 'lab-for': 'inp-for', 'lab-wrap': 'inp-wrap', 'btn-legend': 'btn-legend',
                      'sum-first': 'sum-first', 'tree-entry': 'tree-entry', 'nh-entry': 'nh-entry' };
      const out = {};
      for (const [host, expected] of Object.entries(pairs)) {
        const ic = document.getElementById(host).querySelector('.iiyaku-icon');
        const t = ic && document.querySelector('[data-iiyaku-trigger="' + ic.dataset.iiyakuFor + '"]');
        out[host] = ic ? (t ? t.id : '入口なし') : '印なし';
      }
      return out;
    })()`);
    assert.deepEqual(map, { 'lab-for': 'inp-for', 'lab-wrap': 'inp-wrap', 'btn-legend': 'btn-legend',
                            'sum-first': 'sum-first', 'tree-entry': 'tree-entry', 'nh-entry': 'nh-entry' });
  });

  await t.test('そこで付けなかった語は、後のふつうの文章で説明される', async () => {
    // 入口が無くて見送った語が、どこにも説明されないまま終わっていないこと。
    // 語を落とすのではなく、説明する場所を後ろへ送っているだけである、の確認。
    assert.deepEqual(
      await tab.evaluate(`[...document.querySelectorAll('#prose-fallback .iiyaku-icon')]
        .map(i => i.dataset.iiyakuKey).sort()`),
      ['blame', 'collaborator', 'conflict', 'contributors', 'diff', 'forks', 'insights',
       'origin', 'packages', 'projects', 'release', 'security', 'sync', 'topic',
       'visibility', 'watch', 'watching', 'wiki']
    );
  });

  await t.test('フォーカスできるだけの容器は入口にしない（印自体を入口にする）', async () => {
    const r = await tab.evaluate(`(() => {
      const icons = [...document.querySelectorAll('#scroll-region .iiyaku-icon')];
      return { n: icons.length, roles: icons.map(i => i.getAttribute('role')),
               grouped: icons.filter(i => i.dataset.iiyakuFor).length,
               containerIsTrigger: document.getElementById('scroll-region').hasAttribute('data-iiyaku-trigger') };
    })()`);
    assert.equal(r.n, 2);
    assert.deepEqual(r.roles, ['button', 'button']);
    assert.equal(r.grouped, 0);
    assert.equal(r.containerIsTrigger, false);
  });

  await t.test('フォーカスできない容器の中でも、印自体を入口にする', async () => {
    assert.equal(
      await tab.evaluate(`document.getElementById('ti-minus1').querySelector('.iiyaku-icon')?.getAttribute('role')`),
      'button');
  });

  /* ---------- 到達可能性は、ブラウザに実キーを送って確かめる ---------- */
  // 実装と同じ式でテスト側でも計算すると、同じ誤りを共有して素通りする。
  // ここでは Tab を押して、ブラウザが実際に止まった要素だけを「到達できる」とみなす。

  await t.test('装飾扱いの印の入口は、すべて前向き Tab の順路に出てくる（実キー送信）', async () => {
    // 入口の証明を「実際にブラウザが止まった要素」だけに限る。
    // 矢印キーによる例外を認めない（それは実装のある部品でしか成り立たず、
    // DOM の構造からは実装の有無を判定できないため）。
    const reachable = new Set(await collectTabOrder(cdp, tab, 90));
    const hosted = await tab.evaluate(`[...document.querySelectorAll('.iiyaku-icon[aria-hidden="true"]')]
      .map(ic => {
        const t = document.querySelector('[data-iiyaku-trigger="' + ic.dataset.iiyakuFor + '"]');
        return { key: ic.dataset.iiyakuKey, trigger: t ? (t.id || t.tagName) : null };
      })`);
    const unreachable = hosted.filter(h => !h.trigger || !reachable.has(h.trigger));
    assert.deepEqual(unreachable, [], `前向き Tab で辿り着けない入口: ${JSON.stringify(unreachable)}`);
    assert.ok(hosted.length >= 5, `装飾扱いの印が少なすぎる: ${hosted.length}`);
  });

  await t.test('装飾扱いの印の入口は、Shift+Tab の順路にも出てくる（実キー送信）', async () => {
    // 前向きだけを確かめて「キーボードで到達できる」と書かない。
    // 逆順に回っても同じ入口へ止まることを、実際に Shift+Tab を送って確かめる。
    const back = new Set(await collectTabOrder(cdp, tab, 90, 'after', { shift: true }));
    const hosted = await tab.evaluate(`[...document.querySelectorAll('.iiyaku-icon[aria-hidden="true"]')]
      .map(ic => {
        const t = document.querySelector('[data-iiyaku-trigger="' + ic.dataset.iiyakuFor + '"]');
        return { key: ic.dataset.iiyakuKey, trigger: t ? (t.id || t.tagName) : null };
      })`);
    const missing = hosted.filter(h => !h.trigger || !back.has(h.trigger));
    assert.deepEqual(missing, [], `Shift+Tab で辿り着けない入口: ${JSON.stringify(missing)}`);
  });

  await t.test('到達できない要素が Tab 順路に現れない（対照）', async () => {
    // 上の判定が機能していることの裏取り。ここに出てきたら fixture 側が壊れている。
    const order = new Set(await collectTabOrder(cdp, tab, 90));
    const mustNotAppear = ['inp-hidden', 'inp-dnone', 'inp-vhidden', 'btn-in-fs',
                           'ti-empty', 'ti-space', 'orphan-summary', 'sum-second',
                           'broken-item', 'orphan-item', 'role-only',
                           'tree-target', 'nh-target', 'dc-link', 'dc-btn', 'vh-host'];
    assert.deepEqual(mustNotAppear.filter(id => order.has(id)), []);
    // 逆に、到達できるはずのものは出てくる（対照）
    for (const id of ['inp-for', 'btn-legend', 'sum-first', 'tree-entry', 'nh-entry']) {
      assert.ok(order.has(id), `${id} が Tab 順路に出てこない＝測れていない`);
    }
  });

  await t.test('描画されない入口は、ブラウザ自身も止まらない（反証の対照）', async () => {
    // 監査の独立反証と同じことを、こちらでも実測して同じ答えになるか確かめる。
    // ここで tabbable と出るなら fixture が反例になっていない。
    const r = await tab.evaluate(`(() => {
      const f = id => { const el = document.getElementById(id);
        return { rects: el.getClientRects().length, tabIndex: el.tabIndex }; };
      return { dcLink: f('dc-link'), dcBtn: f('dc-btn'), vhHost: f('vh-host') };
    })()`);
    // tabindex 属性の上では入口に見える（＝構造だけでは見分けられない）
    assert.equal(r.dcLink.tabIndex, 0);
    assert.equal(r.dcBtn.tabIndex, 0);
    assert.equal(r.vhHost.tabIndex, 0);
    // しかし箱が無い／隠れているので、実際には止まれない
    assert.equal(r.dcLink.rects, 0, 'display:contents のリンクに箱がある＝反例になっていない');
    assert.equal(r.dcBtn.rects, 0, 'display:contents のボタンに箱がある＝反例になっていない');
  });

  await t.test('矢印に応答する部品としない部品を、実キーで見分ける（対照）', async () => {
    // 正しい部品では ArrowDown / ArrowUp で実際にフォーカスが動く。
    await tab.evaluate(`(() => { document.getElementById('tree-entry').tabIndex = 0;
      document.getElementById('tree-target').tabIndex = -1;
      document.getElementById('tree-entry').focus(); })(); true`);
    await pressKey(cdp, tab.sessionId, 'ArrowDown');
    await sleep(150);
    const down = await tab.evaluate(`document.activeElement.id`);
    await pressKey(cdp, tab.sessionId, 'ArrowUp');
    await sleep(150);
    const up = await tab.evaluate(`document.activeElement.id`);
    assert.equal(down, 'tree-target', 'ArrowDown で移動しない＝正常な部品になっていない');
    assert.equal(up, 'tree-entry', 'ArrowUp で戻らない');

    // 構造が同じでも、実装が無い部品では動かない。v1.8.2 はここを到達可能と誤判定していた。
    await tab.evaluate(`(() => { document.getElementById('tree-entry').tabIndex = 0;
      document.getElementById('tree-target').tabIndex = -1;
      document.getElementById('nh-entry').focus(); })(); true`);
    await pressKey(cdp, tab.sessionId, 'ArrowDown');
    await sleep(150);
    assert.equal(await tab.evaluate(`document.activeElement.id`), 'nh-entry',
      '実装の無い部品で矢印が効いている＝反例になっていない');

    // どちらの部品でも、-1 の項目には印を付けていない（構造から推定しない）
    assert.deepEqual(
      await tab.evaluate(`['tree-target','nh-target']
        .map(id => document.getElementById(id).querySelectorAll('.iiyaku-icon').length)`),
      [0, 0]);
    await tab.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  });

  await t.test('画面の外にある印へ実際に Tab で移っても説明が出る', async () => {
    // フォーカス移動に伴う自動スクロールで吹き出しが消えていた（v1.8.1 の不具合）。
    // focus() を直接呼ばず、Tab を押し続けて本当に到達させる。
    await tab.evaluate(`window.scrollTo(0, 0); true`);
    const before = await tab.evaluate(`window.scrollY`);
    const hit = await tabUntil(cdp, tab,
      `el.classList.contains('iiyaku-icon') && el.closest('#far-below')`, { steps: 150 });
    assert.ok(hit, '画面外の印へ Tab で到達できない');
    const r = await tab.evaluate(`(() => {
      const tip = document.querySelector('.iiyaku-tooltip');
      return { scrolled: window.scrollY !== ${before}, tip: !!tip,
               key: document.activeElement.dataset.iiyakuKey };
    })()`);
    assert.equal(r.scrolled, true, '自動スクロールが起きていない＝画面外の再現になっていない');
    assert.equal(r.key, 'revert');
    assert.equal(r.tip, true, 'スクロールを伴うフォーカスで説明が消える');
    await tab.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); window.scrollTo(0,0); true`);
  });

  /* ---------- 1つの入口に複数の用語 ---------- */

  await t.test('1つのリンクに複数の用語があると、まとめて読める', async () => {
    const keys = await tab.evaluate(`[...document.querySelectorAll('#nav-multi .iiyaku-icon')]
      .map(i => i.dataset.iiyakuKey).sort()`);
    assert.deepEqual(keys, ['merge', 'pull request']);
    const shown = await tab.evaluate(`(() => {
      document.getElementById('nav-multi').focus();
      const tip = document.querySelector('.iiyaku-tooltip');
      return tip ? { rows: tip.querySelectorAll('.iiyaku-tooltip-item').length, text: tip.textContent } : null;
    })()`);
    assert.ok(shown, 'リンクにフォーカスしても説明が出ない');
    assert.equal(shown.rows, 2, '2つの用語のうち片方しか出ていない');
    assert.ok(shown.text.includes('取り込む') && shown.text.includes('提案'), `説明が両方入っていない: ${shown.text.slice(0, 80)}`);
    await tab.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  });

  await t.test('印そのものに触れたときは、その1件だけ出す', async () => {
    const rows = await tab.evaluate(`(() => {
      const ic = document.querySelector('#nav-multi .iiyaku-icon');
      ic.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      const tip = document.querySelector('.iiyaku-tooltip');
      return tip ? tip.querySelectorAll('.iiyaku-tooltip-item').length : -1;
    })()`);
    assert.equal(rows, 1);
    await tab.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  });

  /* ---------- 読み上げ用の意味づけ ---------- */

  await t.test('リンクの中の印は装飾扱いで、リンク名を汚さない', async () => {
    assert.equal(await tab.evaluate(`document.querySelector('#nav-issues').textContent.trim()`), 'Issues');
    assert.deepEqual(
      await tab.evaluate(`(() => { const i = document.querySelector('#nav-issues .iiyaku-icon');
        return i ? [i.getAttribute('aria-hidden'), i.hasAttribute('aria-label'), i.hasAttribute('tabindex')] : 'なし'; })()`),
      ['true', false, false]
    );
  });

  await t.test('文章の中の印は、短い名前のボタンとして扱う', async () => {
    assert.deepEqual(
      await tab.evaluate(`(() => { const i = document.querySelector('#prose .iiyaku-icon');
        return [i.getAttribute('role'), i.getAttribute('tabindex'), i.getAttribute('aria-label'),
                i.getAttribute('aria-label').length < 20]; })()`),
      ['button', '0', '「branch」の解説', true]
    );
  });

  await t.test('名前と説明が同じ全文にならない（二重読みを避ける）', async () => {
    const r = await tab.evaluate(`(() => {
      // 位置に依存しないよう、単独の印ならどれでもよい
      const i = document.querySelector('.iiyaku-icon[role="button"]');
      if (!i) return { error: '単独の印が無い' };
      i.focus();
      const tip = document.querySelector('.iiyaku-tooltip');
      if (!tip) return { error: '説明が出ない' };
      return { name: i.getAttribute('aria-label'), desc: tip ? tip.textContent : null,
               expanded: i.getAttribute('aria-expanded') };
    })()`);
    assert.notEqual(r.name, r.desc);
    assert.ok(r.desc.length > r.name.length * 2, '説明が名前より十分に長くない');
    assert.equal(r.expanded, 'true');
  });

  await t.test('Escape で閉じ、開閉の状態も戻る', async () => {
    assert.deepEqual(
      await tab.evaluate(`(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        const i = document.querySelector('#prose .iiyaku-icon');
        return [document.querySelector('.iiyaku-tooltip') === null, i.getAttribute('aria-expanded'),
                i.hasAttribute('aria-describedby')]; })()`),
      [true, 'false', false]
    );
  });

  /* ---------- aria-describedby の共存 ---------- */

  await t.test('もともとの aria-describedby と、表示中に足された ID を壊さない', async () => {
    const r = await tab.evaluate(`(() => {
      const host = document.getElementById('aria-host');
      host.focus();
      const during = host.getAttribute('aria-describedby');
      // 表示中に、ページ側が別の ID を足したことにする
      host.setAttribute('aria-describedby', during + ' dynamic-help');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return { during, after: host.getAttribute('aria-describedby') };
    })()`);
    assert.ok(r.during.split(/\s+/).includes('existing-help'), `元の ID が消えている: ${r.during}`);
    assert.ok(r.during.split(/\s+/).length === 2, `表示中の token が2つでない: ${r.during}`);
    assert.deepEqual(r.after.split(/\s+/).sort(), ['dynamic-help', 'existing-help']);
  });

  await t.test('ツールチップの ID がページ側の要素と衝突しない', async () => {
    const r = await tab.evaluate(`(() => {
      document.querySelector('#prose .iiyaku-icon').focus();
      const tip = document.querySelector('.iiyaku-tooltip');
      const dupes = document.querySelectorAll('[id="' + tip.id + '"]').length;
      const legacy = document.getElementById('iiyaku-tooltip');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return { id: tip.id, dupes, legacyIsOurs: legacy ? legacy.classList.contains('iiyaku-tooltip') : null };
    })()`);
    assert.equal(r.dupes, 1, 'ツールチップと同じ ID の要素が複数ある');
    assert.notEqual(r.id, 'iiyaku-tooltip', 'ID が固定のまま');
    assert.equal(r.legacyIsOurs, false, 'ページ側の同名要素を自分のものと取り違えている');
  });

  /* ---------- 狭い画面での表示 ---------- */

  await t.test('320px 幅でも吹き出しが画面の外へ出ない', async () => {
    await cdp.send('Emulation.setDeviceMetricsOverride',
      { width: 320, height: 640, deviceScaleFactor: 1, mobile: false }, tab.sessionId);
    await sleep(200);
    const r = await tab.evaluate(`(() => {
      const i = document.querySelector('#edge .iiyaku-icon') || document.querySelector('#prose .iiyaku-icon');
      i.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      const tip = document.querySelector('.iiyaku-tooltip');
      if (!tip) return null;
      const b = tip.getBoundingClientRect();
      return { left: Math.round(b.left), right: Math.round(b.right), top: Math.round(b.top),
               bottom: Math.round(b.bottom), vw: document.documentElement.clientWidth,
               vh: document.documentElement.clientHeight };
    })()`);
    assert.ok(r, '吹き出しが出ない');
    assert.ok(r.left >= 0 && r.right <= r.vw, `横にはみ出している: ${JSON.stringify(r)}`);
    assert.ok(r.top >= 0 && r.bottom <= r.vh, `縦にはみ出している: ${JSON.stringify(r)}`);
    await tab.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
    await cdp.send('Emulation.clearDeviceMetricsOverride', {}, tab.sessionId);
    await sleep(200);
  });

  await t.test('環境が変わっても字形と形が崩れない（Windows 想定）', async () => {
    const r = await tab.evaluate(`(() => {
      const i = document.querySelector('.iiyaku-icon[role="button"]');
      const tb = document.querySelector('.iiyaku-toggle');
      if (!i) return { error: '単独の印が無い' };
      if (!tb) return { error: '切替ボタンが無い' };
      i.focus();
      const tip = document.querySelector('.iiyaku-tooltip');
      if (!tip) return { error: '説明が出ない' };
      const ib = i.getBoundingClientRect();
      const f = el => getComputedStyle(el).fontFamily;
      const JA = /Yu Gothic UI|Hiragino Sans|Noto Sans CJK|Meiryo/;
      return {
        // 日本語の字形を持つフォントを、こちらで指定できているか
        tipHasJa: JA.test(f(tip)),
        toggleHasJa: JA.test(f(tb)),
        // 印は丸なので、縦横が崩れると欠ける
        square: Math.abs(ib.width - ib.height) < 1.5,
        drawn: ib.width > 6 && ib.height > 6,
        // 吹き出しが潰れていない
        tipBox: tip.getBoundingClientRect().height > 10
      };
    })()`);
    await tab.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
    assert.deepEqual(r, { tipHasJa: true, toggleHasJa: true, square: true, drawn: true, tipBox: true });
  });

  /* ---------- 見えていない場所が「最初の1回」を使い切らない ---------- */

  await t.test('見えていない場所には印を付けず、後ろの読める語へ付ける（4種）', async () => {
    // 隠れている側に付くと、その語はページのどこでも説明されなくなる。
    // 祖先の opacity と content-visibility は、子の computed 値には出ないので、
    // 直接の親だけを見る判定では見抜けない（実測: 子は箱も持つ）。
    const r = await tab.evaluate(`(() => {
      const n = sel => document.querySelectorAll(sel + ' .iiyaku-icon').length;
      return {
        inert:   { hidden: n('#inert-box'), later: n('#after-inert') },
        opacity: { hidden: n('#op-host'),   later: n('#after-op') },
        cvHidden:{ hidden: n('#cv-host'),   later: n('#after-cv') },
        clip:    { hidden: n('#clip-box'),  later: n('#after-clip') }
      };
    })()`);
    assert.deepEqual(r, {
      inert:    { hidden: 0, later: 1 },
      opacity:  { hidden: 0, later: 1 },
      cvHidden: { hidden: 0, later: 1 },
      clip:     { hidden: 0, later: 1 }
    }, `隠れている側に印が付いた: ${JSON.stringify(r)}`);
  });

  await t.test('反例が本当に「見えない」ことをブラウザ自身に確かめる（対照）', async () => {
    // fixture が反例になっていることの裏取り。ここが崩れると上の試験は無意味になる。
    const r = await tab.evaluate(`(() => {
      const opt = { opacityProperty: true, visibilityProperty: true };
      const f = id => { const el = document.getElementById(id);
        return { visible: el.checkVisibility(opt), rects: el.getClientRects().length,
                 boxed: el.offsetWidth > 0 || el.offsetHeight > 0 }; };
      // content-visibility:hidden が隠すのは「中身」なので、host 自身ではなく
      // 語が入っている子要素で測る。host 自身は描画されたままである。
      return { op: f('op-p'), cv: f('cv-p'), clip: f('clip-box'),
               cvHostItself: f('cv-host').visible,
               inertHit: !!document.getElementById('inert-box').closest('[inert]') };
    })()`);
    assert.equal(r.op.visible, false, 'opacity:0 が見えている扱いになっている');
    assert.equal(r.cv.visible, false, 'content-visibility:hidden の中身が見えている扱いになっている');
    assert.equal(r.cvHostItself, true, 'host 自身は描画されたまま＝子で測る必要があることの確認');
    // こちらが使っている箱の検査（offsetWidth / offsetHeight）では落ちない。
    // だから checkVisibility が要る、という関係を固定しておく。
    // なお getClientRects() は文脈によって 0 を返すことがあり、当てにできない。
    assert.equal(r.cv.boxed, true, 'offsetWidth も 0＝箱の検査だけで落ちてしまい反例にならない');
    assert.equal(r.inertHit, true, 'inert が効いていない');
    // clip は checkVisibility では見抜けない。だから形（1px＋clip）で判定している
    assert.equal(r.clip.visible, true, 'clip が checkVisibility で落ちる＝この対照の前提が変わった');
    assert.equal(r.clip.boxed, true, 'clip 要素の箱が 0＝箱の検査で落ちてしまい反例にならない');
  });

  await t.test('見えなくなった古い印は、後から現れた読める語を妨げない', async () => {
    // DOM に残っていること（isConnected）は、説明として使えることを意味しない。
    const before = await tab.evaluate(`(() => {
      const n = k => document.querySelectorAll('.iiyaku-icon[data-iiyaku-key="' + k + '"]').length;
      return { reset: n('reset'), sshKey: n('ssh key') };
    })()`);
    assert.deepEqual(before, { reset: 1, sshKey: 1 }, '前提の印が付いていない');

    await tab.evaluate(`(() => {
      document.getElementById('stale-a').style.display = 'none';   // reset を隠す
      document.getElementById('stale-b').style.opacity = '0';      // ssh key を隠す
      const a = document.createElement('p'); a.id = 'new-reset';
      a.textContent = 'A fresh reset appears here.';
      const b = document.createElement('p'); b.id = 'new-sshkey';
      b.textContent = 'A fresh ssh key appears here.';
      document.getElementById('sink').append(a, b);
    })(); true`);
    await waitFor('隠れた語が、新しく現れた読める場所へ付き直る', async () =>
      await tab.evaluate(`document.querySelectorAll('#new-reset .iiyaku-icon').length === 1
                       && document.querySelectorAll('#new-sshkey .iiyaku-icon').length === 1`));

    const after = await tab.evaluate(`(() => {
      const n = k => document.querySelectorAll('.iiyaku-icon[data-iiyaku-key="' + k + '"]').length;
      return { oldReset: document.querySelectorAll('#stale-a .iiyaku-icon').length,
               oldSshKey: document.querySelectorAll('#stale-b .iiyaku-icon').length,
               totalReset: n('reset'), totalSshKey: n('ssh key') };
    })()`);
    // 古い印は片づける。残すと同じ語の印が画面に2つあることになる。
    assert.deepEqual(after, { oldReset: 0, oldSshKey: 0, totalReset: 1, totalSshKey: 1 },
      `古い印が残っているか、同じ語の印が増えている: ${JSON.stringify(after)}`);
  });

  await t.test('コード表示部分には印が付かない', async () => {
    assert.equal(await tab.evaluate(`document.querySelectorAll('#code .iiyaku-icon').length`), 0);
  });

  await t.test('OFF にしてもページを読み直さず、書きかけの入力が残る', async () => {
    await tab.evaluate(`globalThis.__alive = 'このページのまま'; document.querySelector('#draft').value = '消えないで'; true`);
    await tab.evaluate(`document.querySelector('.iiyaku-toggle').click(); true`);
    await sleep(300);
    assert.equal(await tab.evaluate(`globalThis.__alive ?? null`), 'このページのまま');
    assert.equal(await tab.evaluate(`document.querySelector('#draft').value`), '消えないで');
    assert.equal(await tab.evaluate(`document.documentElement.classList.contains('iiyaku-off')`), true);
    assert.equal(await tab.evaluate(`getComputedStyle(document.querySelector('.iiyaku-icon')).display`), 'none');
    assert.ok(await tab.evaluate(`document.querySelectorAll('.iiyaku-icon').length > 0`), 'OFF で印を DOM から消してはいけない');
  });

  await t.test('別のタブへ設定が伝わる（本物の chrome.storage）', async () => {
    const other = await openPage(cdp, PAGE);
    await waitFor('2枚目が OFF で開く', async () =>
      await other.evaluate(`document.documentElement.classList.contains('iiyaku-off')`));
    await other.evaluate(`document.querySelector('.iiyaku-toggle').click(); true`);
    await waitFor('1枚目へ伝わる', async () =>
      await tab.evaluate(`document.documentElement.classList.contains('iiyaku-off') === false`));
    assert.equal(await tab.evaluate(`document.querySelector('.iiyaku-toggle').textContent`), '解説 ON');
    await other.close();
  });

  await t.test('ON に戻すと、OFF 中に増えた文章にも印が付く', async () => {
    await tab.evaluate(`document.querySelector('.iiyaku-toggle').click(); true`);   // OFF
    await sleep(200);
    await tab.evaluate(`(() => { const p = document.createElement('p'); p.id = 'later';
      p.textContent = 'A squash merge keeps history tidy.'; document.body.appendChild(p); })(); true`);
    await tab.evaluate(`document.querySelector('.iiyaku-toggle').click(); true`);   // ON
    await waitFor('後から足した文章に印が付く', async () =>
      await tab.evaluate(`document.querySelectorAll('#later .iiyaku-icon').length === 1`));
  });

  await t.test('同じ語はページで1回だけ', async () => {
    const dupes = await tab.evaluate(`(() => {
      const keys = [...document.querySelectorAll('.iiyaku-icon')].map(i => i.dataset.iiyakuKey);
      return keys.filter((k, i) => keys.indexOf(k) !== i);
    })()`);
    assert.deepEqual(dupes, []);
  });

  await tab.close();
});

/*
 * 除外領域のテキストが、辞書の照合まで届いていないか。
 *
 * content script は隔離された世界で動くため、ページ側から getter を差し替えても
 * 拡張の中は見えない。同じ拡張の content script として計測用の JS を読み込ませ、
 * 同じ世界の中で測る。使うのは並べた一時ディレクトリの manifest だけで、
 * 配布物は変えない。
 *
 * 測る場所は「文字の取り出し口」ではなく「matcher の入口」。取り出し口は
 * innerText / Range.toString() / substringData() など際限がなく、いくつ塞いでも
 * 「全部塞いだ」とは言えない。読み取り方が何であれ、その文字列で語を判定するなら
 * 必ず matcher を通るので、そこを1か所押さえる。
 *
 * 「順序が正しいか」を静的に見る検査（scripts/verify.mjs）は、別名の変数・
 * 補助関数・bracket 記法などで迂回できる。こちらが本命の担保で、静的検査は
 * 単純な後戻りを早く止めるための補助にすぎない。
 */
const tapped = () => stageExtensionWith(
  { 'matcher-tap.js': 'tests/e2e/matcher-tap.js' },
  js => js.flatMap(f => f === 'src/matcher.js' ? [f, 'matcher-tap.js'] : [f]));

test('除外する領域のテキストが、辞書の照合まで届かない（隔離世界で計測）', async t => {
  const srv = await startTestServer(SENTINEL_PAGE);
  const chrome = await launchChrome({ port: srv.port });
  t.after(async () => { chrome.kill(); await srv.close(); });

  const loaded = await chrome.cdp.send('Extensions.loadUnpacked', { path: tapped() });
  assert.match(loaded.id, /^[a-p]{32}$/, `拡張IDが返らない: ${JSON.stringify(loaded)}`);
  const tab = await openPage(chrome.cdp, PAGE);

  // 計装が効いていること自体を先に確かめる（効いていなければ「0件」は無意味）
  await waitFor('matcher を包めている', async () =>
    await tab.evaluate(`document.documentElement.getAttribute('data-rg-tap') === 'ready'`));
  // 見える場所の目印は必ず届く＝計測が生きていることの対照
  await waitFor('見える場所の目印が届く', async () =>
    (await tab.evaluate(`document.documentElement.getAttribute('data-rg-reads') || ''`))
      .includes('RGSENTINEL_VISIBLE'));
  await waitFor('印が付く', async () =>
    await tab.evaluate(`document.querySelectorAll('.iiyaku-icon').length > 0`));
  await sleep(600);

  const reads = (await tab.evaluate(`document.documentElement.getAttribute('data-rg-reads') || ''`))
    .split(',').filter(Boolean);

  const mustNotRead = ['RGSENTINEL_EDITABLE', 'RGSENTINEL_TEXTAREA', 'RGSENTINEL_INPUT',
                       'RGSENTINEL_SELECT', 'RGSENTINEL_CODE', 'RGSENTINEL_BLOB',
                       'RGSENTINEL_ARIAHIDDEN', 'RGSENTINEL_INERT',
                       'RGSENTINEL_HIDDEN', 'RGSENTINEL_UNTILFOUND'];
  const leaked = mustNotRead.filter(s => reads.includes(s));
  assert.deepEqual(leaked, [], `除外領域なのに辞書照合へ届いた: ${leaked.join(', ')}`);
  assert.ok(reads.includes('RGSENTINEL_VISIBLE'), '見える場所すら届いていない＝計測が壊れている');

  // 除外領域の中身が1文字も変わっていないこと（読まないことと、壊さないことの両方）
  assert.deepEqual(
    await tab.evaluate(`[document.getElementById('s-editable').textContent,
                        document.getElementById('s-textarea').value,
                        document.getElementById('s-input').value,
                        document.querySelectorAll('#s-editable .iiyaku-icon').length,
                        document.querySelectorAll('#s-code .iiyaku-icon').length]`),
    ['RGSENTINEL_EDITABLE a repository draft', 'RGSENTINEL_TEXTAREA a commit message',
     'RGSENTINEL_INPUT a branch name', 0, 0]);

  await tab.close();
});

/*
 * 上の「0件」が、計測できていないだけではないことの裏取り。
 *
 * わざと3通りの取り出し方で除外領域の文字列を辞書照合へ渡し、そのすべてが
 * 記録されることを見る。1つでも記録されなければ、その経路は計測の外にある。
 */
test('計測が、取り出し方を変えても取り逃がさない（わざと漏らす対照）', async t => {
  const srv = await startTestServer(SENTINEL_PAGE);
  const chrome = await launchChrome({ port: srv.port });
  t.after(async () => { chrome.kill(); await srv.close(); });

  await chrome.cdp.send('Extensions.loadUnpacked', { path: stageExtensionWith(
    { 'matcher-tap.js': 'tests/e2e/matcher-tap.js', 'leak-probe.js': 'tests/e2e/leak-probe.js' },
    js => [...js.flatMap(f => f === 'src/matcher.js' ? [f, 'matcher-tap.js'] : [f]), 'leak-probe.js']) });
  const tab = await openPage(chrome.cdp, PAGE);
  await waitFor('わざとの漏れが動いた', async () =>
    await tab.evaluate(`document.documentElement.getAttribute('data-rg-leak') === 'done'`));
  await sleep(300);

  const reads = (await tab.evaluate(`document.documentElement.getAttribute('data-rg-reads') || ''`))
    .split(',').filter(Boolean);
  // ① innerText ② Range.toString() ③ substringData()
  const routes = { innerText: 'RGSENTINEL_EDITABLE', rangeToString: 'RGSENTINEL_CODE',
                   substringData: 'RGSENTINEL_INERT' };
  const missed = Object.entries(routes).filter(([, s]) => !reads.includes(s)).map(([k]) => k);
  assert.deepEqual(missed, [], `この取り出し方は計測をすり抜ける: ${missed.join(', ')}`);

  await tab.close();
});

/*
 * manifest の minimum_chrome_version が要る理由を、実測で残す。
 *
 * Element.checkVisibility が無い環境では、祖先の opacity / content-visibility を
 * 見抜けない。「単純な代替手段では支えられない」ことを、印の付き方の差で示す。
 * これが成り立たなくなったら（＝代替手段で同じ答えが出るなら）、最低版の指定を
 * 見直してよい、という関係を固定しておく。
 */
test('checkVisibility が無いと、見えない場所へ印が付く（最低版を要する理由）', async t => {
  const srv = await startTestServer(VISIBILITY_PAGE);
  const chrome = await launchChrome({ port: srv.port });
  t.after(async () => { chrome.kill(); await srv.close(); });

  await chrome.cdp.send('Extensions.loadUnpacked', { path: stageExtensionWith(
    { 'no-cv.js': 'tests/e2e/no-checkvisibility.js' }, js => ['no-cv.js', ...js]) });
  const tab = await openPage(chrome.cdp, PAGE);
  await waitFor('計測用の差し替えが効いている', async () =>
    await tab.evaluate(`document.documentElement.getAttribute('data-rg-no-checkvisibility') === 'ready'`));
  await waitFor('印が付く', async () =>
    await tab.evaluate(`document.querySelectorAll('.iiyaku-icon').length > 0`));
  await sleep(600);

  const r = await tab.evaluate(`(() => {
    const n = id => document.getElementById(id).querySelectorAll('.iiyaku-icon').length;
    return { cv: { there: n('cv-host'), later: n('cv-later') },
             opacity: { there: n('op-host'), later: n('op-later') },
             display: { there: n('dn-host'), later: n('dn-later') } };
  })()`);
  // 祖先の content-visibility と opacity は見抜けず、見えない側へ付いてしまう
  assert.deepEqual(r.cv, { there: 1, later: 0 },
    `代替手段だけで content-visibility を見抜けている＝最低版の根拠が変わった: ${JSON.stringify(r.cv)}`);
  assert.deepEqual(r.opacity, { there: 1, later: 0 },
    `代替手段だけで opacity を見抜けている＝最低版の根拠が変わった: ${JSON.stringify(r.opacity)}`);
  // display:none は代替手段でも見抜ける（差が出るのは上の2つだけ、という切り分け）
  assert.deepEqual(r.display, { there: 0, later: 1 });

  await tab.close();
});

/*
 * 見えない場所の「直接テキスト」と、印の付け直し。
 * 語が重ならないよう、専用のページを使う（同じ語はページで1回しか注記しないため）。
 */
test('見えない直接テキストを避け、印を付け直せる', async t => {
  const srv = await startTestServer(LIFECYCLE_PAGE);
  const chrome = await launchChrome({ port: srv.port });
  t.after(async () => { chrome.kill(); await srv.close(); });
  await chrome.cdp.send('Extensions.loadUnpacked', { path: stageExtension() });
  const tab = await openPage(chrome.cdp, PAGE);
  await waitFor('印が付く', async () =>
    await tab.evaluate(`document.querySelectorAll('.iiyaku-icon').length > 0`));
  await sleep(400);

  await t.test('要素自身が文字を持つ隠し方でも、後ろの読める語へ回す（4種）', async () => {
    // 子ではなく host 自身が文字を持つ形。host は描画されたままなので、
    // 祖先を見る判定だけでは落ちない（実測で確認した反例）。
    const r = await tab.evaluate(`(() => {
      const n = s => document.querySelectorAll(s + ' .iiyaku-icon').length;
      return { cvDirect:   { hidden: n('#cvd'),     later: n('#after-cvd') },
               hiddenAttr: { hidden: n('#hd'),      later: n('#after-hd') },
               untilFound: { hidden: n('#huf'),     later: n('#after-huf') },
               bigClip:    { hidden: n('#bigclip'), later: n('#after-bigclip') } };
    })()`);
    assert.deepEqual(r, {
      cvDirect:   { hidden: 0, later: 1 },
      hiddenAttr: { hidden: 0, later: 1 },
      untilFound: { hidden: 0, later: 1 },
      bigClip:    { hidden: 0, later: 1 }
    }, `見えない側に印が付いた: ${JSON.stringify(r)}`);
  });

  await t.test('反例が本当に「見えない」ことをブラウザ自身に確かめる（対照）', async () => {
    const r = await tab.evaluate(`(() => {
      const opt = { opacityProperty: true, visibilityProperty: true };
      const f = id => { const el = document.getElementById(id);
        return { visible: el.checkVisibility(opt),
                 cv: getComputedStyle(el).contentVisibility,
                 boxed: el.offsetWidth > 0 || el.offsetHeight > 0 }; };
      return { cvd: f('cvd'), huf: f('huf'), bigclip: f('bigclip') };
    })()`);
    // ここが崩れると、上の試験は何も確かめていないことになる
    assert.equal(r.cvd.visible, true, 'content-visibility:hidden の host 自身が false＝別の理由で落ちている');
    assert.equal(r.cvd.cv, 'hidden', 'contentVisibility が hidden になっていない');
    assert.equal(r.huf.cv, 'hidden', 'hidden="until-found" が content-visibility:hidden になっていない');
    assert.equal(r.bigclip.visible, true, 'clip が checkVisibility で落ちる＝この対照の前提が変わった');
    assert.equal(r.bigclip.boxed, true, '大きな箱のはずが箱を持っていない');
  });

  await t.test('箱を作らなくても、文字が見えていれば注記する（display:contents）', async () => {
    const r = await tab.evaluate(`(() => {
      const el = document.getElementById('dcd');
      const range = document.createRange(); range.selectNodeContents(el);
      return { icons: el.querySelectorAll('.iiyaku-icon').length,
               offsetW: el.offsetWidth, offsetH: el.offsetHeight,
               textRects: range.getClientRects().length,
               cv: el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) };
    })()`);
    // 箱は無く、ブラウザも「描画されていない」と答えるが、文字は見えている
    assert.equal(r.offsetW, 0); assert.equal(r.offsetH, 0);
    assert.equal(r.cv, false, 'display:contents で checkVisibility が true＝この対照の前提が変わった');
    assert.ok(r.textRects > 0, '文字の範囲に矩形が無い＝この反例が成り立っていない');
    assert.ok(r.icons > 0, `見えている文字なのに注記されない: ${JSON.stringify(r)}`);
  });

  await t.test('隠した印は片づけ、戻したら同じ場所へ付け直す（単独の印）', async () => {
    const count = async () => await tab.evaluate(`(() => ({
      old: document.querySelectorAll('#life-plain .iiyaku-icon').length,
      fresh: document.querySelectorAll('#fresh-reset .iiyaku-icon').length,
      total: document.querySelectorAll('.iiyaku-icon[data-iiyaku-key="reset"]').length,
      text: document.getElementById('life-plain').textContent
    }))()`);
    const initial = await count();
    assert.deepEqual([initial.old, initial.fresh, initial.total], [1, 0, 1], '前提が崩れている');

    // ① 古い場所を隠し、読める場所に同じ語を出す
    await tab.evaluate(`(() => { document.getElementById('life-plain').style.display = 'none';
      const p = document.createElement('p'); p.id = 'fresh-reset';
      p.textContent = 'A fresh reset appears.'; document.getElementById('sink').append(p); })(); true`);
    await waitFor('読める側へ付け直る', async () => (await count()).fresh === 1);
    const moved = await count();
    assert.deepEqual([moved.old, moved.fresh, moved.total], [0, 1, 1], `移っていない: ${JSON.stringify(moved)}`);

    // ② 読める場所を消し、古い場所を戻す。画面遷移も起こす
    await tab.evaluate(`(() => { document.getElementById('fresh-reset').remove();
      document.getElementById('life-plain').style.display = '';
      history.pushState({}, '', '/octocat/Hello-World/other');
      const u = document.createElement('p'); u.textContent = 'unrelated';
      document.getElementById('sink').append(u); })(); true`);
    await waitFor('元の場所へ戻る', async () => (await count()).old === 1);
    const back = await count();
    assert.deepEqual([back.old, back.fresh, back.total], [1, 0, 1], `戻っていない: ${JSON.stringify(back)}`);
    assert.equal(back.text, 'Do not reset it lightly.', '本文が変わっている');

    // ③ 同じ要素を外して戻す（Text node の同一性が変わらない経路）
    await tab.evaluate(`(() => { const el = document.getElementById('life-plain');
      const parent = el.parentNode; el.remove(); parent.appendChild(el); })(); true`);
    await waitFor('外して戻しても付く', async () => (await count()).old === 1);
    const again = await count();
    assert.deepEqual([again.old, again.total], [1, 1], `外して戻すと消える: ${JSON.stringify(again)}`);
    assert.equal(again.text, 'Do not reset it lightly.', '本文が変わっている');
  });

  await t.test('リンクの中の印でも同じ往復ができる', async () => {
    const count = async () => await tab.evaluate(`(() => ({
      old: document.querySelectorAll('#life-link .iiyaku-icon').length,
      total: document.querySelectorAll('.iiyaku-icon[data-iiyaku-key="ssh key"]').length,
      text: document.getElementById('life-link').textContent
    }))()`);
    const before = await count();
    assert.deepEqual([before.old, before.total], [1, 1], '前提が崩れている');
    await tab.evaluate(`(() => { document.getElementById('life-link').style.display = 'none';
      const p = document.createElement('p'); p.id = 'fresh-ssh';
      p.textContent = 'Add another ssh key.'; document.getElementById('sink').append(p); })(); true`);
    await waitFor('読める側へ付け直る', async () =>
      await tab.evaluate(`document.querySelectorAll('#fresh-ssh .iiyaku-icon').length === 1`));
    // 付け直しが起きるのは「走査が走ったとき」（画面遷移か、ノードの追加）。
    // 属性を変えただけでは走査は起きない——これは既知の制約として残している。
    await tab.evaluate(`(() => { document.getElementById('fresh-ssh').remove();
      document.getElementById('life-link').style.display = '';
      history.pushState({}, '', '/octocat/Hello-World/again');
      const u = document.createElement('p'); u.textContent = 'unrelated 2';
      document.getElementById('sink').append(u); })(); true`);
    await waitFor('リンクへ戻る', async () => (await count()).old === 1);
    const after = await count();
    assert.deepEqual([after.old, after.total], [1, 1], `リンクへ戻らない: ${JSON.stringify(after)}`);
    assert.equal(after.text, 'Add an ssh key', 'リンクの文字が変わっている');
  });

  await tab.close();
});

/*
 * 箱を作らない要素（display:contents）と、切り取りによる非表示。
 *
 * どちらも「箱を持つ先祖に1回聞いた答え」を子へ転用すると誤る。しかも
 * 誤り方が両方向にある——見えないものへ印を付ける側と、見えているものを
 * 落とす側の両方。片側だけを試すと、もう片側を壊しても気づけないので、
 * 反例を対にして置く。
 */
test('箱を持たない文字と、切り取りの判定', async t => {
  const srv = await startTestServer(VISIBILITY_PAGE);
  const chrome = await launchChrome({ port: srv.port });
  t.after(async () => { chrome.kill(); await srv.close(); });
  await chrome.cdp.send('Extensions.loadUnpacked', { path: stageExtension() });
  const tab = await openPage(chrome.cdp, PAGE);
  await waitFor('印が付く', async () =>
    await tab.evaluate(`document.querySelectorAll('.iiyaku-icon').length > 0`));
  await sleep(400);

  const counts = async ids => await tab.evaluate(`${JSON.stringify(ids)}
    .map(id => document.getElementById(id).querySelectorAll('.iiyaku-icon').length)`);

  await t.test('display:contents の文字を、性質ごとに分けて判定する（5種）', async () => {
    const r = await tab.evaluate(`(() => {
      const n = id => document.getElementById(id).querySelectorAll('.iiyaku-icon').length;
      return {
        // 先祖が中身を飛ばしている: 読めないので、後ろの本文へ回す
        contentVisibility: { there: n('cv-host'), later: n('cv-later') },
        // 先祖が visibility:hidden でも、子が visible に戻していれば読める
        visibilityRestored: { there: n('vh-host'), later: n('vh-later') },
        // 先祖が opacity:0 / display:none: 読めない
        opacity: { there: n('op-host'), later: n('op-later') },
        display:  { there: n('dn-host'), later: n('dn-later') },
        // ふつうの display:contents（直接テキスト）: 読める
        plain: n('plain-dc')
      };
    })()`);
    assert.deepEqual(r, {
      contentVisibility:  { there: 0, later: 1 },
      visibilityRestored: { there: 1, later: 0 },
      opacity:            { there: 0, later: 1 },
      display:            { there: 0, later: 1 },
      plain: 1
    }, `判定が実際の見え方と合っていない: ${JSON.stringify(r)}`);
  });

  await t.test('反例が本当に反例であることを、ブラウザ自身に確かめる（対照）', async () => {
    // ここが崩れると、上の試験は何も確かめていないことになる。
    const r = await tab.evaluate(`(() => {
      const OPT = { opacityProperty: true, visibilityProperty: true };
      const NOVIS = { opacityProperty: true };
      const rects = el => { const g = document.createRange();
        g.selectNodeContents(el); return g.getClientRects().length; };
      const f = id => { const el = document.getElementById(id); const cs = getComputedStyle(el);
        return { display: cs.display, visibility: cs.visibility,
                 visible: el.checkVisibility(OPT), rects: rects(el) }; };
      return {
        cvDc: f('cv-dc'), vhDc: f('vh-dc'),
        cvHostVisible: document.getElementById('cv-host').checkVisibility(OPT),
        cvHostCv: getComputedStyle(document.getElementById('cv-host')).contentVisibility,
        vhHostVisible: document.getElementById('vh-host').checkVisibility(OPT),
        vhHostNoVis: document.getElementById('vh-host').checkVisibility(NOVIS)
      };
    })()`);
    // ① 中身を飛ばす先祖: 先祖自身は「見えている」と答える。
    //    最初から飛ばされている場合は Range の矩形も 0 になる（実測）。
    //    一度描かれてから飛ばした場合は矩形が残る——そちらは下の別の試験で見る。
    assert.equal(r.cvHostVisible, true, '先祖が false＝別の理由で落ちており反例になっていない');
    assert.equal(r.cvHostCv, 'hidden', 'content-visibility:hidden が効いていない');
    assert.equal(r.cvDc.rects, 0, `最初から飛ばした中身に矩形が出た（${r.cvDc.rects}）＝前提が変わった`);
    // ② visibility を戻した子: 先祖は「見えていない」と答えるが、子は visible
    assert.equal(r.vhHostVisible, false, '先祖が true＝反例になっていない');
    assert.equal(r.vhDc.visibility, 'visible', '子の visibility が visible に戻っていない');
    assert.ok(r.vhDc.rects > 0, '子の文字に矩形が無い＝見えているという前提が崩れている');
    // ③ visibility を外して聞けば、先祖は「見えている」と答える（判定の要）
    assert.equal(r.vhHostNoVis, true, 'visibility を外しても先祖が false＝この分け方が成り立たない');
    // ④ どちらも箱を持たない（だから先祖に聞く必要がある）
    assert.equal(r.cvDc.display, 'contents');
    assert.equal(r.vhDc.display, 'contents');
    assert.equal(r.cvDc.visible, false, 'display:contents で checkVisibility が true＝前提が変わった');
  });

  await t.test('一度描かれてから中身を飛ばされた場所は、矩形が残っていても除外する', async () => {
    // これが RG-7-01a の本命。Range は隠したあとも矩形を返し続けるので
    // （実測: 前 1 個 / 後 1 個）、「矩形があるか」だけでは見抜けない。
    assert.deepEqual(await counts(['late-host']), [1], '前提の印が無い');
    const before = await tab.evaluate(`(() => { const g = document.createRange();
      g.selectNodeContents(document.getElementById('late-dc')); return g.getClientRects().length; })()`);
    await tab.evaluate(`(() => {
      document.getElementById('late-host').style.contentVisibility = 'hidden';
      document.getElementById('late-host').getBoundingClientRect();   // レイアウトを起こす
      const p = document.createElement('p'); p.id = 'late-fresh';
      p.textContent = 'Another fetch happens.';
      document.getElementById('late-sink').append(p);
    })(); true`);
    await waitFor('読める側へ回る', async () => await counts(['late-fresh']).then(c => c[0] === 1));
    const r = await tab.evaluate(`(() => {
      const g = document.createRange(); g.selectNodeContents(document.getElementById('late-dc'));
      const host = document.getElementById('late-host');
      return { rectsAfter: g.getClientRects().length,
               hostVisible: host.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
               there: host.querySelectorAll('.iiyaku-icon').length,
               fresh: document.querySelectorAll('#late-fresh .iiyaku-icon').length };
    })()`);
    // 対照: 矩形も先祖の答えも「見えている」と言い続けている
    assert.ok(before > 0, '隠す前に矩形が無い＝前提が崩れている');
    assert.ok(r.rectsAfter > 0, `隠したら矩形も消えた（${r.rectsAfter}）＝この反例が成り立たない`);
    assert.equal(r.hostVisible, true, '先祖が false を返す＝別の理由で落ちており反例にならない');
    // それでも、飛ばされた側には付けず、読める側へ回すこと
    assert.deepEqual([r.there, r.fresh], [0, 1], `飛ばされた側に印が残っている: ${JSON.stringify(r)}`);
  });

  await t.test('画面外の content-visibility:auto は除外しない', async () => {
    // 画面外というだけで落とすと、長いページの下が永久に注記されない。
    assert.deepEqual(await counts(['cva-host']), [1]);
  });

  await t.test('legacy clip は絶対配置のときだけ効く（6種）', async () => {
    const r = await tab.evaluate(`(() => {
      const n = id => document.getElementById(id).querySelectorAll('.iiyaku-icon').length;
      return { staticClip: n('clip-static'), relativeClip: n('clip-relative'),
               absClip: { there: n('clip-abs'), later: n('abs-later') },
               fixedClip: { there: n('clip-fixed'), later: n('fixed-later') },
               clipPath: { there: n('clippath-static'), later: n('clippath-later') },
               primer: { there: n('primer'), later: n('primer-later') } };
    })()`);
    assert.deepEqual(r, {
      staticClip: 1,          // 見えている。除外してはいけない
      relativeClip: 1,        // 同上
      absClip:   { there: 0, later: 1 },
      fixedClip: { there: 0, later: 1 },
      clipPath:  { there: 0, later: 1 },   // clip-path は配置に関係なく効く
      primer:    { there: 0, later: 1 }    // 1px 四方の読み上げ専用
    }, `切り取りの判定が実際の見え方と合っていない: ${JSON.stringify(r)}`);
  });

  await t.test('切り取りが実際に効いているかを、当たり判定で確かめる（対照）', async () => {
    // 「clip は絶対配置にしか効かない」を、こちらの式の言い換えではなく
    // ブラウザの振る舞いで見る。切り取られた領域は指も当たらない。
    const r = await tab.evaluate(`(() => {
      const at = id => { const el = document.getElementById(id);
        // elementFromPoint は画面の座標で見る。画面の外にあると必ず null になり、
        // 「当たらない＝切り取られている」と取り違える（実測でそうなった）。
        el.scrollIntoView({ block: 'center' });
        const b = el.getBoundingClientRect();
        const hit = document.elementFromPoint(b.left + Math.min(4, b.width / 2), b.top + b.height / 2);
        return { self: !!hit && (hit === el || el.contains(hit)),
                 onScreen: b.top >= 0 && b.bottom <= document.documentElement.clientHeight,
                 w: Math.round(b.width), clip: getComputedStyle(el).clip,
                 position: getComputedStyle(el).position }; };
      return { st: at('clip-static'), rel: at('clip-relative'), abs: at('clip-abs') };
    })()`);
    // まず、3つとも画面の中で測れていること（測れていなければ以下は無意味）
    for (const [k, v] of Object.entries(r)) {
      assert.equal(v.onScreen, true, `${k} が画面の外にある＝当たり判定を測れていない`);
    }
    // 3つとも同じ clip 指定であること（違いは position だけ）
    assert.equal(r.st.clip, 'rect(0px, 0px, 0px, 0px)', `static の clip 指定が違う: ${r.st.clip}`);
    assert.equal(r.abs.clip, 'rect(0px, 0px, 0px, 0px)', `absolute の clip 指定が違う: ${r.abs.clip}`);
    assert.equal(r.st.position, 'static');
    assert.equal(r.abs.position, 'absolute');
    assert.ok(r.st.w > 100, `static の箱が小さい＝反例になっていない: ${r.st.w}`);
    // 効き方が違う: static/relative は当たる（＝見えている）、absolute は当たらない
    assert.equal(r.st.self, true, 'static で clip が効いている＝この判定の前提が変わった');
    assert.equal(r.rel.self, true, 'relative で clip が効いている＝この判定の前提が変わった');
    assert.equal(r.abs.self, false, 'absolute で clip が効いていない＝反例になっていない');
  });

  await tab.close();
});

/*
 * 印の片づけ（退役）。
 *
 * 片づけるときに「印の隣にあるもの」を見て自分が割った対だと推し量ると、
 * ページ側が挿し込んだ節点を消す・選択範囲を壊す・印だけ外されると復帰できない、
 * の3つが起きる（いずれも v1.8.5 で実測した）。注記した時点の記録だけを使う。
 */
test('印の片づけが、ページの持ち物と選択範囲を壊さない', async t => {
  const srv = await startTestServer(RETIRE_PAGE);
  const chrome = await launchChrome({ port: srv.port });
  t.after(async () => { chrome.kill(); await srv.close(); });
  await chrome.cdp.send('Extensions.loadUnpacked', { path: stageExtension() });
  const tab = await openPage(chrome.cdp, PAGE);
  await waitFor('印が付く', async () =>
    await tab.evaluate(`document.querySelectorAll('.iiyaku-icon').length > 0`));
  await sleep(400);

  const nIcons = async sel => await tab.evaluate(
    `document.querySelectorAll(${JSON.stringify(sel)} + ' .iiyaku-icon').length`);
  const nKey = async key => await tab.evaluate(
    `document.querySelectorAll('.iiyaku-icon[data-iiyaku-key="' + ${JSON.stringify(key)} + '"]').length`);

  let seq = 0;
  /* 印を「説明として使えない」状態にし、同じ語を読める場所へ出す。
     こうすると、その場所を隠さずに片づけだけを起こせる（選択範囲を見たいので、
     元の文章は見えたままにしておく必要がある）。 */
  async function forceRetire(hostSel, freshText) {
    const id = 'fresh' + (++seq);
    await tab.evaluate(`(() => {
      const ic = document.querySelector(${JSON.stringify(hostSel)} + ' .iiyaku-icon');
      // 入口として使えなくする＝説明として使えない。装飾扱いの印は自分では
      // 止まれないので、その印が指している入口のほうを使えなくする。
      window.__forced = null;
      if (ic) {
        const forId = ic.dataset.iiyakuFor;
        const t = forId ? document.querySelector('[data-iiyaku-trigger="' + forId + '"]') : null;
        window.__forced = t || ic;        // 元へ戻せるよう控える
        window.__forced.tabIndex = -1;
      }
      const p = document.createElement('p'); p.id = ${JSON.stringify(id)};
      p.textContent = ${JSON.stringify(freshText)};
      document.getElementById('sink').append(p);
    })(); true`);
    await waitFor(`${id} へ付け直る`, async () => await nIcons('#' + id) === 1);
    return id;
  }

  async function restoreFrom(freshId) {
    await tab.evaluate(`(() => {
      // 入口を元へ戻す。装飾扱いの印は入口が生きていないと付け直せない
      if (window.__forced) { window.__forced.removeAttribute('tabindex'); window.__forced = null; }
      document.getElementById(${JSON.stringify(freshId)}).remove();
      history.pushState({}, '', '/octocat/Hello-World/r' + ${seq});
      const u = document.createElement('p'); u.textContent = 'unrelated ' + ${seq};
      document.getElementById('sink').append(u);
    })(); true`);
  }

  await t.test('印だけを外されても、その語をもう一度説明できる', async () => {
    assert.equal(await nIcons('#solo'), 1, '前提の印が無い');
    // ページ側が印だけを取り去る。こちらの片づけを通らない経路。
    await tab.evaluate(`document.querySelector('#solo .iiyaku-icon').remove(); true`);
    await waitFor('元の場所へ付き直る', async () => await nIcons('#solo') === 1);
    assert.equal(await nKey('revert'), 1, '同じ語の印が増えている');
    // 監査が指定した経路（画面遷移＋全体走査）でも同じ結果になること
    await tab.evaluate(`document.querySelector('#solo .iiyaku-icon').remove();
      history.pushState({}, '', '/octocat/Hello-World/again');
      const u = document.createElement('p'); u.textContent = 'unrelated';
      document.getElementById('sink').append(u); true`);
    await waitFor('画面遷移でも付き直る', async () => await nIcons('#solo') === 1);
    assert.equal(await tab.evaluate(`document.getElementById('solo').textContent`),
      'Undo it with a revert now.', '本文が変わっている');
  });

  await t.test('印の前へページ側が置いた節点を、消しも書き換えもしない', async () => {
    await tab.evaluate(`(() => {
      const ic = document.querySelector('#solo .iiyaku-icon');
      const n = document.createTextNode(' [page-before]');
      ic.parentNode.insertBefore(n, ic);
      window.__before = n;
    })(); true`);
    const fresh = await forceRetire('#solo', 'A fresh revert appears.');
    const r = await tab.evaluate(`({ connected: window.__before.isConnected,
      value: window.__before.nodeValue,
      inSolo: document.getElementById('solo').contains(window.__before),
      text: document.getElementById('solo').textContent })`);
    assert.equal(r.connected, true, 'ページが置いた節点が DOM から外れている');
    assert.equal(r.value, ' [page-before]', 'ページが置いた節点の中身が書き換わっている');
    assert.equal(r.inSolo, true, 'ページが置いた節点が別の場所へ移っている');
    assert.equal(r.text, 'Undo it with a revert [page-before] now.', `本文が変わっている: ${r.text}`);
    await restoreFrom(fresh);
    await waitFor('元へ戻る', async () => await nIcons('#solo') === 1);
  });

  await t.test('印の後ろへページ側が置いた節点を、消しも書き換えもしない', async () => {
    await tab.evaluate(`(() => {
      const ic = document.querySelector('#solo .iiyaku-icon');
      const n = document.createTextNode(' [page-after]');
      ic.parentNode.insertBefore(n, ic.nextSibling);
      window.__after = n;
    })(); true`);
    const fresh = await forceRetire('#solo', 'Another fresh revert shows.');
    const r = await tab.evaluate(`({ connected: window.__after.isConnected,
      value: window.__after.nodeValue,
      inSolo: document.getElementById('solo').contains(window.__after) })`);
    assert.equal(r.connected, true, 'ページが置いた節点が DOM から外れている（v1.8.5 の不具合）');
    assert.equal(r.value, ' [page-after]', 'ページが置いた節点の中身が書き換わっている');
    assert.equal(r.inSolo, true, 'ページが置いた節点が別の場所へ移っている');
    await restoreFrom(fresh);
    await waitFor('元へ戻る', async () => await nIcons('#solo') === 1);
  });

  await t.test('片づけても、利用者が選んでいる範囲が壊れない（3通り）', async () => {
    // ① 印より後ろだけ ② 印を跨ぐ ③ 逆向き（focus が anchor より前）
    const cases = [
      { name: '後ろだけ', expr: `r.setStart(B, 1); r.setEnd(B, 8); sel.addRange(r);`, want: 'of the ' },
      { name: '跨ぐ',     expr: `r.setStart(A, 18); r.setEnd(B, 4); sel.addRange(r);`, want: 'review of ' },
      { name: '逆向き',   expr: `sel.setBaseAndExtent(B, 4, A, 18);`, want: 'review of ' }
    ];
    for (const c of cases) {
      // 選択を作る。#selectable は見えたままにしておく（隠すと選択の意味が変わる）
      const made = await tab.evaluate(`(() => {
        const p = document.getElementById('selectable');
        const A = p.firstChild, B = p.lastChild;
        const sel = getSelection(); sel.removeAllRanges();
        const r = document.createRange();
        ${c.expr}
        window.__selA = A; window.__selB = B;
        return { text: sel.toString(), a: A.nodeValue, b: B.nodeValue,
                 anchorIsB: sel.anchorNode === B };
      })()`);
      assert.equal(made.text, c.want, `[${c.name}] 前提の選択が作れていない: ${JSON.stringify(made)}`);

      const fresh = await forceRetire('#selectable', 'Please leave a review soon.');
      const after = await tab.evaluate(`(() => {
        const sel = getSelection();
        return { text: sel.toString(), count: sel.rangeCount,
                 anchorAlive: sel.anchorNode ? sel.anchorNode.isConnected : false,
                 focusAlive: sel.focusNode ? sel.focusNode.isConnected : false,
                 sameA: window.__selA.isConnected, sameB: window.__selB.isConnected,
                 reversed: sel.anchorNode === window.__selB,
                 text2: document.getElementById('selectable').textContent };
      })()`);
      assert.equal(after.text, c.want, `[${c.name}] 選択していた文字が変わった: ${JSON.stringify(after)}`);
      assert.equal(after.count, 1, `[${c.name}] 選択が消えた`);
      assert.equal(after.sameA, true, `[${c.name}] 選択の端にあった節点が外された`);
      assert.equal(after.sameB, true, `[${c.name}] 選択の端にあった節点が外された`);
      assert.equal(after.anchorAlive, true, `[${c.name}] anchor が外れた`);
      assert.equal(after.focusAlive, true, `[${c.name}] focus が外れた`);
      assert.equal(after.text2, 'Ask for a careful review of the code.', `[${c.name}] 本文が変わった`);
      if (c.name === '逆向き') assert.equal(after.reversed, true, '向きが入れ替わっている');
      // 次の場合のために片づける（印を戻す）
      await tab.evaluate(`getSelection().removeAllRanges(); true`);
      await restoreFrom(fresh);
      await waitFor('選択用の場所へ戻る', async () => await nIcons('#selectable') === 1);
    }
  });

  await t.test('リンクの中の印でも、同じ片づけと付け直しができる', async () => {
    assert.equal(await nIcons('#hosted'), 1, '前提の印が無い');
    const decorative = await tab.evaluate(
      `document.querySelector('#hosted .iiyaku-icon').getAttribute('aria-hidden')`);
    assert.equal(decorative, 'true', 'リンクの中の印が装飾扱いになっていない');
    const fresh = await forceRetire('#hosted', 'Show me another diff view.');
    assert.equal(await nIcons('#hosted'), 0, 'リンクの中の印が片づいていない');
    assert.equal(await tab.evaluate(`document.getElementById('hosted').textContent`),
      'Open the diff', 'リンクの文字が変わっている');
    await restoreFrom(fresh);
    await waitFor('リンクへ戻る', async () => await nIcons('#hosted') === 1);
    assert.equal(await nKey('diff'), 1);
  });

  await t.test('1つの節点に2つの用語があっても、片方だけを正しく戻せる', async () => {
    const keys = async () => await tab.evaluate(
      `[...document.querySelectorAll('#two .iiyaku-icon')].map(i => i.dataset.iiyakuKey).sort()`);
    assert.deepEqual(await keys(), ['origin', 'remote'], '前提の印が2つない');
    // 2つの印のあいだにある節点を控えておく。片方を片づけるときに、
    // もう片方が使っている節点まで巻き込んで消してはいけない。
    const mid = await tab.evaluate(`(() => {
      const icons = [...document.querySelectorAll('#two .iiyaku-icon')];
      window.__mid = icons[0].nextSibling;
      return { type: window.__mid.nodeType, value: window.__mid.nodeValue };
    })()`);
    assert.equal(mid.type, 3, `印のあいだが文字の節点でない: ${JSON.stringify(mid)}`);

    const fresh = await forceRetire('#two', 'Add a second remote now.');
    assert.deepEqual(await keys(), ['origin'], '片方だけ片づける、ができていない');
    const kept = await tab.evaluate(`({ connected: window.__mid.isConnected,
      value: window.__mid.nodeValue })`);
    assert.equal(kept.connected, true, 'もう片方の印が使っている節点まで消している');
    assert.equal(kept.value, mid.value, 'もう片方の印が使っている節点の中身を書き換えている');
    assert.equal(await tab.evaluate(`document.getElementById('two').textContent`),
      'A remote and an origin differ.', '本文が変わっている');
    await restoreFrom(fresh);
    await waitFor('2つに戻る', async () => (await keys()).length === 2);
    assert.deepEqual(await keys(), ['origin', 'remote']);
    assert.equal(await tab.evaluate(`document.getElementById('two').textContent`),
      'A remote and an origin differ.', '戻したあとに本文が変わっている');
  });

  await t.test('10往復しても、本文・節点の数・印の数が増えも減りもしない', async () => {
    // 用語が末尾ちょうどで終わる形。ここで毎回割ると、空の節点が往復のたびに増える。
    const snap = async () => await tab.evaluate(`(() => {
      const el = document.getElementById('tail-end');
      const kids = [...el.childNodes];
      return { text: el.textContent, nodes: kids.length,
               icons: el.querySelectorAll('.iiyaku-icon').length,
               empties: kids.filter(n => n.nodeType === 3 && n.nodeValue === '').length };
    })()`);
    const first = await snap();
    assert.equal(first.icons, 1, '前提の印が無い');
    assert.equal(first.empties, 0, `最初から空の節点がある: ${JSON.stringify(first)}`);
    for (let i = 0; i < 10; i++) {
      const fresh = await forceRetire('#tail-end', `Check blame view number ${i}.`);
      await restoreFrom(fresh);
      await waitFor(`${i + 1} 回目に戻る`, async () => await nIcons('#tail-end') === 1);
    }
    const last = await snap();
    assert.deepEqual(last, first, `10往復で形が変わった: ${JSON.stringify(first)} -> ${JSON.stringify(last)}`);
    assert.equal(await nKey('blame'), 1, '同じ語の印が増えている');
  });

  await t.test('親ごと差し替えられても、新しい側に1つだけ付く（対照）', async () => {
    assert.equal(await nIcons('#replaceable'), 1, '前提の印が無い');
    // GitHub が一部を描き直す動き。印は親ごと消え、同じ文章の新しい要素が来る。
    await tab.evaluate(`(() => {
      const old = document.getElementById('replaceable');
      const fresh = document.createElement('p');
      fresh.id = 'replaceable';
      fresh.textContent = 'Check the packages list.';
      old.replaceWith(fresh);
    })(); true`);
    await waitFor('新しい側へ付く', async () => await nIcons('#replaceable') === 1);
    assert.equal(await nKey('packages'), 1, '同じ語の印が増えている');
    assert.equal(await tab.evaluate(`document.getElementById('replaceable').textContent`),
      'Check the packages list.', '本文が変わっている');
  });

  await tab.close();
});

/*
 * 正規の印が居なくなったときに、**既にページにある候補**へ引き継げるか。
 *
 * 「同じ語はページで1回だけ」を実現するために、説明済みの語を含む節点は
 * 処理済みとして飛ばしている。飛ばした記録を永久に残すと、最初の印が消えたとき
 * その語がページのどこにも説明されなくなる（実測で 0 個になった）。
 * 記録と DOM の食い違い、複製された印の扱いも、ここでまとめて見る。
 */
test('印が居なくなったら、既にある候補へ引き継ぐ', async t => {
  const srv = await startTestServer(RESELECT_PAGE);
  const chrome = await launchChrome({ port: srv.port });
  t.after(async () => { chrome.kill(); await srv.close(); });
  await chrome.cdp.send('Extensions.loadUnpacked', { path: stageExtension() });
  const tab = await openPage(chrome.cdp, PAGE);
  await waitFor('印が付く', async () =>
    await tab.evaluate(`document.querySelectorAll('.iiyaku-icon').length > 0`));
  await sleep(500);

  const nIn = async sel => await tab.evaluate(
    `document.querySelectorAll(${JSON.stringify(sel)} + ' .iiyaku-icon').length`);
  const nKey = async k => await tab.evaluate(
    `document.querySelectorAll('.iiyaku-icon[data-iiyaku-key="' + ${JSON.stringify(k)} + '"]').length`);
  /* ページ側の変更を起こして、こちらが追随するのを待つ */
  const change = async js => { await tab.evaluate(`(() => { ${js} })(); true`); await sleep(150); };

  await t.test('最初の場所を消すと、既にある2番目へ移る', async () => {
    assert.deepEqual([await nIn('#first'), await nIn('#second'), await nKey('push')], [1, 0, 1],
      '前提が崩れている');
    await change(`document.getElementById('first').remove();
      const u = document.createElement('p'); u.textContent = 'unrelated';
      document.getElementById('sink').append(u);`);
    await waitFor('2番目へ移る', async () => await nIn('#second') === 1);
    assert.deepEqual([await nIn('#second'), await nKey('push')], [1, 1],
      `2番目へ移っていないか、増えている`);
    assert.equal(await tab.evaluate(`document.getElementById('second').textContent`),
      'A push second.', '本文が変わっている');
  });

  await t.test('隠れている候補は選ばず、その次の読める候補へ移る', async () => {
    // #third は display:none。ここを選ぶと、その語はページのどこでも読めなくなる
    await change(`document.getElementById('second').remove();
      const u = document.createElement('p'); u.textContent = 'unrelated 2';
      document.getElementById('sink').append(u);`);
    await waitFor('4番目へ移る', async () => await nIn('#fourth') === 1);
    assert.deepEqual([await nIn('#third'), await nIn('#fourth'), await nKey('push')], [0, 1, 1],
      '隠れている候補を選んでいるか、増えている');
  });

  await t.test('URL 変更＋全体走査でも同じ結果になる（対照）', async () => {
    await change(`history.pushState({}, '', '/octocat/Hello-World/reselect');
      const u = document.createElement('p'); u.textContent = 'unrelated 3';
      document.getElementById('sink').append(u);`);
    await sleep(400);
    assert.deepEqual([await nIn('#fourth'), await nKey('push')], [1, 1],
      '全体走査で増えるか消えるかしている');
  });

  await t.test('10往復しても、印は1個のまま増えも減りもしない', async () => {
    const text = await tab.evaluate(`document.getElementById('fourth').textContent`);
    for (let i = 0; i < 10; i++) {
      await change(`document.getElementById('fourth').style.display = 'none';
        const p = document.createElement('p'); p.id = 'tmp' + ${i};
        p.textContent = 'A push again ${i}.'; document.getElementById('sink').append(p);`);
      await waitFor(`${i}: 移る`, async () => await nIn('#tmp' + i) === 1);
      await change(`document.getElementById('tmp' + ${i}).remove();
        document.getElementById('fourth').style.display = '';
        const u = document.createElement('p'); u.textContent = 'u${i}';
        document.getElementById('sink').append(u);`);
      await waitFor(`${i}: 戻る`, async () => await nIn('#fourth') === 1);
    }
    assert.equal(await nKey('push'), 1, '同じ語の印が増えている');
    assert.equal(await tab.evaluate(`document.getElementById('fourth').textContent`), text,
      '本文が変わっている');
  });

  /* ---------- 記録と DOM の食い違い ---------- */

  await t.test('語だけが消されたら、印を残さず次の候補へ渡す', async () => {
    assert.equal(await nIn('#gone'), 1, '前提の印が無い');
    await change(`document.querySelector('#gone .iiyaku-icon').previousSibling.remove();
      const p = document.createElement('p'); p.id = 'fresh-conflict';
      p.textContent = 'A conflict appears again.'; document.getElementById('sink').append(p);`);
    await waitFor('新しい場所へ移る', async () => await nIn('#fresh-conflict') === 1);
    assert.deepEqual([await nIn('#gone'), await nKey('conflict')], [0, 1],
      '語を失った印が残っているか、増えている');
  });

  await t.test('語が別の文字へ書き換えられたら、古い印を無効にする', async () => {
    assert.equal(await nIn('#rewritten'), 1, '前提の印が無い');
    await change(`document.getElementById('rewritten').firstChild.nodeValue = 'Nothing here.';
      const p = document.createElement('p'); p.id = 'fresh-checks';
      p.textContent = 'Some checks appear again.'; document.getElementById('sink').append(p);`);
    await waitFor('新しい場所へ移る', async () => await nIn('#fresh-checks') === 1);
    assert.deepEqual([await nIn('#rewritten'), await nKey('checks')], [0, 1],
      '語の無くなった場所に印が残っているか、増えている');
  });

  await t.test('語と印のあいだへページが節点を挿しても、ページの節点を動かさず印を語の直後へ戻す', async () => {
    assert.equal(await nIn('#inserted'), 1, '前提の印が無い');
    const before = await tab.evaluate(`document.getElementById('inserted').textContent`);
    await change(`const ic = document.querySelector('#inserted .iiyaku-icon');
      const t = document.createTextNode('PAGE_INSERT'); ic.before(t); window.__ins = t;`);
    await waitFor('印が語の直後へ戻る', async () => await tab.evaluate(
      `(() => { const ic = document.querySelector('#inserted .iiyaku-icon');
        return !!ic && ic.previousSibling === document.getElementById('inserted').firstChild; })()`));
    const r = await tab.evaluate(`(() => {
      const p = document.getElementById('inserted');
      const ic = p.querySelector('.iiyaku-icon');
      return { 印の直前: ic.previousSibling.nodeValue,
               ページ節点が生きている: window.__ins.isConnected,
               ページ節点の中身: window.__ins.nodeValue,
               印の数: p.querySelectorAll('.iiyaku-icon').length,
               本文: p.textContent };
    })()`);
    assert.match(r.印の直前, /issues$/, `印が語の直後にない: ${JSON.stringify(r)}`);
    assert.equal(r.ページ節点が生きている, true, 'ページが置いた節点を外している');
    assert.equal(r.ページ節点の中身, 'PAGE_INSERT', 'ページが置いた節点を書き換えている');
    assert.equal(r.印の数, 1, '印が増えている');
    // 印は語の直後へ戻り、ページが置いた節点はその後ろに残る。
    // 文字そのものは1文字も増減していない（印は文字を持たない <sup>）。
    assert.equal(r.本文, 'Open the issuesPAGE_INSERT tab.', `本文の文字が変わっている: ${r.本文}`);
    assert.equal(r.本文.replace('PAGE_INSERT', ''), before,
      `ページが足した分を除くと元の本文に戻るはず: ${r.本文}`);
  });

  await t.test('語の節点が別の親へ移されても、印は1個のまま追随する', async () => {
    assert.equal(await nIn('#moved'), 1, '前提の印が無い');
    await change(`document.getElementById('elsewhere')
      .appendChild(document.getElementById('moved').firstChild);`);
    await waitFor('移動先へ追随する', async () => await nIn('#elsewhere') === 1);
    assert.deepEqual([await nIn('#moved'), await nKey('packages')], [0, 1],
      '元の場所に印が残っているか、増えている');
  });

  await t.test('作り直しても、利用者の選択範囲を壊さない', async () => {
    const made = await tab.evaluate(`(() => {
      const p = document.getElementById('selectable');
      const A = p.firstChild, B = p.lastChild;
      const sel = getSelection(); sel.removeAllRanges();
      sel.setBaseAndExtent(B, 1, A, 10);          // 逆向きに、印を跨いで選ぶ
      window.__a = A; window.__b = B;
      return { text: sel.toString(), anchorIsB: sel.anchorNode === B };
    })()`);
    assert.ok(made.text.length > 3, `前提の選択が作れていない: ${JSON.stringify(made)}`);
    // 記録の突合を起こす（ページ側が印の隣へ節点を足す）
    await change(`const ic = document.querySelector('#selectable .iiyaku-icon');
      if (ic) ic.before(document.createTextNode(''));`);
    await sleep(400);
    const after = await tab.evaluate(`(() => {
      const sel = getSelection();
      return { text: sel.toString(), count: sel.rangeCount,
               aAlive: window.__a.isConnected, bAlive: window.__b.isConnected,
               reversed: sel.anchorNode === window.__b,
               body: document.getElementById('selectable').textContent };
    })()`);
    assert.equal(after.text, made.text, `選択していた文字が変わった: ${JSON.stringify(after)}`);
    assert.equal(after.count, 1, '選択が消えた');
    assert.equal(after.aAlive, true, '選択の端にあった節点が外された');
    assert.equal(after.bAlive, true, '選択の端にあった節点が外された');
    assert.equal(after.reversed, true, '向きが入れ替わっている');
    assert.equal(after.body, 'Ask about the projects board.', '本文が変わっている');
  });

  await t.test('リンクの中の印と、1つの節点に2用語ある場合も保つ', async () => {
    assert.equal(await nIn('#lnk'), 1, 'リンクの中の印が無い');
    assert.deepEqual(
      await tab.evaluate(`[...document.querySelectorAll('#two .iiyaku-icon')]
        .map(i => i.dataset.iiyakuKey).sort()`), ['sync', 'watch'], '2用語が付いていない');
    assert.equal(await tab.evaluate(`document.getElementById('two').textContent`),
      'A sync and a watch differ.', '本文が変わっている');
  });

  /* ---------- 複製された印 ---------- */

  await t.test('注記済みの領域を複製しても、所有していない印と入口 ID を残さない', async () => {
    const r = await tab.evaluate(`(() => {
      const a = document.getElementById('clone-src').cloneNode(true); a.id = 'clone-a';
      const b = document.getElementById('clone-host').cloneNode(true); b.id = 'clone-b';
      document.getElementById('sink').append(a, b);
      return { 複製直後の印: document.querySelectorAll('#clone-a .iiyaku-icon, #clone-b .iiyaku-icon').length };
    })()`);
    assert.ok(r.複製直後の印 > 0, '複製で印が写っていない＝この試験の前提が崩れている');
    await sleep(600);
    const after = await tab.evaluate(`(() => {
      const ids = [...document.querySelectorAll('[data-iiyaku-trigger]')]
        .map(e => e.getAttribute('data-iiyaku-trigger'));
      return { cloneA: document.querySelectorAll('#clone-a .iiyaku-icon').length,
               cloneB: document.querySelectorAll('#clone-b .iiyaku-icon').length,
               origA: document.querySelectorAll('#clone-src .iiyaku-icon').length,
               origB: document.querySelectorAll('#clone-host .iiyaku-icon').length,
               label: document.querySelectorAll('.iiyaku-icon[data-iiyaku-key="label"]').length,
               workflow: document.querySelectorAll('.iiyaku-icon[data-iiyaku-key="workflow"]').length,
               trigger重複: ids.length !== new Set(ids).size,
               cloneAの本文: document.getElementById('clone-a').textContent.trim(),
               cloneBの本文: document.getElementById('clone-b').textContent.trim() };
    })()`);
    assert.deepEqual([after.cloneA, after.cloneB], [0, 0],
      `複製された印が残っている: ${JSON.stringify(after)}`);
    assert.deepEqual([after.origA, after.origB], [1, 1], '元の印が消えている');
    assert.deepEqual([after.label, after.workflow], [1, 1], '同じ語の印が増えている');
    assert.equal(after.trigger重複, false, '同じ入口 ID を持つ要素が複数ある');
    assert.equal(after.cloneAの本文, 'Add a label here.', '複製側の本文を壊している');
    assert.equal(after.cloneBの本文, 'Open the workflow view', '複製側の本文を壊している');
  });

  await t.test('複製したあとに元を消すと、複製側へ正規の印が1つ移る', async () => {
    await change(`document.getElementById('clone-src').remove();
      document.getElementById('clone-host').remove();
      const u = document.createElement('p'); u.textContent = 'u-clone';
      document.getElementById('sink').append(u);`);
    await waitFor('複製側へ移る', async () => await nIn('#clone-a') === 1);
    assert.deepEqual([await nIn('#clone-a'), await nKey('label')], [1, 1], 'label が移っていない');
    await waitFor('リンクの複製側へも移る', async () => await nIn('#clone-b') === 1);
    assert.deepEqual([await nIn('#clone-b'), await nKey('workflow')], [1, 1], 'workflow が移っていない');
  });

  await tab.close();
});
