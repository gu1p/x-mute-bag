async function mountHarness(sources, fixture) {
  // about:blank is not a secure context; X and extension worlds expose randomUUID.
  const uuid = () => [...crypto.getRandomValues(new Uint8Array(16))].map(n => n.toString(16).padStart(2, '0')).join('');
  if (!crypto.randomUUID) crypto.randomUUID = uuid;
  document.title = 'X Mute Bag · Browser checks';
  document.body.replaceChildren();
  document.body.style.cssText = 'margin:0;background:#000';
  const data = {local: {}, session: {}}, tabs = new Map(), workerEvents = {};
  const model = {account: 'tester', words: [], saves: [], fail: null, uncertain: null, saveDelay: 0};
  let nextTab = 1;
  const errors = [], results = [];
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const clone = value => structuredClone(value);
  async function until(probe, label, timeout = 12000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (probe()) return;
      await sleep(80);
    }
    throw Error('Timeout: ' + label + ' / ' + JSON.stringify(data.local.xMuteBag?.job));
  }
  const event = (object, key) => ({addListener: listener => { object[key] = listener; }});
  const storage = {
    local: {
      get: async key => ({[key]: clone(data.local[key])}),
      set: async values => {
        const changes = {};
        for (const [key, value] of Object.entries(values)) {
          changes[key] = {oldValue: clone(data.local[key]), newValue: clone(value)};
          data.local[key] = clone(value);
        }
        for (const tab of tabs.values()) tab.listeners.storage?.(changes, 'local');
      },
    },
    session: {get: async key => ({[key]: clone(data.session[key])}), set: async values => Object.assign(data.session, clone(values))},
  };
  const tabApi = {
    create: async options => {
      const tab = {id: nextTab++, url: options.url, listeners: {}};
      tabs.set(tab.id, tab);
      await mount(tab);
      return {id: tab.id, url: tab.url};
    },
    get: async id => { const tab = tabs.get(id); if (!tab) throw Error('closed'); return {id, url: tab.url}; },
    update: async (id, options) => {
      const tab = tabs.get(id); if (!tab) throw Error('closed');
      if (options.url) { tab.url = options.url; await mount(tab); }
      return {id, url: tab.url};
    },
    remove: async id => { const tab = tabs.get(id); if (tab) { tab.frame.remove(); tabs.delete(id); workerEvents.removed?.(id); } },
    sendMessage: async (id, message) => { const tab = tabs.get(id); if (!tab) throw Error('closed'); tab.listeners.message?.(message, {}, () => {}); },
    onRemoved: event(workerEvents, 'removed'), onUpdated: event(workerEvents, 'updated'),
  };
  const workerChrome = {
    storage, tabs: tabApi,
    runtime: {id: 'xmb-fixture', onMessage: event(workerEvents, 'message')},
    action: {onClicked: event(workerEvents, 'clicked'), setBadgeText: async () => {}, setTitle: async () => {}},
    scripting: {executeScript: async () => {}},
  };
  // The worker has its own lexical scope, matching the production message boundary.
  new Function('chrome', 'importScripts', sources['core.js'] + '\n' + sources['background.js'])(workerChrome, () => {});
  async function mount(tab) {
    tab.frame?.remove();
    tab.listeners = {};
    const frame = document.createElement('iframe');
    tab.frame = frame;
    frame.style.cssText = tab.id === 1 ? 'display:block;width:100vw;height:100vh;border:0' : 'position:fixed;left:-2000px;width:1280px;height:900px;border:0';
    document.body.append(frame);
    const win = frame.contentWindow;
    if (!win.crypto.randomUUID) win.crypto.randomUUID = uuid;
    win.addEventListener('error', e => errors.push(e.message));
    win.addEventListener('unhandledrejection', e => errors.push(String(e.reason)));
    win.document.documentElement.innerHTML = fixture;
    const location = {
      get pathname() { return new URL(tab.url).pathname; },
      assign(url) {
        tab.url = new URL(url, 'https://x.com').href;
        // A new content-script world, as with a full navigation.
        setTimeout(() => mount(tab), 0);
      },
    };
    const fetch = async (url, options) => {
      if (url === '/__fixture/state') return {json: async () => clone(model)};
      const value = JSON.parse(options.body); model.saves.push(clone(value));
      if (model.saveDelay) await sleep(model.saveDelay);
      if (model.fail === value.text) return {json: async () => ({error: 'Try again: fixture failure'})};
      if (model.words.some(w => w.text.toLowerCase() === value.text.toLowerCase())) return {json: async () => ({error: 'Word already muted'})};
      model.words.push(value);
      return {json: async () => model.uncertain === value.text ? {error: 'Try again: response lost after saving'} : {ok: true}};
    };
    const chrome = {
      storage: {onChanged: event(tab.listeners, 'storage')},
      runtime: {
        onMessage: event(tab.listeners, 'message'),
        sendMessage: message => new Promise(resolve => workerEvents.message(
          clone(message), {id: 'xmb-fixture', url: tab.url, tab: {id: tab.id, url: tab.url}}, resolve
        )),
      },
    };
    const script = win.document.querySelector('script').textContent;
    win.Function('fetch', 'location', script)(fetch, location);
    win.Function('chrome', 'location', sources['core.js'] + '\n' + sources['x-adapter.js'] + '\n' + sources['content.js'])(chrome, location);
    await sleep(30);
    workerEvents.updated?.(tab.id, {status: 'complete'});
  }
  await tabApi.create({url: 'https://x.com/home'});
  const tab = () => tabs.get(1);
  const win = () => tab().frame.contentWindow;
  const panel = () => win().document.querySelector('#x-mute-bag')?.shadowRoot;
  const el = id => panel().getElementById(id);
  const store = () => data.local.xMuteBag;
  const bag = () => store()?.accounts.tester?.bag || [];
  function assert(value, label) { if (!value) throw Error('Assertion failed: ' + label); }
  async function toggle() { workerEvents.clicked({id: 1, url: tab().url}); await until(() => !!panel(), 'panel'); await sleep(100); }
  async function add(text) {
    el('new-word').value = text;
    el('add-form').dispatchEvent(new (win().Event)('submit', {bubbles: true, cancelable: true}));
    await until(() => bag().some(i => i.text === text), 'add ' + text);
  }
  async function pick(text, shiftKey = false, hoverOnly = false, wait = true) {
    const w = win();
    const walker = w.document.createTreeWalker(w.document.querySelector('main'), w.NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const offset = node.data.indexOf(text);
      if (offset < 0 || !node.parentElement.closest('[data-testid=tweetText]')) continue;
      const range = w.document.createRange(); range.setStart(node, offset); range.setEnd(node, offset + text.length);
      const rect = range.getBoundingClientRect();
      const init = {bubbles: true, cancelable: true, composed: true, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2, button: 0, shiftKey};
      node.parentElement.dispatchEvent(new w.MouseEvent('pointermove', init));
      if (!hoverOnly) node.parentElement.dispatchEvent(new w.MouseEvent('click', init));
      if (wait) await sleep(100); return;
    }
    throw Error('Word missing: ' + text);
  }
  async function click(id) { el(id).click(); await sleep(100); }
  async function command(label) {
    const button = [...panel().querySelectorAll('button')].find(e => e.textContent === label);
    assert(button, 'button ' + label); button.click(); await sleep(100);
  }
  function pass(name) { results.push(name); console.log('PASS: ' + name); }
  globalThis.XMBTest = {
    model, store, results, errors, tabs, toggle, add, pick, click, command,
    async selection() {
      await toggle();
      await pick('Café'); await pick('Café'); await pick('#Topic'); await pick('multi');
      assert(bag().map(i => i.text).join('|') === 'Café|#Topic|multipart', 'picked normalized words: ' + JSON.stringify(bag()));
      assert(!win().tweetClicks, 'tweet click intercepted');
      const input = panel().querySelector('input[data-entry="' + bag()[2].id + '"]');
      input.value = 'long phrase'; input.dispatchEvent(new (win().Event)('change', {bubbles: true}));
      await until(() => bag()[2]?.text === 'long phrase', 'edit');
      panel().querySelector('button[aria-label="Remove long phrase"]').click(); await sleep(100);
      await click('collapse'); assert(el('body').hidden, 'collapse');
      await click('collapse');
      win().document.dispatchEvent(new (win().KeyboardEvent)('keydown', {key: 'Escape', bubbles: true}));
      await pick('dogs'); assert(win().tweetClicks === 1, 'normal clicking restored');
      await mount(tab()); await toggle();
      assert(bag().length > 0, 'persistent bag after reload');
      await click('clear');
      const article = win().document.createElement('article'); article.dataset.testid = 'tweet';
      article.innerHTML = '<div data-testid="tweetText" lang="pt">Novíssima palavra.</div>';
      win().document.querySelector('#spacer').before(article); await sleep(150);
      await pick('Novíssima'); assert(bag()[0]?.text === 'Novíssima', 'new tweets selectable');
      await click('clear');
      pass('Picker, duplicates, hashtags, split nodes, editing, Escape, reload and new tweets');
      return results;
    },
    async apply() {
      model.words = [{text: 'existing'}];
      for (const word of ['existing', 'new one', 'new two']) await add(word);
      el('home').checked = false; el('home').dispatchEvent(new (win().Event)('change')); await sleep(100);
      el('audience').value = 'unfollowed'; el('audience').dispatchEvent(new (win().Event)('change')); await sleep(100);
      el('duration').value = '7d'; el('duration').dispatchEvent(new (win().Event)('change')); await sleep(100);
      win().scrollTo(0, 100); const scroll = win().scrollY;
      await click('apply');
      await until(() => store().job?.status === 'complete', 'batch complete', 25000);
      assert(store().job.items.map(i => i.status).join(',') === 'skipped,added,added', 'confirmed results');
      assert(model.saves.length === 2, 'one save per new entry');
      assert(model.saves.every(s => !s.home && s.notifications && s.audience === 1 && s.duration === 2), 'native options');
      assert(!bag().length && tabs.size === 1 && win().scrollY === scroll, 'cleanup and feed preservation');
      pass('Sequential Apply, native options, duplicate skipping, confirmed saves and feed preservation');
      return results;
    },
    async phrases() {
      if (!panel()) await toggle();
      await click('clear');
      if (el('pick').getAttribute('aria-pressed') !== 'true') await click('pick');
      const article = win().document.createElement('article'); article.dataset.testid = 'tweet';
      article.innerHTML = '<div data-testid="tweetText" lang="en">John <span>Paul</span>\n<a href="/Smith">Smith</a> Junior met Jean-Luc Picard.</div>';
      win().document.querySelector('#spacer').before(article);
      await sleep(150);
      await pick('John'); await pick('John');
      await pick('Smith', true, true);
      const preview = [...win().CSS.highlights.get('xmb-hover')].map(r => r.toString().replace(/\s+/g, ' ').trim());
      assert(preview.join('|') === 'John Paul Smith', 'Shift hover previews full phrase: ' + preview);
      await pick('Smith', true);
      assert(bag().length === 1 && bag()[0].text === 'John Paul Smith', 'full name replaces first word');
      assert([...win().CSS.highlights.get('xmb-picked')].some(r => r.toString().replace(/\s+/g, ' ').trim() === 'John Paul Smith'), 'saved phrase stays highlighted');
      await pick('Junior', true);
      assert(bag().length === 1 && bag()[0].text === 'John Paul Smith Junior', 'successive Shift clicks extend one phrase');
      await pick('Paul', true);
      assert(bag().length === 1 && bag()[0].text === 'John Paul', 'successive Shift clicks shrink the same phrase');
      await pick('Café', true);
      assert(bag().length === 1 && el('notice').textContent.includes('same post'), 'cannot span separate tweets');
      await click('clear');
      await pick('Smith'); await pick('John', true);
      assert(bag().length === 1 && bag()[0].text === 'John Paul Smith', 'backwards selection');
      await click('clear');
      await pick('Jean'); await pick('Picard', true);
      assert(bag()[0]?.text === 'Jean-Luc Picard', 'internal punctuation preserved');
      await click('clear'); await add('John');
      await pick('John'); await pick('Smith', true);
      assert(bag().map(i => i.text).join('|') === 'John|John Paul Smith', 'independent single word preserved');
      await click('clear'); await add('John Paul Smith');
      await pick('John'); await pick('Smith', true);
      assert(bag().length === 1 && bag()[0].text === 'John Paul Smith', 'existing phrase deduplicated');
      await click('clear');
      await pick('John', false, false, false); await pick('Smith', true, false, false);
      await until(() => bag().length === 1 && bag()[0].text === 'John Paul Smith', 'rapid clicks');
      assert(win().location.href === 'about:blank', 'Shift-click link did not navigate');
      // Scrolling and rebuilding text ranges must keep the initial word.
      win().dispatchEvent(new (win().Event)('resize')); await sleep(100);
      await pick('Junior', true);
      assert(bag()[0]?.text === 'John Paul Smith Junior', 'anchor survives range refresh');
      await click('clear'); await pick('John');
      win().document.dispatchEvent(new (win().KeyboardEvent)('keydown', {key: 'Escape', bubbles: true}));
      await click('pick'); await pick('Smith', true);
      assert(bag().map(i => i.text).join('|') === 'John|Smith', 'Escape resets the anchor');
      await click('clear');
      // X can reuse a tweet element for a different post: never extend an old range.
      await pick('John');
      article.querySelector('[data-testid=tweetText]').textContent = 'Alice Cooper';
      await sleep(150); await pick('Cooper', true);
      assert(bag().map(i => i.text).join('|') === 'John|Cooper', 'changed tweet invalidates anchor');
      await click('clear');
      await pick('Alice'); await pick('Cooper', true, false, false);
      const savesBefore = model.saves.length;
      await click('apply');
      await until(() => store().job.status === 'complete', 'saving picked expression', 25000);
      assert(model.saves.length === savesBefore + 1 && model.saves.at(-1).text === 'Alice Cooper', 'one expression produces one native save');
      assert(!bag().length, 'saved expression leaves the bag');
      model.saves = []; model.words = [];
      pass('Shift-click names, preview, reverse ranges, punctuation, duplicates, rapid clicks and anchor lifecycle');
      return results;
    },
    async failures() {
      model.fail = 'fail word';
      await add('first success'); await add('fail word'); await add('last pending');
      await click('apply'); await until(() => store().job.status === 'paused', 'failure', 25000);
      assert(bag().map(i => i.text).join(',') === 'fail word,last pending', 'pending bag retained');
      model.fail = null;
      await command('Resume / retry'); await until(() => store().job.status === 'complete', 'retry', 25000);
      assert(model.saves.filter(s => s.text === 'first success').length === 1, 'confirmed save never repeated');
      model.uncertain = 'uncertain';
      await add('uncertain'); await click('apply'); await until(() => store().job.status === 'paused', 'uncertain', 25000);
      await command('Resume / retry'); await until(() => store().job.status === 'complete', 'reconcile', 25000);
      assert(model.saves.filter(s => s.text === 'uncertain').length === 1, 'uncertain save never repeated');
      model.uncertain = null;
      pass('Partial failure, retry, and uncertain-save reconciliation');
      return results;
    },
    async stopAndAccount() {
      model.saveDelay = 1000;
      await add('stop first'); await add('stop second'); await click('apply');
      await until(() => model.saves.some(s => s.text === 'stop first'), 'saving');
      await command('Stop'); await sleep(1300);
      assert(store().job.status === 'paused' && !model.saves.some(s => s.text === 'stop second'), 'Stop prevents next save');
      await tabApi.remove(store().job.tabId); model.saveDelay = 0;
      await command('Resume / retry'); await until(() => store().job.status === 'complete', 'closed tab resume', 25000);
      assert(model.saves.filter(s => s.text === 'stop first').length === 1, 'resume reconciles in-flight save');
      model.account = 'different';
      await add('account guard'); await click('apply'); await until(() => store().job.status === 'paused', 'account guard', 25000);
      assert(!model.saves.some(s => s.text === 'account guard'), 'no save under different account');
      model.account = 'tester'; await command('End batch');
      assert(!errors.length, 'no JavaScript errors: ' + errors.join(','));
      pass('Stop, closed tab recovery, account guard and clean browser execution');
      return results;
    },
  };
  return {ready: true, tests: ['selection', 'phrases', 'apply', 'failures', 'stopAndAccount']};
}
