const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
  const context = await chromium.launchPersistentContext('', {
    ...(process.env.XMB_BROWSER ? {executablePath: process.env.XMB_BROWSER} : {channel: 'chromium'}),
    headless: process.env.XMB_HEADED !== '1',
    args: ['--disable-extensions-except=' + root, '--load-extension=' + root, '--no-first-run'],
    viewport: {width: 1280, height: 900},
  });
  const model = {account: 'tester', words: [], saves: [], fail: null, uncertain: null, saveDelay: 0};
  const errors = [];
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  await context.route('https://x.com/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/__fixture/state') return route.fulfill({json: {account: model.account, words: model.words}});
    if (url.pathname === '/__fixture/save') {
      const value = route.request().postDataJSON();
      model.saves.push(value);
      if (model.saveDelay) await delay(model.saveDelay);
      if (model.fail === value.text) return route.fulfill({json: {error: 'Try again later: fixture failure'}});
      if (model.words.some(word => word.text.toLowerCase() === value.text.toLowerCase())) return route.fulfill({json: {error: 'This word is already muted'}});
      model.words.push(value);
      if (model.uncertain === value.text) return route.fulfill({json: {error: 'Try again: saved but response lost'}});
      return route.fulfill({json: {ok: true}});
    }
    return route.fulfill({contentType: 'text/html', body: fixture});
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', {timeout: 10000});
    const page = await context.newPage();
    await page.goto('https://x.com/home');
    await page.locator('[data-testid=tweetText]').first().waitFor();
    const store = () => worker.evaluate(async () => (await chrome.storage.local.get('xMuteBag')).xMuteBag);
    const tabId = await worker.evaluate(async () => (await chrome.tabs.query({url: 'https://x.com/home'}))[0].id);
    // Exercise the same callback Chrome invokes for an actual toolbar click.
    const toggle = () => worker.evaluate(id => activateTab({id, url: 'https://x.com/home'}), tabId);
    await toggle();
    const panel = page.locator('#x-mute-bag');
    await panel.getByRole('button', {name: /Picking words/}).waitFor();
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
    assert.equal(await page.evaluate(() => [...CSS.highlights.get('xmb-picked')].some(r => r.toString().replace(/\s+/g, ' ').trim() === 'John Paul Smith')), true);
    assert.equal(page.url(), 'https://x.com/home');
    await pick('Junior', 0, true);
    await until(async () => (await store()).accounts.tester.bag[0].text === 'John Paul Smith Junior', 'extend phrase');
    await panel.getByRole('button', {name: 'Clear bag'}).click();
    await pick('Smith'); await pick('John', 0, true);
    await until(async () => (await store()).accounts.tester.bag[0].text === 'John Paul Smith', 'backwards phrase');
    await panel.getByRole('button', {name: 'Apply 1 muted word', exact: true}).click();
    await until(async () => (await store()).job.status === 'complete', 'save picked phrase', 30000);
    assert.equal(model.saves.length, 1);
    assert.equal(model.saves[0].text, 'John Paul Smith');
    model.saves = [];
    console.log('PASS: Shift-click names, phrase highlighting, extending, reverse selection and a single saved phrase');

    model.words = [{text: 'existing'}];
    for (const word of ['existing', 'new one', 'new two']) await add(word);
    await panel.locator('#summary').click();
    await panel.getByLabel('Home timeline', {exact: true}).uncheck();
    await panel.getByLabel('Notification audience', {exact: true}).selectOption('unfollowed');
    await panel.getByLabel('Mute duration', {exact: true}).selectOption('7d');
    await page.evaluate(() => scrollTo(0, 100));
    const beforeScroll = await page.evaluate(() => scrollY);
    await panel.getByRole('button', {name: 'Apply 3 muted words', exact: true}).click();
    await until(async () => (await store()).job?.status === 'complete', 'three-entry batch', 30000);
    const completed = await store();
    assert.deepEqual(completed.job.items.map(i => i.status), ['skipped', 'added', 'added']);
    assert.equal(completed.accounts.tester.bag.length, 0);
    assert.equal(model.saves.length, 2);
    for (const save of model.saves) assert.deepEqual({home: save.home, notifications: save.notifications, audience: save.audience, duration: save.duration}, {home: false, notifications: true, audience: 1, duration: 2});
    assert.equal(page.url(), 'https://x.com/home');
    assert.equal(await page.evaluate(() => scrollY), beforeScroll);
    assert.equal(await worker.evaluate(id => chrome.tabs.get(id).then(() => true, () => false), completed.job.tabId), false);
    console.log('PASS: sequential Apply, duplicate skip, settings, confirmed results, owned-tab closure and original scroll');

    model.fail = 'fail word';
    await add('first success'); await add('fail word'); await add('last pending');
    await panel.getByRole('button', {name: 'Apply 3 muted words', exact: true}).click();
    await until(async () => (await store()).job?.status === 'paused', 'partial failure', 30000);
    assert.deepEqual((await store()).accounts.tester.bag.map(i => i.text), ['fail word', 'last pending']);
    model.fail = null;
    await panel.getByRole('button', {name: 'Resume / retry', exact: true}).click();
    await until(async () => (await store()).job.status === 'complete', 'retry remaining words', 30000);
    assert.equal(model.saves.filter(s => s.text === 'first success').length, 1);
    console.log('PASS: partial failure retains pending words and retry does not repeat confirmed saves');

    model.uncertain = 'uncertain';
    await add('uncertain');
    await panel.getByRole('button', {name: 'Apply 1 muted word', exact: true}).click();
    await until(async () => (await store()).job.status === 'paused', 'uncertain save', 30000);
    await panel.getByRole('button', {name: 'Resume / retry', exact: true}).click();
    await until(async () => (await store()).job.status === 'complete', 'uncertain save recovery', 30000);
    assert.equal(model.saves.filter(s => s.text === 'uncertain').length, 1);
    model.uncertain = null;
    console.log('PASS: uncertain save is reconciled from the list without resubmission');

    model.saveDelay = 1200;
    await add('stop first'); await add('stop second');
    await panel.getByRole('button', {name: 'Apply 2 muted words', exact: true}).click();
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
    await panel.getByRole('button', {name: 'Apply 1 muted word', exact: true}).click();
    await until(async () => (await store()).job.status === 'paused', 'account mismatch', 30000);
    assert.equal(model.saves.some(s => s.text === 'account guard'), false);
    model.account = 'tester';
    await panel.getByRole('button', {name: 'End batch', exact: true}).click();
    console.log('PASS: account mismatch pauses before saving');
    model.words = [{text: 'Silenced Person'}, {text: 'spoiler'}];
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
    await panel.getByRole('textbox', {name: 'Hide replies from account', exact: true}).fill('@Alice');
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
    await panel.getByRole('button', {name: 'Remove reply rule for @alice', exact: true}).click();
    await until(async () => await page.locator('#account-reply').isVisible(), 'removed account rule');
    console.log('PASS: local account reply rules, originals, self-threads, pause, reload and removal');
    fs.mkdirSync(path.join(root, 'artifacts'), {recursive: true});
    await page.screenshot({path: path.join(root, 'artifacts', 'browser-fixture.png')});
    assert.deepEqual(errors, []);
    console.log('All browser checks passed with the actual unpacked extension.');
  } finally { await context.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
