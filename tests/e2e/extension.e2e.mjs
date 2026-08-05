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
import { launchChrome, startTestServer, stageExtension, openPage, sleep, waitFor } from './helpers/chrome.mjs';

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

  await t.test('入口を作れない操作要素の中には印を付けない', async () => {
    // label（対応する入力欄なし）／role だけでフォーカスできない／disabled
    assert.deepEqual(
      await tab.evaluate(`['lab-none','role-only','btn-disabled']
        .map(id => document.getElementById(id).querySelectorAll('.iiyaku-icon').length)`),
      [0, 0, 0]
    );
  });

  await t.test('そこで付けなかった語は、後のふつうの文章で説明される', async () => {
    assert.deepEqual(
      await tab.evaluate(`[...document.querySelectorAll('#prose-fallback .iiyaku-icon')]
        .map(i => i.dataset.iiyakuKey).sort()`),
      ['blame', 'conflict', 'diff']
    );
  });

  await t.test('フォーカスできるだけの容器は入口にしない（印自体を入口にする）', async () => {
    // GitHub は本文を tabindex="0" の大きな領域で包んでいる。ここを入口にすると
    // 本文中の印が全部その1か所へ集まり、文章の中の印から個別に読めなくなる。
    const r = await tab.evaluate(`(() => {
      const icons = [...document.querySelectorAll('#scroll-region .iiyaku-icon')];
      return { n: icons.length,
               roles: icons.map(i => i.getAttribute('role')),
               grouped: icons.filter(i => i.dataset.iiyakuFor).length,
               containerIsTrigger: document.getElementById('scroll-region').hasAttribute('data-iiyaku-trigger') };
    })()`);
    assert.equal(r.n, 2, '容器の中の語に印が付いていない');
    assert.deepEqual(r.roles, ['button', 'button']);
    assert.equal(r.grouped, 0, '容器へぶら下がってしまっている');
    assert.equal(r.containerIsTrigger, false, '容器が入口にされている');
  });

  await t.test('フォーカスできない容器の中でも、印自体を入口にする', async () => {
    // tabindex が負の容器は Tab で止まれないが、中の印は止まれる
    assert.deepEqual(
      await tab.evaluate(`['ti-minus1','ti-minus2'].map(id => {
        const i = document.getElementById(id).querySelector('.iiyaku-icon');
        return i ? i.getAttribute('role') : null; })`),
      ['button', 'button']
    );
  });

  await t.test('矢印キーの入口が無い項目は、入口として扱わない', async () => {
    // role と tabindex があるだけでは到達できる証明にならない。この検証ページの
    // tree には Tab で入れる項目（tabindex=0）が無いので、注記を見送る。
    assert.equal(
      await tab.evaluate(`document.getElementById('tree-item').querySelectorAll('.iiyaku-icon').length`), 0);
  });

  await t.test('装飾扱いの印には、必ず到達できる入口がある（全件）', async () => {
    const orphans = await tab.evaluate(`
      [...document.querySelectorAll('.iiyaku-icon[aria-hidden="true"]')].filter(ic => {
        const id = ic.dataset.iiyakuFor;
        if (!id) return true;
        const t = document.querySelector('[data-iiyaku-trigger="' + id + '"]');
        if (!t) return true;
        if (t.disabled) return true;
        const roving = ['treeitem','option','tab','menuitem','menuitemcheckbox','menuitemradio','radio'];
        const ti = t.getAttribute('tabindex');
        if (ti !== null) {
          if (Number.isInteger(Number(ti)) && Number(ti) >= 0) return false;
          return !roving.includes(t.getAttribute('role'));   // 矢印キーで移動する項目は到達できる
        }
        return !t.matches('a[href], button, input, select, textarea, summary, [contenteditable]:not([contenteditable="false"])');
      }).length`);
    assert.equal(orphans, 0, '入口の無い装飾アイコンがある');
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
      const i = document.querySelector('#prose .iiyaku-icon');
      i.focus();
      const tip = document.querySelector('.iiyaku-tooltip');
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

  /* ---------- これまでの動作を壊していないこと ---------- */

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
