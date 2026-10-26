const {test} = require('node:test');
const assert = require('node:assert/strict');
const C = require('../core.js');
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
