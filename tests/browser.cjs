const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const startFixtureServer = require('./fixture-server.cjs');
const root = path.resolve(__dirname, '..');
const fixture = fs.readFileSync(path.join(__dirname, 'fixture.html'), 'utf8');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(probe, label, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await probe();
    if (value) return value;
    await delay(100);
  }
  throw new Error('Timed out: ' + label);
}
(async () => {
  const model = {account: 'tester', words: [], saves: [], fail: null, uncertain: null, saveDelay: 0};
  const server = await startFixtureServer(model, fixture);
  let context;
  const errors = [];
  try {
    context = await chromium.launchPersistentContext('', {
      ...(process.env.XMB_BROWSER ? {executablePath: process.env.XMB_BROWSER} : {channel: 'chromium'}),
      headless: process.env.XMB_HEADED !== '1',
      // DNS routing also covers the first navigation of chrome.tabs.create(),
      // before Playwright can attach to the new tab. No X traffic leaves this machine.
      args: ['--disable-extensions-except=' + root, '--load-extension=' + root, '--no-first-run',
        '--no-proxy-server', '--ignore-certificate-errors',
        '--host-resolver-rules=MAP x.com 127.0.0.1:' + server.port + ', MAP * ~NOTFOUND'],
      viewport: {width: 1280, height: 900},
    });
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', {timeout: 10000});
    const page = await context.newPage();
    await page.goto('https://x.com/home');
    await page.locator('[data-testid=tweetText]').first().waitFor();
    const store = () => worker.evaluate(async () => (await chrome.storage.local.get('xMuteBag')).xMuteBag);
    // Keep one real 30-second retry below; fast-forward later cooldowns while exercising Chrome's alarm event.
    const advanceRetry = () => worker.evaluate(() => exclusively(async () => {
      const state = await readStore();
      if (state.job?.status !== 'retrying') throw new Error('Expected an automatic retry');
      state.job.retryAt = Date.now();
      await persist(state);
      await chrome.alarms.create('xmb-batch', {when: Date.now() + 50});
    }));
    const tabId = await worker.evaluate(async () => (await chrome.tabs.query({url: 'https://x.com/home'}))[0].id);
    // Exercise the same callback Chrome invokes for an actual toolbar click.
    const toggle = async () => {
      await worker.evaluate(id => activateTab({id, url: 'https://x.com/home'}), tabId);
      await page.locator('#x-mute-bag').waitFor({state: 'visible'});
    };
    await toggle();
    const panel = page.locator('#x-mute-bag');
    await panel.getByRole('button', {name: /Picking words/}).waitFor();
    async function reveal(id) {
      if (!['more-options', 'batch-details'].includes(id)) await reveal('more-options');
      if (id === 'account-settings') await reveal('filter-settings');
      const details = panel.locator('#' + id);
      if (!await details.evaluate(element => element.open)) await details.locator(':scope > summary').click();
    }
    assert.equal(await panel.locator('#more-options').evaluate(element => element.open), false);
    assert.equal(await panel.locator('#import-text').isVisible(), false);
    assert.equal(await panel.locator('#filter-enabled').isVisible(), false);
    assert.equal(await panel.locator('#reply-handle').isVisible(), false);
    fs.mkdirSync(path.join(root, 'artifacts'), {recursive: true});
    await page.screenshot({path: path.join(root, 'artifacts', 'browser-empty.png')});
    async function pick(word, occurrence = 0, shift = false) {
      const point = await page.evaluate(({word, occurrence}) => {
        const walker = document.createTreeWalker(document.querySelector('main'), NodeFilter.SHOW_TEXT);
        let node, found = 0;
        while ((node = walker.nextNode())) {
          if (!node.parentElement.closest('[data-testid=tweetText]')) continue;
          const index = node.data.indexOf(word);
          if (index < 0 || found++ !== occurrence) continue;
          const range = document.createRange(); range.setStart(node, index); range.setEnd(node, index + word.length);
          const rect = range.getBoundingClientRect();
          return {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2};
        }
        throw new Error('Word not found: ' + word);
      }, {word, occurrence});
      if (shift) await page.keyboard.down('Shift');
      try {
        await page.mouse.move(point.x, point.y);
        await page.mouse.click(point.x, point.y);
      } finally { if (shift) await page.keyboard.up('Shift'); }
    }
    async function add(text) {
      await panel.getByRole('textbox', {name: 'Add a word or phrase', exact: true}).fill(text);
      await panel.getByRole('button', {name: 'Add entry', exact: true}).click();
      await until(async () => (await store()).accounts.tester.bag.some(i => i.text === text), 'bag add ' + text);
    }
    async function apply(count) {
      const previous = (await store()).job?.id;
      assert.equal((await store()).accounts.tester.bag.length, count);
      await reveal('mute-options');
      await panel.getByRole('button', {name: 'Mute bag on X', exact: true}).click();
      await until(async () => {
        const job = (await store()).job;
        return job && job.id !== previous;
      }, 'new batch started');
    }
    await pick('Café');
    await until(async () => (await store()).accounts.tester.bag.length === 1, 'word picked');
    await pick('Café');
    await pick('#Topic');
    await until(async () => (await store()).accounts.tester.bag.length === 2, 'hashtag picked');
    assert.equal(await page.evaluate(() => window.tweetClicks || 0), 0);
    assert.equal(page.url(), 'https://x.com/home');
    // An inline word split across elements is still one range.
    await pick('multi');
    await until(async () => (await store()).accounts.tester.bag.some(i => i.text === 'multipart'), 'split word picked');
    await panel.getByRole('textbox', {name: 'Edit multipart', exact: true}).fill('long phrase');
    await panel.getByRole('textbox', {name: 'Edit multipart', exact: true}).press('Enter');
    await until(async () => (await store()).accounts.tester.bag.some(i => i.text === 'long phrase'), 'entry edited');
    await panel.getByRole('button', {name: 'Remove long phrase', exact: true}).click();
    await panel.getByRole('button', {name: 'Collapse bag'}).click();
    await panel.getByRole('button', {name: 'Expand bag'}).click();
    await page.keyboard.press('Escape');
    await panel.getByRole('button', {name: 'Start picking words'}).waitFor();
    await pick('dogs');
    assert.equal(await page.evaluate(() => window.tweetClicks), 1);
    await page.reload();
    await page.locator('[data-testid=tweetText]').first().waitFor();
    await toggle();
    await panel.getByRole('textbox', {name: 'Edit Café', exact: true}).waitFor();
    await panel.getByRole('button', {name: 'Clear bag'}).click();
    await page.evaluate(() => {
      const article = document.createElement('article'); article.dataset.testid = 'tweet';
      article.innerHTML = '<div data-testid="tweetText" lang="pt">Novíssima palavra.</div>';
      document.querySelector('#spacer').before(article);
    });
    await delay(150);
    await pick('Novíssima');
    await until(async () => (await store()).accounts.tester.bag.length === 1, 'dynamically loaded tweet');
    await panel.getByRole('button', {name: 'Clear bag'}).click();
    console.log('PASS: picker, duplicate clicks, links, inline ranges, editing, Escape, reload and new tweets');

    await page.evaluate(() => {
      const article = document.createElement('article'); article.dataset.testid = 'tweet';
      article.innerHTML = '<div data-testid="tweetText" lang="en">John <span>Paul</span>\n<a href="/Smith">Smith</a> Junior.</div>';
      document.querySelector('#spacer').before(article);
    });
    await delay(150);
    await pick('John'); await pick('Smith', 0, true);
    await until(async () => {
      const bag = (await store()).accounts.tester.bag;
      return bag.length === 1 && bag[0].text === 'John Paul Smith';
    }, 'Shift-click full name');
    await until(async () => page.evaluate(() => [...(CSS.highlights.get('xmb-picked') || [])].some(r => r.toString().replace(/\s+/g, ' ').trim() === 'John Paul Smith')), 'phrase highlight');
    assert.equal(page.url(), 'https://x.com/home');
    await pick('Junior', 0, true);
    await until(async () => (await store()).accounts.tester.bag[0]?.text === 'John Paul Smith Junior', 'extend phrase');
    await panel.getByRole('button', {name: 'Clear bag'}).click();
    await pick('Smith'); await pick('John', 0, true);
    await until(async () => (await store()).accounts.tester.bag[0]?.text === 'John Paul Smith', 'backwards phrase');
    await apply(1);
    await until(async () => (await store()).job?.status === 'complete', 'save picked phrase', 30000);
    assert.equal(model.saves.length, 1);
    assert.equal(model.saves[0].text, 'John Paul Smith');
    model.saves = [];
    console.log('PASS: Shift-click names, phrase highlighting, extending, reverse selection and a single saved phrase');

    model.words = [{text: 'existing'}];
    for (const word of ['existing', 'new one', 'new two']) await add(word);
    await reveal('mute-options');
    await panel.getByLabel('Home timeline', {exact: true}).uncheck();
    await until(async () => (await store()).accounts.tester.options.home === false, 'Home option saved');
    await panel.getByLabel('Notification audience', {exact: true}).selectOption('unfollowed');
    await until(async () => (await store()).accounts.tester.options.audience === 'unfollowed', 'audience option saved');
    await panel.getByLabel('Mute duration', {exact: true}).selectOption('7d');
    await until(async () => (await store()).accounts.tester.options.duration === '7d', 'duration option saved');
    await page.evaluate(() => scrollTo(0, 100));
    const beforeScroll = await page.evaluate(() => scrollY);
    await apply(3);
    await until(async () => (await store()).job?.status === 'complete', 'three-entry batch', 30000);
    const completed = await store();
    assert.deepEqual(completed.job.items.map(i => i.status), ['skipped', 'added', 'added']);
    assert.equal(completed.accounts.tester.bag.length, 0);
    assert.equal(model.saves.length, 2);
    for (const save of model.saves) assert.deepEqual({home: save.home, notifications: save.notifications, audience: save.audience, duration: save.duration}, {home: false, notifications: true, audience: 1, duration: 2});
    assert.equal(page.url(), 'https://x.com/home');
    assert.equal(await page.evaluate(() => scrollY), beforeScroll);
    await until(async () => worker.evaluate(id => chrome.tabs.get(id).then(() => false, () => true), completed.job.tabId), 'owned tab closed');
    console.log('PASS: sequential Apply, duplicate skip, settings, confirmed results, owned-tab closure and original scroll');
    await panel.locator('#more-options > summary').click();

    model.fail = 'fail word';
    await add('first success'); await add('fail word'); await add('last pending');
    await apply(3);
    await until(async () => (await store()).job?.status === 'retrying', 'partial failure schedules a retry', 30000);
    assert.deepEqual((await store()).accounts.tester.bag.map(i => i.text), ['fail word', 'last pending']);
    await until(async () => (await panel.locator('#status-text').textContent()).includes('Retrying automatically'), 'automatic retry status');
    assert.equal(await panel.locator('#status-error').isVisible(), false, 'error detail stays collapsed');
    assert.equal(await panel.getByRole('button', {name: 'Mute bag on X', exact: true}).isDisabled(), true);
    assert.equal(await worker.evaluate(async () => !!await chrome.alarms.get('xmb-batch')), true);
    await panel.getByRole('button', {name: 'Close bag', exact: true}).click();
    model.fail = null;
    await until(async () => (await store()).job.status === 'complete', 'automatically retry remaining words with the panel closed', 65000);
    await toggle();
    assert.equal(model.saves.filter(s => s.text === 'first success').length, 1);
    assert.equal(model.saves.filter(s => s.text === 'fail word').length, 2);
    console.log('PASS: automatic alarm retry with the panel closed, pending entries retained, and confirmed saves never repeated');

    model.uncertain = 'uncertain';
    await add('uncertain');
    await apply(1);
    await until(async () => (await store()).job.status === 'retrying', 'uncertain save schedules a retry', 30000);
    await advanceRetry();
    await until(async () => (await store()).job.status === 'complete', 'uncertain save recovery', 30000);
    assert.equal(model.saves.filter(s => s.text === 'uncertain').length, 1);
    model.uncertain = null;
    console.log('PASS: uncertain save is reconciled from the list without resubmission');

    model.fail = 'stop retry';
    await add('stop retry');
    await apply(1);
    await until(async () => (await store()).job.status === 'retrying', 'retry cooldown before Stop', 30000);
    await panel.getByRole('button', {name: 'Stop', exact: true}).click();
    await until(async () => (await store()).job.status === 'paused', 'Stop cancels retry');
    assert.equal(await worker.evaluate(async () => await chrome.alarms.get('xmb-batch')), undefined);
    model.fail = null;
    await worker.evaluate(() => chrome.alarms.create('xmb-batch', {when: Date.now() + 50}));
    await until(async () => !await worker.evaluate(() => chrome.alarms.get('xmb-batch')), 'late alarm ignored after Stop');
    assert.equal((await store()).job.status, 'paused');
    assert.equal(model.saves.filter(s => s.text === 'stop retry').length, 1);
    await panel.getByRole('button', {name: 'Resume / retry', exact: true}).click();
    await until(async () => (await store()).job.status === 'complete', 'explicit resume after Stop', 30000);
    console.log('PASS: Stop cancels scheduled retries; late alarms cannot restart a stopped batch');

    model.saveDelay = 1200;
    await add('stop first'); await add('stop second');
    await apply(2);
    await until(() => model.saves.some(s => s.text === 'stop first'), 'in-flight save');
    await panel.getByRole('button', {name: 'Stop', exact: true}).click();
    await delay(1600);
    assert.equal((await store()).job.status, 'paused');
    assert.equal(model.saves.some(s => s.text === 'stop second'), false);
    const pausedTab = (await store()).job.tabId;
    await worker.evaluate(id => chrome.tabs.remove(id), pausedTab);
    model.saveDelay = 0;
    await panel.getByRole('button', {name: 'Resume / retry', exact: true}).click();
    await until(async () => (await store()).job.status === 'complete', 'resume closed tab', 30000);
    assert.equal(model.saves.filter(s => s.text === 'stop first').length, 1);
    console.log('PASS: Stop prevents the next save; Resume recreates a closed settings tab');

    // Mutating only the fixture’s account identity must never submit for another account.
    model.account = 'different';
    await add('account guard');
    await apply(1);
    await until(async () => (await store()).job.status === 'retrying', 'account mismatch waits without saving', 30000);
    assert.equal(model.saves.some(s => s.text === 'account guard'), false);
    await advanceRetry();
    await until(async () => (await store()).job.status === 'retrying' && (await store()).job.retryCount === 2, 'wrong account remains blocked on retry', 30000);
    assert.equal(model.saves.some(s => s.text === 'account guard'), false);
    model.account = 'tester';
    await advanceRetry();
    await until(async () => (await store()).job.status === 'complete', 'automatic recovery after switching back to the correct account', 30000);
    assert.equal(model.saves.filter(s => s.text === 'account guard').length, 1);
    console.log('PASS: retries never save for the wrong account and continue automatically after switching back');
    model.words = [{text: 'Silenced Person'}, {text: 'spoiler'}];
    await reveal('filter-settings');
    await panel.getByRole('button', {name: 'Sync muted words', exact: true}).click();
    await until(async () => (await store()).accounts.tester.filter.terms.some(i => i.text === 'Silenced Person'), 'native mute import');
    await page.evaluate(() => {
      const quote = document.createElement('div'); quote.dataset.testid = 'cellInnerDiv'; quote.id = 'quote-filter-test';
      quote.innerHTML = '<article data-testid="tweet"><div data-testid="tweetText">Neutral comment</div><div role="link"><div data-testid="tweetText">Silenced <span>Person</span> is quoted</div></div></article>';
      const safe = document.createElement('article'); safe.dataset.testid = 'tweet'; safe.id = 'safe-filter-test';
      safe.innerHTML = '<div data-testid="tweetText">Silenced Personson and spoilerish</div>';
      document.querySelector('main').append(quote, safe);
    });
    await until(async () => await page.locator('#quote-filter-test').getAttribute('data-xmb-filtered') === 'true', 'hide outer quoted post');
    assert.equal(await page.locator('#quote-filter-test').isVisible(), false);
    assert.equal(await page.locator('#safe-filter-test').getAttribute('data-xmb-filtered'), null);
    await panel.getByLabel('Hide muted posts, including quotes', {exact: true}).uncheck();
    await until(async () => await page.locator('#quote-filter-test').isVisible(), 'pause restores quote');
    await panel.getByLabel('Hide muted posts, including quotes', {exact: true}).check();
    await until(async () => !await page.locator('#quote-filter-test').isVisible(), 'reenable filter');
    await page.evaluate(() => document.querySelector('#quote-filter-test [role=link] [data-testid=tweetText]').textContent = 'A completely different quote');
    await until(async () => await page.locator('#quote-filter-test').isVisible(), 'recycled cell restored');
    await page.evaluate(() => document.querySelector('#quote-filter-test [role=link] [data-testid=tweetText]').textContent = 'Silenced Person');
    await until(async () => !await page.locator('#quote-filter-test').isVisible(), 'updated quote hidden');
    model.words = [{text: 'spoiler'}];
    await panel.getByRole('button', {name: 'Sync muted words', exact: true}).click();
    await until(async () => await page.locator('#quote-filter-test').isVisible(), 'native unmute restores quote');
    await page.reload();
    await page.locator('[data-testid=tweetText]').first().waitFor();
    await page.evaluate(() => {
      const article = document.createElement('article'); article.dataset.testid = 'tweet'; article.id = 'persist-filter-test';
      article.innerHTML = '<div data-testid="tweetText">A spoiler after refresh</div>';
      document.querySelector('main').append(article);
    });
    await until(async () => await page.locator('#persist-filter-test').getAttribute('data-xmb-filtered') === 'true', 'filter active without opening panel');
    console.log('PASS: native mute import, whole quoted-post hiding, boundaries, pause, recycled cells, unmute and persistence');
    await toggle();
    await reveal('account-settings');
    const addReplyPosts = () => page.evaluate(() => {
      const cell = (id, author, content) => {
        const element = document.createElement('div'); element.dataset.testid = 'cellInnerDiv'; element.id = id;
        element.innerHTML = '<article data-testid="tweet"><div data-testid="User-Name"><a href="/' + author + '">@' + author + '</a></div>' + content + '</article>';
        document.querySelector('main').append(element);
      };
      cell('account-original', 'Alice', '<div data-testid="tweetText">An original post</div>');
      cell('account-reply', 'Alice', '<div dir="ltr">Replying to <span>@bob</span></div><div data-testid="tweetText">A reply to another account</div>');
      cell('account-self', 'Alice', '<div dir="ltr">Replying to <span>@Alice</span></div><div data-testid="tweetText">My thread continues</div>');
    });
    await addReplyPosts();
    await panel.getByLabel('Hide replies from account', {exact: true}).fill('@Alice');
    await panel.locator('#reply-add').click();
    await until(async () => !await page.locator('#account-reply').isVisible(), 'account reply hidden');
    assert.equal(await page.locator('#account-original').isVisible(), true);
    assert.equal(await page.locator('#account-self').isVisible(), true);
    await panel.getByLabel('Hide replies from @alice', {exact: true}).uncheck();
    await until(async () => await page.locator('#account-reply').isVisible(), 'paused account rule');
    await panel.getByLabel('Hide replies from @alice', {exact: true}).check();
    await page.reload();
    await page.locator('[data-testid=tweetText]').first().waitFor();
    await addReplyPosts();
    await until(async () => !await page.locator('#account-reply').isVisible(), 'account rule persists without panel');
    await toggle();
    await reveal('account-settings');
    await panel.getByRole('button', {name: 'Remove reply rule for @alice', exact: true}).click();
    await until(async () => await page.locator('#account-reply').isVisible(), 'removed account rule');
    console.log('PASS: local account reply rules, originals, self-threads, pause, reload and removal');
    if ((await store()).accounts.tester.bag.length) await panel.getByRole('button', {name: 'Clear bag', exact: true}).click();
    await add('Café');
    await reveal('import-tools');
    const importText = panel.getByRole('textbox', {name: 'Words to import', exact: true});
    const importButton = panel.getByRole('button', {name: 'Add lines to bag', exact: true});
    const transferStatus = panel.locator('#transfer-status');
    const savesBeforeImport = model.saves.length;
    await importText.fill('CAFE\u0301\n\nJohn  Smith\r\n#topic\njohn smith');
    await importButton.click();
    await until(async () => (await transferStatus.textContent()).includes('2 added to bag · 2 duplicates skipped'), 'paste import counts');
    assert.deepEqual((await store()).accounts.tester.bag.map(item => item.text), ['Café', 'John Smith', '#topic']);
    assert.equal(await importText.inputValue(), '');
    assert.equal(await importButton.isDisabled(), true);
    const invalid = 'valid first line\n\n' + 'x'.repeat(281);
    await importText.fill(invalid);
    await importButton.click();
    await until(async () => (await transferStatus.textContent()).includes('Line 3:'), 'invalid line number');
    assert.equal(await importText.inputValue(), invalid, 'keep invalid text available for correction');
    assert.equal((await store()).accounts.tester.bag.length, 3, 'invalid import is atomic');
    const file = {name: 'words.txt', mimeType: 'text/plain', buffer: Buffer.from('\uFEFFCafé\r\n中文\r\n@someone\r\n#topic\r\n')};
    // Exercise the visible file-picker button, then the real File API in the content script.
    const chooser = page.waitForEvent('filechooser');
    await panel.getByRole('button', {name: 'Load .txt file', exact: true}).click();
    await (await chooser).setFiles(file);
    await until(async () => (await transferStatus.textContent()).includes('words.txt loaded'), 'file preview');
    assert.equal((await store()).accounts.tester.bag.length, 3, 'loading a file only previews it');
    assert.ok((await importText.inputValue()).includes('中文'));
    await importButton.click();
    await until(async () => (await transferStatus.textContent()).includes('2 added to bag · 2 duplicates skipped'), 'file import counts');
    await panel.locator('#import-file').setInputFiles(file);
    await until(async () => (await transferStatus.textContent()).includes('words.txt loaded'), 'same file can be selected again');
    await importButton.click();
    await until(async () => (await transferStatus.textContent()).includes('0 added to bag · 4 duplicates skipped'), 'repeat import is idempotent');
    await panel.locator('#import-file').setInputFiles({name: 'invalid.txt', mimeType: 'text/plain', buffer: Buffer.from([0xff, 0xfe, 0x61, 0x00])});
    await until(async () => (await transferStatus.textContent()).includes('Choose a UTF-8 text file'), 'invalid file encoding');
    await panel.locator('#import-file').setInputFiles({name: 'large.txt', mimeType: 'text/plain', buffer: Buffer.alloc(1024 * 1024 + 1, 'a')});
    await until(async () => (await transferStatus.textContent()).includes('1 MB'), 'oversized file rejected');
    await reveal('export-tools');
    const exportStatus = panel.locator('#export-status');
    await panel.getByLabel('Export source', {exact: true}).selectOption('bag');
    const downloading = page.waitForEvent('download');
    await panel.getByRole('button', {name: 'Download .txt', exact: true}).click();
    const download = await downloading;
    assert.equal(download.suggestedFilename(), 'x-mute-bag-tester-bag.txt');
    const exported = fs.readFileSync(await download.path(), 'utf8');
    assert.equal(exported, 'Café\nJohn Smith\n#topic\n中文\n@someone\n');
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {origin: 'https://x.com'});
    await page.bringToFront();
    await panel.getByRole('button', {name: 'Copy text', exact: true}).click();
    await until(async () => (await exportStatus.textContent()) === '5 entries copied.', 'clipboard export');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), exported);
    await panel.getByLabel('Export source', {exact: true}).selectOption('all');
    await panel.getByRole('button', {name: 'Copy text', exact: true}).click();
    const saved = (await store()).accounts.tester.localWords.map(word => word.text);
    const expectedAll = [...new Set(['spoiler', ...saved, ...exported.trim().split('\n')])].join('\n') + '\n';
    await until(async () => (await exportStatus.textContent()) === expectedAll.trim().split('\n').length + ' entries copied.', 'all words export');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), expectedAll);
    await panel.getByRole('button', {name: 'Clear bag', exact: true}).click();
    await panel.locator('#import-file').setInputFiles({name: download.suggestedFilename(), mimeType: 'text/plain', buffer: Buffer.from(exported)});
    await until(async () => (await transferStatus.textContent()).includes('loaded.'), 'load exported text');
    await importButton.click();
    await until(async () => (await transferStatus.textContent()).includes('5 added to bag · 0 duplicates skipped'), 'download reimport');
    assert.equal(model.saves.length, savesBeforeImport, 'import does not submit to X');
    await page.reload();
    await page.locator('[data-testid=tweetText]').first().waitFor();
    await toggle();
    await panel.getByRole('textbox', {name: 'Edit John Smith', exact: true}).waitFor();
    assert.deepEqual((await store()).accounts.tester.bag.map(item => item.text), exported.trim().split('\n'));
    console.log('PASS: paste and file imports, validation, duplicates, clipboard, downloads, export scopes, round trip and persistence');
    assert.equal(await panel.locator('#more-options').evaluate(element => element.open), false);
    fs.mkdirSync(path.join(root, 'artifacts'), {recursive: true});
    await page.screenshot({path: path.join(root, 'artifacts', 'browser-fixture.png')});
    await reveal('more-options');
    assert.equal(await panel.locator('#import-text').isVisible(), false, 'opening More options only reveals section headings');
    await page.screenshot({path: path.join(root, 'artifacts', 'browser-options.png')});
    console.log('PASS: compact default panel and progressive disclosure of imports, exports, settings and filters');
    assert.deepEqual(errors, []);
    console.log('All browser checks passed with the actual unpacked extension.');
  } catch (error) {
    const worker = context?.serviceWorkers()[0];
    console.error('Browser failure state:', JSON.stringify({
      state: worker && await worker.evaluate(async () => (await chrome.storage.local.get('xMuteBag')).xMuteBag).catch(() => null),
      tabs: worker && await worker.evaluate(() => chrome.tabs.query({})).catch(() => []),
      pages: await Promise.all((context?.pages() || []).map(async page => ({url: page.url(), text: await page.locator('body').innerText().catch(() => ''),
        panel: await page.evaluate(() => { const host = document.querySelector('#x-mute-bag'); return host ? {hidden: host.hidden, text: host.shadowRoot?.querySelector('.panel')?.textContent} : null; }).catch(() => null)}))),
      errors,
    }));
    throw error;
  } finally { await context?.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
