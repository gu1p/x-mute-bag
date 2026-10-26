/* Shared, dependency-free logic. Loaded in the worker and the isolated content world. */
(() => {
  'use strict';
  const DEFAULTS = Object.freeze({home: true, notifications: true, audience: 'anyone', duration: 'forever'});
  const clean = text => String(text ?? '').normalize('NFC').trim().replace(/\s+/gu, ' ');
  const key = text => clean(text).toLowerCase();
  const accountKey = value => {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_]{1,15}$/.test(value)) throw new Error('Open X and sign in to your account first.');
    return value.toLowerCase();
  };
  function entry(text, id = crypto.randomUUID()) {
    text = clean(text);
    if (!text) throw new Error('Enter a word or phrase.');
    // Match X’s standard post-length ceiling; the native form remains authoritative.
    if ([...text].length > 280) throw new Error('Keep each entry to 280 characters or fewer.');
    return {id, text, key: key(text)};
  }
  function options(value) {
    if (!value || typeof value.home !== 'boolean' || typeof value.notifications !== 'boolean' ||
        !['anyone', 'unfollowed'].includes(value.audience) || !['forever', '24h', '7d', '30d'].includes(value.duration)) {
      throw new Error('Choose valid mute settings.');
    }
    if (!value.home && !value.notifications) throw new Error('Select Home timeline, notifications, or both.');
    return {home: value.home, notifications: value.notifications, audience: value.audience, duration: value.duration};
  }
  function add(bag, text) {
    const next = entry(text);
    return bag.some(item => item.key === next.key) ? bag : [...bag, next];
  }
  function edit(bag, id, text) {
    const next = entry(text, id);
    if (bag.some(item => item.id !== id && item.key === next.key)) throw new Error('That entry is already in your bag.');
    return bag.map(item => item.id === id ? next : item);
  }
  function pick(bag, text, replace) {
    // A Shift-click may replace only the unchanged entry created by this gesture.
    const previous = bag.find(item => item.id === replace?.id && item.key === replace?.key);
    const next = entry(text, previous?.id);
    const duplicate = bag.find(item => item.id !== previous?.id && item.key === next.key);
    if (duplicate) return {
      bag: previous ? bag.filter(item => item.id !== previous.id) : bag,
      selection: {id: duplicate.id, key: duplicate.key, owned: false},
    };
    return {
      bag: previous ? bag.map(item => item.id === previous.id ? next : item) : [...bag, next],
      selection: {id: next.id, key: next.key, owned: true},
    };
  }
  function tokens(text, locale) {
    let segmenter;
    try { segmenter = new Intl.Segmenter(locale || undefined, {granularity: 'word'}); }
    catch { segmenter = new Intl.Segmenter(undefined, {granularity: 'word'}); }
    const result = [];
    // Mentions and hashtags are indivisible even when their text contains underscores.
    const specials = [...text.matchAll(/[@#][\p{L}\p{M}\p{N}_]+/gu)].map(m => ({start: m.index, end: m.index + m[0].length, text: m[0]}));
    for (const part of segmenter.segment(text)) {
      if (!part.isWordLike || specials.some(s => part.index < s.end && part.index + part.segment.length > s.start)) continue;
      result.push({start: part.index, end: part.index + part.segment.length, text: part.segment});
    }
    return [...result, ...specials].sort((a, b) => a.start - b.start);
  }
  function createJob(account, bag, prefs, sourceTabId) {
    if (!bag.length) throw new Error('Add a word to your bag first.');
    return {id: crypto.randomUUID(), account, sourceTabId, tabId: null, status: 'running',
      phase: 'check', index: 0, options: options(prefs), error: '',
      items: bag.map(item => ({...item, status: 'pending', attempted: false})), updatedAt: Date.now()};
  }
  function finishItem(job, result) {
    if (!['added', 'skipped'].includes(result)) throw new Error('Invalid result.');
    job.items[job.index].status = result;
    job.index++;
    job.phase = 'check';
    job.error = '';
    if (job.index === job.items.length) job.status = 'complete';
    job.updatedAt = Date.now();
  }
  function counts(job) {
    const count = {added: 0, skipped: 0, failed: 0, total: job?.items.length || 0};
    for (const item of job?.items || []) if (item.status in count) count[item.status]++;
    return count;
  }
  const api = {DEFAULTS, clean, key, accountKey, entry, options, add, edit, pick, tokens, createJob, finishItem, counts};
  globalThis.XMuteCore = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
