const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../core.js');
function harness(backing = {local: {}, session: {}}) {
  const listeners = {};
  const alarms = backing.alarms ||= new Map();
  const clock = backing.clock ||= {now: Date.now()};
  class ClockDate extends Date { static now() { return clock.now; } }
  const event = name => ({addListener: fn => { listeners[name] = fn; }});
  const tabs = new Map([[1, {id: 1, url: 'https://x.com/home'}]]);
  let nextId = 10;
  const clone = value => structuredClone(value);
  const storage = area => ({
    get: async name => ({[name]: clone(backing[area][name])}),
    set: async obj => Object.assign(backing[area], clone(obj)),
  });
  const chrome = {
    runtime: {id: 'extension', onMessage: event('message'), onStartup: event('startup'), onInstalled: event('installed')},
    alarms: {
      get: async name => clone(alarms.get(name)),
      create: async (name, info) => { alarms.set(name, {name, scheduledTime: info.when}); },
      clear: async name => alarms.delete(name), onAlarm: event('alarm'),
    },
    storage: {local: storage('local'), session: storage('session')},
    tabs: {
      get: async id => { if (!tabs.has(id)) throw Error('closed'); return tabs.get(id); },
      create: async props => { const tab = {id: nextId++, ...props}; tabs.set(tab.id, tab); return tab; },
      update: async (id, props) => { if (!tabs.has(id)) throw Error('closed'); Object.assign(tabs.get(id), props); return tabs.get(id); },
      remove: async id => { tabs.delete(id); listeners.removed(id); },
      sendMessage: async () => {},
      onRemoved: event('removed'), onUpdated: event('updated'),
    },
    action: {onClicked: event('clicked'), setBadgeText: async () => {}, setTitle: async () => {}},
    scripting: {executeScript: async () => {}},
  };
  const context = vm.createContext({chrome, XMuteCore: C, importScripts() {}, console, URL, Date: ClockDate, crypto});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8'), context);
  async function message(type, fields = {}, tabId = 1, origin = 'https://x.com/home', documentUrl = origin) {
    const result = await new Promise(resolve => listeners.message(
      {type, account: 'tester', ...fields}, {id: 'extension', url: documentUrl, tab: {id: tabId, url: origin}}, resolve
    ));
    if (!result.ok) throw Error(result.error);
    return clone(result.value);
  }
  const store = () => clone(backing.local.xMuteBag);
  async function runner(type, extra = {}) {
    const job = store().job;
    return message(type, {jobId: job.id, runId: job.runId, itemId: job.items[job.index].id, ...extra}, job.tabId);
  }
  async function fireAlarm() {
    await message('view');
    const alarm = alarms.get('xmb-batch');
    assert.ok(alarm, 'batch alarm is scheduled');
    clock.now = Math.max(clock.now, alarm.scheduledTime);
    alarms.delete(alarm.name);
    listeners.alarm(alarm);
    return message('view');
  }
  return {message, store, runner, tabs, backing, listeners, alarms, clock, fireAlarm, chrome};
}
test('concurrent bag mutations serialize and do not lose entries', async () => {
  const h = harness();
  await Promise.all(['alpha', 'beta', 'ALPHA'].map(text => h.message('add', {text})));
  assert.deepEqual(h.store().accounts.tester.bag.map(i => i.text), ['alpha', 'beta']);
  await h.message('add', {account: '__proto__', text: 'safe'});
  assert.equal(h.store().accounts.__proto__.bag[0].text, 'safe');
});
test('local filtering saves thousands of words without native writes, persists, and survives native sync', async () => {
  const h = harness(), words = Array.from({length: 5000}, (_, i) => 'local phrase ' + i);
  await h.message('text:import', {text: words.join('\n')});
  await h.message('local:apply');
  assert.equal(h.store().accounts.tester.localWords.length, 5000);
  assert.equal(h.store().accounts.tester.bag.length, 0);
  assert.equal(h.store().job, null);
  assert.equal(h.tabs.size, 1, 'local Apply does not open native settings');
  assert.equal(h.alarms.size, 0);
  await h.message('filters:import', {words: []}, 1, 'https://x.com/settings/muted_keywords');
  const restarted = harness(h.backing);
  assert.equal((await restarted.message('filters:get')).localWords.length, 5000);
  assert.equal((await restarted.message('text:export', {scope: 'local'})).text, words.join('\n') + '\n');
  assert.equal((await restarted.message('view', {account: 'other'})).localWords.length, 0);
  await restarted.message('text:import', {text: 'LOCAL PHRASE 4999\nnew local word'});
  await restarted.message('local:apply');
  assert.equal(restarted.store().accounts.tester.localWords.length, 5001);
  const first = restarted.store().accounts.tester.localWords[0];
  await restarted.message('local:remove', {id: first.id});
  assert.equal(restarted.store().accounts.tester.localWords.length, 5000);
  assert.equal(restarted.store().accounts.tester.localWords.some(word => word.id === first.id), false);
});
test('local Apply releases an interrupted native batch and cancels its retries', async () => {
  const h = harness();
  await h.message('text:import', {text: 'first\nsecond'}); await h.message('apply');
  await h.runner('runner:failed', {error: 'Native limit reached'});
  await h.message('local:apply');
  assert.equal(h.store().job.status, 'stopped');
  assert.equal(h.alarms.size, 0);
  assert.deepEqual(h.store().accounts.tester.localWords.map(word => word.text), ['first', 'second']);
  await h.message('add', {text: 'third'});
  assert.equal(h.store().accounts.tester.bag.length, 1);
});
test('upgrade retains known native words, pending words, and interrupted batch entries only once', async () => {
  const job = C.createJob('tester', [C.entry('old success'), C.entry('pending')], C.DEFAULTS, 1);
  job.status = 'paused'; job.pauseReason = 'user';
  const h = harness({session: {}, local: {xMuteBag: {version: 1, accounts: {tester: {
    bag: [C.entry('pending')], options: {...C.DEFAULTS},
    filter: {enabled: true, terms: [{text: 'native', validUntil: 1}, {text: 'expired', expiresAt: 1}], syncedAt: 1},
  }}, job}}});
  assert.deepEqual((await h.message('view')).localWords.map(word => word.text), ['native', 'old success', 'pending']);
  const word = h.store().accounts.tester.localWords[0];
  await h.message('local:remove', {id: word.id});
  assert.equal((await harness(h.backing).message('view')).localWords.some(item => item.text === 'native'), false);
});
test('bulk imports merge atomically, serialize with other edits, persist and isolate accounts', async () => {
  const h = harness();
  const results = await Promise.all([
    h.message('text:import', {text: 'Café\nJohn Smith\nCAFÉ'}),
    h.message('text:import', {text: 'john smith\n#topic'}),
    h.message('add', {text: 'last'}),
  ]);
  assert.deepEqual(results[0].imported, {added: 2, duplicates: 1});
  assert.deepEqual(results[1].imported, {added: 1, duplicates: 1});
  const before = h.store();
  await assert.rejects(h.message('text:import', {text: 'valid\n' + 'x'.repeat(281)}), /Line 2/);
  assert.deepEqual(h.store(), before);
  await h.message('text:import', {account: 'other', text: 'other account'});
  const restarted = harness(h.backing);
  assert.deepEqual((await restarted.message('view')).bag.map(item => item.text), ['Café', 'John Smith', '#topic', 'last']);
  assert.deepEqual((await restarted.message('view', {account: 'other'})).bag.map(item => item.text), ['other account']);
  assert.equal(h.store().job, null);
  assert.equal(h.tabs.size, 1, 'import does not open an X settings tab');
  await h.message('apply');
  await h.message('text:import', {text: 'while running'});
  await h.message('stop');
  await h.message('text:import', {text: 'while stopped'});
  await h.message('end');
  await h.message('text:import', {text: 'allowed'});
});
test('text export includes cached mutes and pending words, supports bag only, and never mutates storage', async () => {
  const h = harness();
  await h.message('filters:import', {words: [{text: 'Café', forever: true}, {text: 'Saved phrase', forever: true}]}, 1, 'https://x.com/settings/muted_keywords');
  await h.message('text:import', {text: 'CAFÉ\nPending phrase'});
  await h.message('text:import', {account: 'other', text: 'private'});
  const filter = h.backing.local.xMuteBag.accounts.tester.filter;
  filter.terms[0].validUntil = 1; // Export the last known list even when automatic filtering is stale.
  filter.terms.push({text: 'expired', key: 'expired', expiresAt: h.clock.now - 1});
  const before = h.store();
  assert.deepEqual(await h.message('text:export', {scope: 'all'}), {account: 'tester', count: 3, text: 'Café\nSaved phrase\nPending phrase\n'});
  assert.deepEqual(await h.message('text:export', {scope: 'bag'}), {account: 'tester', count: 2, text: 'CAFÉ\nPending phrase\n'});
  assert.deepEqual(await h.message('text:export', {account: 'empty', scope: 'all'}), {account: 'empty', count: 0, text: ''});
  await assert.rejects(h.message('text:export', {scope: 'invalid'}), /Choose/);
  await assert.rejects(h.message('text:import', {text: 'bad'}, 1, 'https://example.com'), /Unsupported/);
  await assert.rejects(h.message('text:export', {scope: 'all'}, 1, 'https://example.com'), /Unsupported/);
  assert.deepEqual(h.store(), before);
  await h.message('apply');
  assert.equal((await h.message('text:export', {scope: 'bag'})).count, 2, 'export is available during a batch');
});
test('phrase replacement remains available and cannot change a native batch snapshot', async () => {
  const h = harness();
  const first = await h.message('pick', {text: 'John'});
  const full = await h.message('pick', {text: 'John Smith', replace: first.selection});
  assert.deepEqual(full.bag.map(i => i.text), ['John Smith']);
  await h.message('apply');
  await h.message('stop');
  await h.message('pick', {text: 'John Smith Junior', replace: full.selection});
  assert.equal(h.store().accounts.tester.bag[0].text, 'John Smith Junior');
  assert.equal(h.store().job.items[0].text, 'John Smith');
});
test('batch isolates its tab, checkpoints before Save, and removes only confirmed entries', async () => {
  const h = harness();
  for (const text of ['one', 'two', 'three']) await h.message('add', {text});
  await h.message('apply');
  const job = h.store().job;
  assert.notEqual(job.tabId, 1);
  assert.equal(h.tabs.get(1).url, 'https://x.com/home');
  await h.message('add', {text: 'four'});
  assert.equal(h.store().job.items.length, 3);
  await assert.rejects(h.message('runner:missing', {jobId: job.id, itemId: job.items[0].id}, 1), /no longer/);
  await h.runner('runner:found');
  await h.runner('runner:missing');
  await h.runner('runner:submit');
  assert.equal(h.store().job.phase, 'verify');
  await assert.rejects(h.runner('runner:submit'), /already/);
  await h.runner('runner:found');
  await h.runner('runner:found');
  assert.equal(h.store().job.status, 'complete');
  assert.deepEqual(h.store().accounts.tester.bag.map(word => word.text), ['four']);
  assert.equal(h.tabs.has(job.tabId), false);
  assert.equal(h.tabs.has(1), true);
  assert.deepEqual(C.counts(h.store().job), {added: 1, skipped: 2, failed: 0, total: 3});
});
test('uncertain save resumes by checking the list before another submission', async () => {
  const h = harness();
  await h.message('add', {text: 'word'});
  await h.message('apply');
  await h.runner('runner:missing');
  await h.runner('runner:submit');
  await h.runner('runner:failed', {error: 'lost response'});
  assert.equal(h.store().accounts.tester.bag.length, 1);
  await h.fireAlarm();
  assert.equal(h.store().job.phase, 'check');
  assert.equal(h.store().job.items[0].attempted, true);
  await h.runner('runner:found');
  assert.equal(h.store().job.items[0].status, 'added');
});
test('running, retrying and stopped native batches never lock local additions, editing or imports', async () => {
  for (const status of ['running', 'retrying', 'paused']) {
    const h = harness();
    await h.message('add', {text: 'native snapshot'}); await h.message('apply');
    if (status === 'retrying') await h.runner('runner:failed', {error: 'Native limit reached'});
    if (status === 'paused') await h.message('stop');
    const snapshot = h.store().job;
    const restarted = harness(h.backing);
    await restarted.message('view');
    await restarted.message('add', {text: 'typed'});
    await restarted.message('text:import', {text: 'pasted\nfile entry'});
    const picked = await restarted.message('pick', {text: 'phrase'});
    await restarted.message('pick', {text: 'phrase extended', replace: picked.selection});
    await restarted.message('edit', {id: snapshot.items[0].id, text: 'edited local draft'});
    await restarted.message('options', {options: {...C.DEFAULTS, duration: '7d'}});
    assert.deepEqual(restarted.store().job, snapshot, 'native retry state and snapshot remain unchanged');
    assert.deepEqual(restarted.store().accounts.tester.bag.map(word => word.text),
      ['edited local draft', 'typed', 'pasted', 'file entry', 'phrase extended']);
    const typed = restarted.store().accounts.tester.bag.find(word => word.text === 'typed');
    await restarted.message('remove', {id: typed.id});
    await restarted.message('clear');
    await restarted.message('text:import', {text: 'next local word'});
    await restarted.message('local:apply');
    assert.equal(restarted.store().job.status, 'stopped');
    assert.equal(restarted.alarms.size, 0);
    assert.deepEqual(restarted.store().accounts.tester.localWords.map(word => word.text), ['native snapshot', 'next local word']);
    assert.equal(restarted.store().accounts.tester.bag.length, 0);
  }
});
test('late native confirmations retain edited drafts and re-added words', async () => {
  const h = harness();
  await h.message('text:import', {text: 'old phrase\nunchanged\nreadded'});
  await h.message('apply');
  const snapshot = h.store().job.items;
  await h.message('edit', {id: snapshot[0].id, text: 'new phrase'});
  await h.message('remove', {id: snapshot[2].id});
  await h.message('text:import', {text: 'readded\nnew word'});
  assert.notEqual(h.store().accounts.tester.bag.find(word => word.text === 'readded').id, snapshot[2].id);
  await h.runner('runner:found'); await h.runner('runner:found'); await h.runner('runner:found');
  assert.equal(h.store().job.status, 'complete');
  assert.deepEqual(h.store().accounts.tester.bag.map(word => word.text), ['new phrase', 'readded', 'new word']);
});
test('worker restart restores the alarm; browser restart automatically rechecks the interrupted batch', async () => {
  const h = harness();
  await h.message('add', {text: 'word'});
  await h.message('apply');
  h.alarms.clear();
  const workerRestart = harness(h.backing);
  assert.equal((await workerRestart.message('view')).job.status, 'running');
  assert.ok(workerRestart.alarms.has('xmb-batch'));
  h.backing.session = {};
  h.alarms.clear();
  const browserRestart = harness(h.backing);
  const restarted = await browserRestart.message('view');
  assert.equal(restarted.job.status, 'retrying');
  assert.equal(restarted.job.tabId, null);
  assert.equal((await browserRestart.fireAlarm()).job.status, 'running');
});
test('Stop rejects late saves; End releases the retained bag', async () => {
  const h = harness();
  await h.message('add', {text: 'word'});
  await h.message('apply');
  await h.message('stop');
  await assert.rejects(h.runner('runner:submit'), /no longer/);
  await h.message('end');
  await h.message('add', {text: 'another'});
  assert.equal(h.store().accounts.tester.bag.length, 2);
});
test('rejects foreign origins, stale entries, and concurrent batches across accounts', async () => {
  const h = harness();
  await assert.rejects(h.message('add', {text: 'no'}, 1, 'https://example.com'), /Unsupported/);
  await h.message('add', {text: 'word'});
  await h.message('apply');
  await h.message('add', {account: 'other', text: 'another'});
  await assert.rejects(h.message('apply', {account: 'other'}), /existing batch/);
  await assert.rejects(h.runner('runner:missing', {itemId: 'old'}), /advanced/);
});
test('automatic retries have capped backoff without an attempt limit and reject callbacks from earlier runs', async () => {
  const h = harness();
  await h.message('text:import', {text: 'first\nsecond'});
  await h.message('apply');
  const id = h.store().job.id;
  for (let attempt = 1; attempt <= 9; attempt++) {
    const previousRun = h.store().job.runId;
    await h.runner('runner:missing');
    await h.runner('runner:submit');
    await h.runner('runner:failed', {error: 'Try again later'});
    const retry = h.store().job;
    assert.equal(retry.status, 'retrying');
    assert.equal(retry.retryCount, attempt);
    assert.equal(retry.retryAt - h.clock.now, C.retryDelay(attempt));
    assert.equal(retry.phase, 'verify');
    assert.equal((await h.message('text:import', {text: 'first'})).imported.duplicates, 1);
    await h.message('filters:sync', {force: true});
    assert.equal(h.store().filterSync, undefined, 'sync cannot interfere with a retrying batch');
    do { await h.fireAlarm(); } while (h.store().job.status === 'retrying');
    assert.equal(h.store().job.id, id);
    assert.equal(h.store().job.phase, 'check');
    assert.notEqual(h.store().job.runId, previousRun);
    await assert.rejects(h.runner('runner:failed', {runId: previousRun, error: 'late failure'}), /no longer/);
    assert.equal(h.store().job.status, 'running');
  }
  await h.runner('runner:found');
  assert.equal(h.store().job.retryCount, 0, 'successful progress resets the backoff');
  assert.deepEqual(h.store().accounts.tester.bag.map(item => item.text), ['second']);
  await h.runner('runner:found');
  assert.equal(h.store().job.status, 'complete');
  assert.equal(h.alarms.size, 0);
});
test('Stop and End cancel automatic retries, including late alarms and browser restarts', async () => {
  for (const command of ['stop', 'end']) {
    const h = harness();
    await h.message('add', {text: 'word'}); await h.message('apply');
    const oldRun = h.store().job.runId;
    await h.runner('runner:failed', {error: 'Try again'});
    await h.message(command);
    const before = h.store().job;
    assert.equal(h.alarms.size, 0);
    h.clock.now += 600000;
    h.listeners.alarm({name: 'xmb-batch'});
    await h.message('view');
    assert.deepEqual(h.store().job, before);
    await assert.rejects(h.runner('runner:found', {runId: oldRun}), /running|active batch/);
    h.backing.session = {};
    const restarted = harness(h.backing);
    assert.equal((await restarted.message('view')).job.status, before.status);
    assert.equal(restarted.alarms.size, 0);
  }
});
test('closed, stalled, or failed runner tabs recover automatically and never reuse a foreign page', async () => {
  const h = harness();
  await h.message('add', {text: 'word'}); await h.message('apply');
  const originalTab = h.store().job.tabId;
  await h.chrome.tabs.remove(originalTab);
  assert.equal((await h.message('view')).job.status, 'retrying');
  await h.fireAlarm();
  assert.notEqual(h.store().job.tabId, originalTab);
  const stalledRun = h.store().job.runId;
  await h.fireAlarm();
  assert.equal(h.store().job.status, 'retrying');
  assert.match(h.store().job.error, /stopped responding/);
  await h.fireAlarm();
  assert.notEqual(h.store().job.runId, stalledRun);
  const failedTab = h.store().job.tabId;
  h.tabs.get(failedTab).url = 'chrome-error://chromewebdata/';
  h.listeners.updated(failedTab, {url: 'chrome-error://chromewebdata/'});
  assert.equal((await h.message('view')).job.status, 'retrying');
  await h.fireAlarm();
  assert.equal(h.store().job.tabId, failedTab, 'reuse the owned error tab instead of opening more tabs');
  h.tabs.get(failedTab).url = 'https://example.com/';
  h.listeners.updated(failedTab, {url: 'https://example.com/'});
  assert.equal((await h.message('view')).job.status, 'retrying');
  await h.fireAlarm();
  assert.notEqual(h.store().job.tabId, failedTab);
  assert.equal(h.tabs.get(failedTab).url, 'https://example.com/');
});
test('tab allocation failures keep retrying and legacy failure-paused batches migrate without resuming a user Stop', async () => {
  const h = harness();
  const create = h.chrome.tabs.create;
  h.chrome.tabs.create = async () => { throw Error('Browser unavailable'); };
  await h.message('add', {text: 'word'}); await h.message('apply');
  assert.equal(h.store().job.status, 'retrying');
  await h.fireAlarm();
  assert.equal(h.store().job.retryCount, 2);
  h.chrome.tabs.create = create;
  await h.fireAlarm();
  assert.equal(h.store().job.status, 'running');
  for (const [error, expected] of [['Try again later', 'retrying'], ['Stopped. Resume when you are ready;', 'paused'], ['The signed-in X account changed.', 'retrying']]) {
    const backing = structuredClone(h.backing);
    Object.assign(backing.local.xMuteBag.job, {status: 'paused', pauseReason: undefined, error});
    const upgraded = harness(backing);
    assert.equal((await upgraded.message('view')).job.status, expected);
  }
});
test('sync imports existing native mutes, preserves the bag, and removes unmuted terms', async () => {
  const h = harness();
  await h.message('add', {text: 'unsaved'});
  await h.message('filters:sync');
  const sync = h.store().filterSync;
  assert.equal(h.tabs.get(sync.tabId).url, 'https://x.com/settings/muted_keywords');
  assert.equal(h.tabs.get(1).url, 'https://x.com/home');
  await assert.rejects(h.message('filters:import', {words: [{text: 'bad', forever: true}]}), /settings list/);
  await assert.rejects(h.message('filters:import', {syncId: 'wrong', words: []}, sync.tabId, 'https://x.com/settings/muted_keywords'), /no longer/);
  await h.message('filters:import', {syncId: sync.id, words: [{text: 'John Smith', forever: true}, {text: 'cats', forever: true}]}, sync.tabId, 'https://x.com/settings/muted_keywords');
  assert.equal(h.tabs.has(sync.tabId), false);
  assert.deepEqual(h.store().accounts.tester.bag.map(i => i.text), ['unsaved']);
  assert.deepEqual(h.store().accounts.tester.filter.terms.map(i => i.text), ['John Smith', 'cats']);
  await h.message('filters:import', {words: [{text: 'cats', forever: true}]}, 1, 'https://x.com/settings/muted_keywords');
  assert.deepEqual(h.store().accounts.tester.filter.terms.map(i => i.text), ['cats']);
  await h.message('filters:import', {words: []}, 1, 'https://x.com/settings/muted_keywords');
  assert.deepEqual(h.store().accounts.tester.filter.terms, []);
});
test('list imports use the current tab route after same-document navigation, not the original document URL', async () => {
  const h = harness(), list = 'https://x.com/settings/muted_keywords', add = 'https://x.com/settings/add_muted_keyword';
  await h.message('filters:import', {words: [{text: 'saved', forever: true}]}, 1, list, add);
  assert.deepEqual(h.store().accounts.tester.filter.terms.map(item => item.text), ['saved']);
  await assert.rejects(h.message('filters:import', {words: []}, 1, add, list), /settings list/);
  await assert.rejects(h.message('filters:import', {words: []}, 1, 'https://example.com/settings/muted_keywords', list), /settings list/);
  assert.deepEqual(h.store().accounts.tester.filter.terms.map(item => item.text), ['saved']);
});
test('sync is account-scoped, throttled, and never consumes another account’s list', async () => {
  const h = harness();
  await h.message('filters:sync');
  const sync = h.store().filterSync;
  await h.message('filters:sync');
  assert.equal(h.store().filterSync.id, sync.id);
  await assert.rejects(h.message('filters:import', {account: 'other', syncId: sync.id, words: []}, sync.tabId, 'https://x.com/settings/muted_keywords'), /no longer/);
  await h.message('filters:failed', {syncId: sync.id, error: 'login expired'}, sync.tabId, 'https://x.com/settings/muted_keywords');
  assert.equal(h.store().filterSync.status, 'failed');
  await h.message('filters:sync');
  assert.equal(h.store().filterSync.id, sync.id);
  await h.message('filters:toggle', {enabled: false});
  await h.message('filters:sync', {force: true});
  assert.equal(h.store().filterSync.id, sync.id);
});
test('confirmed Apply entries persist after the bag empties and expire on schedule', async () => {
  const h = harness();
  await h.message('add', {text: 'John Smith'});
  await h.message('options', {options: {...C.DEFAULTS, duration: '24h'}});
  await h.message('apply');
  await h.runner('runner:missing'); await h.runner('runner:submit'); await h.runner('runner:found');
  const data = h.store().accounts.tester;
  assert.equal(data.bag.length, 0);
  assert.equal(data.filter.terms[0].text, 'John Smith');
  assert.ok(data.filter.terms[0].expiresAt > h.clock.now + 86300000);
  assert.ok(data.filter.terms[0].validUntil <= h.clock.now + C.FILTER_CACHE_MS);
  assert.equal((await h.message('filters:get', {account: 'other'})).filter.terms.length, 0);
});
test('a renewed native mute replaces an expired local deadline', async () => {
  const h = harness();
  await h.message('filters:import', {words: [{text: 'renewed', forever: false}]}, 1, 'https://x.com/settings/muted_keywords');
  h.backing.local.xMuteBag.accounts.tester.filter.terms[0].expiresAt = h.clock.now - 1;
  await h.message('filters:import', {words: [{text: 'renewed', forever: false}]}, 1, 'https://x.com/settings/muted_keywords');
  const term = h.store().accounts.tester.filter.terms[0];
  assert.equal(term.expiresAt, null);
  assert.equal(C.muteMatcher([term])('renewed'), true);
});
test('account reply rules migrate existing stores, deduplicate, and survive browser restart', async () => {
  const h = harness({local: {xMuteBag: {version: 1, accounts: {tester: {bag: [C.entry('kept')], options: {...C.DEFAULTS}}}, job: null}}, session: {}});
  assert.deepEqual((await h.message('view')).replyRules, []);
  await Promise.all(['@Alice', 'https://x.com/ALICE/', 'bob'].map(handle => h.message('replies:add', {handle})));
  assert.deepEqual(h.store().accounts.tester.replyRules, [{handle: 'alice', enabled: true}, {handle: 'bob', enabled: true}]);
  assert.equal(h.store().accounts.tester.bag[0].text, 'kept');
  assert.equal(h.tabs.size, 1, 'local rules never open native settings');
  await h.message('replies:toggle', {handle: 'alice', enabled: false});
  h.backing.session = {};
  const restarted = harness(h.backing);
  assert.deepEqual((await restarted.message('filters:get')).replyRules, [{handle: 'alice', enabled: false}, {handle: 'bob', enabled: true}]);
  assert.deepEqual((await restarted.message('view', {account: 'other'})).replyRules, []);
  await restarted.message('replies:add', {handle: 'ALICE'});
  await restarted.message('replies:remove', {handle: 'bob'});
  assert.deepEqual((await restarted.message('view')).replyRules, [{handle: 'alice', enabled: true}]);
});
test('reply rules are independent of word filtering, native sync, and an active Apply batch', async () => {
  const h = harness();
  await h.message('add', {text: 'word'}); await h.message('apply');
  await h.message('replies:add', {handle: '@alice'});
  await h.message('filters:toggle', {enabled: false});
  await h.message('filters:import', {words: []}, 1, 'https://x.com/settings/muted_keywords');
  assert.deepEqual((await h.message('filters:get')).replyRules, [{handle: 'alice', enabled: true}]);
  assert.equal(h.store().job.status, 'running');
  await h.message('replies:remove', {handle: 'alice'});
  assert.deepEqual((await h.message('view')).replyRules, []);
});
test('rejects invalid reply rule handles and updates without modifying saved rules', async () => {
  const h = harness();
  await h.message('replies:add', {handle: '__proto__'});
  for (const handle of ['', null, '@@bad', 'a b', '<script>', 'https://evil.com/alice', 'https://x.com/alice/status/123', 'sixteen_charssssss']) {
    await assert.rejects(h.message('replies:add', {handle}), /username/);
  }
  await assert.rejects(h.message('replies:toggle', {handle: '__proto__', enabled: 'false'}), /existing account/);
  await assert.rejects(h.message('replies:toggle', {handle: 'missing', enabled: true}), /existing account/);
  assert.deepEqual((await h.message('view')).replyRules, [{handle: '__proto__', enabled: true}]);
});
