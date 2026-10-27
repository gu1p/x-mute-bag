const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const startFixtureServer = require('./fixture-server.cjs');
const root = path.resolve(__dirname, '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(probe, label) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await delay(50);
  }
  throw Error('Timed out: ' + label);
}
(async () => {
  const model = {account: 'tester', words: [], saves: [], saveTimes: [], documents: [], spa: true};
  const server = await startFixtureServer(model, fs.readFileSync(path.join(__dirname, 'fixture.html'), 'utf8'));
  let context;
  try {
    context = await chromium.launchPersistentContext('', {
      ...(process.env.XMB_BROWSER ? {executablePath: process.env.XMB_BROWSER} : {channel: 'chromium'}),
      headless: true,
      args: ['--disable-extensions-except=' + root, '--load-extension=' + root, '--no-first-run',
        '--no-proxy-server', '--ignore-certificate-errors',
        '--host-resolver-rules=MAP x.com 127.0.0.1:' + server.port + ', MAP * ~NOTFOUND'],
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    await page.goto('https://x.com/home');
    await page.locator('[data-testid=tweetText]').first().waitFor();
    const tabId = await worker.evaluate(async () => (await chrome.tabs.query({url: 'https://x.com/home'}))[0].id);
    // Exercise the real worker and content scripts without timing UI interaction.
    const command = (type, fields = {}) => worker.evaluate(({tabId, type, fields}) => exclusively(() => handle(
      {type, account: 'tester', ...fields},
      {id: chrome.runtime.id, url: 'https://x.com/home', tab: {id: tabId, url: 'https://x.com/home'}}
    )), {tabId, type, fields});
    const store = () => worker.evaluate(async () => (await chrome.storage.local.get('xMuteBag')).xMuteBag);
    const completed = async () => {
      const job = (await store()).job;
      assert.notEqual(job?.status, 'retrying', 'successful saves must not trigger backoff: ' + job?.error);
      return job?.status === 'complete';
    };
    await until(async () => (await store())?.filterSync?.status === 'complete', 'initial filter sync');
    model.documents = []; model.saveTimes = [];
    const words = Array.from({length: 8}, (_, i) => 'speed word ' + i);
    await command('text:import', {text: words.join('\n')});
    const start = Date.now();
    await command('apply');
    try { await until(completed, 'eight confirmed saves'); }
    catch (error) {
      console.error(JSON.stringify({job: (await store()).job, documents: model.documents, saves: model.saves}));
      throw error;
    }
    const elapsed = Date.now() - start;
    const intervals = model.saveTimes.slice(1).map((time, i) => time - model.saveTimes[i]).sort((a, b) => a - b);
    console.log(JSON.stringify({entries: words.length, elapsedMs: elapsed, medianBetweenSavesMs: intervals[Math.floor(intervals.length / 2)], documentLoads: model.documents.length}));
    assert.deepEqual(model.saves.map(word => word.text), words);
    assert.equal((await store()).accounts.tester.bag.length, 0);
    assert.deepEqual(model.documents, ['/settings/muted_keywords'], 'one document load; native links handle later entries');

    // A list skeleton already exposes Add: do not mistake it for a loaded empty list.
    model.listDelay = 250;
    await command('text:import', {text: 'speed word 0\nafter loading'});
    await command('apply');
    await until(completed, 'loaded list checked before inserting');
    assert.deepEqual((await store()).job.items.map(item => item.status), ['skipped', 'added']);
    assert.equal(model.saves.filter(word => word.text === 'speed word 0').length, 1);
    assert.equal(model.saves.filter(word => word.text === 'after loading').length, 1);
    // Some routes reload the form, then Save returns via pushState. Chrome still
    // reports the add-form document URL in messages sent from the resulting list.
    model.listDelay = 0; model.fullAdd = true;
    await command('text:import', {text: 'saved after document navigation'});
    await command('apply');
    await until(completed, 'same-document Save after a full form navigation');
    assert.equal(model.saves.filter(word => word.text === 'saved after document navigation').length, 1);
    console.log('PASS: native navigation, immediate confirmed progress, delayed-list duplicate protection, and stale document URLs');
  } finally { await context?.close(); await server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
