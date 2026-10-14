import { suspiciousText, textFormats, TEXT_DECODING_REVISION } from './text-decoding.js';
import { diagnoseFailure, type FailureDiagnosis } from './failure-diagnosis.js';
import { evaluateRetrieval } from './retrieval-evaluation.js';
import { Configuration } from './settings.js';
import { GraphLearning } from './graph-learning.js';
import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { Store } from '../storage/store.js';
import { Knowledge } from './knowledge.js';
import { Embeddings } from './embedding.js';
import { FileScope, inside } from './paths.js';
import { extractIsolated } from './document-parser.js';
import { createReadStream } from 'node:fs';
async function fileHash(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export interface SourceIssue {
  path: string;
  stage: string;
  error: string;
  hash?: string;
  attempts: number;
  revision: number;
  parserRevision?: number;
}
export interface KnowledgeProgress {
  phase: 'scanning' | 'checking' | 'parsing' | 'graph' | 'indexing' | 'evaluating' | 'done';
  startedAt: number;
  updatedAt: number;
  currentFile?: string;
  completed: number;
  total?: number;
  discovered: number;
  imported: number;
  reused: number;
  failed: number;
  chunks?: { completed: number; total: number };
}
export interface KnowledgeWatch {
  id: string;
  enabled: boolean;
  paths: string[];
  target: string;
  revision: number;
  status?: string;
  progress?: KnowledgeProgress;
  scan?: { files: number; updated: number; unchanged: number };
  issues?: SourceIssue[];
  skipped?: { excluded: number; links: number; unsupported: number };
  error?: string;
  updatedAt?: number;
  failures?: number;
  nextRetryAt?: number;
  failureKind?: string;
  diagnosis?: FailureDiagnosis;
  failedRevision?: string;
  graphProfileId?: string;
  graphTarget?: string;
}
const formats = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.txt',
  '.md',
  '.csv',
  '.json',
  '.docx',
  '.xlsx',
  '.pdf',
  '.html',
  '.xml',
  '.yaml',
  '.yml',
]);
export class KnowledgeMaintenance {
  private timer?: ReturnType<typeof setInterval>;
  private task?: Promise<void>;
  private stopped = false;
  constructor(
    private store: Store,
    private knowledge: Knowledge,
    private embeddings: Embeddings,
    private directory: string,
    private config?: Configuration,
    private parse: (path: string) => Promise<string> = extractIsolated,
  ) {}
  start() {
    this.timer = setInterval(() => void this.tick(), 30000);
    this.timer.unref();
  }
  async close() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.task;
  }
  tick() {
    return (this.task ||= this.scan().finally(() => {
      this.task = undefined;
    }));
  }
  queueIndex(scope: string) {
    if (!this.embeddings.enabled()) throw Error('Configure embeddings first.');
    const old = this.store.maybe<any>('knowledge-batch', scope);
    const target = this.embeddings.fingerprint();
    if (old?.target === target && ['pending', 'running'].includes(old.status)) return old;
    const documents = this.store
      .list<any>('document')
      .filter((d) => d.scope === scope && d.validUntil == null)
      .map((d) => d.id);
    return this.store.put('knowledge-batch', {
      id: scope,
      target,
      documents,
      status: 'pending',
      completed: 0,
      failed: 0,
      createdAt: Date.now(),
    });
  }
  private async batches() {
    for (const job of this.store.list<any>('knowledge-batch')) {
      if (!['pending', 'running'].includes(job.status) || this.stopped) continue;
      const allowed = () =>
        !this.stopped &&
        this.embeddings.enabled() &&
        this.embeddings.fingerprint() === job.target &&
        (!job.id.startsWith('project:') ||
          (!!this.store.maybe<any>('project', job.id.slice(8)) &&
            !this.store.maybe<any>('project', job.id.slice(8))?.removedAt));
      if (!allowed()) {
        this.store.put('knowledge-batch', {
          ...job,
          status: 'needs_attention',
          error: 'Scope or embedding destination changed; submit again after review.',
        });
        continue;
      }
      for (let n = job.completed; n < job.documents.length; n++) {
        if (!allowed()) break;
        const doc = this.store.maybe<any>('document', job.documents[n]);
        try {
          this.store.put('knowledge-batch', { ...job, status: 'running', currentFile: doc?.name });
          if (doc?.scope === job.id && doc.validUntil == null)
            await this.knowledge.index(doc.id, allowed);
        } catch (e: any) {
          job.failed++;
          job.error = String(e.message || e).slice(0, 500);
        }
        if (!allowed()) break;
        job.completed = n + 1;
        this.store.put('knowledge-batch', {
          ...job,
          status:
            job.completed === job.documents.length
              ? job.failed
                ? 'partial'
                : 'completed'
              : 'running',
          currentFile: undefined,
        });
      }
      if (!job.documents.length) this.store.put('knowledge-batch', { ...job, status: 'completed' });
    }
  }
  saveSources(
    input: Pick<
      KnowledgeWatch,
      'id' | 'enabled' | 'paths' | 'target' | 'graphProfileId' | 'graphTarget'
    >,
  ) {
    const old = this.store.maybe<KnowledgeWatch>('knowledge-watch', input.id);
    const paths = [...new Set(input.paths)];
    if (
      old &&
      old.enabled === input.enabled &&
      old.target === input.target &&
      old.graphTarget === input.graphTarget &&
      old.graphProfileId === input.graphProfileId &&
      JSON.stringify([...old.paths].sort()) === JSON.stringify([...paths].sort())
    )
      return old;
    const revision = (old?.revision || 0) + 1;
    return this.store.put('knowledge-watch', {
      ...old,
      ...input,
      paths,
      revision,
      // Configuration changes invalidate active scans, not per-file failure history.
      issues: old?.issues?.map((issue) => ({ ...issue, revision })),
      status: input.enabled ? 'pending' : 'off',
      progress: undefined,
      // A changed scope/service needs a new scan; failed document jobs remain intact.
      failures: 0,
      nextRetryAt: undefined,
      failedRevision: undefined,
      error: undefined,
      diagnosis: undefined,
    });
  }
  synchronize(scope: string) {
    const w = this.store.get<KnowledgeWatch>('knowledge-watch', scope);
    if (!w.enabled || !this.current(w))
      throw Error('Enable and save the source configuration first.');
    if ((w.failures || 0) >= 3 && w.failureKind !== 'transient')
      throw Error('Maintenance is paused after repeated failures; use Retry failed items.');
    const revision = w.revision + 1;
    return this.store.put('knowledge-watch', {
      ...w,
      revision,
      status: 'pending',
      progress: undefined,
      issues: w.issues?.map((issue) => ({ ...issue, revision })),
    });
  }
  recheck(scope: string) {
    const w = this.store.get<KnowledgeWatch>('knowledge-watch', scope);
    if (!w.enabled || !this.current(w))
      throw Error('Scope disabled or destination changed; review the knowledge settings first.');
    for (const job of this.store.list<any>('knowledge-index-job')) {
      const doc = this.store.maybe<any>('document', job.id.split('|')[0]);
      if (doc?.scope === scope && job.status !== 'completed')
        this.store.remove('knowledge-index-job', job.id);
    }
    return this.store.put('knowledge-watch', {
      ...w,
      revision: w.revision + 1,
      failures: 0,
      nextRetryAt: undefined,
      failedRevision: undefined,
      status: 'pending',
      progress: undefined,
      error: undefined,
      diagnosis: undefined,
    });
  }
  private current(w: KnowledgeWatch) {
    const v = this.store.maybe<KnowledgeWatch>('knowledge-watch', w.id);
    if (w.id.startsWith('project:')) {
      const p = this.store.maybe<any>('project', w.id.slice(8));
      if (
        !p ||
        p.removedAt ||
        !w.paths.every((path) => p.folders.some((root: string) => inside(root, path)))
      )
        return false;
    } else if (w.id !== 'general' && !this.store.maybe('conversation', w.id.slice(8))) return false;

    return (
      !this.stopped &&
      v?.enabled &&
      v.revision === w.revision &&
      v.target === this.embeddings.fingerprint()
    );
  }
  private async scan() {
    // Explicit retrieval consent is checked again inside sync; keep watch ingestion independent.
    try {
      await this.knowledge.syncLightRag();
    } catch {
      /* A failed optional sidecar must not stop local import. */
    }

    await this.batches();
    for (let w of this.store.list<KnowledgeWatch>('knowledge-watch')) {
      if (!w.enabled || this.stopped) continue;
      const connectionRevision = this.embeddings.recoveryRevision?.();
      if (w.failedRevision && connectionRevision !== w.failedRevision && this.current(w)) {
        w = this.recheck(w.id);
      }
      // Migrate the old whole-folder size failure; retain the authorized scope/service.
      if (w.error?.startsWith('Source exceeds 25 MB:')) w = this.recheck(w.id);
      if ((w.failures || 0) >= 3 && w.failureKind !== 'transient') continue;
      if ((w.nextRetryAt || 0) > Date.now()) continue;
      const progress: KnowledgeProgress = {
        phase: 'scanning',
        startedAt: Date.now(),
        updatedAt: Date.now(),
        completed: 0,
        discovered: 0,
        imported: 0,
        reused: 0,
        failed: 0,
      };
      let lastPublished = 0;
      const publish = (patch: Partial<KnowledgeProgress>, force = false) => {
        Object.assign(progress, patch);
        if (!this.current(w) || (!force && Date.now() - lastPublished < 400)) return;
        lastPublished = Date.now();
        progress.updatedAt = lastPublished;
        const current = this.store.get<KnowledgeWatch>('knowledge-watch', w.id);
        this.store.put('knowledge-watch', {
          ...current,
          status: 'processing',
          progress: { ...progress },
        });
      };
      try {
        if (w.target !== this.embeddings.fingerprint() || !this.embeddings.enabled())
          throw Error(
            'Embedding service changed; save the scope configuration to authorize the new destination.',
          );
        const project = w.id.startsWith('project:')
          ? this.store.maybe<any>('project', w.id.slice(8))
          : w.id === 'general'
            ? { folders: w.paths }
            : null;
        if (w.id.startsWith('project:') && (!project || project.removedAt))
          throw Error('Project is unavailable.');
        const files: string[] = [];
        const issues: SourceIssue[] = [];
        const skipped = { excluded: 0, links: 0, unsupported: 0 };
        let traversalFailed = false;
        let indexError: unknown;
        const issue = (path: string, stage: string, error: unknown, hash?: string) => {
          const old = w.issues?.find(
            (x) =>
              x.path === path &&
              x.stage === stage &&
              x.hash === hash &&
              x.revision === w.revision &&
              x.parserRevision ===
                (textFormats.has(extname(path).toLowerCase()) ? TEXT_DECODING_REVISION : undefined),
          );
          issues.push({
            path,
            stage,
            hash,
            error: String((error as any)?.message || error).slice(0, 500),
            attempts: (old?.attempts || 0) + 1,
            revision: w.revision,
            parserRevision: textFormats.has(extname(path).toLowerCase())
              ? TEXT_DECODING_REVISION
              : undefined,
          });
        };
        let visited = 0;
        const scope = project && new FileScope(project.folders, this.directory);
        const walk = async (path: string): Promise<void> => {
          if (!this.current(w)) throw Error('Configuration changed');
          publish({ currentFile: path, discovered: files.length });
          if (++visited % 128 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
          if (!scope) throw Error('Folder watching requires a project scope');
          // Resolve against the matching declared project root.
          const root = project.folders.findIndex(
            (r: string) =>
              path === r ||
              path.toLowerCase().startsWith(r.toLowerCase() + '\\') ||
              path.startsWith(r + '/'),
          );
          if (root < 0) throw Error('Source is outside the project');
          const { relative } = await import('node:path');
          const safe = await scope.resolve(
            '@' + root + '/' + relative(project.folders[root], path),
          );
          const stat = await lstat(safe);
          if (stat.isDirectory()) {
            for (const entry of await readdir(safe, { withFileTypes: true })) {
              if (
                entry.name.startsWith('.') ||
                ['node_modules', 'dist', 'build', 'vendor'].includes(entry.name)
              ) {
                skipped.excluded++;
                continue;
              }
              if (entry.isSymbolicLink()) {
                skipped.links++;
                continue;
              }
              try {
                await walk(join(safe, entry.name));
              } catch (e) {
                traversalFailed = true;
                issue(join(safe, entry.name), 'scan', e);
              }
            }
          } else if (formats.has(extname(safe).toLowerCase())) {
            files.push(safe);
          } else {
            skipped.unsupported++;
          }
        };
        this.store.put('knowledge-watch', {
          ...w,
          status: 'processing',
          error: undefined,
          progress,
        });
        for (const path of w.paths) {
          try {
            await walk(path);
          } catch (e: any) {
            if (e.code !== 'ENOENT') {
              traversalFailed = true;
              issue(path, 'scan', e);
            }
          }
        }
        let updated = 0,
          unchanged = 0;
        const uniqueFiles = [...new Set(files)];
        publish(
          {
            phase: 'checking',
            total: uniqueFiles.length,
            completed: 0,
            discovered: uniqueFiles.length,
          },
          true,
        );
        for (const path of uniqueFiles) {
          if (!this.current(w)) return;
          const key = createHash('sha256')
            .update(w.id + '|' + path)
            .digest('hex');
          publish({ phase: 'checking', currentFile: path }, true);
          const old = this.store.maybe<any>('knowledge-source', key);
          const parserRevision = textFormats.has(extname(path).toLowerCase())
            ? TEXT_DECODING_REVISION
            : undefined;
          let needsRepair = false;
          if (old && !old.removed && parserRevision && old.parserRevision !== parserRevision) {
            // One-time quality audit of old text sources; healthy documents keep their vectors.
            const chunks = this.store.db
              .prepare('SELECT text FROM chunks WHERE document_id=?')
              .iterate(old.documentId);
            for (const row of chunks)
              if (suspiciousText((row as any).text)) {
                needsRepair = true;
                break;
              }
          }
          let hash: string | undefined;
          try {
            hash = await fileHash(path);
            const failed = w.issues?.find(
              (x) =>
                x.path === path &&
                x.stage === 'parse' &&
                x.hash === hash &&
                x.revision === w.revision &&
                x.parserRevision === parserRevision,
            );
            if (failed && failed.attempts >= 3) {
              issues.push(failed);
              continue;
            }
            if (old?.hash === hash && !old.removed && !needsRepair) {
              if (old.parserRevision !== parserRevision)
                this.store.put('knowledge-source', { ...old, parserRevision });
              unchanged++;
              continue;
            }
            publish({ phase: 'parsing', currentFile: path }, true);
            const text = await this.parse(path);
            if ((await fileHash(path)) !== hash)
              throw Error('Source changed during parsing; retry on the next scan.');
            if (!this.current(w)) return;
            const doc: any = this.knowledge.import(w.id, basename(path), text, {
              source: path,
              revisionOf: old?.removed ? undefined : old?.documentId,
            });
            updated++;
            this.store.put('knowledge-source', {
              id: key,
              scope: w.id,
              path,
              hash,
              documentId: doc.id,
              removed: false,
              parserRevision,
            });
          } catch (e) {
            issue(path, 'parse', e, hash);
            // A failed replacement must not leave stale facts searchable.
            if (old && hash && (old.hash !== hash || needsRepair)) {
              const doc = this.store.maybe<any>('document', old.documentId);
              if (doc) this.store.put('document', { ...doc, validUntil: Date.now() });
              this.store.put('knowledge-source', { ...old, removed: true });
            }
          } finally {
            publish(
              {
                completed: progress.completed + 1,
                imported: updated,
                reused: unchanged,
                failed: issues.length,
              },
              true,
            );
          }
        }
        if (!this.current(w)) return;
        for (const old of this.store
          .list<any>('knowledge-source')
          .filter(
            (x) => !traversalFailed && x.scope === w.id && !x.removed && !files.includes(x.path),
          )) {
          const doc = this.store.maybe<any>('document', old.documentId);
          if (doc) this.store.put('document', { ...doc, validUntil: Date.now() });
          this.store.put('knowledge-source', { ...old, removed: true });
        }
        const documents = this.store
          .list<any>('document')
          .filter((d) => d.scope === w.id && d.validUntil == null);
        publish(
          { phase: 'indexing', completed: 0, total: documents.length, currentFile: undefined },
          true,
        );
        for (const doc of documents) {
          if (!this.current(w)) return;
          try {
            publish(
              {
                phase: this.config && w.graphProfileId && w.graphTarget ? 'graph' : 'indexing',
                currentFile: doc.name,
                chunks: undefined,
              },
              true,
            );
            if (this.config && w.graphProfileId && w.graphTarget)
              await new GraphLearning(this.store, this.config).document(
                doc,
                w.graphProfileId,
                w.graphTarget,
                () =>
                  !!this.current(w) &&
                  this.store.maybe<KnowledgeWatch>('knowledge-watch', w.id)?.graphTarget ===
                    w.graphTarget,
              );
            const key = doc.id + '|' + w.target;
            const attempt = this.store.maybe<any>('knowledge-index-job', key);
            if (attempt?.status === 'completed') continue;
            if (attempt?.attempts >= 3 && w.failureKind !== 'transient')
              throw Error('Index retries exhausted; save configuration to retry.');
            this.store.put('knowledge-index-job', {
              id: key,
              attempts: (attempt?.attempts || 0) + 1,
              status: 'running',
            });
            publish({ phase: 'indexing' }, true);
            await this.knowledge.index(
              doc.id,
              () => !!this.current(w),
              (chunks) => publish({ chunks }),
            );
            if (!this.current(w)) return;
            this.store.put('knowledge-index-job', {
              id: key,
              attempts: (attempt?.attempts || 0) + 1,
              status: 'completed',
            });
          } catch (e) {
            issue(doc.name, 'index', e);
            indexError = e;
          } finally {
            publish(
              { completed: progress.completed + 1, failed: issues.length, chunks: undefined },
              true,
            );
          }
        }
        publish(
          { phase: 'evaluating', currentFile: undefined, total: undefined, completed: 0 },
          true,
        );
        if (this.current(w)) await evaluateRetrieval(this.store, this.knowledge, w.id);
        if (this.current(w))
          this.store.put('knowledge-watch', {
            ...w,
            status: issues.length ? 'partial' : 'synced',
            progress: {
              ...progress,
              phase: 'done',
              updatedAt: Date.now(),
              completed: uniqueFiles.length,
              total: uniqueFiles.length,
            },
            issues,
            skipped,
            scan: { files: new Set(files).size, updated, unchanged },
            failures: 0,
            failureKind: indexError
              ? diagnoseFailure(indexError).automatic
                ? 'transient'
                : 'configuration'
              : undefined,
            nextRetryAt:
              indexError && diagnoseFailure(indexError).automatic ? Date.now() + 30000 : undefined,
            updatedAt: Date.now(),
            error: undefined,
            diagnosis: undefined,
            failedRevision: indexError ? this.embeddings.recoveryRevision?.() : undefined,
          });
      } catch (e: any) {
        const diagnosis = diagnoseFailure(e);
        const transient = diagnosis.automatic;
        if (this.store.maybe<KnowledgeWatch>('knowledge-watch', w.id)?.revision === w.revision)
          this.store.put('knowledge-watch', {
            ...w,
            status: 'needs_attention',
            progress: { ...progress, updatedAt: Date.now() },
            failures: (w.failures || 0) + 1,
            failureKind: transient ? 'transient' : 'configuration',
            diagnosis,
            failedRevision: this.embeddings.recoveryRevision?.(),
            nextRetryAt: transient
              ? Date.now() + Math.min(3600000, 30000 * 2 ** Math.min(w.failures || 0, 7))
              : undefined,
            error: String(e.message || e).slice(0, 500),
            updatedAt: Date.now(),
          });
      }
    }
  }
}
