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
