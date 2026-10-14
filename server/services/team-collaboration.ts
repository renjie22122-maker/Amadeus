import type { Run } from '../../shared/types.js';
import { Store, id } from '../storage/store.js';
import { assert } from '../core/errors.js';
import { rootRun } from './task-board.js';
import type { TeamSpace } from './team-space.js';

type Review = {
  revision: number;
  version: number;
  reviewer: string;
  runId: string;
  verdict: 'accept' | 'changes-requested';
  reason: string;
  at: number;
};
type Response = {
  reviewRevision: number;
  version: number;
  reviewer: string;
  runId: string;
  reason: string;
  at: number;
};
export interface TeamProposal {
  id: string;
  teamId: string;
  author: string;
  authorRunId: string;
  title: string;
  content: string;
  version: number;
  revision: number;
  reviewers: string[];
  versions: { version: number; content: string; changeNote: string; at: number }[];
  reviews: Review[];
  responses: Response[];
  disposition?: { state: 'retained' | 'withdrawn'; reason: string; runId: string; at: number };
}
export function collaborationUsage(store: Store, runId: string, teamId: string) {
  const row = store.db
    .prepare(
      "SELECT count(*) AS n FROM events WHERE run_id=? AND type='team.lifecycle' AND json_extract(data,'$.teamId')=? AND json_extract(data,'$.action') IN ('proposal-submitted','proposal-revised','proposal-reviewed','proposal-response')",
    )
    .get(runId, teamId) as { n: number };
  return row.n;
}
/** Records attributed proposals and responses; does not infer truth from votes or text. */
export class TeamCollaboration {
  constructor(private store: Store) {}
  private team(run: Run, mutate = false) {
    const t = this.store.maybe<TeamSpace>('team-space', rootRun(this.store, run));
    assert(
      t && t.members.includes(run.id),
      'TEAM_MEMBER',
      'Join this team before using its review records.',
    );
    assert(
      !mutate || !t.closed[run.id],
      'PARTICIPATION_ENDED',
      'Continue the member before changing review records.',
    );
    return t;
  }
  private visible(run: Run, t: TeamSpace, p: TeamProposal) {
    return (
      t.roles.coordinator === run.id ||
      p.author === run.conversationId ||
      p.reviewers.includes(run.conversationId)
    );
  }
  list(run: Run) {
    const t = this.store.maybe<TeamSpace>('team-space', rootRun(this.store, run));
    if (!t || !t.members.includes(run.id)) return [];
    return this.store
      .list<TeamProposal>('team-proposal')
      .filter((p) => p.teamId === t.id && this.visible(run, t, p));
  }
  get(run: Run, key: string) {
    const t = this.team(run);
    const p = this.store.get<TeamProposal>('team-proposal', key);
    assert(
      p.teamId === t.id && this.visible(run, t, p),
      'TEAM_SCOPE',
      'Proposal is not addressed to this member.',
    );
    return p;
  }
  read(run: Run, key: string) {
    const p = this.get(run, key);
    this.store.put('team-proposal-read', {
      id: p.id + ':' + run.id,
      teamId: p.teamId,
      runId: run.id,
      proposalId: p.id,
      version: p.version,
      revision: p.revision,
    });
    return p;
  }
  private save(run: Run, p: TeamProposal, action: string) {
    if (action !== 'proposal-disposition') {
      const t = this.team(run, true);
      const messages = this.store
        .list<any>('team-discussion')
        .filter((m) => m.teamId === t.id && m.sender === run.id).length;
      assert(
        messages + collaborationUsage(this.store, run.id, t.id) < t.maxMessages,
        'DISCUSSION_LIMIT',
        'Member discussion budget exhausted. Coordinator may adjust it or explicitly retain unresolved work; do not send redundant messages.',
      );
    }
    this.store.put('team-proposal', p);
    this.store.event(run.conversationId, run.id, 'team.lifecycle', {
      teamId: p.teamId,
      action,
      proposalId: p.id,
      revision: p.revision,
      version: p.version,
    });
    return p;
  }
  submit(
    run: Run,
    input: {
      id?: string;
      revision?: number;
      title: string;
      content: string;
      reviewerRunIds: string[];
      changeNote: string;
    },
  ) {
    return this.store.transaction(() => {
      const t = this.team(run, true);
      const reviewers = [
        ...new Set(
          input.reviewerRunIds.map((key) => {
            assert(
              t.members.includes(key) && !t.closed[key],
              'TEAM_SCOPE',
              'Reviewers must be enrolled participants.',
            );
            return this.store.runHeader(key).conversationId;
          }),
        ),
      ];
      assert(
        reviewers.length > 0 && !reviewers.includes(run.conversationId),
        'TEAM_REVIEW_SELF',
        'Choose another member to review a concrete proposal; do not create reviews for independent work.',
      );
      if (input.id) {
        const p = this.get(run, input.id);
        assert(
          p.author === run.conversationId,
          'TEAM_REVIEW_AUTHOR',
          'Only the author may revise a proposal.',
        );
        assert(p.revision === input.revision, 'TEAM_CHANGED', 'Inspect current proposal revision.');
        assert(
          !p.disposition,
          'TEAM_REVIEW_CLOSED',
          'A retained or withdrawn proposal is historical; submit a new proposal if new work is authorized.',
        );
        assert(
          p.content !== input.content,
          'TEAM_REVIEW_UNCHANGED',
          'For an unchanged proposal use respond_team_review with a reason, not a fake revision.',
        );
        assert(
          p.version < 6,
          'TEAM_REVIEW_BUDGET',
          'Six versions exhausted. Retain unresolved concerns explicitly or withdraw the proposal; do not restart merely to evade this bound.',
        );
        p.title = input.title;
        p.content = input.content;
        p.version++;
        p.revision++;
        // Existing obligations cannot disappear by silently dropping a reviewer.
        p.reviewers = [...new Set([...p.reviewers, ...reviewers])];
        p.versions.push({
          version: p.version,
          content: p.content,
          changeNote: input.changeNote,
          at: Date.now(),
        });
        return this.save(run, p, 'proposal-revised');
      }
      const p: TeamProposal = {
        id: id(),
        teamId: t.id,
        author: run.conversationId,
        authorRunId: run.id,
        title: input.title,
        content: input.content,
        version: 1,
        revision: 1,
        reviewers,
        versions: [
          { version: 1, content: input.content, changeNote: input.changeNote, at: Date.now() },
        ],
        reviews: [],
        responses: [],
      };
      return this.save(run, p, 'proposal-submitted');
    });
  }
  review(run: Run, key: string, revision: number, verdict: Review['verdict'], reason: string) {
    return this.store.transaction(() => {
      this.team(run, true);
      const p = this.get(run, key);
      assert(p.revision === revision, 'TEAM_CHANGED', 'Inspect current proposal revision.');
      assert(!p.disposition, 'TEAM_REVIEW_CLOSED', 'This proposal was retained or withdrawn.');
      assert(
        p.reviewers.includes(run.conversationId) && p.author !== run.conversationId,
        'TEAM_REVIEW_ROLE',
        'Only an assigned independent member can record this review.',
      );
      const read = this.store.maybe<{ revision: number }>(
        'team-proposal-read',
        p.id + ':' + run.id,
      );
      assert(
        read?.revision === p.revision,
        'TEAM_REVIEW_UNREAD',
        'Use inspect_team_proposal to read the current version and responses before reviewing.',
      );
      const previous = p.reviews
        .filter((r) => r.version === p.version && r.reviewer === run.conversationId)
        .at(-1);
      if (previous?.verdict === 'changes-requested')
        assert(
          p.responses.some(
            (r) =>
              r.version === p.version &&
              r.reviewer === run.conversationId &&
              r.reviewRevision === previous.revision,
          ),
          'TEAM_REVIEW_RESPONSE',
          'Wait for an author response or a revised proposal before closing this concern.',
        );
      assert(
        previous?.verdict !== 'accept',
        'TEAM_REVIEW_DUPLICATE',
        'This version is already accepted by you; do not add agreement messages.',
      );
      p.reviews.push({
        revision: p.revision + 1,
        version: p.version,
        reviewer: run.conversationId,
        runId: run.id,
        verdict,
        reason,
        at: Date.now(),
      });
      p.revision++;
      return this.save(run, p, 'proposal-reviewed');
    });
  }
  respond(run: Run, key: string, revision: number, reviewer: string, reason: string) {
    return this.store.transaction(() => {
      this.team(run, true);
      const p = this.get(run, key);
      assert(p.revision === revision, 'TEAM_CHANGED', 'Inspect current proposal revision.');
      assert(
        !p.disposition && p.author === run.conversationId,
        'TEAM_REVIEW_AUTHOR',
        'Only the author can respond to an open proposal.',
      );
      const latest = p.reviews
        .filter((r) => r.version === p.version && r.reviewer === reviewer)
        .at(-1);
      assert(
        latest?.verdict === 'changes-requested',
        'TEAM_REVIEW_CONCERN',
        'Respond to a recorded concern in the current version.',
      );
      assert(
        !p.responses.some(
          (r) =>
            r.version === p.version &&
            r.reviewer === reviewer &&
            r.reviewRevision === latest.revision,
        ),
        'TEAM_REVIEW_DUPLICATE',
        'Response already recorded; wait for review rather than repeating it.',
      );
      p.responses.push({
        reviewRevision: latest.revision,
        version: p.version,
        reviewer,
        reason,
        runId: run.id,
        at: Date.now(),
      });
      p.revision++;
      return this.save(run, p, 'proposal-response');
    });
  }
  settle(run: Run, key: string, revision: number, state: 'retained' | 'withdrawn', reason: string) {
    return this.store.transaction(() => {
      const t = this.team(run, true);
      const p = this.get(run, key);
      assert(
        t.roles.coordinator === run.id,
        'TEAM_ROLE',
        'Only the coordinator can retain unresolved disagreement or withdraw scope.',
      );
      assert(p.revision === revision, 'TEAM_CHANGED', 'Inspect current proposal revision.');
      assert(!p.disposition, 'TEAM_REVIEW_CLOSED', 'Disposition is already recorded.');
      p.disposition = { state, reason, runId: run.id, at: Date.now() };
      p.revision++;
      return this.save(run, p, 'proposal-disposition');
    });
  }
  state(p: TeamProposal) {
    if (p.disposition) return p.disposition.state;
    const current = p.reviewers.map((reviewer) =>
      p.reviews.filter((r) => r.version === p.version && r.reviewer === reviewer).at(-1),
    );
    if (current.some((r) => r?.verdict === 'changes-requested')) {
      return current
        .filter((r) => r?.verdict === 'changes-requested')
        .every((r) =>
          p.responses.some(
            (a) =>
              a.version === p.version &&
              a.reviewer === r!.reviewer &&
              a.reviewRevision === r!.revision,
          ),
        )
        ? 'awaiting-recheck'
        : 'needs-response';
    }
    return current.every((r) => r?.verdict === 'accept') ? 'reviewed' : 'awaiting-review';
  }
  summary(run: Run) {
    const t = this.store.maybe<TeamSpace>('team-space', rootRun(this.store, run));
    const items = this.list(run).map((p) => ({
      id: p.id,
      title: p.title,
      version: p.version,
      revision: p.revision,
      state: this.state(p),
      author: p.author,
      reviewers: p.reviewers,
      reason: p.disposition?.reason,
    }));
    const missing = !!t?.reviewRequired && t.roles.coordinator === run.id && !items.length;
    return {
      required: !!t?.reviewRequired,
      missing,
      items,
      open: items.filter((p) =>
        ['awaiting-review', 'needs-response', 'awaiting-recheck'].includes(p.state),
      ).length,
      retained: items.filter((p) => p.state === 'retained').length,
      withdrawn: items.filter((p) => p.state === 'withdrawn').length,
      meaning:
        'Attributed peer review, not proof of truth, feasibility or independent sources. No message quota or voting threshold.',
    };
  }
  blockers(run: Run) {
    const t = this.store.maybe<TeamSpace>('team-space', rootRun(this.store, run));
    if (!t || t.roles.coordinator !== run.id) return [];
    const s = this.summary(run);
    return [
      ...(s.missing ? ['Declared peer review has no concrete proposal.'] : []),
      ...s.items
        .filter((p) => ['awaiting-review', 'needs-response', 'awaiting-recheck'].includes(p.state))
        .map((p) => 'Unfinished peer review: ' + p.id),
    ];
  }
  recipients(run: Run, p: TeamProposal) {
    const t = this.team(run);
    return t.members.filter(
      (key) =>
        key !== run.id &&
        !t.closed[key] &&
        [
          p.author,
          ...p.reviewers,
          this.store.runHeader(t.roles.coordinator).conversationId,
        ].includes(this.store.runHeader(key).conversationId),
    );
  }
}
