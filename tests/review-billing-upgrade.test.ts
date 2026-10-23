import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareFileReview } from '../server/services/file-review.js';
import { FileScope } from '../server/services/paths.js';
import { mediaNeedsBudgetApproval, mediaReviewContext } from '../shared/media-approval.js';
import { observeMediaBilling, mediaCostLabel } from '../shared/media-billing.js';
import { standardUsage } from '../server/providers/protocol.js';
import { usageCost } from '../server/core/context-economics.js';
test('budget gate distinguishes known free, unknown, and bounded paid service', () => {
  assert.equal(mediaNeedsBudgetApproval(0, null), false);
  for (const cost of [null, undefined, NaN, -1, Infinity])
    assert.equal(mediaNeedsBudgetApproval(cost, 10), true);
  assert.equal(mediaNeedsBudgetApproval(0.2, 0.3), false);
  assert.equal(mediaNeedsBudgetApproval(0.4, 0.3), true);
  assert.equal(mediaNeedsBudgetApproval(0.2, null), true);
  const context = mediaReviewContext(
    { id: 'x', kind: 'video', baseUrl: 'http://127.0.0.1:42/path?secret=abc', estimatedUsd: null },
    1,
  );
  assert.equal(context.localityIsAuthorization, false);
  assert.equal(JSON.stringify(context).includes('secret'), false);
});
test('billing only accepts explicit fields and preserves estimates versus reported charges', () => {
  assert.equal(observeMediaBilling({ cost: 4 }), undefined);
  const billing = { amountPath: 'billing.usd', unitsPath: 'usage.seconds', usdPerUnit: 0.1 };
  const actual = observeMediaBilling({ billing: { usd: 0 }, usage: { seconds: 20 } }, billing)!;
  assert.equal(actual.source, 'provider-reported');
  assert.equal(actual.usd, 0);
  const estimated = observeMediaBilling({ usage: { seconds: 20 } }, billing)!;
  assert.equal(estimated.source, 'usage-calculated');
  assert.equal(estimated.usd, 2);
  for (const usd of [-1, Infinity, '3', null])
    assert.equal(
      observeMediaBilling({ billing: { usd } }, { amountPath: 'billing.usd' }),
      undefined,
    );
  assert.equal(observeMediaBilling({}, { amountPath: '__proto__.cost' }), undefined);
  assert.match(mediaCostLabel({ estimatedUsd: null, actualUsd: null }, false), /unknown/);
});
test('API cache hits and misses preserve measured usage and priced components', () => {
  const usage = standardUsage({
    prompt_tokens: 1000,
    prompt_cache_hit_tokens: 800,
    prompt_cache_miss_tokens: 200,
    completion_tokens: 100,
  });
  assert.equal(usage.uncached, 200);
  assert.equal(usage.cached, 800);
  assert.equal(usageCost(usage, { input: 2, cached: 0.2, output: 4 }), 0.00096);
  assert.equal(usageCost(usage, { input: null, cached: null, output: null }), null);
});
test('file preview never writes and invalidates changed bytes before execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'file-review-'));
  const file = join(root, 'a.txt');
  await writeFile(file, 'before');
  const files = new FileScope([root]);
  const review = await prepareFileReview(files, 'edit_file', {
    path: file,
    oldText: 'before',
    newText: 'after',
  });
  assert.equal(await readFile(file, 'utf8'), 'before');
  assert.equal(review!.evidence[0].after, 'after');
  await review!.revalidate();
  await writeFile(file, 'third party edit');
  await assert.rejects(review!.revalidate(), /File changed/);
  const fresh = join(root, 'new.txt');
  const creation = await prepareFileReview(files, 'write_file', { path: fresh, content: 'new' });
  assert.equal(creation!.evidence[0].operation, 'create');
  await creation!.revalidate();
  await assert.rejects(
    prepareFileReview(files, 'write_file', {
      path: join(root, '..', 'outside.txt'),
      content: 'bad',
    }),
  );
});

test('distant changes retain every changed region without carrying unchanged middle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-diff-'));
  const file = join(root, 'source.txt');
  const middle = 'unchanged line\n'.repeat(3000);
  const before = 'old start\n' + middle + 'old end\n';
  await writeFile(file, before);
  const review = await prepareFileReview(new FileScope([root]), 'write_file', {
    path: file,
    content: 'new start\n' + middle + 'new end\n',
  });
  const evidence = review!.evidence[0];
  assert.equal(evidence.truncated, false);
  assert.equal(evidence.completeChangedRegions, true);
  assert.match(evidence.before, /old start/);
  assert.match(evidence.before, /old end/);
  assert.match(evidence.after, /new start/);
  assert.match(evidence.after, /new end/);
  assert(evidence.after.length < 1000);
  assert.equal(await readFile(file, 'utf8'), before);
});

test('oversized actual changes request smaller edits before any mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-limit-'));
  const file = join(root, 'source.txt');
  await writeFile(file, 'original');
  await assert.rejects(
    prepareFileReview(new FileScope([root]), 'write_file', {
      path: file,
      content: 'changed\n'.repeat(4000),
    }),
    (e: any) => e.code === 'FILE_REVIEW_TOO_LARGE',
  );
  assert.equal(await readFile(file, 'utf8'), 'original');
});
