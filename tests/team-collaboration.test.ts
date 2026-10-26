import { finalizeRun } from '../server/core/finalization.js';
import { FileScope } from '../server/services/paths.js';
import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/storage/store.js';
import { Teams } from '../server/services/team-space.js';
import { TeamCollaboration } from '../server/services/team-collaboration.js';
import { deliveryEvidence } from '../server/services/delivery-evidence.js';
function fixture(required = true) {
  const store = new Store(':memory:');
  const lead: any = {
    id: 'lead',
    conversationId: 'lead-chat',
    parentRunId: null,
    status: 'running',
    createdAt: 1,
    checkpoints: [],
  };
  const author: any = { ...lead, id: 'author', conversationId: 'author-chat', parentRunId: 'lead' };
  const reviewer: any = { ...author, id: 'reviewer', conversationId: 'reviewer-chat' };
  const outsider: any = { ...author, id: 'outsider', conversationId: 'outsider-chat' };
  for (const run of [lead, author, reviewer, outsider]) {
    store.put('run', run);
    store.put('conversation', { id: run.conversationId, teamMode: 'auto', teamStrategy: 'auto' });
  }
  const teams = new Teams(store);
  teams.configure(
    lead,
    'creative',
    ['lead', 'author', 'reviewer', 'outsider'],
    20,
    true,
    'Interacting constraints',
    required,
  );
  const service = new TeamCollaboration(store);
  const submit = () =>
    service.submit(author, {
      title: 'Design decision',
      content: 'Version one output',
      reviewerRunIds: ['reviewer'],
      changeNote: 'Check the dependent constraint',
    });
  return { store, lead, author, reviewer, outsider, teams, service, submit };
}
function review(f: ReturnType<typeof fixture>, ...args: Parameters<TeamCollaboration['review']>) {
  f.service.read(args[0], args[1]);
  return f.service.review(...args);
}
test('independent aggregation adds no obligatory discussion; declared cross-review cannot finish without proposal', () => {
  for (const required of [false, true]) {
    const f = fixture(required);
    try {
      assert.equal(f.service.summary(f.lead).missing, required);
      if (required) {
        assert.throws(() => f.teams.close(f.lead, 'Done'), /peer review/);
        assert.equal(deliveryEvidence(f.store, f.lead).verdict, 'red');
      } else {
        assert.equal(f.service.blockers(f.lead).length, 0);
        f.teams.close(f.lead, 'Independent work aggregated');
      }
    } finally {
      f.store.close();
    }
  }
});
test('specific concern requires author response and reviewer reassessment; changed versions invalidate acceptance', () => {
  const f = fixture();
  try {
    let p = f.submit();
    assert.throws(
      () => review(f, f.author, p.id, p.revision, 'accept', 'Self vote'),
      /independent/,
    );
    p = review(
      f,
      f.reviewer,
      p.id,
      p.revision,
      'changes-requested',
      'The requested interface cannot consume this output',
    );
    assert.throws(
      () => review(f, f.reviewer, p.id, p.revision, 'accept', 'Never mind'),
      /author response/,
    );
    p = f.service.respond(
      f.author,
      p.id,
      p.revision,
      f.reviewer.conversationId,
      'The adapter already supports this representation; retain it for these reasons',
    );
    assert.equal(f.service.state(p), 'awaiting-recheck');
    assert(f.service.blockers(f.lead).length > 0);
    p = review(
      f,
      f.reviewer,
      p.id,
      p.revision,
      'accept',
      'Adapter constraint addressed by the response',
    );
    assert.equal(f.service.state(p), 'reviewed');
    p = f.service.submit(f.author, {
      id: p.id,
      revision: p.revision,
      title: p.title,
      content: 'Version two output',
      reviewerRunIds: ['reviewer'],
      changeNote: 'New constraint requires a changed output',
    });
    assert.equal(f.service.state(p), 'awaiting-review');
    assert.equal(p.versions.length, 2);
    assert.equal(p.reviews.length, 2);
    assert.throws(() => review(f, f.reviewer, p.id, p.revision - 1, 'accept', 'Stale'), /revision/);
    p = review(f, f.reviewer, p.id, p.revision, 'accept', 'Rechecked the changed representation');
    assert.equal(f.service.blockers(f.lead).length, 0);
    f.teams.close(f.lead, 'Reviewed current proposal');
  } finally {
    f.store.close();
  }
});
test('unresolved concerns remain yellow when explicitly retained; no majority or author override', () => {
  const f = fixture();
  try {
    let p = f.submit();
    p = review(
      f,
      f.reviewer,
      p.id,
      p.revision,
      'changes-requested',
      'Feasibility needs external measurement',
    );
    assert.throws(
      () => f.service.settle(f.author, p.id, p.revision, 'retained', 'Override'),
      /coordinator/,
    );
    p = f.service.settle(
      f.lead,
      p.id,
      p.revision,
      'retained',
      'Measurement is unavailable; report feasibility as unresolved',
    );
    assert.equal(f.service.state(p), 'retained');
    assert.equal(deliveryEvidence(f.store, f.lead).verdict, 'yellow');
    assert.equal(f.service.blockers(f.lead).length, 0);
    assert.equal(p.reviews[0].verdict, 'changes-requested');
    assert.throws(
      () => review(f, f.reviewer, p.id, p.revision, 'accept', 'Erase concern'),
      /retained/,
    );
  } finally {
    f.store.close();
  }
});
test('scope, addressed visibility and continued member identity survive review handoff without deleting history', () => {
  const f = fixture();
  try {
    let p = f.submit();
    assert.throws(() => f.service.get(f.outsider, p.id), /not addressed/);
    assert.deepEqual(f.service.list(f.outsider), []);
    f.store.put('run', { ...f.reviewer, status: 'completed' });
    const next = { ...f.reviewer, id: 'reviewer-next' };
    f.store.put('run', next);
    f.teams.enrollSpawn(f.lead, next);
    assert(f.service.recipients(f.author, p).includes(next.id));
    p = review(f, next, p.id, p.revision, 'accept', 'Reviewed from retained private context');
    assert.equal(p.reviews[0].runId, next.id);
    const foreign = { ...f.lead, id: 'foreign', conversationId: 'elsewhere' };
    f.store.put('run', foreign);
    assert.throws(() => f.service.get(foreign, p.id), /Join this team/);
  } finally {
    f.store.close();
  }
});
test('structured reviews share message budget; no chatter required for acceptance and exhausted budget can retain gaps', () => {
  const f = fixture();
  try {
    f.teams.updateLimits(f.lead, 1);
    const p = f.submit();
    assert.throws(() => f.teams.post(f.author, 'Extra message', []), /limit/);
    assert.equal(f.teams.project(f.author)!.discussionBudget.remaining, 0);
    f.teams.post(f.reviewer, 'Used budget', ['author']);
    assert.throws(() => review(f, f.reviewer, p.id, p.revision, 'accept', 'Check'), /budget/);
    assert.equal(f.service.get(f.lead, p.id).reviews.length, 0);
    const retained = f.service.settle(
      f.lead,
      p.id,
      p.revision,
      'retained',
      'Budget exhausted, no review verdict',
    );
    assert.equal(f.service.state(retained), 'retained');
  } finally {
    f.store.close();
  }
});

test('a review requires current proposal receipt and cannot reuse a read from before revision', () => {
  const f = fixture();
  try {
    let p = f.submit();
    assert.throws(
      () => f.service.review(f.reviewer, p.id, p.revision, 'accept', 'No read'),
      /inspect_team_proposal/,
    );
    f.service.read(f.reviewer, p.id);
    p = f.service.submit(f.author, {
      id: p.id,
      revision: p.revision,
      title: p.title,
      content: 'Changed constraint',
      reviewerRunIds: ['reviewer'],
      changeNote: 'Changed output',
    });
    assert.throws(
      () => f.service.review(f.reviewer, p.id, p.revision, 'accept', 'Old read'),
      /inspect_team_proposal/,
    );
    f.service.read(f.reviewer, p.id);
    assert.equal(
      f.service.state(
        f.service.review(f.reviewer, p.id, p.revision, 'accept', 'Current draft checked'),
      ),
      'reviewed',
    );
  } finally {
    f.store.close();
  }
});

test('host finalization refuses an open review without marking work completed', async () => {
  const f = fixture();
  try {
    const p = f.submit();
    await assert.rejects(
      finalizeRun(f.store, f.lead, new FileScope([tmpdir()])),
      (e: any) => e.code === 'TEAM_REVIEW_PENDING',
    );
    assert.equal(f.store.get<any>('run', f.lead.id).status, 'running');
    review(
      f,
      f.reviewer,
      p.id,
      p.revision,
      'accept',
      'Constraint checked against current proposal',
    );
    await finalizeRun(f.store, f.lead, new FileScope([tmpdir()]));
    assert.equal(f.store.get<any>('run', f.lead.id).status, 'completed');
  } finally {
    f.store.close();
  }
});

test('research-linked peer review needs a distinguishing observation, not agreement', () => {
  const f = fixture();
  try {
    f.store.put('research-case', { id: 'research', revision: 2, evidence: [] });
    const p = f.service.submit(f.author, {
      title: 'Comparison',
      content: 'Compare competing mechanisms',
      reviewerRunIds: ['reviewer'],
      changeNote: 'Check interpretation',
      research: { id: 'research', revision: 2, hypothesisIds: ['a', 'b'] },
    });
    f.service.read(f.reviewer, p.id);
    assert.throws(
      () => f.service.review(f.reviewer, p.id, p.revision, 'accept', 'Agree'),
      /distinguishing observation/,
    );
    const accepted = f.service.review(
      f.reviewer,
      p.id,
      p.revision,
      'accept',
      'A fits the observed timing',
      {
        alternativeId: 'b',
        discriminatingObservation: 'B predicts the reverse ordering',
        impact: 'Timing favors A, other mechanisms remain possible',
      },
    );
    assert.equal(f.service.state(accepted), 'reviewed');
    f.store.put('research-case', { id: 'research', revision: 3, evidence: [] });
    assert.equal(f.service.state(accepted), 'awaiting-review');
    assert(f.service.blockers(f.lead).length);
  } finally {
    f.store.close();
  }
});

test('zero discussion quota permits continued useful contributions without erasing history', () => {
  const f = fixture();
  try {
    f.teams.updateLimits(f.lead, 0);
    for (let i = 0; i < 25; i++) f.teams.post(f.author, 'Evidence item ' + i, ['reviewer']);
    f.submit();
    const state = f.teams.project(f.author);
    assert(state);
    assert.equal(state.discussionBudget.limit, 0);
    assert.equal(state.discussionBudget.remaining, null);
    assert.equal(state.messages.length, 25);
    f.teams.updateLimits(f.lead, 10);
    assert.throws(() => f.teams.post(f.author, 'additional', ['reviewer']), /limit/);
  } finally {
    f.store.close();
  }
});
