import test from 'node:test';
import assert from 'node:assert/strict';
import {
  boundedReview,
  decideAssessment,
  assessmentSchema,
  reviewValidationIssue,
} from '../server/services/review-policy.js';
const base = {
  risk: 'low',
  authorization: 'explicit',
  evidence: [0],
  bounded: true,
  effectsKnown: true,
  sensitiveData: false,
  securityChange: false,
  reason: 'bounded',
};
test('host owns risk/authorization matrix and rejects invalid evidence', () => {
  for (const risk of ['low', 'medium', 'high', 'critical', 'unknown'])
    for (const authorization of ['explicit', 'implicit', 'none', 'unknown']) {
      const allow =
        ['low', 'medium'].includes(risk) && ['explicit', 'implicit'].includes(authorization);
      assert.equal(
        decideAssessment({ ...base, risk, authorization }, [0]).decision,
        allow ? 'allow' : 'ask',
      );
    }
  for (const override of [
    { evidence: [] },
    { evidence: [99] },
    { bounded: false },
    { effectsKnown: false },
    { sensitiveData: true },
    { securityChange: true },
  ])
    assert.equal(decideAssessment({ ...base, ...override }, [0]).decision, 'ask');
  for (const value of [
    { decision: 'allow' },
    { ...base, decision: 'allow' },
    { ...base, bounded: 'true' },
    { ...base, evidence: ['0'] },
  ])
    assert.throws(() => decideAssessment(value, [0]));
});
test('uncooperative provider cannot keep review waiting or authorize late', async () => {
  const c = new AbortController();
  let finish!: (v: string) => void;
  const p = boundedReview(
    new Promise<string>((r) => {
      finish = r;
    }),
    c.signal,
  );
  c.abort(new Error('deadline'));
  await assert.rejects(p, /deadline/);
  finish('allow');
});

test('high impact needs explicit consent and evidenced recovery, without bypassing restrictions', () => {
  const high = {
    ...base,
    risk: 'high',
    recovery: {
      kind: 'recoverable',
      evidence: 'host read verified backup manifest and restore procedure',
      boundedImpact: 'one user-selected disposable output directory',
    },
  };
  assert.equal(decideAssessment(high, [0]).decision, 'allow');
  for (const override of [
    { authorization: 'implicit' },
    { evidence: [99] },
    { bounded: false },
    { effectsKnown: false },
    { sensitiveData: true },
    { securityChange: true },
    { risk: 'critical' },
    { recovery: undefined },
    { recovery: { ...high.recovery, kind: 'unknown' } },
    { recovery: { ...high.recovery, kind: 'irreversible' } },
  ])
    assert.equal(decideAssessment({ ...high, ...override }, [0]).decision, 'ask');
});

test('review schema diagnostics identify missing facts without disclosing model output', () => {
  const result = assessmentSchema.safeParse({
    ...base,
    effectsKnown: 'secret-value',
    secret: 'private',
  });
  assert.equal(result.success, false);
  if (!result.success) {
    const issue = reviewValidationIssue(result.error);
    assert.equal(issue.category, 'schema');
    assert.match(JSON.stringify(issue), /effectsKnown/);
    assert(!JSON.stringify(issue).includes('secret'));
    assert(!JSON.stringify(issue).includes('private'));
  }
  assert.equal(reviewValidationIssue(new SyntaxError('private JSON text')).category, 'json');
});

test('material evidence gaps get bounded inspection without changing the approval matrix', () => {
  for (const change of [{ bounded: false }, { effectsKnown: false }, { risk: 'high' }]) {
    const result = decideAssessment({ ...base, authorization: 'implicit', ...change }, [0]);
    assert.equal(result.decision, 'ask');
    assert.equal(result.replan?.kind, 'inspect');
    assert.match(result.replan!.instruction, /not approved/);
  }
  const irreversible = {
    ...base,
    risk: 'high',
    authorization: 'implicit',
    recovery: {
      kind: 'irreversible',
      evidence: 'No retained copy',
      boundedImpact: 'unique local experiment records',
    },
  };
  assert.equal(decideAssessment(irreversible, [0]).decision, 'ask');
  assert.equal(decideAssessment(irreversible, [0]).replan, undefined);
  for (const change of [
    { authorization: 'none' },
    { authorization: 'unknown' },
    { evidence: [90] },
    { sensitiveData: true },
    { securityChange: true },
    { risk: 'critical' },
    { clarification: 'Do you authorize deleting the unique data?' },
  ]) {
    assert.equal(
      decideAssessment({ ...base, effectsKnown: false, ...change }, [0]).replan,
      undefined,
    );
  }
  assert.equal(decideAssessment({ ...base, authorization: 'implicit' }, [0]).decision, 'allow');
});
