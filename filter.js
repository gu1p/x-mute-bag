/* Continuous, account-scoped filtering, independent of the word picker panel. */
(() => {
  'use strict';
  if (globalThis.XMuteTimeline) return;
  const C = XMuteCore, X = XMuteX;
  let account = null, data = null, syncing = false, loading = null, requestingSync = false;
  let timer = null, inspecting = false, imported = '', hidden = new Set(), hiddenCount = 0;
  let lastStatus = '', matcher = () => false, matcherUntil = 0;
  const listeners = new Set();
  const style = document.createElement('style');
  style.textContent = '[data-xmb-filtered="true"]{display:none!important}';
  document.documentElement.append(style);
  async function request(type, fields = {}) {
    const reply = await chrome.runtime.sendMessage({type, account: X.account(), ...fields});
    if (!reply?.ok) throw new Error(reply?.error || 'Refresh X after reloading the extension.');
    return reply.value;
  }
  const alive = term => (term.expiresAt == null || term.expiresAt > Date.now()) &&
    (term.validUntil == null || term.validUntil > Date.now());
  function status() {
    return {enabled: data?.enabled ?? true, words: data?.terms.filter(alive).length || 0,
      hidden: hiddenCount, syncing, synced: !!data?.syncedAt, error: data?.error || ''};
  }
  function notify() {
    const current = JSON.stringify(status());
    if (current === lastStatus) return;
    lastStatus = current;
    for (const listener of listeners) listener();
  }
  function accept(value, expected) {
    if (X.account() !== expected) return;
    account = expected; data = value.filter; syncing = value.syncing;
    matcher = C.muteMatcher(data.terms);
    const deadlines = data.terms.flatMap(term => [term.expiresAt, term.validUntil]).filter(time => time > Date.now());
    matcherUntil = deadlines.length ? Math.min(...deadlines) : Infinity;
    schedule(); notify();
  }
  async function sync(force = false) {
    const expected = X.account();
    if (!expected || requestingSync || !data?.enabled) return;
    if (!force && (Date.now() - data.syncedAt < C.FILTER_SYNC_MS || Date.now() - data.lastAttemptAt < 60000)) return;
    requestingSync = true;
    try { accept(await request('filters:sync', {force, account: expected}), expected); }
    catch (error) { if (account === expected && data) { data.error = error.message; notify(); } }
    finally { requestingSync = false; }
  }
  async function load() {
    const expected = X.account();
    if (!expected || loading === expected) return;
    loading = expected;
    try {
      accept(await request('filters:get', {account: expected}), expected);
      // A settings page can import directly; it does not need another tab.
      if (location.pathname !== X.LIST) await sync();
    } catch (error) {
      if (data) { data.error = error.message; notify(); }
    } finally { if (loading === expected) loading = null; }
  }
  function restore() {
    for (const element of hidden) element.removeAttribute('data-xmb-filtered');
    hidden.clear(); hiddenCount = 0;
  }
  function schedule() {
    if (timer == null) timer = setTimeout(() => { timer = null; scan(); }, 25);
  }
  function scan() {
    const current = X.account();
    if (current !== account) {
      restore(); data = null; account = null; syncing = false;
      if (current) load();
      notify(); return;
    }
    if (!current || !data?.enabled || /^\/(settings|messages|compose|i\/chat)(\/|$)/.test(location.pathname)) {
      restore(); notify(); return;
    }
    if (Date.now() >= matcherUntil) {
      matcher = C.muteMatcher(data.terms);
      matcherUntil = Infinity;
      const deadlines = data.terms.flatMap(term => [term.expiresAt, term.validUntil]).filter(time => time > Date.now());
      if (deadlines.length) matcherUntil = Math.min(...deadlines);
    }
    const next = new Set();
    hiddenCount = 0;
    for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
      if (article.parentElement.closest('article[data-testid="tweet"]') || article.closest('[role="dialog"],[contenteditable="true"]')) continue;
      // Evaluate each body separately: never join the end of a quote to its comment.
      if (!X.postTexts(article).some(matcher)) continue;
      const cell = article.closest('[data-testid="cellInnerDiv"]');
      const outerPosts = cell && [...cell.querySelectorAll('article[data-testid="tweet"]')].filter(post => !post.parentElement.closest('article[data-testid="tweet"]'));
      next.add(cell && outerPosts.length === 1 ? cell : article);
      hiddenCount++;
    }
    for (const element of hidden) if (!next.has(element)) element.removeAttribute('data-xmb-filtered');
    for (const element of next) if (element.getAttribute('data-xmb-filtered') !== 'true') element.setAttribute('data-xmb-filtered', 'true');
    hidden = next;
    notify();
  }
  async function inspectList() {
    if (inspecting) return;
    inspecting = true;
    let job;
    try {
      job = await request('filters:discover');
      if (!job && location.pathname !== X.LIST) return;
      const start = Date.now();
      let signature = '', stableSince = start;
      while (Date.now() - start < 20000) {
        const actual = X.account();
        if (job && actual && job.account !== actual) throw new Error('The X account changed during sync.');
        if (location.pathname !== X.LIST) {
          if (job) throw new Error('The sync tab left muted-word settings.');
          return;
        }
        const words = X.mutedSnapshot();
        if (actual && words) {
          const next = actual + ':' + JSON.stringify(words);
          if (next !== signature) { signature = next; stableSince = Date.now(); }
          if (Date.now() - stableSince >= 750) {
            if (signature !== imported || job) {
              await request('filters:import', {account: actual, words, syncId: job?.id});
              imported = signature;
            }
            return;
          }
        } else { signature = ''; stableSince = Date.now(); }
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      throw new Error('Could not read X’s muted-word list. Open it in English and try syncing again.');
    } catch (error) {
      if (job) await request('filters:failed', {account: job.account, syncId: job.id, error: error.message}).catch(() => {});
    } finally { inspecting = false; }
  }
  globalThis.XMuteTimeline = {
    status,
    subscribe(listener) { listeners.add(listener); },
    async setEnabled(enabled) {
      const expected = X.account();
      accept(await request('filters:toggle', {enabled, account: expected}), expected);
      if (enabled) await sync();
    },
    async sync() { await sync(true); },
  };
  new MutationObserver(() => {
    schedule();
    if (location.pathname === X.LIST) inspectList();
  }).observe(document.documentElement, {childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ['href', 'data-testid', 'alt']});
  chrome.runtime.onMessage.addListener(message => {
    if (message.type === 'RUN') { inspectList(); schedule(); }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.xMuteBag) return;
    const next = changes.xMuteBag.newValue, expected = X.account();
    const filter = expected && next?.accounts?.[expected]?.filter;
    if (filter) accept({filter, syncing: next.filterSync?.account === expected && next.filterSync.status === 'running'}, expected);
    else { account = null; data = null; restore(); schedule(); }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { schedule(); load(); }
  });
  // Backstop for expired rules, account switches, and pages left open all day.
  setInterval(() => { schedule(); load(); }, 30000);
  schedule();
  inspectList();
})();
