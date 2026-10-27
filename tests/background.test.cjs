const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../core.js');
function harness(backing = {local: {}, session: {}}) {
  const listeners = {};
  const event = name => ({addListener: fn => { listeners[name] = fn; }});
  const tabs = new Map([[1, {id: 1, url: 'https://x.com/home'}]]);
  let nextId = 10;
  const clone = value => structuredClone(value);
  const storage = area => ({
    get: async name => ({[name]: clone(backing[area][name])}),
    set: async obj => Object.assign(backing[area], clone(obj)),
  });
  const chrome = {
    runtime: {id: 'extension', onMessage: event('message')},
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
  const context = vm.createContext({chrome, XMuteCore: C, importScripts() {}, console, URL, Date, crypto});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8'), context);
  async function message(type, fields = {}, tabId = 1, origin = 'https://x.com/home') {
    const result = await new Promise(resolve => listeners.message(
      {type, account: 'tester', ...fields}, {id: 'extension', url: origin, tab: {id: tabId, url: origin}}, resolve
    ));
    if (!result.ok) throw Error(result.error);
    return clone(result.value);
  }
  const store = () => clone(backing.local.xMuteBag);
  async function runner(type, extra = {}) {
    const job = store().job;
    return message(type, {jobId: job.id, itemId: job.items[job.index].id, ...extra}, job.tabId);
  }
  return {message, store, runner, tabs, backing, listeners};
}
test('concurrent bag mutations serialize and do not lose entries', async () => {
  const h = harness();
  await Promise.all(['alpha', 'beta', 'ALPHA'].map(text => h.message('add', {text})));
  assert.deepEqual(h.store().accounts.tester.bag.map(i => i.text), ['alpha', 'beta']);
  await h.message('add', {account: '__proto__', text: 'safe'});
  assert.equal(h.store().accounts.__proto__.bag[0].text, 'safe');
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
  await assert.rejects(h.message('text:import', {text: 'blocked'}), /current batch/);
  await h.message('stop');
  await assert.rejects(h.message('text:import', {text: 'still blocked'}), /current batch/);
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
  filter.terms.push({text: 'expired', key: 'expired', expiresAt: Date.now() - 1});
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
test('phrase replacement is atomic and paused jobs reject picker mutations', async () => {
  const h = harness();
  const first = await h.message('pick', {text: 'John'});
  const full = await h.message('pick', {text: 'John Smith', replace: first.selection});
  assert.deepEqual(full.bag.map(i => i.text), ['John Smith']);
  await h.message('apply');
  await assert.rejects(h.message('pick', {text: 'John Smith Junior', replace: full.selection}), /current batch/);
  assert.equal(h.store().job.items[0].text, 'John Smith');
});
test('batch isolates its tab, checkpoints before Save, and removes only confirmed entries', async () => {
  const h = harness();
  for (const text of ['one', 'two', 'three']) await h.message('add', {text});
  await h.message('apply');
  const job = h.store().job;
  assert.notEqual(job.tabId, 1);
  assert.equal(h.tabs.get(1).url, 'https://x.com/home');
  await assert.rejects(h.message('add', {text: 'four'}), /current batch/);
  await assert.rejects(h.message('runner:missing', {jobId: job.id, itemId: job.items[0].id}, 1), /no longer/);
  await h.runner('runner:found');
  await h.runner('runner:missing');
  await h.runner('runner:submit');
  assert.equal(h.store().job.phase, 'verify');
  await assert.rejects(h.runner('runner:submit'), /already/);
  await h.runner('runner:found');
  await h.runner('runner:found');
  assert.equal(h.store().job.status, 'complete');
  assert.equal(h.store().accounts.tester.bag.length, 0);
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
  await h.runner('runner:pause', {error: 'lost response'});
  assert.equal(h.store().accounts.tester.bag.length, 1);
  await h.message('resume');
  assert.equal(h.store().job.phase, 'check');
  assert.equal(h.store().job.items[0].attempted, true);
  await h.runner('runner:found');
  assert.equal(h.store().job.items[0].status, 'added');
});
test('worker restart preserves a running job; a new browser session pauses it', async () => {
  const h = harness();
  await h.message('add', {text: 'word'});
  await h.message('apply');
  const workerRestart = harness(h.backing);
  assert.equal((await workerRestart.message('view')).job.status, 'running');
  h.backing.session = {};
  const browserRestart = harness(h.backing);
  assert.equal((await browserRestart.message('view')).job.status, 'paused');
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
  assert.ok(data.filter.terms[0].expiresAt > Date.now() + 86300000);
  assert.ok(data.filter.terms[0].validUntil <= Date.now() + C.FILTER_CACHE_MS);
  assert.equal((await h.message('filters:get', {account: 'other'})).filter.terms.length, 0);
});
test('a renewed native mute replaces an expired local deadline', async () => {
  const h = harness();
  await h.message('filters:import', {words: [{text: 'renewed', forever: false}]}, 1, 'https://x.com/settings/muted_keywords');
  h.backing.local.xMuteBag.accounts.tester.filter.terms[0].expiresAt = Date.now() - 1;
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
