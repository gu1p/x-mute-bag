const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const startFixtureServer = require('./fixture-server.cjs');
const root = path.resolve(__dirname, '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(probe, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await probe()) return; await delay(50); }
  throw Error('Timed out: ' + label);
}
(async () => {
  const model = {account: 'tester', words: Array.from({length: 200}, (_, i) => ({text: 'native word ' + i})), saves: []};
  const server = await startFixtureServer(model, fs.readFileSync(path.join(__dirname, 'fixture.html'), 'utf8'));
  let context;
  try {
    context = await chromium.launchPersistentContext('', {
      ...(process.env.XMB_BROWSER ? {executablePath: process.env.XMB_BROWSER} : {channel: 'chromium'}),
      headless: true,
      args: ['--disable-extensions-except=' + root, '--load-extension=' + root, '--no-first-run', '--no-proxy-server', '--ignore-certificate-errors',
        '--host-resolver-rules=MAP x.com 127.0.0.1:' + server.port + ', MAP * ~NOTFOUND'],
      viewport: {width: 1280, height: 900},
    });
    const errors = [];
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    await page.goto('https://x.com/home');
    await page.locator('[data-testid=tweetText]').first().waitFor();
    const tabId = await worker.evaluate(async () => (await chrome.tabs.query({url: 'https://x.com/home'}))[0].id);
    const store = () => worker.evaluate(async () => (await chrome.storage.local.get('xMuteBag')).xMuteBag);
    const toggle = async () => {
      await worker.evaluate(id => activateTab({id, url: 'https://x.com/home'}), tabId);
      await page.locator('#x-mute-bag').waitFor({state: 'visible'});
    };
    const panel = page.locator('#x-mute-bag');
    const reveal = async id => {
      if (id !== 'more-options') await reveal('more-options');
      const details = panel.locator('#' + id);
      if (!await details.evaluate(node => node.open)) await details.locator(':scope > summary').click();
    };
    const scene = () => page.evaluate(() => {
      // Structure observed through Chrome MCP: a cell wraps an article, with
      // separate tweetText blocks for the comment and the quoted role=link card.
      const cell = (id, body, quote = '') => {
        const node = document.createElement('div'); node.id = id; node.dataset.testid = 'cellInnerDiv';
        node.innerHTML = '<div><div><article role="article" data-testid="tweet"><div data-testid="User-Name">local word 4999</div><div data-testid="tweetText" lang="en" dir="auto">' + body + '</div>' +
          (quote ? '<div role="link"><div data-testid="tweetText" lang="pt" dir="auto">' + quote + '</div></div>' : '') + '</article></div></div>';
        document.querySelector('main').append(node);
      };
      cell('direct', '<span>LOCAL WORD 4999</span>');
      cell('quoted', 'An unrelated comment', '<span>Café</span><br><span>do futuro</span>');
      cell('emoji', '<img alt="🚀"> launch');
      cell('safe', 'local word 49999 and cafe do futuro');
      cell('separate', 'Café', 'do futuro');
      cell('hidden-text', 'Safe text <span aria-hidden="true">local word 4999</span>');
      cell('draft', 'local word 4999'); document.getElementById('draft').setAttribute('contenteditable', 'true');
      cell('sidebar', 'local word 4999'); document.body.append(document.getElementById('sidebar'));
    });
    await until(async () => (await store())?.accounts.tester?.filter.terms.length === 200, 'existing native mute list');
    await scene(); await toggle(); await reveal('import-tools');
    const words = [...Array.from({length: 5000}, (_, i) => 'local word ' + i), 'Café do futuro', '🚀 launch'];
    await panel.locator('#import-file').setInputFiles({name: 'local-words.txt', mimeType: 'text/plain', buffer: Buffer.from(words.join('\n'))});
    await until(async () => (await panel.locator('#transfer-status').textContent()).includes('local-words.txt loaded'), 'large file preview');
    await panel.getByRole('button', {name: 'Add lines to bag', exact: true}).click();
    await until(async () => (await store()).accounts.tester.bag.length === words.length, 'large import');
    assert.equal(await page.locator('#direct').isVisible(), true, 'draft words remain reviewable before Apply');
    const start = Date.now();
    await panel.getByRole('button', {name: 'Filter 5002 words', exact: true}).click();
    await until(async () => (await store()).accounts.tester.localWords.length === words.length, 'local save beyond native limit');
    await until(async () => !await page.locator('#direct').isVisible() && !await page.locator('#quoted').isVisible() && !await page.locator('#emoji').isVisible(), 'whole posts and quotes hidden');
    console.log('PASS: 5,002 local words applied and matched in ' + (Date.now() - start) + ' ms with 200 native mutes already present');
    assert.equal((await store()).job, null);
    assert.deepEqual(model.saves, [], 'local filtering never submits native mutes');
    assert.equal((await store()).accounts.tester.bag.length, 0);
    for (const id of ['safe', 'separate', 'hidden-text', 'draft', 'sidebar']) assert.equal(await page.locator('#' + id).isVisible(), true, id);
    assert.equal(await page.locator('#direct').evaluate(node => node.isConnected && !!node.querySelector('article')), true);
    await page.locator('#direct [data-testid=tweetText]').evaluate(node => { node.textContent = 'A recycled cell with unrelated text'; });
    await until(() => page.locator('#direct').isVisible(), 'recycled cell restored');
    await page.locator('#direct [data-testid=tweetText]').evaluate(node => { node.textContent = 'local word 4998'; });
    await until(async () => !await page.locator('#direct').isVisible(), 'recycled cell rechecked');
    await page.evaluate(() => {
      const cell = document.getElementById('direct').cloneNode(true); cell.id = 'new-post'; cell.removeAttribute('data-xmb-filtered');
      document.querySelector('main').append(cell);
    });
    await until(async () => !await page.locator('#new-post').isVisible(), 'new posts filtered');
    await reveal('filter-settings');
    await panel.getByLabel('Hide muted posts, including quotes', {exact: true}).uncheck();
    await until(() => page.locator('#quoted').isVisible(), 'disabled filter restores posts');
    await panel.getByLabel('Hide muted posts, including quotes', {exact: true}).check();
    await until(async () => !await page.locator('#quoted').isVisible(), 'filter reenabled');
    model.words = [];
    await panel.getByRole('button', {name: 'Sync muted words', exact: true}).click();
    await until(async () => (await store()).accounts.tester.filter.terms.length === 0, 'native list cleared');
    assert.equal((await store()).accounts.tester.localWords.length, words.length);
    assert.equal(await page.locator('#quoted').isVisible(), false, 'native sync cannot erase local filters');
    await reveal('local-tools');
    await panel.getByLabel('Search saved filters', {exact: true}).fill('café do futuro');
    await panel.getByRole('button', {name: 'Remove local filter Café do futuro', exact: true}).click();
    await until(() => page.locator('#quoted').isVisible(), 'removing a saved filter restores posts');
    await reveal('export-tools');
    await panel.getByLabel('Export source', {exact: true}).selectOption('local');
    const downloading = page.waitForEvent('download');
    await panel.getByRole('button', {name: 'Download .txt', exact: true}).click();
    assert.equal(fs.readFileSync(await (await downloading).path(), 'utf8'), words.filter(word => word !== 'Café do futuro').join('\n') + '\n');
    await page.reload(); await page.locator('[data-testid=tweetText]').first().waitFor(); await scene();
    await until(async () => !await page.locator('#direct').isVisible(), 'saved filters active without opening the panel');
    assert.equal(await page.locator('#quoted').isVisible(), true, 'removal persists');
    // Reproduce a persisted stopped native batch. Opening the bag must still
    // allow typing, picking, paste/file import, and another local Apply.
    await worker.evaluate(() => exclusively(async () => {
      const state = await readStore();
      const data = accountState(state, 'tester');
      data.bag = [C.entry('native pending')];
      state.job = C.createJob('tester', data.bag, data.options, null);
      pause(state.job, 'Stopped. Resume when you are ready;');
      await persist(state);
    }));
    await page.reload(); await page.locator('[data-testid=tweetText]').first().waitFor();
    await toggle();
    await panel.getByRole('button', {name: /Picking words/}).waitFor();
    assert.equal(await panel.getByRole('textbox', {name: 'Add a word or phrase', exact: true}).isEnabled(), true);
    await panel.getByRole('textbox', {name: 'Add a word or phrase', exact: true}).fill('typed while stopped');
    await panel.getByRole('button', {name: 'Add entry', exact: true}).click();
    await until(async () => (await store()).accounts.tester.bag.length === 2, 'typing during a stopped batch');
    await page.evaluate(() => {
      const node = document.querySelector('[data-testid=tweetText]').firstChild;
      const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, 4);
      const rect = range.getBoundingClientRect();
      node.parentElement.dispatchEvent(new MouseEvent('click', {bubbles:true,cancelable:true,clientX:rect.x+rect.width/2,clientY:rect.y+rect.height/2,button:0}));
    });
    await until(async () => (await store()).accounts.tester.bag.some(word => word.text === 'Café'), 'picking during a stopped batch');
    await reveal('import-tools');
    await panel.getByRole('textbox', {name: 'Words to import', exact: true}).fill('pasted while stopped');
    await panel.getByRole('button', {name: 'Add lines to bag', exact: true}).click();
    await until(async () => (await store()).accounts.tester.bag.length === 4, 'pasting during a stopped batch');
    await panel.locator('#import-file').setInputFiles({name:'more.txt',mimeType:'text/plain',buffer:Buffer.from('file while stopped')});
    await until(async () => (await panel.locator('#transfer-status').textContent()).includes('more.txt loaded'), 'file during stopped batch');
    await panel.getByRole('button', {name: 'Add lines to bag', exact: true}).click();
    await until(async () => (await store()).accounts.tester.bag.length === 5, 'file import during a stopped batch');
    assert.equal((await store()).job.status, 'paused');
    await panel.getByRole('textbox', {name: 'Edit native pending', exact: true}).fill('edited while stopped');
    await panel.getByRole('textbox', {name: 'Edit native pending', exact: true}).press('Enter');
    await until(async () => (await store()).accounts.tester.bag[0].text === 'edited while stopped', 'draft editing during a stopped batch');
    assert.equal((await store()).job.items[0].text, 'native pending');
    await panel.getByRole('button', {name: 'Filter 5 words', exact: true}).click();
    await until(async () => (await store()).accounts.tester.bag.length === 0, 'filter more words despite old stopped batch');
    assert.equal((await store()).job.status, 'stopped');
    for (const text of ['edited while stopped', 'typed while stopped', 'Café', 'pasted while stopped', 'file while stopped']) {
      assert.equal((await store()).accounts.tester.localWords.some(word => word.text === text), true, text);
    }
    console.log('PASS: a persisted stopped native batch cannot lock typing, picking, editing, paste/file import, or local Apply');
    model.account = 'other';
    await page.reload(); await page.locator('[data-testid=tweetText]').first().waitFor(); await scene();
    await until(async () => (await store()).accounts.other != null, 'new account loaded');
    assert.equal(await page.locator('#direct').isVisible(), true, 'rules remain account scoped');
    assert.equal((await store()).accounts.other.localWords.length, 0);
    assert.deepEqual(errors, []);
    assert.deepEqual(model.saves, []);
    console.log('PASS: literal boundaries, Unicode/emoji, quotes, editable exclusions, dynamic/recycled cells, toggle, removal, sync independence, export, reload, and account isolation');
  } finally { await context?.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
