import { reviewContent, reviewHash, ReviewFlights } from './review-cache.js';
import type { FileScope } from './paths.js';
import {
  inspectReviewSources,
  reviewEvidence,
  recentExecutionEvidence,
  commandScopeSignals,
  selectReviewMessages,
} from './review-evidence.js';
import { approvalRisk } from '../../shared/approval-risk.js';
import { executionSettings } from '../../shared/execution.js';
import { ModelPool } from '../core/pool.js';
import { createHash } from 'node:crypto';
import {
  boundedReview,
  decideAssessment,
  REVIEW_POLICY_VERSION,
  REVIEW_PROMPT,
} from './review-policy.js';
import type { Conversation, Run } from '../../shared/types.js';
import type { ModelProvider } from '../providers/protocol.js';
import type { Configuration } from './settings.js';
import { Store, id } from '../storage/store.js';
export class AutoReview {
  private pool = new ModelPool(() => 1);
  private flights = new ReviewFlights<any>();
  constructor(
    private store: Store,
    private config: Configuration,
    private provider: (p: any) => ModelProvider,
    private filesForRun?: (run: Run) => Promise<FileScope>,
  ) {}
  async review(run: Run, payload: Record<string, any>, signal: AbortSignal) {
    const c = this.store.get<Conversation>('conversation', run.conversationId);
    if (c.permission !== 'auto') return null;
    const settings = executionSettings(this.config.get(), c);
    const humanDecisions = () =>
      this.store
        .list<any>('input')
        .filter(
          (q) =>
            q.conversationId === run.conversationId &&
            q.kind === 'approval' &&
            ['answered', 'denied'].includes(q.status) &&
            q.payload?.autoReview?.decision !== 'allow',
        )
        .slice(-12)
        .map((q) => ({
          id: q.id,
          status: q.status,
          answer: q.answer,
          request: Object.fromEntries(
            Object.entries(q.payload || {}).filter(
              ([key]) => !['autoReview', 'risk'].includes(key),
            ),
          ),
          scope: 'one-time decision only; never a reusable grant',
        }));
    const contextStamp = () =>
      createHash('sha256')
        .update(
          JSON.stringify({
            conversation: this.store.get<Conversation>('conversation', run.conversationId),
            settings: this.config.get(),
            humanDecisions: humanDecisions(),
            messages: this.store
              .events(run.conversationId)
              .filter((e) => e.type === 'user.message'),
          }),
        )
        .digest('hex');
    const initialStamp = contextStamp();
    const actionSnapshot = JSON.stringify(payload);
    const record: any = {
      id: id(),
      policyVersion: REVIEW_POLICY_VERSION,
      status: 'reviewing',
      runId: run.id,
      conversationId: run.conversationId,
      at: Date.now(),
      fingerprint: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
      decision: 'ask',
      reason: 'Automatic review unavailable.',
    };
    this.store.event(run.conversationId, run.id, 'approval.reviewing', {
      id: record.id,
      policyVersion: REVIEW_POLICY_VERSION,
    });
    let phase = 'prepare';
    let reviewSignal: AbortSignal | undefined;
    try {
      const original = this.config.profile(settings.autoReview?.profileId || run.profileId);
      const files =
        original.id === run.profileId && this.filesForRun ? await this.filesForRun(run) : undefined;
      const inspectedSource = files ? await inspectReviewSources(files, payload) : [];
      record.sourceEvidence = inspectedSource.map(({ content, ...metadata }: any) => metadata);
      const profile = {
        ...original,
        reasoning: original.efforts.includes('none')
          ? ('none' as const)
          : original.efforts.includes('low')
            ? ('low' as const)
            : ('auto' as const),
        maxOutputTokens: Math.min(original.maxOutputTokens, 4096),
        timeoutMs: settings.autoReview?.timeoutMs || 30000,
      };
      reviewSignal = AbortSignal.any([signal, AbortSignal.timeout(profile.timeoutMs)]);
      const allMessages = this.store
        .events(run.conversationId)
        .filter((e) => e.type === 'user.message' && !e.data.scheduledTrigger)
        .map((e, index) => ({
          id: index,
          currentRun: e.runId === run.id,
          text: String(e.data.content || e.data.text || '').slice(0, 5000),
        }));
      const messages = selectReviewMessages(allMessages, payload);
      const risk = approvalRisk(payload);
      const commandSignals = commandScopeSignals(String(payload.command || ''));
      record.commandSignals = commandSignals;
      record.risk = risk;
      if (
        risk.automatic &&
        typeof payload.cwd === 'string' &&
        ['approval-host', 'native-windows', 'docker'].includes(payload.backend)
      ) {
        record.decision = 'allow';
        record.reason = 'Bounded built-in environment query; no arguments or shell composition.';
      } else if (commandSignals.broadProcessSelection) {
        record.reason =
          'Process cleanup is not scoped to this task. Select runtime-owned process identities before retrying; cwd does not constrain Stop-Process.';
        record.failureCode = 'UNSCOPED_PROCESS_TERMINATION';
      } else if (risk.level === 'high')
        record.reason = 'High-risk operation requires explicit human approval: ' + risk.reason;
      else {
        const content = reviewContent({
          humanMessages: messages,
          humanDecisions: humanDecisions(),
          request:
            original.id === run.profileId || !payload.fileChanges
              ? payload
              : {
                  ...payload,
                  fileChanges: payload.fileChanges.map(({ before, after, ...metadata }: any) => ({
                    ...metadata,
                    contentWithheld: true,
                    reason: 'Separate reviewer profile: newly read source content is not shared.',
                  })),
                },
          sandbox: settings.commandBackend,
          network:
            settings.commandBackend === 'approval-host'
              ? 'host'
              : settings.commandBackend === 'docker'
                ? 'deny'
                : settings.nativeNetwork,
          cwdIsSecurityBoundary: false,
          hostAccountPermissions: settings.commandBackend === 'approval-host',
          risk,
          observedSource: reviewEvidence(run, original.id === run.profileId),
          inspectedSource,
          executionEvidence:
            original.id === run.profileId ? recentExecutionEvidence(this.store, run) : [],
          commandSignals,
        });
        record.cache = {
          policyPrefixHash: reviewHash(REVIEW_PROMPT),
          requestHash: reviewHash(content),
          serializedCharacters: content.length,
          reuse: 'provider-prefix-eligible',
          hitRate: null,
        };
        phase = 'queue';
        const queuedAt = Date.now();
        const activeSignal = reviewSignal;
        const flight = this.flights.get(
          signal,
          reviewHash(initialStamp + run.id + JSON.stringify(profile) + content),
          record.id,
          () =>
            this.pool.run(
              activeSignal,
              () => {
                phase = 'provider';
                record.queueMs = Date.now() - queuedAt;
                return boundedReview(
                  this.provider(profile).complete({
                    profile,
                    tools: [],
                    signal: activeSignal,
                    onText: () => {},
                    messages: [
                      {
                        role: 'system',
                        content: REVIEW_PROMPT,
                      },
                      {
                        role: 'user',
                        content,
                      },
                    ],
                  }),
                  activeSignal,
                );
              },
              run.conversationId,
            ),
        );
        if (flight.joined) {
          record.sharedReviewId = flight.owner;
          phase = 'shared-review';
        }
        const result = await boundedReview(flight.work, activeSignal);
        if (!flight.joined) record.usage = result.usage;
        record.cache.hitRate =
          result.usage.measured && result.usage.input > 0
            ? Math.min(1, Math.max(0, result.usage.cached / result.usage.input))
            : null;
        record.model = profile.model;
        const prices = profile.prices,
          u = result.usage;
        record.estimatedUsd =
          !flight.joined &&
          u.measured &&
          prices.input !== null &&
          prices.output !== null &&
          prices.cached !== null
            ? (Math.max(0, u.input - u.cached) * prices.input +
                u.cached * prices.cached +
                u.output * prices.output) /
              1e6
            : null;
        phase = 'validate-response';
        if (result.message.calls?.length) throw Error('Reviewer may not call tools.');
        const parse = (text: string) =>
          decideAssessment(
            JSON.parse(text.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '')),
            messages.map((message) => message.id),
          );
        let parsed;
        try {
          parsed = parse(result.message.content);
        } catch {
          // Repair invalid formatting once; never retry a valid negative assessment.
          record.formatRepairAttempts = 1;
          const repaired = await boundedReview(
            this.provider(profile).complete({
              profile,
              tools: [],
              signal: activeSignal,
              onText: () => {},
              messages: [
                {
                  role: 'system',
                  content:
                    REVIEW_PROMPT +
                    '\nYour previous response did not validate. Return only the exact JSON assessment schema with enum strings and numeric humanMessages IDs. Do not return decision/allow fields. Reassess the same evidence; uncertainty must remain uncertainty.',
                },
                { role: 'user', content },
              ],
            }),
            activeSignal,
          );
          record.repairUsage = repaired.usage;
          if (!flight.joined)
            record.usage = {
              ...result.usage,
              input: result.usage.input + repaired.usage.input,
              output: result.usage.output + repaired.usage.output,
              cached: result.usage.cached + repaired.usage.cached,
              measured: result.usage.measured && repaired.usage.measured,
            };
          if (record.estimatedUsd != null && repaired.usage.measured)
            record.estimatedUsd +=
              (Math.max(0, repaired.usage.input - repaired.usage.cached) * prices.input! +
                repaired.usage.output * prices.output! +
                repaired.usage.cached * prices.cached!) /
              1e6;
          if (repaired.message.calls?.length) throw Error('Reviewer may not call tools.');
          parsed = parse(repaired.message.content);
        }
        Object.assign(record, parsed);
        if (
          files &&
          JSON.stringify(await inspectReviewSources(files, payload)) !==
            JSON.stringify(inspectedSource)
        ) {
          record.decision = 'ask';
          record.reason = 'Reviewed source changed during assessment; request a fresh review.';
        }
      }
    } catch (error: any) {
      record.decision = 'ask';
      const code = signal.aborted
        ? 'REVIEW_CANCELLED'
        : reviewSignal?.aborted || error?.name === 'TimeoutError'
          ? 'REVIEW_TIMEOUT'
          : phase === 'validate-response'
            ? 'REVIEW_INVALID_RESPONSE'
            : phase === 'prepare'
              ? 'REVIEW_PREPARATION_FAILED'
              : 'REVIEW_PROVIDER_FAILED';
      record.failureCode = code;
      record.failurePhase = phase;
      // Never persist arbitrary provider error bodies: they may contain credentials/source.
      record.reason = (
        {
          REVIEW_CANCELLED: 'Automatic review cancelled; no automatic permission granted.',
          REVIEW_TIMEOUT:
            'Automatic reviewer exceeded its configured deadline; manual approval is required.',
          REVIEW_INVALID_RESPONSE:
            'Reviewer returned invalid JSON, schema or tool calls; manual approval is required.',
          REVIEW_PREPARATION_FAILED:
            'Could not prepare the configured reviewer or scoped evidence; manual approval is required.',
          REVIEW_PROVIDER_FAILED:
            'Reviewer connection/provider request failed; manual approval is required.',
        } as Record<string, string>
      )[code];
      if (code === 'REVIEW_TIMEOUT' && phase === 'queue')
        record.reason =
          'Automatic review deadline expired while queued; no reviewer conclusion was received.';
      record.errorType =
        typeof error?.name === 'string' && /^[A-Za-z]+Error$/.test(error.name)
          ? error.name
          : 'Error';
    }
    if (this.store.get<Conversation>('conversation', run.conversationId).permission !== 'auto') {
      record.decision = 'ask';
      record.reason = 'Permission mode changed while reviewing.';
    }
    if (contextStamp() !== initialStamp || JSON.stringify(payload) !== actionSnapshot) {
      record.decision = 'ask';
      record.reason =
        'Authorization context or action changed during review; review again with current evidence.';
    }
    record.status = signal.aborted
      ? 'aborted'
      : record.decision === 'allow'
        ? 'approved'
        : 'needs_human';
    record.durationMs = Date.now() - record.at;
    if (signal.aborted) {
      this.store.put('approval-review', record);
      this.store.event(run.conversationId, run.id, 'approval.reviewed', record);
    }
    signal.throwIfAborted();
    this.store.put('approval-review', record);
    this.store.event(run.conversationId, run.id, 'approval.reviewed', record);
    return record;
  }
}
