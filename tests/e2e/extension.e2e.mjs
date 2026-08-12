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
         USABILITY_PAGE, NAMESPACE_CLIP_PAGE, PROTECTED_PAGE, CONVERGE_PAGE,
         SIGNALS_PAGE, OWNERSHIP_PAGE, LATENT_PAGE, SIGNATURE_PAGE,
         LATENT_GUARD_PAGE, DEFERRED_PAGE, SKIPNAME_PAGE, CLIPZERO_PAGE,
         PAINT_PAGE, LIFECYCLE13_PAGE, SIGNATURE13_PAGE, TRANSIENT_PAGE,
         ROOTATTR_PAGE, latentPage,
         WORDRECT_PAGE, NAMESPACE14_PAGE,
         PAINT15_PAGE, HOVER15_PAGE,
         PAINT16_PAGE, REACH16_PAGE, NAMESPACE16_PAGE,
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
    assert.equal(await tab.evaluate(`document.getElementById('inp-for').getAttribute('data-iiyaku-entrance')`), id);
  });

  await t.test('label が入力欄を含む場合も、その入力欄が入口になる', async () => {
    const id = await tab.evaluate(`document.querySelector('#lab-wrap .iiyaku-icon')?.dataset.iiyakuFor ?? null`);
    assert.ok(id);
    assert.equal(await tab.evaluate(`document.getElementById('inp-wrap').getAttribute('data-iiyaku-entrance')`), id);
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
        const t = ic && document.querySelector('[data-iiyaku-entrance="' + ic.dataset.iiyakuFor + '"]');
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
               containerIsTrigger: document.getElementById('scroll-region').hasAttribute('data-iiyaku-entrance') };
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
        const t = document.querySelector('[data-iiyaku-entrance="' + ic.dataset.iiyakuFor + '"]');
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
        const t = document.querySelector('[data-iiyaku-entrance="' + ic.dataset.iiyakuFor + '"]');
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
    assert.equal(await tab.evaluate(`document.documentElement.hasAttribute('data-iiyaku-off')`), true);
    assert.equal(await tab.evaluate(`document.documentElement.className`), '',
      'ページの class 属性には触れない');
    assert.equal(await tab.evaluate(`getComputedStyle(document.querySelector('.iiyaku-icon')).display`), 'none');
    assert.ok(await tab.evaluate(`document.querySelectorAll('.iiyaku-icon').length > 0`), 'OFF で印を DOM から消してはいけない');
  });

  await t.test('別のタブへ設定が伝わる（本物の chrome.storage）', async () => {
    const other = await openPage(cdp, PAGE);
    await waitFor('2枚目が OFF で開く', async () =>
      await other.evaluate(`document.documentElement.hasAttribute('data-iiyaku-off')`));
    await other.evaluate(`document.querySelector('.iiyaku-toggle').click(); true`);
    await waitFor('1枚目へ伝わる', async () =>
      await tab.evaluate(`document.documentElement.hasAttribute('data-iiyaku-off') === false`));
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
    await tab.evaluate(`localStorage.getItem('rg-tap') === 'ready'`));
  // 見える場所の目印は必ず届く＝計測が生きていることの対照
  await waitFor('見える場所の目印が届く', async () =>
    (await tab.evaluate(`localStorage.getItem('rg-reads') || ''`))
      .includes('RGSENTINEL_VISIBLE'));
  await waitFor('印が付く', async () =>
    await tab.evaluate(`document.querySelectorAll('.iiyaku-icon').length > 0`));
  await sleep(600);

  const reads = (await tab.evaluate(`localStorage.getItem('rg-reads') || ''`))
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
    await tab.evaluate(`localStorage.getItem('rg-leak') === 'done'`));
  await sleep(300);

  const reads = (await tab.evaluate(`localStorage.getItem('rg-reads') || ''`))
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
    await tab.evaluate(`localStorage.getItem('rg-no-checkvisibility') === 'ready'`));
  await waitFor('印が付く', async () =>
    await tab.evaluate(`document.querySelectorAll('.iiyaku-icon').length > 0`));
  await sleep(600);

  const r = await tab.evaluate(`(() => {
    const n = id => document.getElementById(id).querySelectorAll('.iiyaku-icon').length;
    return { cv: { there: n('cv-host'), later: n('cv-later') },
             opacity: { there: n('op-host'), later: n('op-later') },
             display: { there: n('dn-host'), later: n('dn-later') } };
  })()`);
  // 祖先の opacity は見抜けず、見えない側へ付いてしまう。
  // content-visibility のほうは、v1.8.13 で**語の矩形**を測るようにしたことで、
  // checkVisibility が無くても落とせるようになった（矩形が出ないため）。
  assert.deepEqual(r.cv, { there: 0, later: 1 },
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

  await t.test('面積で判定する — 座標が0でなくても、面積が0なら隠れている（5種）', async () => {
    // 決まった書き方だけを文字列で照合していたときは、ここを取りこぼしていた。
    const r = await tab.evaluate(`(() => {
      const n = id => document.getElementById(id).querySelectorAll('.iiyaku-icon').length;
      return {
        // 面積0（座標は0でない）→ 隠れている側 0・後ろ 1
        rectNonZero: { there: n('clip-nonzero'),  later: n('nonzero-later') },
        rectFixed:   { there: n('clip-fixed2'),   later: n('fixed2-later') },
        inset100:    { there: n('clip-inset100'), later: n('inset100-later') },
        // 面積が残る → 見えているので注記する
        rectPositive: n('clip-positive'),
        inset10:      n('clip-inset10'),
        // display:contents 自身の clip-path は箱が無いので効かない
        contentsClip: n('dc-clip')
      };
    })()`);
    assert.deepEqual(r, {
      rectNonZero: { there: 0, later: 1 },   // rect(5px,5px,5px,5px)
      rectFixed:   { there: 0, later: 1 },   // rect(10px,8px,10px,3px)
      inset100:    { there: 0, later: 1 },   // inset(100%)
      rectPositive: 1,                        // rect(0,200px,40px,0) は面積が残る
      inset10: 1,                             // inset(10%) も残る
      contentsClip: 1                         // 箱が無いので clip-path は効かない
    }, `面積の判定が実際の見え方と合っていない: ${JSON.stringify(r)}`);
  });

  await t.test('面積0の切り取りが本当に見えないことを、当たり判定で確かめる（対照）', async () => {
    // 当たり判定は「文字が描かれている場所」で見る。要素の箱の左端で測ると、
    // display:contents には箱が無く、部分的な切り取りでは余白側を突いてしまう。
    const r = await tab.evaluate(`(() => {
      const at = id => { const el = document.getElementById(id);
        const g = document.createRange(); g.selectNodeContents(el);
        let b = g.getBoundingClientRect();
        // 文字の場所が画面に入るまでスクロールしてから測る
        window.scrollBy(0, b.top - 200); b = g.getBoundingClientRect();
        const hit = document.elementFromPoint(b.left + Math.min(4, b.width/2), b.top + b.height/2);
        // 祖先が返ってきたときに「当たった」と数えてはいけない。全面を切り取ると
        // body が返るので、el.contains(hit) だけで見る（display:contents の要素は
        // 箱が無くても elementFromPoint に自分が返る。実測で確認した）。
        return { self: !!hit && (hit === el || el.contains(hit)),
                 onScreen: b.top >= 0 && b.bottom <= document.documentElement.clientHeight && b.width > 0,
                 clip: getComputedStyle(el).clip, clipPath: getComputedStyle(el).clipPath }; };
      return { nonzero: at('clip-nonzero'), positive: at('clip-positive'),
               inset100: at('clip-inset100'), contentsClip: at('dc-clip') };
    })()`);
    for (const [k, v] of Object.entries(r)) {
      assert.equal(v.onScreen, true, `${k} の文字を画面の中で測れていない: ${JSON.stringify(v)}`);
    }
    // 面積0のものには指が当たらない（＝本当に見えていない）
    assert.equal(r.nonzero.self, false, `rect(5px,5px,5px,5px) に当たる＝反例になっていない（${r.nonzero.clip}）`);
    assert.equal(r.inset100.self, false, `inset(100%) に当たる＝反例になっていない（${r.inset100.clipPath}）`);
    // 面積が残るものには当たる（＝見えている）
    assert.equal(r.positive.self, true, `面積の残る rect に当たらない（${r.positive.clip}）`);
    // display:contents 自身の clip-path は効かない＝文字は見えている
    assert.equal(r.contentsClip.self, true,
      `display:contents 自身の clip-path が効いている＝この判定の前提が変わった（${r.contentsClip.clipPath}）`);
    // inset(10%) は当たり判定に入れない。部分的な切り取りなので、文字が余白側に
    // 掛かるかは要素の幅次第で、こちらが主張しているのは「全面ではない」ことだけ。
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
     元の文章は見えたままにしておく必要がある）。

     手口は「その場所を走査の対象から外す」（aria-hidden）。印そのものを
     tabindex="-1" にする手口は使えない——v1.8.9 からは、ページ側が印を使えなく
     したら**同じ場所へ新しい印を付け直す**ので、語が別の場所へ移らない（実測）。
     aria-hidden なら見た目は変わらないまま走査から外れるので、選択範囲や
     ページの持ち物を見る、この一連の試験の目的をそのまま保てる。 */
  async function forceRetire(hostSel, freshText) {
    const id = 'fresh' + (++seq);
    await tab.evaluate(`(() => {
      const host = document.querySelector(${JSON.stringify(hostSel)});
      window.__forced = host;             // 元へ戻せるよう控える
      host.setAttribute('aria-hidden', 'true');
      const p = document.createElement('p'); p.id = ${JSON.stringify(id)};
      p.textContent = ${JSON.stringify(freshText)};
      document.getElementById('sink').append(p);
    })(); true`);
    await waitFor(`${id} へ付け直る`, async () => await nIcons('#' + id) === 1);
    return id;
  }

  async function restoreFrom(freshId) {
    await tab.evaluate(`(() => {
      // 走査の対象へ戻す
      if (window.__forced) { window.__forced.removeAttribute('aria-hidden'); window.__forced = null; }
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

    // ここは**片方だけ**を片づけたい。場所ごと走査から外す手口（aria-hidden）では
    // 両方が退役してしまうので、ページ側が片方の印だけを外す形にする。
    // 付け直り先が元の場所にならないよう、読める同じ語を**前に**置く。
    await tab.evaluate(`(() => {
      const p = document.createElement('p'); p.id = 'freshTwo';
      p.textContent = 'Add a second remote now.';
      const two = document.getElementById('two');
      two.parentNode.insertBefore(p, two);
      const ic = [...two.querySelectorAll('.iiyaku-icon')]
        .find(i => i.dataset.iiyakuKey === 'remote');
      ic.remove();
    })(); true`);
    await waitFor('前へ置いた候補へ付け直る', async () => await nIcons('#freshTwo') === 1);
    assert.deepEqual(await keys(), ['origin'], '片方だけ片づける、ができていない');
    const kept = await tab.evaluate(`({ connected: window.__mid.isConnected,
      value: window.__mid.nodeValue })`);
    assert.equal(kept.connected, true, 'もう片方の印が使っている節点まで消している');
    assert.equal(kept.value, mid.value, 'もう片方の印が使っている節点の中身を書き換えている');
    assert.equal(await tab.evaluate(`document.getElementById('two').textContent`),
      'A remote and an origin differ.', '本文が変わっている');
    await tab.evaluate(`document.getElementById('freshTwo').remove(); true`);
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
      const ids = [...document.querySelectorAll('[data-iiyaku-entrance]')]
        .map(e => e.getAttribute('data-iiyaku-entrance'));
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

/* ============================================================================
   第9回監査の反例（RG-9-01 … RG-9-07）
   ここに置く試験は、いずれも v1.8.7 の実物で**先に再現してから**書いている。
   ========================================================================= */

// 吹き出しは出しっぱなしにせず、その場で数えて閉じる。
// （出したままだと次の測定が前の吹き出しを数えてしまう）
const HOVER_ROWS = id => `(() => {
  const el = document.getElementById(${JSON.stringify(id)});
  if (!el) return -1;
  el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  const t = document.querySelector('.iiyaku-tooltip');
  const n = t ? t.querySelectorAll('.iiyaku-tooltip-item').length : 0;
  el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
  return n;
})()`;

test('隠された・無効になった・書き換わった印は、読める同じ語へ譲る', async t => {
  const srv = await startTestServer(USABILITY_PAGE);
  const chrome = await launchChrome({ port: srv.port });
  const { cdp } = chrome;
  t.after(async () => { chrome.kill(); await srv.close(); });
  await cdp.send('Extensions.loadUnpacked', { path: stageExtension() });
  const tab = await openPage(cdp, PAGE);

  const nIn = sel => tab.evaluate(`document.querySelectorAll(${JSON.stringify(sel)} + ' .iiyaku-icon').length`);
  const nKey = k => tab.evaluate(
    `document.querySelectorAll('.iiyaku-icon[data-iiyaku-key="' + ${JSON.stringify(k)} + '"]').length`);
  // 陽性対照つきの待ち。ページ側にも .iiyaku-icon が居る場面があるので、
  // 「自分が付けた印（key つき）」で数える。
  await waitFor('拡張が印を付ける', async () =>
    await tab.evaluate(`[...document.querySelectorAll('.iiyaku-icon')].filter(i => i.dataset.iiyakuKey).length`));

  await t.test('RG-9-01a 最初の場所を隠すと、既にある2番目へ移る（属性の変更だけで）', async () => {
    assert.deepEqual([await nIn('#u-hide1'), await nIn('#u-hide2')], [1, 0], '前提が崩れている');
    // ノードを足さない。属性を変えるだけで気づけること自体が要件。
    await tab.evaluate(`document.getElementById('u-hide1').style.display = 'none'; true`);
    await waitFor('2番目へ移る', async () => await nIn('#u-hide2') === 1);
    assert.deepEqual([await nIn('#u-hide1'), await nIn('#u-hide2'), await nKey('branch')], [0, 1, 1]);
  });

  await t.test('RG-9-01b 入口を無効にすると、後ろの読める語へ移り、旧入口に説明が出ない', async () => {
    assert.deepEqual([await nIn('#u-btn'), await nIn('#u-btn-later')], [1, 0], '前提が崩れている');
    await tab.evaluate(`document.getElementById('u-btn').disabled = true; true`);
    await waitFor('後ろへ移る', async () => await nIn('#u-btn-later') === 1);
    assert.deepEqual([await nIn('#u-btn'), await nIn('#u-btn-later'), await nKey('fetch')], [0, 1, 1]);
    assert.equal(await tab.evaluate(HOVER_ROWS('u-btn')), 0, '無効にした入口にまだ説明が出る');
  });

  await t.test('RG-9-02 語のうしろに文字が増えたら退役し、新しい候補へ1つだけ付く', async () => {
    const before = await tab.evaluate(`(() => {
      const ic = [...document.querySelectorAll('.iiyaku-icon')].find(i => i.dataset.iiyakuKey === 'rebase');
      if (!ic) return null;
      ic.previousSibling.appendData('PAGE_SUFFIX');
      const p = document.createElement('p'); p.textContent = 'A rebase newly appears.';
      document.getElementById('u-suffix-sink').appendChild(p);
      return ic.previousSibling.nodeValue;
    })()`);
    assert.equal(before, 'A rebasePAGE_SUFFIX', 'この試験の前提（末尾への追記）が起きていない');
    await waitFor('新しい候補へ付け直る', async () => await nIn('#u-suffix-sink') === 1);
    assert.equal(await nKey('rebase'), 1, 'rebase の印が1つでない');
    assert.equal(
      await tab.evaluate(`[...document.querySelectorAll('.iiyaku-icon')]
        .find(i => i.dataset.iiyakuKey === 'rebase').previousSibling.nodeValue`),
      'A rebase', '印が語の直後にない');
    // ページ側が書き足した文字は、こちらで消さない
    assert.match(await tab.evaluate(`document.getElementById('u-suffix').textContent`), /PAGE_SUFFIX/);
  });

  await t.test('RG-9-03 label の for が変わったら、新しい control だけが入口になる', async () => {
    assert.equal(await tab.evaluate(HOVER_ROWS('u-ia')), 1, '前提: 最初は ia が入口');
    assert.equal(await tab.evaluate(HOVER_ROWS('u-ib')), 0, '前提: ib はまだ入口ではない');
    await tab.evaluate(`document.getElementById('u-lab').htmlFor = 'u-ib'; true`);
    await waitFor('新しい control が入口になる', async () =>
      await tab.evaluate(HOVER_ROWS('u-ib')) === 1);
    assert.equal(await tab.evaluate(HOVER_ROWS('u-ia')), 0, '古い control にまだ説明が出る');
    assert.equal(await nIn('#u-lab'), 1, 'label から印が消えている');
    assert.equal(await nIn('#u-lab-later'), 0, '後ろへ余計に付いている');
    // 残留した目印が無いこと（自分の合言葉つきのものだけを数える）
    assert.equal(
      await tab.evaluate(`document.getElementById('u-ia').hasAttribute('data-iiyaku-entrance')`),
      false, '入口でなくなった要素に目印が残っている');
  });

  await t.test('RG-9-06 語そのものを書き換えたら、他の変更を待たずに移る', async () => {
    assert.deepEqual([await nIn('#u-cd1'), await nIn('#u-cd2')], [1, 0], '前提が崩れている');
    await tab.evaluate(`(() => {
      const ic = [...document.querySelectorAll('.iiyaku-icon')].find(i => i.dataset.iiyakuKey === 'revert');
      ic.previousSibling.nodeValue = 'A banana';
    })(); true`);
    // ここで**ノードを足さない**。足すと childList の変更で気づいてしまい、
    // 文字の書き換えに気づけたかを確かめられない。
    await waitFor('2番目へ移る', async () => await nIn('#u-cd2') === 1);
    assert.deepEqual([await nIn('#u-cd1'), await nKey('revert')], [0, 1]);
  });

  await tab.close();
});

test('ページ側の同名 class・同名属性を壊さず、面積0の切り取りは可視から外す', async t => {
  const srv = await startTestServer(NAMESPACE_CLIP_PAGE);
  const chrome = await launchChrome({ port: srv.port });
  const { cdp } = chrome;
  t.after(async () => { chrome.kill(); await srv.close(); });
  await cdp.send('Extensions.loadUnpacked', { path: stageExtension() });
  const tab = await openPage(cdp, PAGE);
  const nIn = sel => tab.evaluate(`document.querySelectorAll(${JSON.stringify(sel)} + ' .iiyaku-icon').length`);
  await waitFor('拡張が印を付ける', async () =>
    await tab.evaluate(`[...document.querySelectorAll('.iiyaku-icon')].filter(i => i.dataset.iiyakuKey).length`));

  await t.test('RG-9-05 ページ所有の .iiyaku-icon は、読み込みの前後どちらでも残る', async () => {
    assert.equal(await tab.evaluate(`!!document.getElementById('page-icon')`), true,
      '元から在ったページ側の要素を消している');
    await tab.evaluate(`(() => { const a = document.createElement('a');
      a.id = 'page-icon-late'; a.href = '#dest2'; a.className = 'iiyaku-icon'; a.textContent = 'LATE';
      document.getElementById('ns-sink').appendChild(a); })(); true`);
    await sleep(500);
    assert.equal(await tab.evaluate(`!!document.getElementById('page-icon-late')`), true,
      '後から足したページ側の要素を消している');
    assert.equal(await tab.evaluate(`document.getElementById('page-icon-late').textContent`), 'LATE');
  });

  await t.test('RG-9-05 ページ所有リンクのクリックを横取りしない', async () => {
    const r = await tab.evaluate(`(() => {
      const a = document.getElementById('page-icon');
      const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
      a.dispatchEvent(ev);
      return { prevented: ev.defaultPrevented, hash: location.hash };
    })()`);
    assert.equal(r.prevented, false, 'ページ側のリンクの既定動作を止めている');
    assert.equal(r.hash, '#dest', 'リンク先へ移動していない');
  });

  await t.test('RG-9-05 ページ既存の data-iiyaku-trigger を自分の ID として採用しない', async () => {
    // 同じ値を持つ入口が2つあっても、説明が混ざらないこと
    assert.equal(await tab.evaluate(HOVER_ROWS('ns-a')), 1, 'ns-a に別の語の説明まで出ている');
    assert.equal(await tab.evaluate(HOVER_ROWS('ns-b')), 1, 'ns-b に別の語の説明まで出ている');
    // 値をそのまま使っていないこと（自分の目印は別名で、値は自分の合言葉つき）
    const ids = await tab.evaluate(`[...document.querySelectorAll('[data-iiyaku-entrance]')]
      .map(e => e.getAttribute('data-iiyaku-entrance'))`);
    assert.ok(ids.length >= 3, `自分の目印が付いていない: ${JSON.stringify(ids)}`);
    assert.ok(ids.every(v => /^iiyaku-[a-z0-9]+-t\d+$/.test(v)), `外から来た値が混ざっている: ${JSON.stringify(ids)}`);
    assert.equal(new Set(ids).size, ids.length, '同じ目印が2つ以上ある');
    // ページ側の属性は書き換えていない
    assert.deepEqual(
      await tab.evaluate(`['ns-a','ns-b','ns-c'].map(i => document.getElementById(i).getAttribute('data-iiyaku-trigger'))`),
      ['shared', 'shared', 'bad"]sel'], 'ページ側の属性を書き換えている');
  });

  await t.test('RG-9-05 selector に使えない値が入口にあっても、説明は出る', async () => {
    // `bad"]sel` を selector へ埋めると SyntaxError になる。値を使わない設計なので出るはず。
    assert.equal(await tab.evaluate(HOVER_ROWS('ns-c')), 1, '不正な属性値のせいで説明が出ない');
  });

  await t.test('RG-9-07 面積0の切り取りの中には付けず、後ろの読める語へ回す（4形）', async () => {
    const pairs = [['#c-pct', '#c-pct-later'], ['#c-px', '#c-px-later'],
                   ['#c-side', '#c-side-later'], ['#c-circle', '#c-circle-later']];
    const got = [];
    for (const [a, b] of pairs) got.push([await nIn(a), await nIn(b)]);
    assert.deepEqual(got, [[0, 1], [0, 1], [0, 1], [0, 1]],
      `切り取りの判定が合っていない: ${JSON.stringify(got)}`);
  });

  await t.test('RG-9-07 面積が残る切り取りと display:contents は、可視のまま扱う（落としすぎの対照）', async () => {
    // v1.8.13 で期待値を直した。`clip-path: inset(10%)` の左端は x≈96 で、
    // `tags` は x≈25〜59 にある。**語の矩形の画素は 0**（後ろの読める `tags` は 183 画素）。
    assert.deepEqual([await nIn('#c-part'), await nIn('#c-part-later')], [0, 1],
      'inset(10%) を全面非表示と誤判定している');
    assert.deepEqual([await nIn('#c-dc'), await nIn('#c-dc-later')], [1, 0],
      'display:contents 自身の clip-path を効かせてしまっている');
  });

  await tab.close();
});

test('注記したあとで触れない領域へ変わったら、本文を読まずに手を引く', async t => {
  const srv = await startTestServer(PROTECTED_PAGE);
  const chrome = await launchChrome({ port: srv.port });
  const { cdp } = chrome;
  t.after(async () => { chrome.kill(); await srv.close(); });
  // 生の読み取りを計測する版。matcher tap は「辞書の照合まで届いたか」しか見ないので、
  // 照合せずに本文を読むだけの経路はそこに映らない（第9回監査はその差を突いた）。
  const dir = stageExtensionWith(
    { 'nodevalue-probe.js': 'tests/e2e/nodevalue-probe.js' },
    js => ['nodevalue-probe.js', ...js]);
  await cdp.send('Extensions.loadUnpacked', { path: dir });
  const tab = await openPage(cdp, PAGE);
  const nIn = sel => tab.evaluate(`document.querySelectorAll(${JSON.stringify(sel)} + ' .iiyaku-icon').length`);
  const reads = () => tab.evaluate(`localStorage.getItem('rg-raw')`);
  await waitFor('拡張が印を付ける', async () =>
    await tab.evaluate(`[...document.querySelectorAll('.iiyaku-icon')].filter(i => i.dataset.iiyakuKey).length`));

  await t.test('計測そのものが効いている（陽性対照）', async () => {
    assert.equal(await tab.evaluate(`localStorage.getItem('rg-rawtap')`), 'ready',
      '4つの取り出し口を包めていない');
    assert.equal(await reads(), 'RGSENTINEL_SELFTEST',
      '包んだ getter が効いていない＝「読まれていない」を主張できない');
  });

  const CASES = [
    ['pr-ce', 'RGSENTINEL_CE', `el.setAttribute('contenteditable','true')`, 'branch'],
    ['pr-ah', 'RGSENTINEL_AH', `el.setAttribute('aria-hidden','true')`, 'commit'],
    ['pr-in', 'RGSENTINEL_IN', `el.setAttribute('inert','')`, 'merge'],
    ['pr-hd', 'RGSENTINEL_HD', `el.setAttribute('hidden','')`, 'fetch']
  ];
  for (const [id, sentinel, mutate, key] of CASES) {
    await t.test(`RG-9-04 ${id} が保護領域へ移ったあと、本文（${sentinel}）を読まない`, async () => {
      assert.equal(await nIn('#' + id), 1, '前提: 先に印が付いている');
      await tab.evaluate(`(() => {
        const el = document.getElementById(${JSON.stringify(id)});
        ${mutate};
        const ic = el.querySelector('.iiyaku-icon');
        ic.previousSibling.nodeValue = ${JSON.stringify(sentinel + ' ' + key)};
      })(); true`);
      await tab.evaluate(`(() => { const s = document.createElement('span'); s.textContent = 'zzz';
        document.getElementById('sink').appendChild(s); })(); true`);
      await sleep(400);
      assert.equal(await reads(), 'RGSENTINEL_SELFTEST',
        `保護領域になった本文を読んでいる: ${await reads()}`);
      assert.equal(await nIn('#' + id), 0, '保護領域に印が残っている');
      // 本文はこちらで書き換えない
      assert.match(await tab.evaluate(
        `document.getElementById(${JSON.stringify(id)}).textContent`), new RegExp(sentinel));
    });
  }

  await t.test('RG-9-04 保護領域から戻ったら、ふつうの候補として選び直せる', async () => {
    await tab.evaluate(`(() => {
      const el = document.getElementById('pr-ce');
      el.removeAttribute('contenteditable');
      el.firstChild.nodeValue = 'A branch again.';
    })(); true`);
    await waitFor('戻った場所へ付け直る', async () => await nIn('#pr-ce') === 1);
    assert.equal(await reads(), 'RGSENTINEL_SELFTEST', '戻す途中で保護領域の本文を読んでいる');
  });

  await tab.close();
});

test('退役と選び直しは、変更を混ぜても収束する', async t => {
  const srv = await startTestServer(CONVERGE_PAGE);
  const chrome = await launchChrome({ port: srv.port });
  const { cdp } = chrome;
  t.after(async () => { chrome.kill(); await srv.close(); });
  await cdp.send('Extensions.loadUnpacked', { path: stageExtension() });
  const tab = await openPage(cdp, PAGE);
  const nKey = k => tab.evaluate(
    `document.querySelectorAll('.iiyaku-icon[data-iiyaku-key="' + ${JSON.stringify(k)} + '"]').length`);
  await waitFor('拡張が印を付ける', async () => await nKey('conflict'));

  await t.test('RG-9-01/06 属性・文字・削除を混ぜて50往復しても、印は常に0か1', async () => {
    // 利用者の選択範囲が壊れないことも、同じ往復の中で見る
    await tab.evaluate(`(() => {
      const t = document.getElementById('cv-sel').firstChild;
      const r = document.createRange(); r.setStart(t, 4); r.setEnd(t, 20);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      window.__selText = String(s);
      window.__textNode = t;
      window.__body = document.getElementById('cv-sel').textContent;
    })(); true`);

    const t0 = Date.now();
    let worst = 0;
    for (let i = 0; i < 50; i++) {
      const mode = i % 4;
      await tab.evaluate(`(() => {
        const ids = ['cv1', 'cv2', 'cv3'];
        const el = document.getElementById(ids[${i} % 3]);
        if (${mode} === 0) el.style.display = 'none';
        else if (${mode} === 1) { for (const x of ids) document.getElementById(x).style.display = ''; }
        else if (${mode} === 2) {
          const ic = document.querySelector('.iiyaku-icon[data-iiyaku-key="conflict"]');
          if (ic && ic.previousSibling) ic.previousSibling.nodeValue = 'A banana';
        } else {
          const s = document.createElement('p'); s.textContent = 'A conflict extra.';
          s.id = 'cv-extra'; const old = document.getElementById('cv-extra'); if (old) old.remove();
          document.getElementById('cv-sink').appendChild(s);
        }
      })(); true`);
      await sleep(40);
      const n = await nKey('conflict');
      if (n > worst) worst = n;
      assert.ok(n <= 1, `${i} 回目で conflict の印が ${n} 個になった`);
    }
    const elapsed = Date.now() - t0;

    // 変更を止めたあと、状態が動き続けていないこと（自分の変更で回り続ける形の検出）
    await sleep(400);
    const a = await tab.evaluate(`document.querySelectorAll('.iiyaku-icon').length`);
    await sleep(400);
    const b = await tab.evaluate(`document.querySelectorAll('.iiyaku-icon').length`);
    assert.equal(a, b, `変更を止めても印の数が動き続けている: ${a} -> ${b}`);

    // 読める候補が在るなら、必ず1つは説明が付いている
    const final = await tab.evaluate(`(() => {
      const vis = ['cv1','cv2','cv3','cv-extra'].filter(id => {
        const el = document.getElementById(id); return el && el.checkVisibility();
      });
      return { visible: vis.length,
               icons: document.querySelectorAll('.iiyaku-icon[data-iiyaku-key="conflict"]').length };
    })()`);
    if (final.visible > 0) assert.equal(final.icons, 1, `読める候補が ${final.visible} 個あるのに印が ${final.icons} 個`);
    assert.equal(worst, 1, `途中で印が重複した（最大 ${worst} 個）`);
    assert.ok(elapsed < 60000, `50往復に ${elapsed}ms かかった`);
    console.log(`  # 50往復: ${elapsed}ms / 最大同時 ${worst} 個`);
  });

  await t.test('往復のあいだ、利用者の選択範囲と本文が壊れていない', async () => {
    const r = await tab.evaluate(`({
      sel: String(getSelection()), kept: window.__selText,
      sameNode: getSelection().anchorNode === window.__textNode,
      body: document.getElementById('cv-sel').textContent, wasBody: window.__body })`);
    assert.equal(r.sel, r.kept, `選択範囲が変わった: ${JSON.stringify(r)}`);
    assert.equal(r.sameNode, true, '選択していた Text node が別のものに差し替わった');
    assert.equal(r.body, r.wasBody, '本文が変わった');
  });

  await tab.close();
});

/* ============================================================================
   第10回監査の反例（RG-10-01 … RG-10-07）
   いずれも v1.8.8 の実物で**先に再現してから**書いている。
   ========================================================================= */

test('見え方が変わる合図は、DOM の変更として出ないものも拾う', async t => {
  const srv = await startTestServer(SIGNALS_PAGE);
  const chrome = await launchChrome({ port: srv.port });
  const { cdp } = chrome;
  t.after(async () => { chrome.kill(); await srv.close(); });
  await cdp.send('Extensions.loadUnpacked', { path: stageExtension() });
  const tab = await openPage(cdp, PAGE);
  const nIn = sel => tab.evaluate(`document.querySelectorAll(${JSON.stringify(sel)} + ' .iiyaku-icon').length`);
  const nKey = k => tab.evaluate(
    `document.querySelectorAll('.iiyaku-icon[data-iiyaku-key="' + ${JSON.stringify(k)} + '"]').length`);
  await waitFor('拡張が印を付ける', async () =>
    await tab.evaluate(`[...document.querySelectorAll('.iiyaku-icon')].filter(i => i.dataset.iiyakuKey).length`));

  await t.test('RG-10-01 input の type を hidden にすると、後ろの読める語へ移る', async () => {
    assert.deepEqual([await nIn('#lab'), await nIn('#lab-later')], [1, 0], '前提が崩れている');
    await tab.evaluate(`document.getElementById('ctrl').type = 'hidden'; true`);
    await waitFor('後ろへ移る', async () => await nIn('#lab-later') === 1);
    assert.deepEqual([await nIn('#lab'), await nKey('branch')], [0, 1]);
  });

  await t.test('RG-10-01 任意の data-* で隠されても移る（属性を絞り込まない）', async () => {
    assert.deepEqual([await nIn('#ds'), await nIn('#ds-later')], [1, 0], '前提が崩れている');
    await tab.evaluate(`document.getElementById('ds').dataset.state = 'closed'; true`);
    await waitFor('後ろへ移る', async () => await nIn('#ds-later') === 1);
    assert.deepEqual([await nIn('#ds'), await nKey('commit')], [0, 1]);
  });

  await t.test('RG-10-02 子を1つ足すだけで祖先が消えても移る（:has）', async () => {
    assert.deepEqual([await nIn('#has-box'), await nIn('#has-later')], [1, 0], '前提が崩れている');
    await tab.evaluate(`(() => { const s = document.createElement('span'); s.className = 'hider';
      document.getElementById('has-box').append(s); })(); true`);
    await waitFor('後ろへ移る', async () => await nIn('#has-later') === 1);
    assert.deepEqual([await nIn('#has-box'), await nKey('rebase')], [0, 1]);
  });

  await t.test('RG-10-03 CSS の遷移が終わって透明になったら移る', async () => {
    assert.deepEqual([await nIn('#fade'), await nIn('#fade-later')], [1, 0], '前提が崩れている');
    await tab.evaluate(`document.getElementById('fade').classList.add('gone'); true`);
    await waitFor('後ろへ移る', async () => await nIn('#fade-later') === 1);
    assert.equal(await tab.evaluate(`getComputedStyle(document.getElementById('fade')).opacity`), '0');
    assert.deepEqual([await nIn('#fade'), await nKey('revert')], [0, 1]);
  });

  await t.test('RG-10-03 画面幅で表示が入れ替わったら移る（往復）', async () => {
    assert.deepEqual([await nIn('#wide'), await nIn('#narrow')], [1, 0], '前提が崩れている');
    const setW = w => cdp.send('Emulation.setDeviceMetricsOverride',
      { width: w, height: 800, deviceScaleFactor: 1, mobile: false }, tab.sessionId);
    await setW(500);
    await waitFor('狭い側へ移る', async () => await nIn('#narrow') === 1);
    assert.deepEqual([await nIn('#wide'), await nKey('fetch')], [0, 1]);
    await setW(1000);
    await waitFor('広い側へ戻る', async () => await nIn('#wide') === 1);
    assert.deepEqual([await nIn('#narrow'), await nKey('fetch')], [0, 1]);
    await cdp.send('Emulation.clearDeviceMetricsOverride', {}, tab.sessionId);
  });

  await t.test('RG-10-03 head へ stylesheet を足して隠されたら移る（外すと戻る）', async () => {
    assert.deepEqual([await nIn('#hs'), await nIn('#hs-later')], [1, 0], '前提が崩れている');
    await tab.evaluate(`(() => { const st = document.createElement('style'); st.id = 'inject';
      st.textContent = '#hs{display:none}'; document.head.append(st); })(); true`);
    await waitFor('後ろへ移る', async () => await nIn('#hs-later') === 1);
    assert.deepEqual([await nIn('#hs'), await nKey('webhook')], [0, 1]);
    // stylesheet を外しても、印は**戻らないのが正しい**。移った先が読めている限り、
    // その語は説明済みだからである（戻すと同じ語の印が2つになる）。
    await tab.evaluate(`document.getElementById('inject').remove(); true`);
    await sleep(600);
    assert.deepEqual([await nIn('#hs'), await nIn('#hs-later'), await nKey('webhook')], [0, 1, 1],
      '外したときに印が増えたか、移った先から消えている');
  });

  await t.test('RG-10-01 属性を100回連打しても収束する（印は常に0か1）', async () => {
    let worst = 0;
    for (let i = 0; i < 100; i++) {
      await tab.evaluate(`(() => { const el = document.getElementById('ds');
        el.dataset.state = ${'`'}${'$'}{${i} % 2 ? 'closed' : 'open'}${'`'}; })(); true`);
      if (i % 10 === 0) {
        const n = await nKey('commit');
        if (n > worst) worst = n;
        assert.ok(n <= 1, `${i} 回目で commit の印が ${n} 個`);
      }
    }
    await sleep(500);
    const a = await tab.evaluate(`document.querySelectorAll('.iiyaku-icon').length`);
    await sleep(500);
    const b = await tab.evaluate(`document.querySelectorAll('.iiyaku-icon').length`);
    assert.equal(a, b, `連打をやめても印の数が動き続けている: ${a} -> ${b}`);
    assert.equal(await nKey('commit'), 1, '読める候補があるのに印が1つでない');
    assert.equal(worst, 1, `途中で重複した（最大 ${worst}）`);
  });

  await tab.close();
});

test('所有していないものへ手を出さず、自分の変更だけを自分の仕業とする', async t => {
  const srv = await startTestServer(OWNERSHIP_PAGE);
  const chrome = await launchChrome({ port: srv.port });
  const { cdp } = chrome;
  t.after(async () => { chrome.kill(); await srv.close(); });
  await cdp.send('Extensions.loadUnpacked', { path: stageExtension() });
  const tab = await openPage(cdp, PAGE);
  const nIn = sel => tab.evaluate(`document.querySelectorAll(${JSON.stringify(sel)} + ' .iiyaku-icon').length`);
  const nKey = k => tab.evaluate(
    `document.querySelectorAll('.iiyaku-icon[data-iiyaku-key="' + ${JSON.stringify(k)} + '"]').length`);
  await waitFor('拡張が印を付ける', async () =>
    await tab.evaluate(`[...document.querySelectorAll('.iiyaku-icon')].filter(i => i.dataset.iiyakuKey).length`));

  await t.test('RG-10-06 参照ボックスつきの切り取りを見抜く（inset(50%) content-box）', async () => {
    assert.equal(await tab.evaluate(`getComputedStyle(document.getElementById('clip-box')).clipPath`),
      'inset(50%) content-box', 'この試験の前提（computed 値）が違う');
    assert.deepEqual([await nIn('#clip-box'), await nIn('#clip-later')], [0, 1]);
  });

  await t.test('RG-10-06 キーワード半径の ellipse を見抜く（ellipse(0 closest-side)）', async () => {
    assert.match(await tab.evaluate(`getComputedStyle(document.getElementById('ellipse')).clipPath`),
      /^ellipse\(0px closest-side\)/, 'この試験の前提（computed 値）が違う');
    assert.deepEqual([await nIn('#ellipse'), await nIn('#ellipse-later')], [0, 1]);
  });

  await t.test('RG-10-05 ページ側が正規の印を隠したら、見える印へ置き換える', async () => {
    assert.deepEqual([await nIn('#hide-me'), await nIn('#hide-later')], [1, 0], '前提が崩れている');
    await tab.evaluate(`(() => { window.__old = document.querySelector('#hide-me .iiyaku-icon');
      window.__old.style.display = 'none'; })(); true`);
    await waitFor('見えない印が片づく', async () =>
      await tab.evaluate(`!window.__old.isConnected`));
    const r = await tab.evaluate(`(() => { const all = [...document.querySelectorAll('.iiyaku-icon[data-iiyaku-key="commit"]')];
      return { 合計: all.length, 見える: all.filter(i => i.checkVisibility()).length,
               style付き: all.filter(i => i.getAttribute('style')).length }; })()`);
    assert.deepEqual(r, { 合計: 1, 見える: 1, style付き: 0 },
      `隠された印が残っているか、印が増えている: ${JSON.stringify(r)}`);
  });

  await t.test('RG-10-04 OFF のあいだに複製しても、ON へ戻したら印は1つ', async () => {
    assert.equal(await nKey('branch'), 1, '前提が崩れている');
    await tab.evaluate(`document.querySelector('.iiyaku-toggle').click(); true`);
    await sleep(400);
    await tab.evaluate(`(() => { const c = document.getElementById('orig').cloneNode(true);
      c.id = 'off-clone'; document.getElementById('sink').append(c); })(); true`);
    await sleep(300);
    assert.equal(await nIn('#off-clone'), 1, 'この試験の前提（複製に印が写る）が崩れている');
    await tab.evaluate(`document.querySelector('.iiyaku-toggle').click(); true`);
    await waitFor('複製の印が消える', async () => await nIn('#off-clone') === 0);
    assert.equal(await nKey('branch'), 1, 'ON へ戻したら印が増えている');
    assert.equal(await tab.evaluate(`document.getElementById('off-clone').textContent`),
      'A branch first.', '複製側の本文を壊している');
  });

  // ⚠️ v1.8.9 では「合言葉を消した複製は DOM に残す」ことを固定していた。
  // 第11回監査で、それが**見えないまま Tab で止まる**ことが実測された
  // （幅0でも role=button と tabindex=0 は残る）。残す判断のほうが誤りだったので、
  // 期待値を作り直す。判定は合言葉の値ではなく、自分が書いた説明文そのもので行う。
  await t.test('RG-11-02 合言葉を消した複製も取り除く（残すと見えない停止点になる）', async () => {
    await tab.evaluate(`(() => { const c = document.getElementById('orig').cloneNode(true);
      c.id = 'bare-clone';
      for (const ic of c.querySelectorAll('.iiyaku-icon')) ic.removeAttribute('data-iiyaku-owner');
      document.getElementById('sink').append(c); })(); true`);
    await waitFor('複製が取り除かれる', async () => await nIn('#bare-clone') === 0);
    assert.equal(await tab.evaluate(`document.getElementById('bare-clone').textContent`),
      'A branch first.', '複製側の本文まで壊している');
    assert.equal(
      await tab.evaluate(`document.querySelectorAll('.iiyaku-icon[data-iiyaku-owner][data-iiyaku-key="branch"]').length`),
      1, '正規の印が増減している');
  });

  await tab.close();
});

/* ===================== 第11回監査（v1.8.10）の受入条件 ===================== */

test('初回に見えていなかった語も、見えるようになったら見つける', async t => {
  const srv = await startTestServer(LATENT_PAGE);
  const chrome = await launchChrome({ port: srv.port });
  const { cdp } = chrome;
  t.after(async () => { chrome.kill(); await srv.close(); });
  await cdp.send('Extensions.loadUnpacked', { path: stageExtension() });
  const tab = await openPage(cdp, PAGE);
  const setW = w => cdp.send('Emulation.setDeviceMetricsOverride',
    { width: w, height: 900, deviceScaleFactor: 1, mobile: false }, tab.sessionId);
  await setW(1000);
  const nKey = k => tab.evaluate(
    `document.querySelectorAll('.iiyaku-icon[data-iiyaku-key="' + ${JSON.stringify(k)} + '"]').length`);
  const nIn = sel => tab.evaluate(`document.querySelectorAll(${JSON.stringify(sel)} + ' .iiyaku-icon').length`);
  // 見えている語には印が付く＝拡張が走っている対照。これが出るまで待つ。
  await waitFor('見えている語へ印が付く', async () => await nKey('repository') === 1);

  await t.test('RG-11-01 前提: 隠れている語には、まだ印が無い', async () => {
    assert.deepEqual(
      [await nKey('clone'), await nKey('fork'), await nKey('milestone'), await nKey('artifact')],
      [0, 0, 0, 0], 'この試験の前提（初回は見えない）が崩れている');
  });

  await t.test('RG-11-01 画面幅が変わって現れた語を見つける', async () => {
    await setW(500);
    await waitFor('狭い側の語に印が付く', async () => await nKey('clone') === 1);
    assert.equal(await nIn('#narrow-only'), 1);
  });

  await t.test('RG-11-01 stylesheet が外れて現れた語を見つける', async () => {
    await tab.evaluate(`document.getElementById('hide-style').remove(); true`);
    await waitFor('その語に印が付く', async () => await nKey('fork') === 1);
    assert.equal(await nIn('#style-only'), 1);
  });

  await t.test('RG-11-01 遷移が終わって現れた語を見つける', async () => {
    await tab.evaluate(`document.getElementById('fade-in').classList.add('shown'); true`);
    await waitFor('その語に印が付く', async () => await nKey('milestone') === 1);
    assert.equal(await tab.evaluate(`getComputedStyle(document.getElementById('fade-in')).opacity`), '1');
    assert.equal(await nIn('#fade-in'), 1);
  });

  await t.test('RG-11-01 属性にも DOM にも出ない変化で現れた語も、暇なときに見つける', async () => {
    await tab.evaluate(`document.getElementById('tgl').checked = true; true`);
    // 2秒周期の確認でしか気づけない。即座ではないことを、待ち時間で明示する。
    await waitFor('その語に印が付く', async () => await nKey('artifact') === 1, { timeout: 12000 });
    assert.equal(await nIn('#checked-only'), 1);
  });

  await t.test('RG-11-01 同じ語が既に読める場所にあるなら、増やさない', async () => {
    assert.equal(await nKey('webhook'), 1, '前提が崩れている');
    await tab.evaluate(`document.getElementById('dup-hidden').style.display = ''; true`);
    await sleep(800);
    assert.equal(await nKey('webhook'), 1, '同じ語の印が2つになった');
    assert.deepEqual([await nIn('#dup-shown'), await nIn('#dup-hidden')], [1, 0],
      '読める印から動かしている');
  });

  await t.test('RG-11-01 合図を100回まとめても、印は増えない', async () => {
    const before = await tab.evaluate(`document.querySelectorAll('.iiyaku-icon').length`);
    await tab.evaluate(`(() => { for (let i = 0; i < 100; i++) window.dispatchEvent(new Event('resize')); })(); true`);
    await sleep(800);
    assert.equal(await tab.evaluate(`document.querySelectorAll('.iiyaku-icon').length`), before,
      '合図を連打すると印が増える');
  });

  await cdp.send('Emulation.clearDeviceMetricsOverride', {}, tab.sessionId);
  await tab.close();
});

test('自分の署名を持つものだけを片づけ、ページの持ち物には触れない', async t => {
  const srv = await startTestServer(SIGNATURE_PAGE);
  const chrome = await launchChrome({ port: srv.port });
  const { cdp } = chrome;
  t.after(async () => { chrome.kill(); await srv.close(); });
  await cdp.send('Extensions.loadUnpacked', { path: stageExtension() });
  const tab = await openPage(cdp, PAGE);
  const nIn = sel => tab.evaluate(`document.querySelectorAll(${JSON.stringify(sel)} + ' .iiyaku-icon').length`);
  const nKey = k => tab.evaluate(
    `document.querySelectorAll('.iiyaku-icon[data-iiyaku-key="' + ${JSON.stringify(k)} + '"]').length`);
  await waitFor('拡張が印を付ける', async () =>
    await tab.evaluate(`[...document.querySelectorAll('.iiyaku-icon')].filter(i => i.dataset.iiyakuKey).length`));

  await t.test('RG-11-04 半径を省いた circle（既定は closest-side）を見抜く', async () => {
    assert.equal(await tab.evaluate(`getComputedStyle(document.getElementById('circle-box')).clipPath`),
      'circle(at 0px 50%)', 'この試験の前提（computed 値）が違う');
    assert.deepEqual([await nIn('#circle-box'), await nIn('#circle-later')], [0, 1]);
  });

  await t.test('RG-11-04 参照ボックスだけの指定で、その箱が潰れていたら見抜く', async () => {
    assert.equal(await tab.evaluate(`getComputedStyle(document.getElementById('box-only')).clipPath`),
      'content-box', 'この試験の前提（computed 値）が違う');
    assert.deepEqual([await nIn('#box-only'), await nIn('#box-later')], [0, 1]);
  });

  await t.test('RG-11-04 対照: 潰れていない参照ボックスは、誤って落とさない', async () => {
    assert.equal(await tab.evaluate(`getComputedStyle(document.getElementById('box-normal')).clipPath`),
      'content-box', 'この試験の前提（computed 値）が違う');
    assert.deepEqual([await nIn('#box-normal'), await nIn('#normal-later')], [1, 0],
      '見えている箱の語を隠れていると判定している');
  });

  await t.test('RG-11-02 退役した領域をページが戻しても、印は1つのまま', async () => {
    assert.deepEqual([await nIn('#retire-src'), await nIn('#retire-dst')], [1, 0], '前提が崩れている');
    await tab.evaluate(`window.__kept = document.getElementById('retire-src'); window.__kept.remove(); true`);
    await waitFor('後ろへ移る', async () => await nIn('#retire-dst') === 1);
    await tab.evaluate(`document.body.appendChild(window.__kept); true`);
    await sleep(800);
    assert.equal(await nKey('branch'), 1, '戻した側の古い印が生き返っている');
    assert.equal(await nIn('#retire-src'), 0, '退役した印が残っている');
  });

  await t.test('RG-11-02 合言葉の値を書き換えた複製も取り除く', async () => {
    await tab.evaluate(`(() => { const c = document.getElementById('clone-src').cloneNode(true);
      c.id = 'odd-clone';
      for (const ic of c.querySelectorAll('.iiyaku-icon')) ic.setAttribute('data-iiyaku-owner', 'page-value');
      document.getElementById('sink').append(c); })(); true`);
    await waitFor('複製が取り除かれる', async () => await nIn('#odd-clone') === 0);
    assert.equal(await nKey('milestone'), 1, '正規の印が増減している');
    assert.equal(await tab.evaluate(`document.getElementById('odd-clone').textContent`),
      'A milestone first.', '複製側の本文まで壊している');
  });

  await t.test('RG-11-02 ページが正規の印から合言葉を外したら、見えない停止点を残さない', async () => {
    assert.equal(await nIn('#strip'), 1, '前提が崩れている');
    await tab.evaluate(`(() => { window.__old = document.querySelector('#strip .iiyaku-icon');
      window.__old.removeAttribute('data-iiyaku-owner'); })(); true`);
    await waitFor('合言葉の無い印が片づく', async () => await tab.evaluate(`!window.__old.isConnected`));
    const r = await tab.evaluate(`(() => {
      const all = [...document.querySelectorAll('.iiyaku-icon[data-iiyaku-key="commit"]')];
      return { 合計: all.length, 見える: all.filter(i => i.checkVisibility()).length,
               合言葉なし: all.filter(i => !i.dataset.iiyakuOwner).length }; })()`);
    // 元の場所はいまも読めるので、そこへ付け直すのが正しい（後ろへ譲る必要はない）。
    // 大事なのは「見えない停止点が残らない」ことと「増えない」こと。
    assert.deepEqual(r, { 合計: 1, 見える: 1, 合言葉なし: 0 },
      `合言葉の無い印が残っているか、印が増えている: ${JSON.stringify(r)}`);
  });

  // ページ側の本文が同じ class を名乗っているだけの場所は、走査してよい。
  // v1.8.9 は class 名を除外一覧へ並べていたので、ここを**永久に**走らなかった
  // （時間が経っても直らない。実測: その語は後ろの段落へ回っていた）。
  await t.test('RG-11-03 ページ側の同名 class の中も、ふつうに走査する', async () => {
    assert.deepEqual([await nIn('#page-tip'), await nIn('#tip-later')], [1, 0],
      'ページの本文を、自分の吹き出しと取り違えて飛ばしている');
  });

  await t.test('RG-11-03 ページ側が同じ class を使っても、自分のものとして扱わない', async () => {
    assert.deepEqual([await nIn('#tip-class'), await nIn('#tip-class-later')], [1, 0], '前提が崩れている');
    await tab.evaluate(`(() => { const p = document.getElementById('tip-class');
      p.classList.add('iiyaku-tooltip'); p.style.display = 'none'; })(); true`);
    await waitFor('後ろの読める語へ移る', async () => await nIn('#tip-class-later') === 1);
    assert.deepEqual([await nIn('#tip-class'), await nKey('merge')], [0, 1]);
  });

  await t.test('RG-11-03 ページ側の同名 class 要素を、消しも書き換えもしない', async () => {
    const r = await tab.evaluate(`(() => { const el = document.getElementById('page-own');
      if (!el) return { 消された: true };
      return { 消された: false, text: el.textContent,
               owner: el.getAttribute('data-iiyaku-owner'), cls: el.className }; })()`);
    assert.deepEqual(r, { 消された: false, text: 'page', owner: 'page', cls: 'iiyaku-icon' },
      `ページの持ち物に手を出している: ${JSON.stringify(r)}`);
  });

  await t.test('RG-11-02 合言葉の値が違う要素は、印として描かない', async () => {
    const r = await tab.evaluate(`(() => { const el = document.getElementById('page-own');
      const cs = getComputedStyle(el);
      return { display: cs.display, borderTopWidth: cs.borderTopWidth,
               afterContent: getComputedStyle(el, '::after').content }; })()`);
    assert.notEqual(r.display, 'inline-flex', '合言葉の値が違うのに印として描かれている');
    assert.equal(r.borderTopWidth, '0px', '合言葉の値が違うのに丸が描かれている');
    assert.equal(r.afterContent, 'none', '合言葉の値が違うのに "i" が描かれている');
  });

  await t.test('RG-11-02 取り除いた複製は、Tab の停止点を増やさない', async () => {
    // このページには正規の印が複数ある。総数で判定すると何を測っているか分からない
    // ので、**複製を足す前後の差**で見る（増えなければ、複製は停止点になっていない）。
    const stops = async () => {
      const order = await collectTabOrder(cdp, tab, 16, 'before');
      const wrap = order.indexOf('before');            // 一周して戻ってきた位置
      return (wrap === -1 ? order : order.slice(0, wrap)).filter(x => x === 'SUP').length;
    };
    const before = await stops();
    assert.ok(before > 0, `前提が崩れている（印の停止点が ${before} 個）`);
    await tab.evaluate(`(() => { const c = document.getElementById('clone-src').cloneNode(true);
      c.id = 'tab-clone';
      for (const ic of c.querySelectorAll('.iiyaku-icon')) ic.removeAttribute('data-iiyaku-owner');
      document.getElementById('sink').append(c); })(); true`);
    await waitFor('複製が取り除かれる', async () => await nIn('#tab-clone') === 0);
    assert.equal(await stops(), before, '複製が Tab の停止点として残っている');
  });

  await tab.close();
});

test('1回のページ変更で、まとめ直しは1回しか走らない', async t => {
  // まとめ直しの回数は、隔離された世界の中でしか数えられない。
  // 数える仕掛け自身が効いていることを、同じ実行の陽性対照で確かめてから測る。
  const srv = await startTestServer(`<!doctype html><html lang="en"><head><meta charset="utf-8">
    <title>batch</title></head><body>
    <p id="first">A branch first.</p><p id="second">A branch second.</p></body></html>`);
  const chrome = await launchChrome({ port: srv.port });
  t.after(async () => { chrome.kill(); await srv.close(); });
  await chrome.cdp.send('Extensions.loadUnpacked', {
    path: stageExtensionWith({ 'batch-probe.js': 'tests/e2e/batch-probe.js' },
      js => ['batch-probe.js', ...js]) });
  const tab = await openPage(chrome.cdp, PAGE);
  // 計測器の公表先は localStorage（<html> の属性へ書くと content.js の見張りと
  // 噛み合って止まらなくなる）。合図を送る側だけは属性のまま。
  const probe = n => tab.evaluate(`localStorage.getItem(${JSON.stringify('rg-' + n)})`);
  // 暇なときの確認は2秒ごとに走る。600ms の窓で数えると、そこへ割り込まれた回を
  // 「いま起こした変更のせい」と読み違える（実測で5回に1回ずれた）。
  // **その確認が走った直後から測る**ようにして、窓の中に入らないようにする。
  const afterIdleTick = async () => {
    const a = Number(await probe('batches'));
    await waitFor('暇なときの確認が1回走る', async () => Number(await probe('batches')) > a);
  };

  await waitFor('拡張が印を付ける', async () =>
    await tab.evaluate(`[...document.querySelectorAll('.iiyaku-icon')].filter(i => i.dataset.iiyakuKey).length`));

  await t.test('RG-11-05 数える仕掛けが効いている（陽性対照）', async () => {
    assert.equal(await probe('probe-selftest'), '1',
      '予約を包めていない。ここが 0 なら、以降の「1回」は測れていない');
  });

  await t.test('RG-11-05 1回隠すと、まとめ直しは1回だけ', async () => {
    await afterIdleTick();
    await tab.evaluate(`localStorage.setItem('rg-reset', '1'); true`);
    await waitFor('数え直しが効く', async () => await probe('batches') === '0');
    await tab.evaluate(`document.getElementById('first').style.display = 'none'; true`);
    await waitFor('後ろへ移る', async () =>
      await tab.evaluate(`document.querySelectorAll('#second .iiyaku-icon').length`) === 1);
    await sleep(500);
    assert.equal(await probe('batches'), '1',
      'まとめ直しが余計に走っている（自分が起こした変更を数えている）');
  });

  await t.test('RG-11-05 吹き出しの開閉では、本文の走査を予約しない', async () => {
    await afterIdleTick();
    await tab.evaluate(`localStorage.setItem('rg-reset', '1'); true`);
    await waitFor('数え直しが効く', async () => await probe('batches') === '0');
    await tab.evaluate(`(() => { const ic = document.querySelector('#second .iiyaku-icon');
      ic.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); })(); true`);
    await sleep(600);
    assert.equal(await probe('batches'), '0',
      '吹き出しを出しただけで本文のまとめ直しが走っている');
  });

  await tab.close();
});

/* ===================== 第12回監査（v1.8.11）の受入条件 ===================== */

test('控えの見直しは、触れない場所の本文を読まない', async t => {
  const srv = await startTestServer(LATENT_GUARD_PAGE);
  const chrome = await launchChrome({ port: srv.port });
  t.after(async () => { chrome.kill(); await srv.close(); });
  await chrome.cdp.send('Extensions.loadUnpacked', {
    path: stageExtensionWith({ 'nodevalue-probe.js': 'tests/e2e/nodevalue-probe.js' },
      js => ['nodevalue-probe.js', ...js]) });
  const tab = await openPage(chrome.cdp, PAGE);
  const raw = () => tab.evaluate(`localStorage.getItem('rg-raw') || ''`);
  const nKey = k => tab.evaluate(
    `document.querySelectorAll('.iiyaku-icon[data-iiyaku-key="' + ${JSON.stringify(k)} + '"]').length`);

  await t.test('RG-12-01 計装が効いている（陽性対照）', async () => {
    // 拡張が読み込まれる前に見ると null になる。**待ってから**確かめる
    // （待たずに書いて、全件実行のときだけ落ちる不安定な試験になった）。
    await waitFor('読み取りを包めている', async () => await tab.evaluate(
      `localStorage.getItem('rg-rawtap') === 'ready' ? 1 : 0`));
    await waitFor('見えている語へ印が付く', async () => await nKey('repository') === 1);
    assert.equal(await raw(), 'RGSENTINEL_SELFTEST', '最初から余計な読み取りがある');
  });

  await t.test('RG-12-01 保護領域へ移った控えの本文は、一度も読まない（4種）', async () => {
    // 目印は「保護する」のと同時に入れる。初回走査で読まれた分を数えないため。
    await tab.evaluate(`(() => {
      const set = (id, sentinel, apply) => {
        const el = document.getElementById(id);
        apply(el); el.classList.remove('hid');
        el.firstChild.nodeValue = sentinel + ' ' + el.firstChild.nodeValue;
      };
      set('lat-edit',   'RGSENTINEL_LATEDIT',   el => el.contentEditable = 'true');
      set('lat-aria',   'RGSENTINEL_LATARIA',   el => el.setAttribute('aria-hidden', 'true'));
      set('lat-inert',  'RGSENTINEL_LATINERT',  el => el.setAttribute('inert', ''));
      set('lat-hidden', 'RGSENTINEL_LATHIDDEN', el => el.setAttribute('hidden', ''));
    })(); true`);
    await sleep(5200);   // 2秒周期の確認を2回以上通す
    const seen = (await raw()).split(',').filter(Boolean);
    const leaked = seen.filter(s => s.startsWith('RGSENTINEL_LAT'));
    assert.deepEqual(leaked, [], `触れない場所の本文を読んだ: ${leaked.join(', ')}`);
  });

  await t.test('RG-12-01 保護されていない控えは、これまでどおり読んで注記する（陽性対照）', async () => {
    await tab.evaluate(`(() => { const el = document.getElementById('lat-open');
      el.classList.remove('hid');
      el.firstChild.nodeValue = 'RGSENTINEL_LATOPEN ' + el.firstChild.nodeValue; })(); true`);
    await waitFor('その語に印が付く', async () => await nKey('revert') === 1, { timeout: 12000 });
    assert.ok((await raw()).includes('RGSENTINEL_LATOPEN'),
      '注記したのに読み取りが記録されていない＝計測が壊れている');
  });

  await tab.close();
});

test('いまは入口が無いだけの語も、入口ができたら説明する', async t => {
  const srv = await startTestServer(DEFERRED_PAGE);
  const chrome = await launchChrome({ port: srv.port });
  t.after(async () => { chrome.kill(); await srv.close(); });
  await chrome.cdp.send('Extensions.loadUnpacked', { path: stageExtension() });
  const tab = await openPage(chrome.cdp, PAGE);
  const nKey = k => tab.evaluate(
    `document.querySelectorAll('.iiyaku-icon[data-iiyaku-key="' + ${JSON.stringify(k)} + '"]').length`);
  await waitFor('拡張が印を付ける', async () => await nKey('repository') === 1);

  await t.test('RG-12-02 前提: 入口が無いあいだは印を付けない', async () => {
    assert.deepEqual([await nKey('branch'), await nKey('commit'), await nKey('merge')],
      [0, 0, 0], 'この試験の前提が崩れている');
  });

  // 監査は「href の後付け」も同じ型として挙げたが、実装ではそもそも該当しない。
  // `href` の無い `<a>` は入口の候補にならないので、その中の語は最初から
  // **ふつうの印**（印自体を入口にする形）で説明される。実測して確かめてある。
  await t.test('RG-12-02 対照: href の無い a は、最初からふつうに説明される', async () => {
    assert.equal(await nKey('rebase'), 1,
      'href の無い a の中の語に、最初から印が付いていない＝前提の理解が違う');
  });

  await t.test('RG-12-02 disabled を外すと説明が付く', async () => {
    await tab.evaluate(`document.getElementById('btn').disabled = false; true`);
    await waitFor('印が付く', async () => await nKey('branch') === 1, { timeout: 12000 });
  });

  await t.test('RG-12-02 tabindex が -1 から 0 になると説明が付く', async () => {
    await tab.evaluate(`document.getElementById('roving').setAttribute('tabindex', '0'); true`);
    await waitFor('印が付く', async () => await nKey('commit') === 1, { timeout: 12000 });
  });

  await t.test('RG-12-02 label の対応先が後からできると説明が付く', async () => {
    await tab.evaluate(`document.getElementById('lab').setAttribute('for', 'ctrl'); true`);
    await waitFor('印が付く', async () => await nKey('merge') === 1, { timeout: 12000 });
  });

  await t.test('RG-12-02 もう一度無効にすると退役する（増えも残りもしない）', async () => {
    await tab.evaluate(`document.getElementById('btn').disabled = true; true`);
    await waitFor('印が外れる', async () => await nKey('branch') === 0, { timeout: 12000 });
  });

  await tab.close();
});

test('控えが多くても、探すのをやめない', async t => {
  // 旧版の上限は 2,000 で、しかも**控えに既にある節点を数え直して**上限を踏み、
  // 控えを丸ごと捨てていた。捨てたあとは「候補0件」に見えるので二度と探さない。
  const hidden = [];
  for (let i = 0; i < 2100; i++) hidden.push(`<p>Hidden line ${i} mentions a branch here.</p>`);
  const srv = await startTestServer(`<!doctype html><html lang="en"><head><meta charset="utf-8">
    <title>many</title><style>#vault{display:none}#target{display:none}
    body:has(#tgl:checked) #target{display:block}</style></head><body>
    <div id="vault">${hidden.join('')}</div>
    <input id="tgl" type="checkbox">
    <p id="target">A commit appears when ticked.</p></body></html>`);
  const chrome = await launchChrome({ port: srv.port });
  t.after(async () => { chrome.kill(); await srv.close(); });
  await chrome.cdp.send('Extensions.loadUnpacked', { path: stageExtension() });
  const tab = await openPage(chrome.cdp, PAGE);
  const nKey = k => tab.evaluate(
    `document.querySelectorAll('.iiyaku-icon[data-iiyaku-key="' + ${JSON.stringify(k)} + '"]').length`);
  await sleep(2500);

  await t.test('RG-12-04 前提: 隠れているあいだは印が無い', async () => {
    assert.equal(await nKey('commit'), 0, 'この試験の前提が崩れている');
  });

  await t.test('RG-12-04 2,100件の控えがあっても、後から見えた語を見つける', async () => {
    await tab.evaluate(`document.getElementById('tgl').checked = true; true`);
    await waitFor('印が付く', async () => await nKey('commit') === 1, { timeout: 20000 });
    assert.equal(await tab.evaluate(`getComputedStyle(document.getElementById('target')).display`), 'block');
  });

  await tab.close();
});

test('最初の走査の途中で自分が起こした変更が、あとの外部変更を食べない', async t => {
  const srv = await startTestServer(`<!doctype html><html lang="en"><head><meta charset="utf-8">
    <title>expect</title></head><body>
    <p id="first">A branch first.</p><p id="second">A branch later.</p></body></html>`);
  const chrome = await launchChrome({ port: srv.port });
  t.after(async () => { chrome.kill(); await srv.close(); });
  await chrome.cdp.send('Extensions.loadUnpacked', {
    path: stageExtensionWith({ 'batch-probe.js': 'tests/e2e/batch-probe.js' },
      js => ['batch-probe.js', ...js]) });
  const tab = await openPage(chrome.cdp, PAGE);
  // 計測器の公表先は localStorage（<html> の属性へ書くと content.js の見張りと
  // 噛み合って止まらなくなる）。合図を送る側だけは属性のまま。
  const probe = n => tab.evaluate(`localStorage.getItem(${JSON.stringify('rg-' + n)})`);
  // 暇なときの確認は2秒ごとに走る。600ms の窓で数えると、そこへ割り込まれた回を
  // 「いま起こした変更のせい」と読み違える（実測で5回に1回ずれた）。
  // **その確認が走った直後から測る**ようにして、窓の中に入らないようにする。
  const afterIdleTick = async () => {
    const a = Number(await probe('batches'));
    await waitFor('暇なときの確認が1回走る', async () => Number(await probe('batches')) > a);
  };

  const nIn = sel => tab.evaluate(`document.querySelectorAll(${JSON.stringify(sel)} + ' .iiyaku-icon').length`);
  await waitFor('拡張が印を付ける', async () => await nIn('#first') === 1);

  await t.test('RG-12-03 数える仕掛けが効いている（陽性対照）', async () => {
    assert.equal(await probe('probe-selftest'), '1', '予約を包めていない');
  });

  await t.test('RG-12-03 最初の外部の文字変更に、その場で反応する', async () => {
    await afterIdleTick();
    await tab.evaluate(`localStorage.setItem('rg-reset', '1'); true`);
    await waitFor('数え直しが効く', async () => await probe('batches') === '0');
    await tab.evaluate(`document.getElementById('first').firstChild.nodeValue = 'A banana'; true`);
    await sleep(600);   // 暇なときの確認（2秒）より十分早い
    assert.equal(await probe('batches'), '1',
      '外部の文字変更を「自分の変更」として捨てている（残った予定が食べた）');
    assert.deepEqual([await nIn('#first'), await nIn('#second')], [0, 1]);
  });

  await tab.close();
});

test('潰れた参照ボックスの切り取りを、寸法不明と混ぜない', async t => {
  const srv = await startTestServer(CLIPZERO_PAGE);
  const chrome = await launchChrome({ port: srv.port });
  t.after(async () => { chrome.kill(); await srv.close(); });
  await chrome.cdp.send('Extensions.loadUnpacked', { path: stageExtension() });
  const tab = await openPage(chrome.cdp, PAGE);
  const nIn = sel => tab.evaluate(`document.querySelectorAll(${JSON.stringify(sel)} + ' .iiyaku-icon').length`);
  await waitFor('拡張が印を付ける', async () =>
    await tab.evaluate(`[...document.querySelectorAll('.iiyaku-icon')].filter(i => i.dataset.iiyakuKey).length`));

  await t.test('RG-12-05 content box が 0 の inset(0) は、全面が消えていると見抜く', async () => {
    assert.equal(await tab.evaluate(`getComputedStyle(document.getElementById('zero')).clipPath`),
      'inset(0px) content-box', 'この試験の前提（computed 値）が違う');
    assert.deepEqual([await nIn('#zero'), await nIn('#zero-later')], [0, 1]);
  });

  await t.test('RG-12-05 対照: 負の inset で外へ広がる形は、誤って落とさない', async () => {
    // ⚠️ v1.8.13 で一度 [0,1] へ反転させたが、それは **macOS だけの実測**だった。
    // CI で ubuntu と windows は [1,0] を返し、折り返し次第で答えが割れると分かった。
    // 見本のほうを折り返さない形（nowrap ＋ 広い負の inset）へ直し、
    // 「負の inset で外へ広がった先の語は落とさない」という**性質だけ**を見る。
    assert.deepEqual([await nIn('#zero-neg'), await nIn('#neg-later')], [1, 0],
      '負の inset で外へ広がった先の語を落としている');
  });

  await t.test('RG-12-05 対照: 潰れていない content box の inset(0) は可視', async () => {
    assert.deepEqual([await nIn('#nonzero'), await nIn('#nonzero-later')], [1, 0]);
  });

  await tab.close();
});

test('自分の class 名を、ページ側の同名要素へ当てはめない', async t => {
  const srv = await startTestServer(SKIPNAME_PAGE);
  const chrome = await launchChrome({ port: srv.port });
  t.after(async () => { chrome.kill(); await srv.close(); });
  await chrome.cdp.send('Extensions.loadUnpacked', { path: stageExtension() });
  const tab = await openPage(chrome.cdp, PAGE);
  const nIn = sel => tab.evaluate(`document.querySelectorAll(${JSON.stringify(sel)} + ' .iiyaku-icon').length`);
  const nKey = k => tab.evaluate(
    `document.querySelectorAll('.iiyaku-icon[data-iiyaku-key="' + ${JSON.stringify(k)} + '"]').length`);
  await waitFor('拡張が印を付ける', async () => await nKey('branch') === 1);

  await t.test('RG-12-06 ページ側の .iiyaku-icon の本文も、ふつうに走査する', async () => {
    assert.equal(await nKey('commit'), 1, 'ページ本文を自分の印と取り違えて飛ばしている');
    assert.equal(await tab.evaluate(`document.getElementById('page-icon').textContent`),
      'A commit in ordinary page text.'.replace('commit', 'commit'), '本文を壊している');
  });

  await t.test('RG-12-06 ページ側の .iiyaku-tooltip へ移ったら、説明は閉じる', async () => {
    await tab.evaluate(`(() => { const ic = document.querySelector('#src .iiyaku-icon');
      ic.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); })(); true`);
    await waitFor('説明が出る', async () =>
      await tab.evaluate(`!!document.querySelector('.iiyaku-tooltip[data-iiyaku-owner]')`));
    await tab.evaluate(`(() => { const ic = document.querySelector('#src .iiyaku-icon');
      ic.dispatchEvent(new MouseEvent('mouseout', { bubbles: true,
        relatedTarget: document.getElementById('page-tip') })); })(); true`);
    await waitFor('説明が閉じる', async () =>
      await tab.evaluate(`!document.querySelector('.iiyaku-tooltip[data-iiyaku-owner]')`));
  });

  await t.test('RG-12-06 本物の吹き出しへ移ったときは、閉じない', async () => {
    await tab.evaluate(`(() => { const ic = document.querySelector('#src .iiyaku-icon');
      ic.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); })(); true`);
    await waitFor('説明が出る', async () =>
      await tab.evaluate(`!!document.querySelector('.iiyaku-tooltip[data-iiyaku-owner]')`));
    await tab.evaluate(`(() => { const ic = document.querySelector('#src .iiyaku-icon');
      ic.dispatchEvent(new MouseEvent('mouseout', { bubbles: true,
        relatedTarget: document.querySelector('.iiyaku-tooltip[data-iiyaku-owner]') })); })(); true`);
    await sleep(500);
    assert.ok(await tab.evaluate(`!!document.querySelector('.iiyaku-tooltip[data-iiyaku-owner]')`),
      '本物の吹き出しへ移ったのに閉じている＝長い説明が読めない');
  });

  await tab.close();
});

/* ===================== 第13回監査（v1.8.12）の受入条件 ===================== */

test('語が実際に描かれている場所だけへ注記する', async t => {
  const srv = await startTestServer(PAINT_PAGE);
  const chrome = await launchChrome({ port: srv.port });
  t.after(async () => { chrome.kill(); await srv.close(); });
  await chrome.cdp.send('Extensions.loadUnpacked', { path: stageExtension() });
  const tab = await openPage(chrome.cdp, PAGE);
  const nIn = sel => tab.evaluate(`document.querySelectorAll(${JSON.stringify(sel)} + ' .iiyaku-icon').length`);
  // 前提は「どこかに印が付いた」だけにする。場所まで前提にすると、場所を
  // 間違える実装では**個々のケースの判定に届かず**、何を落としているか分からない。
  await waitFor('拡張が印を付ける', async () =>
    await tab.evaluate(`document.querySelectorAll('.iiyaku-icon').length`) > 0);
  await sleep(600);

  // 隠れている側に付けてはいけない（付けると「最初の1回」を使い切り、
  // 後ろの読める同じ語が永久に説明されなくなる）
  for (const [id, why] of [
    ['ovh', 'overflow:hidden の切り取りの外'],
    ['ovc', 'overflow:clip の切り取りの外'],
    ['cpi', '面積のある clip-path の外'],
    ['flt', 'filter:opacity(0) で完全に透明'],
    ['trs', 'transform:scale(0) で面積0'],
    ['msk', '完全に透明な mask']
  ]) {
    await t.test(`RG-13-01 ${why}には注記しない`, async () => {
      assert.deepEqual([await nIn(`#h-${id}`), await nIn(`#l-${id}`)], [0, 1],
        `隠れている側に印が付いている（${why}）`);
    });
  }

  // 逆向きの対照。ここが 0/1 になったら落としすぎている
  for (const [id, why] of [
    ['neg', '1px の箱でも、負の inset で外へ描かれている'],
    ['part', '切り取りに一部が掛かっているだけ'],
    ['esc', '絶対配置で、包含ブロックでない祖先の切り取りからは逃げている'],
    ['scr', 'スクロールすれば読める（overflow:auto の画面外）']
  ]) {
    await t.test(`RG-13-01【対照】${why}語は落とさない`, async () => {
      assert.deepEqual([await nIn(`#h-${id}`), await nIn(`#l-${id}`)], [1, 0],
        `読める語を落としている（${why}）`);
    });
  }

  await tab.close();
});

test('生成した印の生命周期を、記録どおりに保つ', async t => {
  const srv = await startTestServer(LIFECYCLE13_PAGE);
  const chrome = await launchChrome({ port: srv.port });
  t.after(async () => { chrome.kill(); await srv.close(); });
  await chrome.cdp.send('Extensions.loadUnpacked', { path: stageExtension() });
  const tab = await openPage(chrome.cdp, PAGE);
  const nKey = k => tab.evaluate(`document.querySelectorAll('.iiyaku-icon[data-iiyaku-key=${JSON.stringify(k)}]').length`);
  await waitFor('拡張が印を付ける', async () => await nKey('branch') === 1);

  await t.test('RG-13-04 ページが正規の印だけを外したら、暇なときの確認を待たずに戻る', async () => {
    await tab.evaluate(`document.querySelector('.iiyaku-icon[data-iiyaku-key="branch"]').remove(); true`);
    // 暇なときの確認は2秒ごと。それより十分早く戻ること
    await sleep(500);
    assert.equal(await nKey('branch'), 1, '外部の削除に気づかず、説明が消えたままになっている');
  });

  await t.test('RG-13-04 退役した印をページが本文として使い回しても、消さず、中の語も説明する', async () => {
    const r = await tab.evaluate(`(async () => {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const ic = document.querySelector('.iiyaku-icon[data-iiyaku-key="commit"]');
      ic.remove();
      await wait(300);
      ic.textContent = 'A squash merge inside.';
      document.getElementById('reuse-dest').appendChild(ic);
      await wait(1200);
      return { connected: ic.isConnected, text: ic.textContent,
               inside: ic.querySelectorAll('.iiyaku-icon').length };
    })()`);
    assert.equal(r.connected, true, 'ページが使い回している節点を消している');
    assert.match(r.text, /squash merge/, 'ページの本文を壊している');
    assert.equal(r.inside, 1, '使い回された節点の中が走査されていない');
  });

  await t.test('RG-13-04 説明文・用語・role を書き換えられたら、正しい印へ作り直す', async () => {
    await tab.evaluate(`(() => { const ic = document.querySelector('.iiyaku-icon[data-iiyaku-key="webhook"]');
      ic.dataset.iiyaku = 'WRONG'; ic.dataset.iiyakuTerm = 'wrong'; ic.setAttribute('role', 'img'); })(); true`);
    await waitFor('正しい印へ戻る', async () => await tab.evaluate(
      `(() => { const ic = document.querySelector('.iiyaku-icon[data-iiyaku-key="webhook"]');
        return !!ic && ic.dataset.iiyaku !== 'WRONG' && ic.getAttribute('role') === 'button'; })()`));
    assert.equal(await nKey('webhook'), 1, '印が増減している');
  });

  await tab.close();
});

test('自分の署名だけで片づけ、ページの持ち物には触れない（第13回）', async t => {
  const srv = await startTestServer(SIGNATURE13_PAGE);
  const chrome = await launchChrome({ port: srv.port });
  const { cdp } = chrome;
  t.after(async () => { chrome.kill(); await srv.close(); });
  await cdp.send('Extensions.loadUnpacked', { path: stageExtension() });
  const tab = await openPage(cdp, PAGE);
  await waitFor('拡張が印を付ける', async () => await tab.evaluate(
    `document.querySelectorAll('#clone-src .iiyaku-icon').length`) === 1);

  for (const [name, mutate] of [
    ['合言葉を消した', `c.removeAttribute('data-iiyaku-owner')`],
    ['合言葉を書き換えた', `c.setAttribute('data-iiyaku-owner', 'page')`],
    ['辞書のキーを消した', `c.removeAttribute('data-iiyaku-key')`],
    ['説明文を書き換えた', `c.dataset.iiyaku = 'MUTATED'`]
  ]) {
    await t.test(`RG-13-03 ${name}複製は、見える印も Tab の停止点も増やさない`, async () => {
      await tab.evaluate(`(() => {
        document.getElementById('sink').textContent = '';
        const c = document.querySelector('#clone-src .iiyaku-icon').cloneNode(true);
        c.id = 'dup'; ${mutate};
        document.getElementById('sink').appendChild(c); })(); true`);
      await waitFor('複製が無力になる', async () => await tab.evaluate(
        `(() => { const d = document.getElementById('dup');
          if (!d) return true;                      // 消えたなら、それも無力
          return d.tabIndex < 0 && d.getAttribute('role') !== 'button'
                 && d.getBoundingClientRect().width < 1; })()`));
      assert.equal(await tab.evaluate(
        `document.querySelectorAll('.iiyaku-icon[data-iiyaku-key="milestone"]').length`), 1,
        '正規の印が増減している');
    });
  }

  await t.test('RG-13-03 辞書の説明文をそのまま持つページの要素を、消さない', async () => {
    // 「たまたま自分と同じ data 属性を持つ」だけの、ページの持ち物。
    // **追加された領域として**入れる（複製の後始末はそこにしか掛からないので、
    // 既にある要素へ属性を足すだけでは、この経路を通らない）。
    await tab.evaluate(`(() => {
      const src = document.querySelector('.iiyaku-icon[data-iiyaku-key="milestone"]');
      const el = document.createElement('span');
      el.id = 'page-copy';
      el.dataset.iiyaku = src.dataset.iiyaku;      // 辞書の説明文そのもの
      el.dataset.iiyakuKey = 'milestone';
      el.textContent = 'PAGE DATA';
      document.getElementById('sink').appendChild(el); })(); true`);
    await sleep(700);
    assert.equal(await tab.evaluate(
      `(() => { const el = document.getElementById('page-copy'); return el ? el.textContent : null; })()`),
      'PAGE DATA', 'ページの持ち物を、本文ごと消している');
  });

  await t.test('RG-13-03 ページ側の同名 class へ、自分の見た目を与えない', async () => {
    const r = await tab.evaluate(`(() => {
      const s = id => { const cs = getComputedStyle(document.getElementById(id));
                        return [cs.position, cs.zIndex]; };
      return { tip: s('page-tip'), toggle: s('page-toggle') }; })()`);
    assert.deepEqual(r.tip, ['static', 'auto'], 'ページの要素が自分の吹き出しの見た目になっている');
    assert.deepEqual(r.toggle, ['static', 'auto'], 'ページの要素が自分の切替ボタンの見た目になっている');
  });

  await tab.close();
});

test('CSS だけで短時間ひらく場所の語も説明する', async t => {
  const srv = await startTestServer(TRANSIENT_PAGE);
  const chrome = await launchChrome({ port: srv.port });
  const { cdp } = chrome;
  t.after(async () => { chrome.kill(); await srv.close(); });
  await cdp.send('Extensions.loadUnpacked', { path: stageExtension() });
  const tab = await openPage(cdp, PAGE);
  await waitFor('拡張が印を付ける', async () => await tab.evaluate(
    `document.querySelectorAll('.iiyaku-icon').length`) > 0);
  const move = (x, y) => cdp.send('Input.dispatchMouseEvent',
    { type: 'mouseMoved', x, y, button: 'none', buttons: 0, clickCount: 0 }, tab.sessionId);
  const nKey = k => tab.evaluate(`document.querySelectorAll('.iiyaku-icon[data-iiyaku-key=${JSON.stringify(k)}]').length`);

  await t.test('RG-13-02 hover で開いた 400ms のあいだに印が付く', async () => {
    assert.equal(await nKey('branch'), 0, '前提が崩れている（最初から見えている）');
    const p = await tab.evaluate(`(() => { const r = document.getElementById('host').getBoundingClientRect();
      return [Math.round(r.x + 5), Math.round(r.y + r.height / 2)]; })()`);
    await move(p[0], p[1]);
    await sleep(400);   // 暇なときの確認（2秒）より十分早い
    assert.equal(await tab.evaluate(`getComputedStyle(document.getElementById('menu')).display`),
      'block', '前提が崩れている（メニューが開いていない）');
    assert.equal(await nKey('branch'), 1, '開いているあいだに説明が付いていない');
    await move(5, 5);
  });

  await t.test('RG-13-02 閉じたあとに、見えない印を残さない', async () => {
    await waitFor('見えない印が片づく', async () => await nKey('branch') === 0);
  });

  await tab.close();
});

test('`<html>` の属性変更に、待たずに気づく', async t => {
  const srv = await startTestServer(ROOTATTR_PAGE);
  const chrome = await launchChrome({ port: srv.port });
  t.after(async () => { chrome.kill(); await srv.close(); });
  await chrome.cdp.send('Extensions.loadUnpacked', { path: stageExtension() });
  const tab = await openPage(chrome.cdp, PAGE);
  const nKey = k => tab.evaluate(`document.querySelectorAll('.iiyaku-icon[data-iiyaku-key=${JSON.stringify(k)}]').length`);
  await waitFor('拡張が印を付ける', async () => await nKey('branch') === 1);

  await t.test('RG-13-05 `<html>` の属性で隠したら、暇なときの確認を待たずに退役する', async () => {
    await tab.evaluate(`document.documentElement.setAttribute('data-theme', 'b'); true`);
    await sleep(500);   // 2秒の確認より十分早い
    assert.equal(await nKey('branch'), 0, '`<html>` の属性変更が合図になっていない');
  });

  await t.test('RG-13-05 自分が書いた値へページが戻す変更も、外部の変更として扱う', async () => {
    await tab.evaluate(`document.documentElement.removeAttribute('data-theme'); true`);
    await waitFor('戻る', async () => await nKey('branch') === 1);
    // `class` は**自分が書く属性**（ON/OFF の印を付け外しする）。予定を1回で
    // 消費しないと、ページが同じ値へ書き戻した変更を自分の仕業として捨てる。
    const mine = await tab.evaluate(`document.documentElement.getAttribute('class')`);
    await tab.evaluate(`document.documentElement.setAttribute('class', 'theme-b'); true`);
    await sleep(500);
    assert.equal(await nKey('branch'), 0, '前提が崩れている（class で隠せていない）');
    // ここで**自分が最後に書いた値へ戻す**。捨てられると、この語は説明されないまま残る
    await tab.evaluate(`document.documentElement.setAttribute('class', ${JSON.stringify('')} + ${JSON.stringify(mine ?? '')}); true`);
    await sleep(500);
    assert.equal(await nKey('branch'), 1, '自分が書いた値と同じ変更を、外部のものと見ていない');
  });

  await tab.close();
});

test('控えが多くても、1回の見直しを短く保ち、上限の外も取り戻す', async t => {
  // 上限は 20,000。19,999 件の filler ＋ 逃がし弁 ＋ こぼれる1件 で境界を作る。
  const srv = await startTestServer(latentPage(19999));
  const chrome = await launchChrome({ port: srv.port });
  t.after(async () => { chrome.kill(); await srv.close(); });
  await chrome.cdp.send('Extensions.loadUnpacked', {
    path: stageExtensionWith({ 'timing-probe.js': 'tests/e2e/timing-probe.js' },
      js => ['timing-probe.js', ...js]) });
  const tab = await openPage(chrome.cdp, PAGE);
  const probe = n => tab.evaluate(`localStorage.getItem(${JSON.stringify('rg-' + n)})`);
  const nKey = k => tab.evaluate(`document.querySelectorAll('.iiyaku-icon[data-iiyaku-key=${JSON.stringify(k)}]').length`);
  // 痕跡の残らない見え方の変化。控えの見直しでしか拾えない経路を通す
  const reveal = id => tab.evaluate(
    `document.styleSheets[0].insertRule('#${id}{display:block}', document.styleSheets[0].cssRules.length); true`);
  await waitFor('拡張が印を付ける', async () => await nKey('commit') === 1, { timeout: 90000 });

  await t.test('RG-13-06 計る仕掛けが効いている（陽性対照）', async () => {
    assert.equal(await probe('time-selftest'), '1', '予約を包めていない');
  });

  await t.test('RG-13-06 20,000 件の控えでも、1回の処理が 50ms を超えない', async () => {
    await tab.evaluate(`localStorage.setItem('rg-reset', '1'); true`);
    await sleep(11000);   // 暇なときの確認を5周ぶん（1回だけ短い回を見て済まさない）
    const ms = JSON.parse(await probe('times') || '[]');
    assert.ok(ms.length > 0, '1回も測れていない');
    assert.ok(Math.max(...ms) < 50, `1回の処理が長すぎる: ${Math.max(...ms)}ms`);
  });

  await t.test('RG-13-06 上限を超えてこぼれた候補も、空きができれば見つける', async () => {
    await reveal('spill');
    await sleep(4000);
    assert.equal(await nKey('milestone'), 0, '前提が崩れている（上限を超えていない）');
    await reveal('relief');     // 1件が注記されて控えに空きができる
    await waitFor('逃がし弁が注記される', async () => await nKey('fetch') === 1, { timeout: 30000 });
    await waitFor('こぼれた候補を取り戻す', async () => await nKey('milestone') === 1, { timeout: 60000 });
  });

  await tab.close();
});

/* ===================== 第14回監査（v1.8.13）の受入条件 ===================== */

test('一致した語そのものの位置で、描かれているかを決める', async t => {
  const srv = await startTestServer(WORDRECT_PAGE);
  const chrome = await launchChrome({ port: srv.port });
  t.after(async () => { chrome.kill(); await srv.close(); });
  await chrome.cdp.send('Extensions.loadUnpacked', { path: stageExtension() });
  const tab = await openPage(chrome.cdp, PAGE);
  const nIn = sel => tab.evaluate(`document.querySelectorAll(${JSON.stringify(sel)} + ' .iiyaku-icon').length`);
  await waitFor('拡張が印を付ける', async () =>
    await tab.evaluate(`document.querySelectorAll('.iiyaku-icon').length`) > 0);
  await sleep(600);

  for (const [id, why] of [
    ['pre', '同じ段落の先頭だけが見えていて、語は切り取りの外'],
    ['zero', '親が font-size:0 で、見えているのは別の子要素'],
    ['acp', '絶対配置でも、祖先の clip-path からは逃げられない'],
    ['cir', '円の外（外接矩形の内）'],
    ['rnd', '角丸の外']
  ]) {
    await t.test(`RG-14-01/02/03 ${why}には注記しない`, async () => {
      assert.deepEqual([await nIn(`#h-${id}`), await nIn(`#l-${id}`)], [0, 1],
        `語の矩形では 0 画素なのに印が付いている（${why}）`);
    });
  }
  for (const [id, why] of [
    ['aov', 'overflow:hidden からは絶対配置が本当に逃げる'],
    ['cin', '同じ 6px でも円の内側なら読める']
  ]) {
    await t.test(`RG-14-01/02/03【対照】${why}語は落とさない`, async () => {
      assert.deepEqual([await nIn(`#h-${id}`), await nIn(`#l-${id}`)], [1, 0],
        `読める語を落としている（${why}）`);
    });
  }
  await tab.close();
});

test('ページ所有の同名要素を、見た目も中身も変えない（第14回）', async t => {
  const srv = await startTestServer(NAMESPACE14_PAGE);
  const chrome = await launchChrome({ port: srv.port });
  t.after(async () => { chrome.kill(); await srv.close(); });
  await chrome.cdp.send('Extensions.loadUnpacked', { path: stageExtension() });
  const tab = await openPage(chrome.cdp, PAGE);
  await waitFor('拡張が印を付ける', async () => await tab.evaluate(
    `document.querySelectorAll('#src .iiyaku-icon').length`) === 1);

  await t.test('RG-14-07 ページ側が指定した見た目を打ち消さない', async () => {
    assert.deepEqual(await tab.evaluate(`(() => { const c = getComputedStyle(document.getElementById('page-box'));
      return [c.display, c.color, c.width, c.height]; })()`),
      ['grid', 'rgb(255, 0, 0)', '140px', '30px'], 'ページ自身の指定を打ち消している');
  });

  await t.test('RG-14-04 ページ所有の空 SUP から、class も role も剥がさない', async () => {
    assert.deepEqual(await tab.evaluate(`(() => { const e = document.getElementById('page-sup');
      return e ? [e.className, e.getAttribute('role'), e.getAttribute('tabindex')] : null; })()`),
      ['iiyaku-icon', 'button', '0'], 'ページの持ち物を書き換えている');
  });

  await t.test('RG-14-04 空の Text を足した複製も、Tab の停止点にしない', async () => {
    await tab.evaluate(`(() => {
      const c = document.querySelector('#src .iiyaku-icon').cloneNode(true);
      c.id = 'dup'; c.removeAttribute('data-iiyaku-owner');
      c.appendChild(document.createTextNode(''));
      document.getElementById('sink').appendChild(c); })(); true`);
    await waitFor('複製が無力になる', async () => await tab.evaluate(
      `(() => { const d = document.getElementById('dup');
        return !d || (d.tabIndex < 0 && d.getAttribute('role') !== 'button'); })()`));
  });

  await t.test('RG-14-05 印へ aria-hidden と中身を入れられたら、作り直す', async () => {
    await tab.evaluate(`(() => { const ic = document.querySelector('.iiyaku-icon[data-iiyaku-key="commit"]');
      ic.setAttribute('aria-hidden', 'true'); ic.appendChild(document.createTextNode('PAGE')); })(); true`);
    await waitFor('正しい印へ戻る', async () => await tab.evaluate(
      `(() => { const ic = document.querySelector('.iiyaku-icon[data-iiyaku-key="commit"]');
        return !!ic && !ic.hasAttribute('aria-hidden') && ic.textContent === ''; })()`));
    assert.equal(await tab.evaluate(
      `document.querySelectorAll('.iiyaku-icon[data-iiyaku-key="commit"]').length`), 1, '印が増減している');
  });

  await tab.close();
});

/* ===================== 第15回監査（v1.8.14）の受入条件 ===================== */

test('語の選び方と描画判定（第15回）', async t => {
  const srv = await startTestServer(PAINT15_PAGE);
  const chrome = await launchChrome({ port: srv.port });
  const { cdp } = chrome;
  t.after(async () => { chrome.kill(); await srv.close(); });
  await cdp.send('Extensions.loadUnpacked', { path: stageExtension() });
  const tab = await openPage(cdp, PAGE);
  const nIn = sel => tab.evaluate(`document.querySelectorAll(${JSON.stringify(sel)} + ' .iiyaku-icon').length`);
  await waitFor('拡張が印を付ける', async () =>
    await tab.evaluate(`document.querySelectorAll('.iiyaku-icon').length`) > 0);
  await sleep(700);

  await t.test('RG-15-01 同じ節点で1つ目が隠れていても、読める2つ目に説明が付く', async () => {
    assert.deepEqual([await nIn('#h-dup'), await nIn('#l-dup')], [1, 0],
      '1つ目で候補を使い切り、読める2つ目に付いていない');
  });
  for (const [id, why, want] of [
    ['rnd', '角ごとに丸みが違うとき、丸めた角の語', [0, 1]],
    ['frag', '折り返した断片が、別々の形だけを通るとき', [0, 1]],
    ['off', '画面の外へ固定された語', [0, 1]],
    ['tc', '透明な文字', [0, 1]],
    ['rnd2', '【対照】丸めていない角の語', [1, 0]],
    ['scr', '【対照】スクロールで出せる入れ物の中', [1, 0]]
  ]) {
    await t.test(`RG-15-02/03/04/05 ${why}`, async () => {
      assert.deepEqual([await nIn(`#h-${id}`), await nIn(`#l-${id}`)], want, why);
    });
  }

  await t.test('RG-15-04 画面の外の印へ、Tab で止まれない', async () => {
    const hit = await tabUntil(cdp, tab,
      `el.classList.contains('iiyaku-icon') && el.getBoundingClientRect().right < 0`,
      { steps: 40, startId: 'before' });
    assert.equal(hit, null, `画面外の印で止まった: ${hit}`);
  });

  await t.test('RG-15-08 名札を全部消した複製も、Tab の停止点にしない', async () => {
    await tab.evaluate(`(() => {
      const c = document.querySelector('#clone-src .iiyaku-icon').cloneNode(true);
      c.id = 'bare';
      for (const a of [...c.attributes]) if (a.name.startsWith('data-iiyaku')) c.removeAttribute(a.name);
      document.getElementById('sink').appendChild(c); })(); true`);
    await waitFor('複製が無力になる', async () => await tab.evaluate(
      `(() => { const d = document.getElementById('bare');
        return !d || (d.tabIndex < 0 && d.getAttribute('role') !== 'button'); })()`));
  });

  await tab.close();
});

test('カーソルが素早く移っても、取りこぼさない（第15回）', async t => {
  const srv = await startTestServer(HOVER15_PAGE);
  const chrome = await launchChrome({ port: srv.port });
  const { cdp } = chrome;
  t.after(async () => { chrome.kill(); await srv.close(); });
  await cdp.send('Extensions.loadUnpacked', { path: stageExtension() });
  const tab = await openPage(cdp, PAGE);
  await waitFor('拡張が印を付ける', async () => await tab.evaluate(
    `document.querySelectorAll('.iiyaku-icon').length`) > 0);
  const move = (x, y) => cdp.send('Input.dispatchMouseEvent',
    { type: 'mouseMoved', x, y, button: 'none', buttons: 0, clickCount: 0 }, tab.sessionId);
  const at = id => tab.evaluate(`(() => { const r = document.getElementById(${JSON.stringify(id)})
    .getBoundingClientRect(); return [Math.round(r.x + 5), Math.round(r.y + r.height / 2)]; })()`);

  await t.test('RG-15-07 150ms 以内に別の場所へ移っても、そちらに説明が付く', async () => {
    const p1 = await at('h1'), p2 = await at('h2');
    await move(p1[0], p1[1]);
    await sleep(60);                 // 間引きの窓の内側で移る
    await move(p2[0], p2[1]);
    await sleep(500);                // 暇なときの確認（2秒）より十分早い
    assert.equal(await tab.evaluate(
      `document.querySelectorAll('.iiyaku-icon[data-iiyaku-key="rebase"]').length`), 1,
      '窓の内側で来た合図を捨てている（暇なときの確認まで付かない）');
    await move(5, 5);
  });

  await tab.close();
});

/* ===================== 第16回監査（v1.8.15）の受入条件 ===================== */
test('形と描画の判定（第16回）', async t => {
  const srv = await startTestServer(PAINT16_PAGE);
  const chrome = await launchChrome({ port: srv.port });
  const { cdp } = chrome;
  t.after(async () => { chrome.kill(); await srv.close(); });
  await cdp.send('Extensions.loadUnpacked', { path: stageExtension() });
  const tab = await openPage(cdp, PAGE);
  const nIn = sel => tab.evaluate(`document.querySelectorAll(${JSON.stringify(sel)} + ' .iiyaku-icon').length`);
  await waitFor('拡張が印を付ける', async () =>
    await tab.evaluate(`document.querySelectorAll('.iiyaku-icon').length`) > 0);
  await sleep(700);

  for (const [id, why, want] of [
    ['pct', 'RG-16-02 正方形でない箱の `round 50%` の中の語', [1, 0]],
    ['over', 'RG-16-02 隣り合う半径が辺を超えるとき、縮めた形の中の語', [1, 0]],
    ['rot', 'RG-16-03 回転した楕円の外の語', [0, 1]],
    ['rotin', 'RG-16-03【対照】回転した楕円の内の語', [1, 0]],
    ['stk', 'RG-16-04 幅はあるが色が透明な縁取り', [0, 1]],
    ['stkb', 'RG-16-04【対照】黒い縁取り', [1, 0]],
    ['shd', 'RG-16-04 透明な塗りでも、影が文字を描く', [1, 0]],
    ['bgc', 'RG-16-04 背景を文字型に抜いている', [1, 0]],
    ['flt', 'RG-16-05 `opacity(0)` の後ろで描き直される', [1, 0]],
    ['flt0', 'RG-16-05【対照】`opacity(0)` だけ', [0, 1]],
    ['ocm', 'RG-16-07 `overflow:hidden` に余白は効かない', [0, 1]],
    ['ocmc', 'RG-16-07【対照】`overflow:clip` の余白の中', [1, 0]]
  ]) {
    await t.test(why, async () => {
      assert.deepEqual([await nIn(`#h-${id}`), await nIn(`#l-${id}`)], want, why);
    });
  }

  await tab.close();
});

test('スクロールで出せる範囲だけを、読める場所として扱う（第16回）', async t => {
  const srv = await startTestServer(REACH16_PAGE);
  const chrome = await launchChrome({ port: srv.port });
  const { cdp } = chrome;
  t.after(async () => { chrome.kill(); await srv.close(); });
  await cdp.send('Extensions.loadUnpacked', { path: stageExtension() });
  const tab = await openPage(cdp, PAGE);
  const nIn = sel => tab.evaluate(`document.querySelectorAll(${JSON.stringify(sel)} + ' .iiyaku-icon').length`);
  await waitFor('拡張が印を付ける', async () =>
    await tab.evaluate(`document.querySelectorAll('.iiyaku-icon').length`) > 0);
  await sleep(700);

  for (const [id, why, want] of [
    ['fix', 'RG-16-01 スクロールできる入れ物の中の、画面外へ固定された語', [0, 1]],
    ['abs', 'RG-16-01 動かせる量では届かない、負の向きの絶対配置', [0, 1]],
    ['ok', 'RG-16-01【対照】右へスクロールすれば読める語', [1, 0]],
    ['tall', 'RG-16-01【対照】縦に長い中身の、下のほうの語', [1, 0]]
  ]) {
    await t.test(why, async () => {
      assert.deepEqual([await nIn(`#b-${id}`), await nIn(`#l-${id}`)], want, why);
    });
  }

  await t.test('RG-16-01 出せない場所の印で、Tab が止まらない', async () => {
    const hit = await tabUntil(cdp, tab,
      `el.classList.contains('iiyaku-icon') && el.getBoundingClientRect().right < 0`,
      { steps: 40, startId: 'before' });
    assert.equal(hit, null, `画面へ出せない印で止まった: ${hit}`);
  });

  await tab.close();
});

test('ページと名前を共有しない（第16回）', async t => {
  const srv = await startTestServer(NAMESPACE16_PAGE);
  const chrome = await launchChrome({ port: srv.port });
  const { cdp } = chrome;
  t.after(async () => { chrome.kill(); await srv.close(); });
  await cdp.send('Extensions.loadUnpacked', { path: stageExtension() });
  const tab = await openPage(cdp, PAGE);
  await waitFor('拡張が印を付ける', async () =>
    await tab.evaluate(`document.querySelectorAll('.iiyaku-icon').length`) > 0);
  await sleep(700);

  await t.test('RG-16-06 ページの `iiyaku-off` class を消さない', async () => {
    assert.equal(await tab.evaluate(`document.documentElement.className`), 'iiyaku-off');
    assert.equal(await tab.evaluate(`getComputedStyle(document.body).backgroundColor`),
      'rgb(0, 170, 85)', 'ページの class に紐づいた見た目まで失っている');
  });

  await t.test('RG-16-06 ページが同じ名前のレイヤーを使っていても、ページが勝つ', async () => {
    const cs = await tab.evaluate(`(() => { const s = getComputedStyle(document.getElementById('page-own'));
      return [s.display, s.position, s.zIndex, s.color, s.width, s.height]; })()`);
    assert.deepEqual(cs, ['grid', 'relative', '5', 'rgb(255, 0, 0)', '140px', '30px'],
      'ページ自身の @layer の指定を打ち消している');
  });

  await t.test('RG-16-08 名札も読み上げ名も全部消した複製を、Tab の停止点にしない', async () => {
    await tab.evaluate(`(() => {
      const c = document.querySelector('#src .iiyaku-icon').cloneNode(true);
      for (const a of [...c.attributes])
        if (!['class', 'role', 'tabindex', 'aria-expanded'].includes(a.name)) c.removeAttribute(a.name);
      c.textContent = ''; c.id = 'ghost';
      document.getElementById('sink').appendChild(c); })(); true`);
    await waitFor('複製が無力になる', async () => await tab.evaluate(
      `(() => { const d = document.getElementById('ghost');
        return !d || (d.tabIndex < 0 && d.getAttribute('role') !== 'button'); })()`));
    const hit = await tabUntil(cdp, tab, `el.id === 'ghost'`, { steps: 40, startId: 'before' });
    assert.equal(hit, null, '実際に Tab で複製に止まった');
  });

  await tab.close();
});
