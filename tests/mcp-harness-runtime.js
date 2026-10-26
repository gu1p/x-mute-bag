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
  const event = (object, key) => ({addListener: listener => {
    const previous = object[key];
    object[key] = previous ? (...args) => { previous(...args); listener(...args); } : listener;
  }});
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
    win.Function('chrome', 'location', sources['core.js'] + '\n' + sources['x-adapter.js'] + '\n' + sources['filter.js'] + '\n' + sources['content.js'])(chrome, location);
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
    async replies() {
      await until(() => store()?.accounts.tester?.filter.syncedAt > 0, 'initial import');
      await toggle();
      const make = (id, author, {above = false, below = false, label = '', text = 'An ordinary post', extra = ''} = {}) => {
        const cell = win().document.createElement('div'); cell.dataset.testid = 'cellInnerDiv'; cell.id = 'reply-test-' + id;
        // Same avatar columns and connector layout observed on the live X feed.
        cell.innerHTML = '<article data-testid="tweet"><div>' +
          (above ? '<div><div><div><div style="width:2px;position:absolute"></div></div><div></div></div></div>' : '') +
          '<div><div><div data-testid="Tweet-User-Avatar"></div>' + (below ? '<div style="width:2px;flex-grow:1"></div>' : '') + '</div><div>' +
          '<div data-testid="User-Name"><a href="/' + author + '">@' + author + '</a><a href="/' + author + '/status/123"><time>Now</time></a></div>' +
          (label ? '<div dir="ltr">Replying to <span>' + label + '</span></div>' : '') +
          '<div data-testid="tweetText">' + text + '</div>' + extra + '</div></div></div></article>';
        win().document.querySelector('main').append(cell); return cell;
      };
      const hidden = node => node.hasAttribute('data-xmb-filtered');
      const parent = make('parent', 'bob', {below: true});
      const reply = make('answer', 'Alice', {above: true});
      const original = make('original', 'alice');
      const selfParent = make('self-parent', 'alice', {below: true});
      const selfReply = make('self-reply', 'alice', {above: true});
      const labeled = make('labeled', 'alice', {label: '@bob'});
      const selfLabeled = make('self-labeled', 'alice', {label: '@alice'});
      const quote = make('quote', 'alice', {extra: '<div role="link"><div data-testid="User-Name"><a href="/alice">@alice</a></div><div dir="ltr">Replying to <span>@bob</span></div><div data-testid="tweetText">Quoted reply</div></div>'});
      const written = make('written', 'alice', {text: '<div dir="ltr">Replying to <span>@bob</span> is something I often do</div>'});
      const orphan = make('orphan', 'alice', {above: true});
      const chainParent = make('chain-parent', 'bob', {below: true});
      const chainReply = make('chain-reply', 'alice', {above: true, below: true});
      const chainLeaf = make('chain-leaf', 'carol', {above: true});
      const mismatchParent = make('mismatch-parent', 'dave', {below: true});
      const mismatchReply = make('mismatch-reply', 'alice', {above: true, label: '@bob'});
      el('reply-handle').value = 'https://x.com/ALICE';
      el('reply-form').dispatchEvent(new (win().Event)('submit', {cancelable: true}));
      await until(() => hidden(parent) && hidden(reply) && hidden(labeled) && hidden(chainReply) && hidden(mismatchReply), 'replies and attached context hidden');
      assert(win().getComputedStyle(parent).display === 'none' && reply.isConnected, 'hide complete cells without deleting DOM');
      for (const node of [original, selfParent, selfReply, selfLabeled, quote, written, orphan, chainParent, chainLeaf, mismatchParent]) assert(!hidden(node), 'preserve ' + node.id);
      assert(store().accounts.tester.replyRules.length === 1 && !model.saves.length, 'local rule saved without native mutations');
      await sleep(200);
      assert(hidden(parent) && hidden(reply), 'connectors still recognized while hidden');
      const ruleToggle = () => panel().querySelector('input[aria-label="Hide replies from @alice"]');
      ruleToggle().click(); await until(() => !hidden(parent) && !hidden(labeled), 'pause restores context and replies');
      ruleToggle().click(); await until(() => hidden(parent), 'resume rule');
      // Changing the author in a recycled node must restore both cells.
      reply.querySelector('[data-testid="User-Name"] a').setAttribute('href', '/bob');
      await until(() => !hidden(parent) && !hidden(reply), 'recycled author becomes self-thread');
      reply.querySelector('[data-testid="User-Name"] a').setAttribute('href', '/alice');
      await until(() => hidden(parent), 'updated author rematched');
      const lateParent = make('late-parent', 'bob', {below: true});
      await sleep(80); const lateReply = make('late-reply', 'alice', {above: true});
      await until(() => hidden(lateParent) && hidden(lateReply), 'newly loaded reply');
      await win().XMuteTimeline.setEnabled(false);
      assert(hidden(parent), 'reply rule independent of word toggle');
      model.account = 'other';
      win().document.querySelector('[data-testid=AppTabBar_Profile_Link]').href = '/other';
      await until(() => !hidden(parent), 'account switch restores replies');
      model.account = 'tester';
      win().document.querySelector('[data-testid=AppTabBar_Profile_Link]').href = '/tester';
      await until(() => hidden(parent), 'account-specific rules restored');
      tab().url = 'https://x.com/alice/status/123';
      win().document.querySelector('main').append(win().document.createComment('route changed'));
      await until(() => !hidden(parent) && !hidden(labeled), 'direct conversation readable');
      tab().url = 'https://x.com/home';
      win().document.querySelector('main').append(win().document.createComment('route changed'));
      await until(() => hidden(parent), 'back to feed');
      // Native cache updates, removals, and expiry must not erase local account rules.
      const state = clone(store());
      state.accounts.tester.filter.enabled = true;
      state.accounts.tester.filter.terms = [{text: 'An ordinary post', expiresAt: null, validUntil: Date.now() + 150}];
      await storage.local.set({xMuteBag: state});
      await until(() => hidden(original), 'word and author filters coexist');
      await sleep(200);
      win().document.querySelector('main').append(win().document.createComment('cache expired'));
      await until(() => !hidden(original), 'word expiry');
      assert(hidden(parent) && hidden(labeled), 'account rule does not expire');
      await mount(tab());
      const reloaded = make('reload', 'alice', {label: '@bob'});
      await until(() => hidden(reloaded), 'rule survives reload with panel closed');
      await toggle();
      panel().querySelector('button[aria-label="Remove reply rule for @alice"]').click();
      await until(() => !hidden(reloaded) && !store().accounts.tester.replyRules.length, 'remove rule restores post');
      reloaded.remove(); await click('close');
      assert(!errors.length, 'clean reply filter execution: ' + errors.join(','));
      pass('Local account rules, connected conversations, original posts, self-threads, quotes, recycling, independent word filter, accounts, routes and reload');
      return results;
    },
    async filtering() {
      await until(() => store()?.accounts.tester?.filter.syncedAt > 0, 'initial muted-word import');
      model.words = [{text: 'Silenced Person'}, {text: 'spoiler'}, {text: '🇧🇷'}];
      const sync = async () => {
        const previous = store().accounts.tester.filter.syncedAt;
        await win().XMuteTimeline.sync();
        await until(() => store().accounts.tester.filter.syncedAt > previous && store().filterSync?.status !== 'running', 'native list sync');
      };
      await sync();
      assert(!panel() || win().document.querySelector('#x-mute-bag').hidden, 'filter runs with panel closed');
      const cell = (id, html) => {
        const element = win().document.createElement('div'); element.dataset.testid = 'cellInnerDiv'; element.id = id;
        element.innerHTML = '<article data-testid="tweet">' + html + '</article>';
        win().document.querySelector('main').append(element);
        return element;
      };
      const body = text => '<div data-testid="tweetText">' + text + '</div>';
      const quoted = cell('filter-quote', body('A neutral comment') + '<div role="link">' + body('<span>Silenced</span> <b>Person</b> was quoted') + '</div>');
      const own = cell('filter-own', body('A SPOILER here'));
      const safe = cell('filter-safe', body('spoilerish and Silenced Personson'));
      const split = cell('filter-split', body('Silenced') + '<div role="link">' + body('Person') + '</div>');
      const emoji = cell('filter-emoji', body('Flag <img alt="🇧🇷">'));
      const nested = cell('filter-nested', body('Neutral') + '<article data-testid="tweet">' + body('spoiler') + '</article>');
      const metadata = cell('filter-metadata', '<div data-testid="User-Name">spoiler</div>' + body('Body stays clear'));
      await until(() => quoted.hasAttribute('data-xmb-filtered') && own.hasAttribute('data-xmb-filtered') &&
        emoji.hasAttribute('data-xmb-filtered') && nested.hasAttribute('data-xmb-filtered'), 'outer posts hidden');
      assert(win().getComputedStyle(quoted).display === 'none' && quoted.isConnected, 'entire quote cell hidden without deleting React DOM');
      assert(!safe.hasAttribute('data-xmb-filtered') && !split.hasAttribute('data-xmb-filtered') && !metadata.hasAttribute('data-xmb-filtered'), 'boundaries and separate bodies avoid false positives');
      quoted.querySelectorAll('[data-testid=tweetText]')[1].textContent = 'Now a different clean quote';
      await until(() => !quoted.hasAttribute('data-xmb-filtered'), 'recycled cell restored');
      const late = cell('filter-late', body('Initially clean'));
      await sleep(100);
      late.querySelector('article').insertAdjacentHTML('beforeend', '<div role="link">' + body('A spoiler arrives later') + '</div>');
      await until(() => late.hasAttribute('data-xmb-filtered'), 'late quoted content');
      await win().XMuteTimeline.setEnabled(false);
      await until(() => !own.hasAttribute('data-xmb-filtered') && !late.hasAttribute('data-xmb-filtered'), 'toggle restores all posts');
      await win().XMuteTimeline.setEnabled(true);
      await until(() => own.hasAttribute('data-xmb-filtered'), 'toggle enables filter');
      const terms = model.words;
      model.account = 'other'; model.words = [];
      win().document.querySelector('[data-testid=AppTabBar_Profile_Link]').href = '/other';
      await until(() => !own.hasAttribute('data-xmb-filtered') && store().accounts.other?.filter.syncedAt > 0, 'account switch isolation');
      model.account = 'tester'; model.words = terms;
      win().document.querySelector('[data-testid=AppTabBar_Profile_Link]').href = '/tester';
      await until(() => own.hasAttribute('data-xmb-filtered'), 'original account filter restored');
      await mount(tab());
      const persisted = cell('filter-persisted', body('Ordinary text') + '<div role="link">' + body('Silenced Person') + '</div>');
      await until(() => persisted.hasAttribute('data-xmb-filtered'), 'persistent filter after reload without toolbar click');
      model.words = [{text: 'spoiler'}];
      await sync();
      await until(() => !persisted.hasAttribute('data-xmb-filtered'), 'unmuted native term restored');
      await toggle(); await add('unsaved phrase');
      const unsaved = cell('filter-unsaved', body('unsaved phrase'));
      await sleep(100);
      assert(!unsaved.hasAttribute('data-xmb-filtered'), 'pending bag entries are not active mutes');
      const expiring = cell('filter-expiring', body('spoiler'));
      await until(() => expiring.hasAttribute('data-xmb-filtered'), 'active cached word');
      const state = clone(store());
      state.accounts.tester.filter.terms[0].validUntil = Date.now() + 80;
      await storage.local.set({xMuteBag: state});
      await sleep(120);
      win().document.querySelector('main').append(win().document.createComment('time advanced'));
      await until(() => !expiring.hasAttribute('data-xmb-filtered'), 'stale cache no longer hides posts');
      await click('clear');
      model.words = [];
      await sync();
      for (const element of win().document.querySelectorAll('[id^="filter-"]')) element.remove();
      await click('close');
      assert(!errors.length, 'clean filtering execution: ' + errors.join(','));
      pass('Automatic mute import, quote/outer-post filtering, boundaries, new and recycled posts, pause, accounts, reload, unmute and expiry');
      return results;
    },
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
  return {ready: true, tests: ['replies', 'filtering', 'selection', 'phrases', 'apply', 'failures', 'stopAndAccount']};
}
