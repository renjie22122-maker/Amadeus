import { canRememberApproval } from '../../shared/approval-grants.js';
import { ApprovalGrants } from './approval-grants.js';
import { approvalRisk } from '../../shared/approval-risk.js';
import type { PendingInput, Run } from '../../shared/types.js';
import { abortError, assert, NotStartedError } from '../core/errors.js';
import { Store, id } from '../storage/store.js';
export class Inputs {
  readonly grants: ApprovalGrants;
  private waiting = new Map<
    string,
    { resolve: (value: string) => void; reject: (e: Error) => void }
  >();
  constructor(
    private store: Store,
    private review?: (run: Run, payload: Record<string, any>, signal: AbortSignal) => Promise<any>,
  ) {
    this.grants = new ApprovalGrants(store);
  }
  async request(
    run: Run,
    kind: PendingInput['kind'],
    payload: Record<string, any>,
    signal: AbortSignal,
    options: { id?: string; background?: boolean } = {},
  ): Promise<string> {
    if (signal.aborted) throw abortError();
    const item: PendingInput = {
      id: options.id || id(),
      runId: run.id,
      conversationId: run.conversationId,
      kind,
      payload: kind === 'approval' ? { ...payload, risk: approvalRisk(payload) } : payload,
      status: 'pending',
      answer: null,
      createdAt: Date.now(),
    };
    if (kind === 'approval' && canRememberApproval(payload))
      item.payload.repeatableBinding = this.grants.binding(run.conversationId);
    const grant =
      kind === 'approval' && !run.recoveryOnly && !signal.aborted
        ? this.grants.consume(run.conversationId, payload)
        : undefined;
    if (grant) {
      item.status = 'answered';
      item.answer = 'Approved by remembered scope ' + grant.id;
      item.payload = { ...item.payload, rememberedGrantId: grant.id };
      this.store.put('input', item);
      this.store.event(run.conversationId, run.id, 'input.requested', { ...item });
      this.store.event(run.conversationId, run.id, 'input.answered', {
        id: item.id,
        answer: item.answer,
        allow: true,
        grantId: grant.id,
      });
      return item.answer;
    }
    if (
      kind === 'approval' &&
      this.review &&
      !payload.forceManual &&
      payload.action !== 'resolve-effect'
    ) {
      const review = await this.review(run, payload, signal);
      if (review) {
        item.payload = {
          ...item.payload,
          autoReview: review,
          clarification:
            review.decision === 'ask' ? review.assessment?.clarification || null : null,
        };
        signal.throwIfAborted();
        if (review.decision === 'allow') {
          item.status = 'answered';
          item.answer = 'Approved by automatic reviewer: ' + review.reason;
          this.store.put('input', item);
          this.store.event(run.conversationId, run.id, 'input.requested', { ...item });
          this.store.event(run.conversationId, run.id, 'input.answered', {
            id: item.id,
            answer: item.answer,
            allow: true,
            automatic: true,
          });
          return item.answer;
        }
      }
    }
    signal.throwIfAborted();
    this.store.put('input', item);
    if (!options.background)
      this.store.transition(run.id, kind === 'approval' ? 'waiting_approval' : 'waiting_user');
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.waiting.delete(item.id);
        this.store.put('input', {
          ...item,
          status: 'cancelled',
          payload: { ...item.payload, interruptionReason: 'run_cancelled' },
        });
        reject(abortError());
      };
      this.waiting.set(item.id, {
        resolve: (value) => {
          signal.removeEventListener('abort', abort);
          this.waiting.delete(item.id);
          if (!signal.aborted && !options.background) this.store.transition(run.id, 'running');
          resolve(value);
        },
        reject: (e) => {
          if (!signal.aborted && !options.background) this.store.transition(run.id, 'running');
          signal.removeEventListener('abort', abort);
          this.waiting.delete(item.id);
          reject(e);
        },
      });
      signal.addEventListener('abort', abort, { once: true });
      this.store.event(run.conversationId, run.id, 'input.requested', { ...item });
      if (signal.aborted) abort();
    });
  }
  answer(key: string, answer: string, allow: boolean, remember = false) {
    const q = this.store.get<PendingInput>('input', key),
      waiter = this.waiting.get(key);
    assert(
      q.status === 'pending' && waiter,
      'STALE_INPUT',
      'This request is no longer waiting.',
      409,
    );
    assert(
      !remember || (allow && q.kind === 'approval'),
      'APPROVAL_SCOPE',
      'Only an allowed approval can be remembered.',
    );
    const grant = remember ? this.grants.create(q.conversationId, q.payload) : undefined;
    this.store.put('input', {
      ...q,
      payload: grant ? { ...q.payload, rememberedGrantId: grant.id } : q.payload,
      status: allow ? 'answered' : 'denied',
      answer,
    });
    this.store.event(q.conversationId, q.runId, 'input.answered', {
      id: key,
      answer,
      allow,
      grantId: grant?.id,
    });
    // A denial is a tool result, not an entire task failure.
    if (!allow && q.kind === 'approval')
      waiter.reject(new NotStartedError('APPROVAL_DENIED', 'User denied this operation.'));
    else waiter.resolve(answer);
  }
}
