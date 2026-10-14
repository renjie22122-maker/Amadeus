import test from 'node:test';
import assert from 'node:assert/strict';
import { groupManagementRoles, managementMemberLabel } from '../src/team-management.js';
test('management responsibilities group by owner without inventing professional members', () => {
  assert.deepEqual(
    groupManagementRoles({
      coordinator: 'lead',
      planner: 'lead',
      reviewer: 'peer',
      summarizer: 'lead',
    }),
    [
      { member: 'lead', roles: ['coordinator', 'planner', 'summarizer'] },
      { member: 'peer', roles: ['reviewer'] },
    ],
  );
  assert.equal(
    groupManagementRoles({
      coordinator: 'lead',
      planner: 'lead',
      reviewer: 'lead',
      summarizer: 'lead',
    }).length,
    1,
  );
});
test('lead name never repeats the user prompt; long and duplicate peer titles remain identifiable', () => {
  assert.equal(managementMemberLabel('root', 'root', 'A very long user task', true), '主 Agent');
  assert.equal(managementMemberLabel('root', 'root', 'A very long user task', false), 'Lead agent');
  assert.notEqual(
    managementMemberLabel('aaaaaa1', 'root', 'Same', true),
    managementMemberLabel('bbbbbb2', 'root', 'Same', true),
  );
  assert(managementMemberLabel('peer', 'root', 'x'.repeat(1000), false).length < 50);
});
