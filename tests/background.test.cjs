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
  const context = vm.createContext({chrome, XMuteCore: C, importScripts() {}, console, URL, Date});
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
