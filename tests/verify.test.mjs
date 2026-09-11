import test from 'node:test';
import assert from 'node:assert/strict';
import {signatureOf, pickOne} from '../src/verify.mjs';

test('signatureOf renders a human-readable fragment from an ABI entry', () => {
  assert.equal(
    signatureOf({type: 'function', name: 'claimFees', stateMutability: 'nonpayable',
      inputs: [{type: 'address', name: 'token'}], outputs: [{type: 'uint256'}]}),
    'function claimFees(address token) returns (uint256)');
});

test('signatureOf marks views so a read is never mistaken for a write', () => {
  assert.match(
    signatureOf({type: 'function', name: 'claimable', stateMutability: 'view',
      inputs: [{type: 'address', name: 'token'}], outputs: [{type: 'uint256'}]}),
    / view returns /);
});

test('pickOne auto-fills only a lone no-arg or single-address function', () => {
  assert.equal(pickOne(['function claimFees(address token)']), 'function claimFees(address token)');
  assert.equal(pickOne(['function claim()']), 'function claim()');
});

test('pickOne refuses when the choice is ambiguous', () => {
  assert.equal(pickOne([]), null);
  assert.equal(pickOne(['function claim()', 'function claimFees(address)']), null);
});

test('pickOne refuses a signature whose arguments it would have to invent', () => {
  assert.equal(pickOne(['function claim(address token, uint256 amount)']), null);
  assert.equal(pickOne(['function claim(uint256 positionId)']), null);
});
