import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// The shipped config is what every command loads first. A broken file here
// is a bot that cannot start, and no other test reads it.
test('config/default.json parses and carries the fields every mode depends on', async () => {
  const c = JSON.parse(await readFile('config/default.json', 'utf8'));
  assert.equal(c.mode, 'preview', 'ships in preview; live is a deliberate edit');
  assert.ok(c.policy.maxTotalExposureUsd > 0);
  assert.ok(c.policy.sizing.maxPositionPercent >= c.policy.sizing.maxOrderPercent, 'a step can never exceed the ceiling');
  assert.ok(c.policy.maxOrderUsd === null || c.policy.maxOrderUsd > 0);
  assert.ok(c.execution.tickIntervalSeconds >= 10);
  assert.ok(c.site.repriceSeconds >= 5);
  assert.equal(c.uniswap.routerVariant, null, 'resolved by npm run verify, never shipped guessed');
  assert.equal(c.pons.claim.functionName, null, 'resolved by npm run verify, never shipped guessed');
  assert.ok(c.assetScope.blockedAssetClasses.includes('memecoin'));
});
