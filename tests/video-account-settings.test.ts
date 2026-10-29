import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVideoAccountSettings } from '../server/services/video-account-settings.js';
test('account scope editor hides secrets, preserves runtime config and rejects stale saves', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'video-scope-'));
  try {
    await writeFile(
      join(dir, 'video-reader.json'),
      JSON.stringify({
        python: 'private-python',
        accounts: {
          bilibili: {
            cookiesFile: 'private-cookie-path',
            conversationIds: ['old'],
            allowLocalConversations: true,
            privateChatTransports: ['qq'],
          },
        },
      }),
    );
    const editor = createVideoAccountSettings(dir),
      initial = await editor.read();
    assert.ok(!JSON.stringify(initial).includes('private-'));
    const change = {
      revision: initial.revision,
      platform: 'bilibili',
      scope: {
        allowLocalConversations: false,
        privateChatTransports: ['qq', 'onebot11'],
        conversationIds: ['group-1', 'group-1'],
      },
    };
    const saved = await editor.save(change);
    assert.deepEqual(saved.accounts[0].conversationIds, ['group-1']);
    await assert.rejects(editor.save(change), /changed/);
    await assert.rejects(
      editor.save({ ...change, revision: saved.revision, cookiesFile: 'replacement' }),
    );
    const actual = JSON.parse(await readFile(join(dir, 'video-reader.json'), 'utf8'));
    assert.equal(actual.python, 'private-python');
    assert.equal(actual.accounts.bilibili.cookiesFile, 'private-cookie-path');
    const parallel = await Promise.allSettled([
      editor.save({
        ...change,
        revision: saved.revision,
        scope: { ...change.scope, conversationIds: ['group-2'] },
      }),
      editor.save({
        ...change,
        revision: saved.revision,
        scope: { ...change.scope, conversationIds: [] },
      }),
    ]);
    assert.deepEqual(
      parallel.map((r) => r.status),
      ['fulfilled', 'rejected'],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
