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
import { launchChrome, startTestServer, stageExtension,
         LIFECYCLE_PAGE, openPage, sleep, waitFor,
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
