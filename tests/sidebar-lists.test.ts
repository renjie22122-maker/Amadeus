import test from 'node:test';
import assert from 'node:assert/strict';
import { recentChats, recentProjects, visibleEntries } from '../src/sidebar-lists.js';
test('sidebar keeps pinned items first and sorts remaining conversations by activity without mutation', () => {
  const input: any[] = [
    { id: 'old', updatedAt: 1, createdAt: 1 },
    { id: 'new', updatedAt: 5, createdAt: 2 },
    { id: 'pin', updatedAt: 0, createdAt: 0, pinned: true },
  ];
  assert.deepEqual(
    recentChats(input).map((x) => x.id),
    ['pin', 'new', 'old'],
  );
  assert.equal(input[0].id, 'old');
});
test('recent project activity outranks creation and archived chats do not reorder projects', () => {
  const projects: any[] = [
    { id: 'a', createdAt: 1 },
    { id: 'b', createdAt: 2 },
  ];
  assert.deepEqual(
    recentProjects(projects, [{ projectId: 'a', updatedAt: 3 } as any]).map((x) => x.id),
    ['a', 'b'],
  );
  assert.deepEqual(
    recentProjects(projects, [{ projectId: 'a', updatedAt: 3, archived: true } as any]).map(
      (x) => x.id,
    ),
    ['b', 'a'],
  );
});
test('collapsed list retains selected and pinned entries beyond its initial slice', () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ id: String(i), pinned: i === 10 }));
  assert.deepEqual(
    visibleEntries(items, 3, '11').map((x) => x.id),
    ['0', '1', '2', '10', '11'],
  );
});
