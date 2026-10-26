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
  return state.accounts[account];
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
  const account = C.accountKey(message.account);
  const data = accountState(state, account);
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
        job.phase = 'verify';
        break;
      case 'runner:found': {
        if (!['check', 'verify'].includes(job.phase)) throw new Error('Unexpected save confirmation.');
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
  const locked = state.job?.account === account && ['running', 'paused'].includes(state.job.status);
  if (['add', 'pick', 'edit', 'remove', 'clear', 'options'].includes(message.type) && locked) {
    throw new Error('Finish or end the current batch before editing your bag.');
  }
  switch (message.type) {
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
    await chrome.scripting.executeScript({target: {tabId: tab.id}, files: ['core.js', 'x-adapter.js', 'content.js']});
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
    }).catch(console.error);
  }
});
