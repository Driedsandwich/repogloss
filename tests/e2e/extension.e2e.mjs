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
import { launchChrome, startTestServer, stageExtension, openPage, sleep, waitFor,
         pressKey, collectTabOrder } from './helpers/chrome.mjs';

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

  await t.test('到達できない場所には印を付けない（境界12件）', async () => {
    // label（対応する入力欄なし）／role だけ／disabled／隠れた入力欄／display:none／
    // visibility:hidden／空の tabindex／空白だけの tabindex／details の外の summary／
    // details の2番目の summary／無効な fieldset の中／入口の無い矢印ウィジェット
    const ids = ['lab-none', 'role-only', 'btn-disabled', 'lab-hidden', 'lab-dnone', 'lab-vhidden',
                 'ti-empty', 'ti-space', 'orphan-summary', 'sum-second', 'btn-in-fs',
                 'broken-item', 'orphan-item'];
    const counts = await tab.evaluate(`${JSON.stringify(ids)}
      .map(id => document.getElementById(id).querySelectorAll('.iiyaku-icon').length)`);
    assert.deepEqual(counts, ids.map(() => 0), `印が付いた場所: ${ids.filter((_, i) => counts[i] > 0)}`);
  });

  await t.test('到達できる入口には印を付ける（境界5件）', async () => {
    // label→入力欄／label が包む入力欄／無効な fieldset でも最初の legend の中は例外／
    // details の最初の summary／矢印ウィジェットの Tab 入口
    const map = await tab.evaluate(`(() => {
      const pairs = { 'lab-for': 'inp-for', 'lab-wrap': 'inp-wrap', 'btn-legend': 'btn-legend',
                      'sum-first': 'sum-first', 'tree-entry': 'tree-entry' };
      const out = {};
      for (const [host, expected] of Object.entries(pairs)) {
        const ic = document.getElementById(host).querySelector('.iiyaku-icon');
        const t = ic && document.querySelector('[data-iiyaku-trigger="' + ic.dataset.iiyakuFor + '"]');
        out[host] = ic ? (t ? t.id : '入口なし') : '印なし';
      }
      return out;
    })()`);
    assert.deepEqual(map, { 'lab-for': 'inp-for', 'lab-wrap': 'inp-wrap', 'btn-legend': 'btn-legend',
                            'sum-first': 'sum-first', 'tree-entry': 'tree-entry' });
  });

  await t.test('そこで付けなかった語は、後のふつうの文章で説明される', async () => {
    assert.deepEqual(
      await tab.evaluate(`[...document.querySelectorAll('#prose-fallback .iiyaku-icon')]
        .map(i => i.dataset.iiyakuKey).sort()`),
      ['blame', 'collaborator', 'conflict', 'contributors', 'diff', 'forks', 'insights',
       'origin', 'packages', 'sync', 'visibility', 'watch', 'watching']
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

  await t.test('装飾扱いの印の入口が、実際の Tab 順路に出てくる（実キー送信）', async () => {
    const order = await collectTabOrder(cdp, tab, 70);
    const reachable = new Set(order);
    // 矢印キーで到達する項目は Tab 順路に出ない。実際に矢印で動かして確かめる。
    const arrow = await tab.evaluate(`(() => { document.getElementById('tree-entry').focus();
      return document.activeElement.id; })()`);
    assert.equal(arrow, 'tree-entry');
    await pressKey(cdp, tab.sessionId, 'ArrowDown');
    await sleep(150);
    const afterArrow = await tab.evaluate(`document.activeElement.id`);
    assert.equal(afterArrow, 'tree-target', '矢印キーで対象へ移動しない');
    reachable.add(afterArrow);

    const hosted = await tab.evaluate(`[...document.querySelectorAll('.iiyaku-icon[aria-hidden="true"]')]
      .map(ic => {
        const t = document.querySelector('[data-iiyaku-trigger="' + ic.dataset.iiyakuFor + '"]');
        return { key: ic.dataset.iiyakuKey, trigger: t ? (t.id || t.tagName) : null };
      })`);
    const unreachable = hosted.filter(h => !h.trigger || !reachable.has(h.trigger));
    assert.deepEqual(unreachable, [], `Tab でも矢印でも辿り着けない入口: ${JSON.stringify(unreachable)}`);
    assert.ok(hosted.length >= 5, `装飾扱いの印が少なすぎる: ${hosted.length}`);
  });

  await t.test('到達できない要素が Tab 順路に現れない（対照）', async () => {
    // 前のテストの矢印操作で tabindex が入れ替わっているので、初期状態へ戻す
    await tab.evaluate(`(() => { document.getElementById('tree-entry').tabIndex = 0;
      document.getElementById('tree-target').tabIndex = -1;
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); })(); true`);
    // 上の判定が機能していることの裏取り。ここに出てきたら fixture 側が壊れている。
    const order = new Set(await collectTabOrder(cdp, tab, 70));
    const mustNotAppear = ['inp-hidden', 'inp-dnone', 'inp-vhidden', 'btn-in-fs',
                           'ti-empty', 'ti-space', 'orphan-summary', 'sum-second',
                           'broken-item', 'orphan-item', 'role-only'];
    assert.deepEqual(mustNotAppear.filter(id => order.has(id)), []);
    // 逆に、到達できるはずのものは出てくる（対照）
    for (const id of ['inp-for', 'btn-legend', 'sum-first', 'tree-entry']) {
      assert.ok(order.has(id), `${id} が Tab 順路に出てこない＝測れていない`);
    }
  });

  await t.test('矢印で移動した先でも説明が出る', async () => {
    // 前のテストの矢印操作で tabindex が入れ替わっているので、初期状態へ戻す
    await tab.evaluate(`(() => { document.getElementById('tree-entry').tabIndex = 0;
      document.getElementById('tree-target').tabIndex = -1;
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); })(); true`);
    await tab.evaluate(`document.getElementById('tree-entry').focus(); true`);
    await pressKey(cdp, tab.sessionId, 'ArrowDown');
    await sleep(200);
    const r = await tab.evaluate(`(() => {
      const tip = document.querySelector('.iiyaku-tooltip');
      return { active: document.activeElement.id, tip: tip ? tip.textContent.slice(0, 12) : null };
    })()`);
    assert.equal(r.active, 'tree-target');
    assert.ok(r.tip && r.tip.length > 5, `移動先で説明が出ない: ${JSON.stringify(r)}`);
    await tab.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  });

  await t.test('画面の外にある印へキーボードで移っても説明が出る', async () => {
    // フォーカス移動に伴う自動スクロールで吹き出しが消えていた（v1.8.1 の不具合）
    const r = await tab.evaluate(`(() => {
      window.scrollTo(0, 0);
      const i = document.querySelector('#edge .iiyaku-icon') || document.querySelector('#prose .iiyaku-icon');
      const before = window.scrollY;
      document.querySelector('#code').scrollIntoView();
      i.focus();
      return { scrolled: window.scrollY !== before, tip: !!document.querySelector('.iiyaku-tooltip'),
               active: document.activeElement === i };
    })()`);
    assert.equal(r.active, true, '印にフォーカスが当たっていない');
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
