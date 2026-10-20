import { createHash } from 'node:crypto';
import { canRememberApproval, approvalGrantMode } from '../../shared/approval-grants.js';
import { assert } from '../core/errors.js';
import { Store, id } from '../storage/store.js';
export interface ApprovalGrant {
  id: string;
  conversationId: string;
  scope: string;
  binding: string;
  maxUsd: number;
  expiresAt: number;
  remaining: number;
  label: string;
  revoked?: boolean;
}
function stable(value: any): any {
  return Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, stable(value[k])]),
        )
      : value;
}
const hash = (x: any) =>
  createHash('sha256')
    .update(JSON.stringify(stable(x)))
    .digest('hex');
export class ApprovalGrants {
  constructor(private store: Store) {}
  binding(conversationId: string) {
    const c = this.store.get<any>('conversation', conversationId);
    return hash([
      c.profileId,
      c.permission,
      c.projectId,
      c.isolationId,
      c.allowedTools,
      c.execution,
      c.remoteChatOnly,
      c.projectId ? this.store.maybe('project', c.projectId) : null,
      this.store
        .list<any>('chat-connection')
        .filter((x) => x.conversationId === conversationId)
        .map((x) => [x.id, x.revision, x.enabled, x.authorizedTarget, x.remoteApprovals])
        .sort(),
    ]);
  }
  private scope(p: Record<string, any>) {
    if (approvalGrantMode(p) === 'service') return hash([p.backend, p.cwd, p.repeatable]);
    const {
      reason,
      risk,
      autoReview,
      clarification,
      repeatableBinding,
      rememberedGrantId,
      estimatedUsd,
      ...operation
    } = p;
    return hash(operation);
  }
  list(conversationId: string) {
    return this.store
      .list<ApprovalGrant>('approval-grant')
      .filter(
        (g) =>
          g.conversationId === conversationId &&
          !g.revoked &&
          g.expiresAt > Date.now() &&
          g.remaining > 0,
      );
  }
  create(conversationId: string, p: Record<string, any>) {
    assert(
      canRememberApproval(p),
      'APPROVAL_SCOPE',
      'This operation has no bounded reusable approval scope.',
    );
    const scope = this.scope(p),
      binding = this.binding(conversationId);
    assert(
      p.repeatableBinding === binding,
      'APPROVAL_SCOPE',
      'Conversation authority changed while approval was pending. Request again.',
    );
    for (const old of this.list(conversationId)) if (old.scope === scope) this.revoke(old.id);
    const grant: ApprovalGrant = {
      id: id(),
      conversationId,
      scope,
      binding,
      maxUsd: p.estimatedUsd ?? 0,
      expiresAt: Date.now() + 86400000,
      remaining: 100,
      label: String(p.command || 'Media generation'),
    };
    this.store.put('approval-grant', grant);
    return grant;
  }
  consume(conversationId: string, p: Record<string, any>) {
    if (!canRememberApproval(p)) return;
    const scope = this.scope(p),
      binding = this.binding(conversationId);
    const grant = this.list(conversationId).find(
      (g) => g.scope === scope && g.binding === binding && (p.estimatedUsd ?? 0) <= g.maxUsd,
    );
    if (!grant) return;
    this.store.put('approval-grant', { ...grant, remaining: grant.remaining - 1 });
    return grant;
  }
  revoke(key: string) {
    const grant = this.store.get<ApprovalGrant>('approval-grant', key);
    this.store.put('approval-grant', { ...grant, revoked: true });
  }
  revokeConversation(conversationId: string) {
    for (const grant of this.list(conversationId)) this.revoke(grant.id);
  }
}
