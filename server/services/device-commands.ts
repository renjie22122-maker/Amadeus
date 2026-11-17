import { Store, id } from '../storage/store.js';
import { assert } from '../core/errors.js';
import type { PairedDevice } from './personal-agent.js';
export class DeviceCommands {
  constructor(private store: Store) {}
  queue(
    conversationId: string,
    deviceId: string,
    capability: string,
    args: Record<string, unknown>,
  ) {
    const d = this.store.get<PairedDevice>('paired-device', deviceId);
    assert(
      !d.revokedAt && d.conversationId === conversationId && d.scopes.includes('device-control'),
      'DEVICE_SCOPE',
      'Device control not authorized for this conversation.',
    );
    assert(
      d.capabilities?.includes(capability),
      'CAPABILITY',
      'The device has not advertised this capability.',
    );
    assert(
      (d.lastSeenAt || 0) > Date.now() - 120000,
      'OFFLINE',
      'Device is offline; reconnect before sending actions.',
    );
    return this.store.put('device-command', {
      id: id(),
      deviceId,
      conversationId,
      capability,
      args,
      status: 'queued',
      createdAt: Date.now(),
      expiresAt: Date.now() + 120000,
    });
  }
  claim(device: PairedDevice) {
    return this.store.transaction(() => {
      for (const command of this.store
        .list<any>('device-command')
        .filter((c) => c.deviceId === device.id && c.status === 'queued')) {
        if (command.expiresAt <= Date.now()) {
          this.store.put('device-command', { ...command, status: 'expired' });
          continue;
        }
        // A claimed action is never redelivered. The device retries only its persisted result.
        return this.store.put('device-command', {
          ...command,
          status: 'claimed',
          claimedAt: Date.now(),
        });
      }
      return null;
    });
  }
  result(device: PairedDevice, key: string, status: string, result: unknown) {
    const old = this.store.get<any>('device-command', key);
    assert(
      old.deviceId === device.id && old.conversationId === device.conversationId,
      'SCOPE',
      'Command belongs to another device.',
      403,
    );
    if (['completed', 'failed', 'unknown'].includes(old.status)) return { ok: true };
    assert(old.status === 'claimed', 'STATE', 'Command was not claimed.');
    this.store.put('device-command', { ...old, status, result, finishedAt: Date.now() });
    return { ok: true };
  }
}
