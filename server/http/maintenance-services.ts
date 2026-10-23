import { MemoryLifecycle } from '../services/memory-lifecycle.js';
import { MemoryLearning } from '../services/memory-learning.js';
import { KnowledgeMaintenance } from '../services/knowledge-maintenance.js';
import { ScheduledWorkService } from '../services/scheduled-work.js';
import { Embeddings } from '../services/embedding.js';
import type { Store } from '../storage/store.js';
import type { Runtime } from '../core/runtime.js';
import type { Configuration } from '../services/settings.js';
export function startMaintenanceServices(
  store: Store,
  config: Configuration,
  runtime: Runtime,
  directory: string,
) {
  new MemoryLifecycle(store).reconcileConflicts();
  const memoryLearning = new MemoryLearning(store, config);
  memoryLearning.start();
  const knowledgeEmbedding = new Embeddings(() => config.get().embedding);
  const maintenance = new KnowledgeMaintenance(
    store,
    runtime.knowledge,
    knowledgeEmbedding,
    directory,
    config,
  );
  maintenance.start();
  const scheduledWork = new ScheduledWorkService(store, runtime);
  scheduledWork.start();

  return { memoryLearning, knowledgeEmbedding, maintenance, scheduledWork };
}
