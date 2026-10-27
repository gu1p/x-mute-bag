/* Shared, dependency-free logic. Loaded in the worker and the isolated content world. */
(() => {
  'use strict';
  const DEFAULTS = Object.freeze({home: true, notifications: true, audience: 'anyone', duration: 'forever'});
  const FILTER_SYNC_MS = 10 * 60 * 1000;
  const FILTER_CACHE_MS = 15 * 60 * 1000;
  const TEXT_LIMIT = 1024 * 1024;
  const BATCH_STALE_MS = 90000;
  const retryDelay = failures => Math.min(300000, 30000 * 2 ** Math.min(4, Math.max(0, failures - 1)));
  const activeJob = job => ['running', 'retrying', 'paused'].includes(job?.status);
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
  function importText(bag, text) {
    if (typeof text !== 'string') throw new Error('Paste text or choose a UTF-8 text file.');
    if (new TextEncoder().encode(text).length > TEXT_LIMIT) throw new Error('Keep imports to 1 MB of UTF-8 text or less.');
    const next = [...bag], seen = new Set(bag.map(item => item.key));
    let duplicates = 0, lines = 0;
    for (const [index, line] of text.split(/\r\n|[\n\r\u2028\u2029]/u).entries()) {
      if (!clean(line)) continue;
      let item;
      try {
        if (line.includes('\0')) throw new Error('Use valid UTF-8 text.');
        item = entry(line);
      } catch (error) { throw new Error('Line ' + (index + 1) + ': ' + error.message); }
      lines++;
      if (seen.has(item.key)) { duplicates++; continue; }
      seen.add(item.key);
      next.push(item);
    }
    if (!lines) throw new Error('Enter at least one word or expression, one per line.');
    return {bag: next, added: next.length - bag.length, duplicates};
  }
  function exportText(entries) {
    const unique = new Map();
    for (const item of entries) {
      const text = clean(item.text), normalized = key(text);
      if (text && !unique.has(normalized)) unique.set(normalized, text);
    }
    return {text: unique.size ? [...unique.values()].join('\n') + '\n' : '', count: unique.size};
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
      runId: crypto.randomUUID(), phase: 'check', index: 0, options: options(prefs), error: '',
      retryCount: 0, retryAt: null, pauseReason: null,
      items: bag.map(item => ({...item, status: 'pending', attempted: false})), updatedAt: Date.now()};
  }
  function finishItem(job, result) {
    if (!['added', 'skipped'].includes(result)) throw new Error('Invalid result.');
    job.items[job.index].status = result;
    job.index++;
    job.phase = 'check';
    job.error = '';
    job.retryCount = 0;
    job.retryAt = null;
    if (job.index === job.items.length) job.status = 'complete';
    job.updatedAt = Date.now();
  }
  function counts(job) {
    const count = {added: 0, skipped: 0, failed: 0, total: job?.items.length || 0};
    for (const item of job?.items || []) if (item.status in count) count[item.status]++;
    return count;
  }
  function muteDeadline(duration, now = Date.now()) {
    const hours = {'24h': 24, '7d': 168, '30d': 720}[duration];
    return hours ? now + hours * 3600000 : null;
  }
  function muteMatcher(terms, now = Date.now()) {
    // A prefix tree shares work across large dictionaries instead of running
    // one regular expression per word against every post.
    const root = {next: new Map(), end: false};
    const wordChar = /[\p{L}\p{M}\p{N}_]/u, preceding = /[\p{L}\p{M}\p{N}_@#]/u;
    const insert = word => {
      let node = root;
      for (const char of word) {
        if (!node.next.has(char)) node.next.set(char, {next: new Map(), end: false});
        node = node.next.get(char);
      }
      node.end = true;
    };
    for (const term of terms) {
      if (term.expiresAt != null && term.expiresAt <= now || term.validUntil != null && term.validUntil <= now) continue;
      const word = key(term.text);
      if (!word) continue;
      insert(word);
      if (wordChar.test([...word][0])) insert('#' + word);
    }
    return text => {
      const chars = [...key(text)];
      for (let start = 0; start < chars.length; start++) {
        if (start && preceding.test(chars[start - 1])) continue;
        let node = root;
        for (let end = start; end < chars.length; end++) {
          node = node.next.get(chars[end]);
          if (!node) break;
          if (node.end && !wordChar.test(chars[end + 1] || '')) return true;
        }
      }
      return false;
    };
  }
  function filterTerms(filter, localWords = [], now = Date.now()) {
    const terms = new Map();
    for (const term of filter?.terms || []) {
      if ((term.expiresAt == null || term.expiresAt > now) && (term.validUntil == null || term.validUntil > now)) terms.set(key(term.text), term);
    }
    for (const term of localWords) terms.set(key(term.text), {text: term.text, key: key(term.text)});
    return [...terms.values()];
  }
  function mergeWords(existing, incoming) {
    const words = new Map(existing.map(word => [key(word.text), word]));
    for (const word of incoming) {
      const normalized = key(word.text);
      if (!words.has(normalized)) words.set(normalized, entry(word.text));
    }
    return [...words.values()];
  }
  function userHandle(value) {
    const handle = typeof value === 'string' ? value.trim().replace(/^https:\/\/(?:www\.)?x\.com\/([^/?#]+)\/?(?:[?#].*)?$/i, '$1').replace(/^@/, '') : '';
    if (!/^[a-zA-Z0-9_]{1,15}$/.test(handle)) throw new Error('Enter an X @username or profile link.');
    return handle.toLowerCase();
  }
  const api = {DEFAULTS, FILTER_SYNC_MS, FILTER_CACHE_MS, TEXT_LIMIT, BATCH_STALE_MS, retryDelay, activeJob, clean, key, accountKey, userHandle, entry, options, add, importText, exportText, edit, pick, tokens, createJob, finishItem, counts, muteDeadline, muteMatcher, filterTerms, mergeWords};
  globalThis.XMuteCore = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
