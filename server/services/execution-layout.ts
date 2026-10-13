import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { FileScope, validateRoots } from './paths.js';
/** Embedded runtimes must not use an ancestor of their workspace as private storage. */
export async function prepareExecutionLayout(root: string) {
  const directory = resolve(root),
    state = join(directory, 'runtime-state'),
    workspace = join(directory, 'workspace');
  await mkdir(state, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await validateRoots([workspace], state);
  return { state, workspace, files: new FileScope([workspace], state) };
}
