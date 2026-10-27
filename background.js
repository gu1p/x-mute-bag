/* The service worker is the only writer of extension state. */
importScripts('core.js');
const C = XMuteCore;
const STORE = 'xMuteBag';
let serial = Promise.resolve();
function exclusively(task) {
  const next = serial.then(task);
  serial = next.catch(() => {});
  return next;
}
async function readStore() {
  return (await chrome.storage.local.get(STORE))[STORE] || {version: 1, accounts: {}, job: null};
}
async function persist(state) {
  await chrome.storage.local.set({[STORE]: state});
}
const boot = (async () => {
  const session = await chrome.storage.session.get('awake');
  if (!session.awake) {
    const state = await readStore();
    if (state.job?.status === 'running') {
      state.job.status = 'paused';
      state.job.error = 'Browser session interrupted. Resume to check saved words and continue.';
      await persist(state);
    }
    if (state.filterSync?.status === 'running') {
      state.filterSync.status = 'interrupted';
      await persist(state);
    }
    await chrome.storage.session.set({awake: true});
  }
})();
function validSender(sender) {
  return sender.id === chrome.runtime.id && sender.tab?.id != null &&
    new URL(sender.url || sender.tab.url).origin === 'https://x.com';
}
function accountState(state, account) {
  if (!Object.hasOwn(state.accounts, account)) Object.defineProperty(state.accounts, account, {
    value: {bag: [], options: {...C.DEFAULTS}}, enumerable: true, writable: true, configurable: true,
  });
  const data = state.accounts[account];
  data.filter ||= {enabled: true, terms: [], syncedAt: 0, lastAttemptAt: 0, error: ''};
  data.replyRules ||= [];
  return data;
}
function filterView(state, account) {
  const data = accountState(state, account);
  return {filter: data.filter, replyRules: data.replyRules, syncing: state.filterSync?.account === account && state.filterSync.status === 'running'};
}
async function closeSync(state, error = '') {
  const sync = state.filterSync;
  if (!sync || sync.status !== 'running') return;
  sync.status = error ? 'failed' : 'complete';
  accountState(state, sync.account).filter.error = error;
  await persist(state);
  try {
    const tab = await chrome.tabs.get(sync.tabId);
    if (new URL(tab.url || tab.pendingUrl).href === 'https://x.com/settings/muted_keywords') await chrome.tabs.remove(sync.tabId);
  } catch {}
}
async function filters(message, sender, state, account) {
  const data = accountState(state, account), now = Date.now();
  const sync = state.filterSync;
  if (message.type === 'filters:get') return filterView(state, account);
  if (message.type === 'filters:toggle') {
    if (typeof message.enabled !== 'boolean') throw new Error('Choose whether to enable filtering.');
    data.filter.enabled = message.enabled;
    await persist(state);
    return filterView(state, account);
  }
  if (message.type === 'filters:failed') {
    if (sync?.id === message.syncId && sync.tabId === sender.tab.id && sync.account === account) {
      await closeSync(state, String(message.error || 'Could not read X’s muted words.').slice(0, 300));
    }
    return filterView(state, account);
  }
  if (message.type === 'filters:import') {
    if (new URL(sender.url || sender.tab.url).pathname !== '/settings/muted_keywords' || !Array.isArray(message.words)) {
      throw new Error('Muted words can only be imported from X’s settings list.');
    }
    if (message.syncId && (sync?.id !== message.syncId || sync.tabId !== sender.tab.id || sync.account !== account || sync.status !== 'running')) {
      throw new Error('This muted-word sync is no longer active.');
    }
    const old = new Map(data.filter.terms.map(term => [term.key, term]));
    const unique = new Map();
    for (const word of message.words) {
      if (typeof word?.text !== 'string' || typeof word.forever !== 'boolean') throw new Error('Unrecognized muted-word entry.');
      const parsed = C.entry(word.text);
      const previousDeadline = old.get(parsed.key)?.expiresAt;
      // A word still present after its old deadline may have been renewed in X.
      const expiresAt = !word.forever && previousDeadline > now ? previousDeadline : null;
      unique.set(parsed.key, {text: parsed.text, key: parsed.key, expiresAt, validUntil: now + C.FILTER_CACHE_MS});
    }
    data.filter.terms = [...unique.values()];
    data.filter.syncedAt = now;
    data.filter.error = '';
    await persist(state);
    if (sync?.status === 'running' && sync.account === account && sync.tabId === sender.tab.id) await closeSync(state);
    return filterView(state, account);
  }
  if (message.type !== 'filters:sync') throw new Error('Unsupported filter request.');
  if (!data.filter.enabled || state.job?.status === 'running') return filterView(state, account);
  if (sync?.status === 'running') {
    if (now - sync.startedAt < 45000) return filterView(state, account);
    await closeSync(state, 'Muted-word sync timed out. Try Sync muted words again.');
  }
  if (!message.force && (now - data.filter.syncedAt < C.FILTER_SYNC_MS || now - data.filter.lastAttemptAt < 60000)) return filterView(state, account);
  data.filter.lastAttemptAt = now;
  data.filter.error = '';
  state.filterSync = {id: crypto.randomUUID(), account, status: 'running', tabId: null, startedAt: now};
  await persist(state);
  try {
    const tab = await chrome.tabs.create({url: 'https://x.com/settings/muted_keywords', active: false});
    state.filterSync.tabId = tab.id;
    await persist(state);
    await kick(tab.id);
  } catch (error) {
    state.filterSync.status = 'failed';
    data.filter.error = error.message;
    await persist(state);
  }
  return filterView(state, account);
}
function view(state, account) {
  return {account, ...accountState(state, account), job: state.job?.account === account ? state.job : null};
}
function currentJob(state, account) {
  const job = state.job;
  if (!job || job.account !== account || !['running', 'paused'].includes(job.status)) throw new Error('There is no active batch for this account.');
  return job;
}
function pause(job, error) {
  job.status = 'paused';
  job.error = String(error || 'The batch was paused.').slice(0, 500);
  job.updatedAt = Date.now();
  if (job.items[job.index]) job.items[job.index].status = 'failed';
}
async function kick(tabId) {
  if (tabId != null) await chrome.tabs.sendMessage(tabId, {type: 'RUN'}).catch(() => {});
}
async function runnerTab(job) {
  if (job.tabId != null) {
    try {
      const tab = await chrome.tabs.get(job.tabId);
      if (new URL(tab.url || tab.pendingUrl).origin === 'https://x.com') {
        await chrome.tabs.update(tab.id, {url: 'https://x.com/settings/muted_keywords'});
        return tab.id;
      }
    } catch {}
  }
  return (await chrome.tabs.create({url: 'https://x.com/settings/muted_keywords', active: false})).id;
}
async function handle(message, sender) {
  await boot;
  if (!validSender(sender) || !message || typeof message.type !== 'string') throw new Error('Unsupported request.');
  const state = await readStore();
  // Runner discovery must work even before X finishes rendering the account link.
  if (message.type === 'runner:discover') {
    return state.job?.tabId === sender.tab.id && state.job.status === 'running' ? state.job : null;
  }
  if (message.type === 'filters:discover') {
    return state.filterSync?.tabId === sender.tab.id && state.filterSync.status === 'running' ? state.filterSync : null;
  }
  const account = C.accountKey(message.account);
  const data = accountState(state, account);
  if (message.type.startsWith('filters:')) return filters(message, sender, state, account);
  if (message.type.startsWith('replies:')) {
    const handle = C.userHandle(message.handle);
    const rule = data.replyRules.find(item => item.handle === handle);
    if (message.type === 'replies:add') {
      if (rule) rule.enabled = true;
      else data.replyRules.push({handle, enabled: true});
    } else if (message.type === 'replies:toggle') {
      if (!rule || typeof message.enabled !== 'boolean') throw new Error('Choose an existing account rule to enable or disable.');
      rule.enabled = message.enabled;
    } else if (message.type === 'replies:remove') {
      data.replyRules = data.replyRules.filter(item => item.handle !== handle);
    } else throw new Error('Unsupported account rule request.');
    await persist(state);
    return view(state, account);
  }
  const isRunner = message.type.startsWith('runner:');
  if (isRunner) {
    const job = currentJob(state, account);
    if (job.tabId !== sender.tab.id || job.id !== message.jobId || job.status !== 'running') throw new Error('This batch is no longer running.');
    const item = job.items[job.index];
    if (message.itemId !== item.id) throw new Error('This entry has already advanced.');
    switch (message.type) {
      case 'runner:missing':
        if (job.phase !== 'check') throw new Error('The save could not be confirmed. Retry to check the muted list again.');
        job.phase = 'form';
        break;
      case 'runner:submit':
        if (job.phase !== 'form') throw new Error('This entry has already been submitted.');
        // Commit uncertainty BEFORE clicking Save. A reload must verify, never resubmit.
        item.attempted = true;
        item.attemptedAt = Date.now();
        job.phase = 'verify';
        break;
      case 'runner:found': {
        if (!['check', 'verify'].includes(job.phase)) throw new Error('Unexpected save confirmation.');
        if (item.attempted) {
          const term = {text: item.text, key: item.key, expiresAt: C.muteDeadline(job.options.duration, item.attemptedAt || Date.now()), validUntil: Date.now() + C.FILTER_CACHE_MS};
          data.filter.terms = [...data.filter.terms.filter(word => word.key !== term.key), term];
        }
        C.finishItem(job, item.attempted ? 'added' : 'skipped');
        data.bag = data.bag.filter(word => word.id !== item.id);
        break;
      }
      case 'runner:pause':
        pause(job, message.error);
        break;
      default: throw new Error('Unsupported runner request.');
    }
    job.updatedAt = Date.now();
    await persist(state);
    if (job.status === 'complete') {
      // Only the tab created for this batch is eligible for automatic closure.
      await chrome.tabs.remove(job.tabId).catch(() => {});
    }
    return job;
  }
  if (message.type === 'view') return view(state, account);
  if (message.type === 'text:export') {
    if (!['bag', 'all'].includes(message.scope)) throw new Error('Choose which words to export.');
    const muted = message.scope === 'all' ? data.filter.terms.filter(term => term.expiresAt == null || term.expiresAt > Date.now()) : [];
    return {account, ...C.exportText([...muted, ...data.bag])};
  }
  const locked = state.job?.account === account && ['running', 'paused'].includes(state.job.status);
  if (['add', 'pick', 'edit', 'remove', 'clear', 'options', 'text:import'].includes(message.type) && locked) {
    throw new Error('Finish or end the current batch before editing your bag.');
  }
  switch (message.type) {
    case 'text:import': {
      const {bag, added, duplicates} = C.importText(data.bag, message.text);
      data.bag = bag;
      await persist(state);
      return {...view(state, account), imported: {added, duplicates}};
    }
    case 'pick': {
      const result = C.pick(data.bag, message.text, message.replace);
      data.bag = result.bag;
      await persist(state);
      return {...view(state, account), selection: result.selection};
    }
    case 'add': data.bag = C.add(data.bag, message.text); break;
    case 'edit': data.bag = C.edit(data.bag, message.id, message.text); break;
    case 'remove': data.bag = data.bag.filter(item => item.id !== message.id); break;
    case 'clear': data.bag = []; break;
    case 'options': data.options = C.options(message.options); break;
    case 'apply': {
      if (['running', 'paused'].includes(state.job?.status)) throw new Error('Finish or end the existing batch first.');
      await closeSync(state);
      state.job = C.createJob(account, data.bag, data.options, sender.tab.id);
      // Persist the intent before allocating the tab.
      await persist(state);
      try { state.job.tabId = await runnerTab(state.job); }
      catch (error) { pause(state.job, error.message); }
      break;
    }
    case 'stop': pause(currentJob(state, account), 'Stopped. Resume when you are ready; saved words stay muted.'); break;
    case 'resume': {
      const job = currentJob(state, account);
      if (job.status !== 'paused') throw new Error('This batch is already running.');
      job.status = 'running';
      job.phase = 'check';
      job.error = '';
      job.items[job.index].status = 'pending';
      try { job.tabId = await runnerTab(job); }
      catch (error) { pause(job, error.message); }
      break;
    }
    case 'end': {
      const job = currentJob(state, account);
      job.status = 'stopped';
      job.error = 'Batch ended. Unsaved entries are still in your bag.';
      break;
    }
    case 'show-tab': {
      const job = currentJob(state, account);
      if (job.tabId != null) await chrome.tabs.update(job.tabId, {active: true}).catch(() => { throw new Error('The settings tab is closed. Use Resume to open it again.'); });
      return view(state, account);
    }
    default: throw new Error('Unsupported request.');
  }
  await persist(state);
  if (['apply', 'resume'].includes(message.type) && state.job.status === 'running') await kick(state.job.tabId);
  return view(state, account);
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  exclusively(() => handle(message, sender)).then(
    value => respond({ok: true, value}),
    error => respond({ok: false, error: error.message})
  );
  return true;
});
async function activateTab(tab) {
  if (!tab.url?.startsWith('https://x.com/')) {
    await chrome.action.setBadgeText({tabId: tab.id, text: 'X'});
    await chrome.action.setTitle({tabId: tab.id, title: 'Open x.com and click here to pick words'});
    return;
  }
  await chrome.action.setBadgeText({tabId: tab.id, text: ''});
  try { await chrome.tabs.sendMessage(tab.id, {type: 'TOGGLE'}); }
  catch {
    await chrome.scripting.executeScript({target: {tabId: tab.id}, files: ['core.js', 'x-adapter.js', 'filter.js', 'content.js']});
    await chrome.tabs.sendMessage(tab.id, {type: 'TOGGLE'});
  }
}
chrome.action.onClicked.addListener(tab => activateTab(tab).catch(console.error));
chrome.tabs.onRemoved.addListener(tabId => {
  exclusively(async () => {
    await boot;
    const state = await readStore();
    if (state.job?.tabId === tabId && state.job.status === 'running') {
      pause(state.job, 'The settings tab was closed. Resume to check progress and continue.');
      state.job.tabId = null;
      await persist(state);
    }
    if (state.filterSync?.tabId === tabId && state.filterSync.status === 'running') {
      state.filterSync.status = 'failed';
      accountState(state, state.filterSync.account).filter.error = 'The muted-word sync tab was closed. Try syncing again.';
      await persist(state);
    }
  }).catch(console.error);
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'complete') kick(tabId);
  if (change.url && !change.url.startsWith('https://x.com/')) {
    exclusively(async () => {
      await boot;
      const state = await readStore();
      if (state.job?.tabId === tabId && state.job.status === 'running') {
        pause(state.job, 'The settings tab left X. Resume to continue.');
        state.job.tabId = null;
        await persist(state);
      }
      if (state.filterSync?.tabId === tabId && state.filterSync.status === 'running') {
        // The user navigated this tab elsewhere; stop owning it.
        state.filterSync.status = 'failed';
        accountState(state, state.filterSync.account).filter.error = 'The sync tab left X. Try syncing again.';
        await persist(state);
      }
    }).catch(console.error);
  }
});
