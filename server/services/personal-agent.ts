import { randomBytes, createHash } from 'node:crypto';
import { z } from 'zod';
import { Store, id } from '../storage/store.js';
import { assert } from '../core/errors.js';
import type { Runtime } from '../core/runtime.js';
import type { Conversation } from '../../shared/types.js';
import type { ScheduledWork } from './scheduled-work.js';
import { executionWindowSchema } from './schedule-window.js';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export const goalFields = z.object({
  title: z.string().trim().min(1).max(120),
  objective: z.string().trim().min(1).max(6000),
  success: z.string().trim().min(1).max(2000),
  intervalMs: z
    .number()
    .int()
    .min(60000)
    .max(30 * 86400000),
  maxRuns: z.number().int().min(1).max(1000),
  endAt: z.number().int().positive(),
  executionWindow: executionWindowSchema.nullable().optional(),
});
export interface PersonalIdentity {
  id: string;
  name: string;
  conversationId: string;
  createdAt: number;
}
export interface PairedDevice {
  id: string;
  name: string;
  tokenHash: string;
  conversationId: string;
  scopes: string[];
  createdAt: number;
  revokedAt?: number;
  lastSeenAt?: number;
  capabilities?: string[];
}
export class PersonalAgent {
  constructor(
    readonly store: Store,
    readonly runtime: Runtime,
  ) {}
  identity() {
    return this.store.maybe<PersonalIdentity>('personal-identity', 'primary');
  }
  configure(name: string, conversationId: string) {
    const c = this.available(conversationId);
    const old = this.identity();
    assert(
      !old || old.conversationId === c.id,
      'IDENTITY_BOUND',
      'The primary identity keeps its original conversation.',
    );
    return this.store.put('personal-identity', {
      id: 'primary',
      name,
      conversationId: c.id,
      createdAt: old?.createdAt || Date.now(),
    });
  }
  available(key: string) {
    const c = this.store.get<Conversation>('conversation', key);
    assert(
      !c.archived && !c.parentId && !c.isolationId,
      'SCOPE',
      'Choose an available top-level conversation.',
    );
    if (c.projectId)
      assert(
        !this.store.get<any>('project', c.projectId).removedAt,
        'SCOPE',
        'Restore the project first.',
      );
    return c;
  }
  snapshot() {
    const identity = this.identity();
    return {
      identity: identity || null,
      now: Date.now(),
      hostRequired: true,
      goals: this.store
        .list<any>('personal-goal')
        .map((g) => ({ ...g, task: this.store.maybe('scheduled-work', g.scheduleId) })),
      devices: this.devices(),
    };
  }
  createGoal(input: unknown) {
    const d = goalFields.parse(input),
      identity = this.identity();
    assert(identity, 'SETUP', 'Choose a primary conversation first.');
    assert(
      d.endAt > Date.now() && d.endAt <= Date.now() + 366 * 86400000,
      'DEADLINE',
      'Choose a future deadline within one year.',
    );
    const c = this.available(identity.conversationId),
      profile = this.runtime.config.profile(c.profileId);
    const key = id(),
      scheduleId = id();
    return this.store.transaction(() => {
      this.store.put('scheduled-work', {
        id: scheduleId,
        conversationId: c.id,
        name: d.title,
        enabled: true,
        status: 'waiting',
        dueAt: Date.now(),
        intervalMs: d.intervalMs,
        maxRuns: d.maxRuns,
        endAt: d.endAt,
        executionWindow: d.executionWindow,
        destination: 'same-chat',
        notifications: 'meaningful',
        target: JSON.stringify([profile.id, profile.baseUrl, c.projectId]),
        prompt: `You are ${identity.name}, the user's persistent personal agent. Continue this authorized goal using the conversation history and available tools.\nGoal: ${d.objective}\nCompletion criteria: ${d.success}\nInspect prior results before acting; do not repeat effects or treat activity as success. Ask when blocked. Report evidence and remaining work. Only report complete when the completion criteria are met. Current time is supplied by the host; elapsed time alone is not evidence of progress.`,
      });
      return this.store.put('personal-goal', {
        id: key,
        ...d,
        scheduleId,
        conversationId: c.id,
        createdAt: Date.now(),
      });
    });
  }
  goalAction(key: string, action: 'pause' | 'resume' | 'wake', eventId?: string) {
    const goal = this.store.get<any>('personal-goal', key),
      task = this.store.get<ScheduledWork>('scheduled-work', goal.scheduleId);
    if (action === 'pause')
      return this.store.put('scheduled-work', {
        ...task,
        enabled: false,
        status: task.runId ? task.status : 'paused',
      });
    if (action === 'wake' && eventId && this.store.maybe('personal-wake', key + ':' + eventId))
      return task;
    this.available(goal.conversationId);
    assert(!task.runId, 'BUSY', 'Wait for the current turn to settle.', 409);
    assert(
      !['needs_attention', 'completed', 'limit_reached'].includes(task.status),
      'REVIEW',
      'Review finished, interrupted or exhausted work and create a new goal; it will not be replayed.',
    );
    assert(
      (task.dispatchCount || 0) < (task.maxRuns || 0) && (task.endAt || 0) > Date.now(),
      'LIMIT',
      'Goal budget or deadline reached.',
    );
    return this.store.transaction(() => {
      if (action === 'wake') {
        assert(eventId, 'EVENT', 'A wake event ID is required.');
        const eventKey = key + ':' + eventId;
        if (this.store.maybe('personal-wake', eventKey)) return task;
        this.store.put('personal-wake', { id: eventKey, at: Date.now() });
      }
      return this.store.put('scheduled-work', {
        ...task,
        enabled: true,
        status: 'waiting',
        ...(action === 'wake' ? { dueAt: Date.now(), deferredUntil: undefined } : {}),
      });
    });
  }
  devices() {
    return this.store.list<PairedDevice>('paired-device').map(({ tokenHash: _, ...d }) => d);
  }
  invite(name: string, scopes: string[]) {
    const identity = this.identity();
    assert(identity, 'SETUP', 'Configure the personal agent first.');
    const secret = randomBytes(24).toString('base64url');
    const invite = {
      id: hash(secret),
      name,
      conversationId: identity.conversationId,
      scopes,
      expiresAt: Date.now() + 300000,
    };
    this.store.put('device-invite', invite);
    return { code: secret, expiresAt: invite.expiresAt };
  }
  pair(secret: string) {
    return this.store.transaction(() => {
      const invite = this.store.maybe<any>('device-invite', hash(secret));
      assert(
        invite && invite.expiresAt > Date.now(),
        'PAIRING',
        'Pairing code is invalid or expired.',
        401,
      );
      this.available(invite.conversationId);
      const token = randomBytes(32).toString('base64url'),
        key = id();
      this.store.remove('device-invite', invite.id);
      this.store.put('paired-device', {
        id: key,
        name: invite.name,
        tokenHash: hash(token),
        conversationId: invite.conversationId,
        scopes: invite.scopes,
        createdAt: Date.now(),
      });
      return { deviceId: key, token, scopes: invite.scopes, identity: this.identity() };
    });
  }
  authenticate(token: string) {
    const digest = hash(token),
      device = this.store
        .list<PairedDevice>('paired-device')
        .find((d) => d.tokenHash === digest && !d.revokedAt);
    assert(device, 'DEVICE_AUTH', 'Device authorization required.', 401);
    this.available(device.conversationId);
    return device;
  }
  require(device: PairedDevice, scope: string) {
    assert(
      !this.store.get<PairedDevice>('paired-device', device.id).revokedAt &&
        device.scopes.includes(scope),
      'DEVICE_SCOPE',
      'This device is not authorized for this operation.',
      403,
    );
  }
  revoke(key: string) {
    const device = this.store.get<PairedDevice>('paired-device', key);
    this.store.put('paired-device', { ...device, revokedAt: Date.now() });
    for (const command of this.store
      .list<any>('device-command')
      .filter((c) => c.deviceId === key && c.status === 'queued'))
      this.store.put('device-command', { ...command, status: 'cancelled' });
    return { ok: true };
  }
  message(device: PairedDevice, requestId: string, text: string, attachmentIds: string[] = []) {
    this.require(device, 'message');
    const key = device.id + ':' + requestId;
    const old = this.store.maybe<any>('device-request', key);
    const textHash = hash(JSON.stringify([text, attachmentIds]));
    if (old) {
      assert(
        old.textHash === textHash,
        'REPLAY',
        'Request ID reused with a different message.',
        409,
      );
      return old;
    }
    assert(
      !this.runtime.active(device.conversationId),
      'BUSY',
      'Agent is busy; wait or stop the current turn.',
      409,
    );
    const receipt = { id: key, runId: id(), textHash, status: 'dispatching', at: Date.now() };
    this.store.put('device-request', receipt);
    try {
      this.runtime.start(device.conversationId, text, 0, { runId: receipt.runId, attachmentIds });
      return this.store.put('device-request', { ...receipt, status: 'accepted' });
    } catch (e) {
      // Never automatically replay a reserved request after an uncertain failure.
      this.store.put('device-request', { ...receipt, status: 'needs_attention' });
      throw e;
    }
  }
}
