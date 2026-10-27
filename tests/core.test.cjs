const {test} = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');
test('large local dictionaries preserve literal phrases, Unicode, overlapping prefixes and word boundaries', () => {
  const words = Array.from({length: 10000}, (_, i) => ({text: 'entry ' + i}));
  words.push(...['café do futuro', 'cat', 'cat videos', 'C++', '@someone', '🦊'].map(text => ({text})));
  const matches = C.muteMatcher(words);
  for (const text of ['entry 9999', 'A CAFÉ\nDO FUTURO!', '#cat', 'cat videos', 'C++!', '@someone', '🦊']) assert.equal(matches(text), true, text);
  for (const text of ['entry 99999', 'education', '@cat', 'catapult', 'cafe do futuro', '@someone_else', 'nothing relevant']) assert.equal(matches(text), false, text);
});
test('local words do not expire with the native cache and override duplicate native deadlines', () => {
  const terms = C.filterTerms({terms: [{text: 'expired', validUntil: 1}, {text: 'local', expiresAt: 1}, {text: 'native', validUntil: 100}]}, [{text: 'local'}, {text: 'saved'}], 50);
  assert.deepEqual(terms.map(word => word.text), ['native', 'local', 'saved']);
  assert.equal(C.muteMatcher(terms, 200)('local'), true);
  assert.equal(C.muteMatcher(terms, 200)('native'), false);
});
test('retry delays back off to five minutes without a finite retry limit', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 20, 1000].map(C.retryDelay), [30000, 60000, 120000, 240000, 300000, 300000, 300000]);
  assert.equal(C.activeJob({status: 'retrying'}), true);
  assert.equal(C.activeJob({status: 'complete'}), false);
});
test('Unicode normalization and case-insensitive deduplication preserve accents', () => {
  const bag = C.add([], '  ELEIÇÃO  ');
  assert.equal(C.add(bag, 'eleição').length, 1);
  assert.equal(C.add(bag, 'eleicao').length, 2);
  assert.equal(C.entry(' two\n words ').text, 'two words');
});
test('picker handles punctuation, apostrophes, multilingual text, hashtags and handles', () => {
  const text = '“Café,” don’t #Olá_mundo @some_user! 中文 words.';
  const tokens = C.tokens(text, 'en');
  assert.deepEqual(tokens.map(t => t.text), ['Café', 'don’t', '#Olá_mundo', '@some_user', '中文', 'words']);
  for (const token of tokens) assert.equal(text.slice(token.start, token.end), token.text);
  assert.ok(C.tokens('words', 'not_a_locale').length);
});
test('editing rejects duplicates, empty entries, and oversized phrases', () => {
  const bag = C.add(C.add([], 'cats'), 'dogs');
  assert.throws(() => C.edit(bag, bag[1].id, 'CATS'), /already/);
  assert.throws(() => C.entry('  '), /Enter/);
  assert.throws(() => C.entry('a'.repeat(281)), /280/);
  assert.equal(C.edit(bag, bag[0].id, 'big cats')[0].text, 'big cats');
});
test('text import preserves expressions and handles BOM, line endings, whitespace and Unicode duplicates', () => {
  const bag = C.add([], 'Café');
  const result = C.importText(bag, '\uFEFF CAFE\u0301\r\n\r\n John\t Smith \n#Topic\r@someone\u2028中文\u2029john smith\ncomma, stays; here\n');
  assert.deepEqual(result.bag.map(item => item.text), ['Café', 'John Smith', '#Topic', '@someone', '中文', 'comma, stays; here']);
  assert.equal(result.added, 5);
  assert.equal(result.duplicates, 2);
  assert.equal(result.bag[0].id, bag[0].id);
  assert.equal(bag.length, 1);
});
test('invalid imports report original line numbers without partially changing the bag', () => {
  const bag = C.add([], 'existing');
  assert.throws(() => C.importText(bag, 'valid\r\n\r\n' + '😀'.repeat(281)), /Line 3:.*280/);
  assert.throws(() => C.importText(bag, 'valid\nwrong\0encoding'), /Line 2:.*UTF-8/);
  assert.deepEqual(bag.map(item => item.text), ['existing']);
  for (const text of ['', '\uFEFF \r\n\t', null, ['word']]) assert.throws(() => C.importText(bag, text));
  assert.throws(() => C.importText(bag, 'é'.repeat(C.TEXT_LIMIT / 2 + 1)), /1 MB/);
  assert.equal(C.importText([], '😀'.repeat(280)).added, 1);
  assert.equal(C.importText(bag, 'EXISTING\nexisting').added, 0);
});
test('plain text exports round trip with stable ordering and no duplicate expressions', () => {
  const exported = C.exportText([{text: 'Cafe\u0301'}, {text: 'John  Smith'}, {text: 'CAFÉ'}, {text: '#topic'}, {text: '@user'}]);
  assert.deepEqual(exported, {count: 4, text: 'Café\nJohn Smith\n#topic\n@user\n'});
  assert.deepEqual(C.exportText(C.importText([], exported.text).bag), exported);
  assert.deepEqual(C.exportText([]), {count: 0, text: ''});
});
test('settings require a destination and valid X choices', () => {
  assert.throws(() => C.options({...C.DEFAULTS, home: false, notifications: false}), /Select/);
  assert.throws(() => C.options({...C.DEFAULTS, duration: '5d'}), /valid/);
  assert.deepEqual(C.options(C.DEFAULTS), C.DEFAULTS);
});
test('phrase picking replaces only its own provisional word and keeps one entry', () => {
  const first = C.pick([], 'John');
  const full = C.pick(first.bag, 'John\n Smith', first.selection);
  assert.deepEqual(full.bag.map(i => i.text), ['John Smith']);
  assert.equal(full.bag[0].id, first.bag[0].id);
  const extended = C.pick(full.bag, 'John Smith Junior', full.selection);
  assert.deepEqual(extended.bag.map(i => i.text), ['John Smith Junior']);
  assert.equal(extended.selection.owned, true);
});
test('existing or edited bag entries are not consumed by phrase picking', () => {
  const bag = C.add([], 'John');
  const first = C.pick(bag, 'JOHN');
  assert.equal(first.selection.owned, false);
  const full = C.pick(first.bag, 'John Smith');
  assert.deepEqual(full.bag.map(i => i.text), ['John', 'John Smith']);
  const initial = C.pick([], 'John');
  const edited = C.edit(initial.bag, initial.selection.id, 'some other phrase');
  assert.deepEqual(C.pick(edited, 'John Smith', initial.selection).bag.map(i => i.text), ['some other phrase', 'John Smith']);
});
test('an existing phrase absorbs a provisional word without becoming owned', () => {
  const initial = C.pick(C.add([], 'John Smith'), 'John');
  const full = C.pick(initial.bag, 'JOHN SMITH', initial.selection);
  assert.deepEqual(full.bag.map(i => i.text), ['John Smith']);
  assert.equal(full.selection.owned, false);
});
test('an invalid phrase cannot remove the provisional selection', () => {
  const initial = C.pick([], 'John');
  assert.throws(() => C.pick(initial.bag, 'a'.repeat(281), initial.selection), /280/);
  assert.deepEqual(initial.bag.map(i => i.text), ['John']);
});
test('job snapshots bag and counts confirmations separately from unresolved entries', () => {
  const bag = C.add(C.add([], 'one'), 'two');
  const job = C.createJob('person', bag, C.DEFAULTS, 1);
  bag[0].text = 'changed';
  assert.equal(job.items[0].text, 'one');
  C.finishItem(job, 'added');
  const restored = JSON.parse(JSON.stringify(job));
  C.finishItem(restored, 'skipped');
  assert.equal(restored.status, 'complete');
  assert.deepEqual(C.counts(restored), {added: 1, skipped: 1, failed: 0, total: 2});
});
test('account identities are handles, not arbitrary storage keys', () => {
  assert.equal(C.accountKey('My_Account'), 'my_account');
  for (const value of ['../x', '', 'name with spaces', null]) assert.throws(() => C.accountKey(value));
});
test('local matching respects Unicode words, accents, hashtags and literal phrases', () => {
  const matcher = C.muteMatcher(['cat', 'John Smith', 'ação', '#topic', '@some_user', 'C++', '🇧🇷'].map(text => ({text})));
  for (const text of ['A CAT!', '#cat', 'JOHN\n  SMITH', 'ação!', 'ação!', '#topic', '@some_user said', 'C++ is here', '🇧🇷']) {
    assert.equal(matcher(text), true, text);
  }
  for (const text of ['education', 'cats', 'catapult', '@cat', 'John Smithson', 'John and Smith', 'acao', 'topic', '#topical', '@some_user2', 'C--']) {
    assert.equal(matcher(text), false, text);
  }
  assert.equal(C.muteMatcher([{text: 'a.b (test)'}])('aXb test'), false);
  assert.equal(C.muteMatcher([{text: 'a.b (test)'}])('a.b (test)!'), true);
});
test('expired or stale muted rules stop matching', () => {
  const now = 100000;
  assert.equal(C.muteMatcher([{text: 'expired', expiresAt: now}], now)('expired'), false);
  assert.equal(C.muteMatcher([{text: 'stale', validUntil: now - 1}], now)('stale'), false);
  assert.equal(C.muteMatcher([{text: 'active', validUntil: now + 1, expiresAt: now + 10}], now)('active'), true);
  assert.equal(C.muteDeadline('24h', now), now + 86400000);
  assert.equal(C.muteDeadline('forever', now), null);
});
