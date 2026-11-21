import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CODE, cleanName, codesIn, joinText, newCode } from '../src/invites.js';

test('invite codes are 8 characters with no look-alikes (I, O, 0, 1)', () => {
  for (let i = 0; i < 500; i++) {
    const code = newCode();
    assert.match(code, CODE);
    assert.doesNotMatch(code, /[IO01]/);
  }
});

test('the prefilled join text carries its code back', () => {
  const code = newCode();
  assert.deepEqual(codesIn(joinText(code)), [code]);
  assert.deepEqual(codesIn(`${joinText(code)} 🎉`), [code]);
});

test('ordinary texts carry no code', () => {
  assert.deepEqual(codesIn('Hi Sticky'), []);
  assert.deepEqual(codesIn('join group k7q2mxrp'), []); // codes are upper case
  assert.deepEqual(codesIn('make it 8 seconds and open on the dog'), []);
  assert.deepEqual(codesIn('K7Q2MXRP1'), []); // nine characters is not a code
});

test('group names are one tidy line, at most 40 characters, "sticky" when blank', () => {
  assert.equal(cleanName('  Ali’s   birthday \n crew '), 'Ali’s birthday crew');
  assert.equal(cleanName(''), 'sticky');
  assert.equal(cleanName(undefined), 'sticky');
  assert.equal(cleanName('\u0000​'), 'sticky');
  assert.equal([...cleanName('🎬'.repeat(60))].length, 40);
});
