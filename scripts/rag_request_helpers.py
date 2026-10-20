"""Bounded, content-free request diagnostics for the optional RAG service."""
import json, re, threading, time, uuid
from contextlib import contextmanager

class RequestDiagnostics:
    def __init__(self, root):
        self.root, self.local, self.write_lock = root, threading.local(), threading.Lock()

    def begin(self, path, request_id='', budget_ms=60000):
        request_id = request_id if re.fullmatch(r'[a-zA-Z0-9-]{1,64}', request_id) else uuid.uuid4().hex
        self.local.state = {'requestId':request_id, 'path':path, 'start':time.monotonic(),
                            'budgetMs':budget_ms, 'at':int(time.time()*1000), 'stagesMs':{}}

    def add(self, **values):
        state = getattr(self.local, 'state', None)
        if state is not None: state.update(values)

    def remaining(self):
        state = getattr(self.local, 'state', None)
        return max(0, state['budgetMs']/1000-(time.monotonic()-state['start'])) if state else 60

    def check(self):
        if self.remaining() <= 0: raise TimeoutError('Request deadline exceeded')

    @contextmanager
    def stage(self, name):
        start = time.monotonic()
        try: yield
        finally:
            state = getattr(self.local, 'state', None)
            if state is not None:
                stages = state['stagesMs']; stages[name] = stages.get(name, 0)+(time.monotonic()-start)*1000

    @contextmanager
    def locked(self, lock, name):
        with self.stage(name+'Wait'):
            acquired = lock.acquire(timeout=self.remaining())
        if not acquired: raise TimeoutError('Model queue deadline exceeded')
        try:
            self.check()
            with self.stage(name): yield
        finally: lock.release()

    def finish(self, outcome):
        state = getattr(self.local, 'state', None)
        if state is None: return
        self.local.state = None
        elapsed = (time.monotonic()-state.pop('start'))*1000
        state.update(outcome=outcome, elapsedMs=round(elapsed,2), deadlineExceeded=elapsed>=state['budgetMs'])
        state['stagesMs'] = {k:round(v,2) for k,v in state['stagesMs'].items()}
        # No prompts, URLs, credentials, response vectors or exception messages.
        try:
            with self.write_lock:
                path=self.root/'requests.jsonl'
                if path.exists() and path.stat().st_size >= 1024*1024:
                    path.replace(self.root/'requests.previous.jsonl')
                with path.open('a',encoding='utf-8') as stream: stream.write(json.dumps(state)+'\n')
        except OSError: pass  # Diagnostics must never fail an otherwise successful request.


def embedding_windows(encoder, texts, purpose='passage'):
    """Retokenize prefixed windows before inference; never silently truncate a tail."""
    tokenizer=encoder.tokenizer
    limits=[int(v) for v in (getattr(encoder,'max_seq_length',None),getattr(tokenizer,'model_max_length',None))
            if isinstance(v,(int,float)) and 8 <= v <= 1000000]
    if not limits: raise ValueError('Embedding model must declare a finite context length')
    limit=min(limits)
    windows,groups,tokens,lengths=[],[],0,[]
    for text in texts:
        prefix='query: ' if text.startswith('query: ') or purpose=='query' else 'passage: '
        body=text.split(': ',1)[1] if text.startswith(('query: ','passage: ')) else text
        # This is counting/splitting, not model inference. Suppress only this tokenizer's length warning.
        ids=tokenizer.encode(body,add_special_tokens=False,verbose=False)
        tokens+=len(ids); group=[]; start=0
        while True:
            end=min(len(ids),start+min(480,limit-8))
            while True:
                window=prefix+tokenizer.decode(ids[start:end],skip_special_tokens=True)
                length=len(tokenizer.encode(window,add_special_tokens=True,truncation=False,verbose=False))
                if length<=limit: break
                if end-start<=1: raise ValueError('Embedding prefix/token exceeds model context')
                end=start+max(1,(end-start)//2)
            group.append(len(windows));windows.append(window);lengths.append(length)
            if end>=len(ids): break
            start=end-min(32,max(0,end-start-1))
        groups.append(group)
    return windows,groups,tokens,{'inputTokens':tokens,'windows':len(windows),'maxModelInputTokens':max(lengths,default=0),'modelTokenLimit':limit}

async def light_document_complete(rag, doc_id, text, source=None):
    """Accept duplicates only after their exact-content original finishes; bound chains."""
    seen = set()
    duplicate = False
    for _ in range(8):
        if doc_id in seen: return False
        seen.add(doc_id)
        status = await rag.doc_status.get_by_id(doc_id)
        if not status and source and len(seen) == 1:
            # LightRAG can persist a batch duplicate under a generated dup-* ID.
            lookup = getattr(rag.doc_status, "get_doc_by_file_path", None)
            candidate = await lookup(source) if lookup else None
            metadata = (candidate or {}).get("metadata") or {}
            if candidate and candidate.get("file_path") == source and metadata.get("is_duplicate") and metadata.get("duplicate_kind") == "content_hash":
                status = candidate
        if not status: return False
        if status.get("status") == "processed":
            if not duplicate: return True
            original = await rag.full_docs.get_by_id(doc_id)
            return bool(original and isinstance(original.get("content"), str) and original["content"].strip() == text.strip())
        metadata = status.get("metadata") or {}
        if not metadata.get("is_duplicate") or metadata.get("duplicate_kind") != "content_hash": return False
        original_id = metadata.get("original_doc_id")
        if not isinstance(original_id, str) or not original_id: return False
        doc_id, duplicate = original_id, True
    return False


async def light_resume_plan(rag, texts, sources):
    """Fail closed before a workspace retry: exact persisted input, no unrelated work."""
    import hashlib
    ids = ["doc-" + hashlib.sha256((source + text).encode()).hexdigest() for source, text in zip(sources, texts)]
    completed, pending = [], []
    for doc_id, text, source in zip(ids, texts, sources):
        if await light_document_complete(rag, doc_id, text, source):
            completed.append(doc_id)
            continue
        status = await rag.doc_status.get_by_id(doc_id)
        original = await rag.full_docs.get_by_id(doc_id)
        if not status or status.get("file_path") != source or not original or original.get("content", "").strip() != text.strip():
            raise ValueError("Recovery requires the unchanged persisted source")
        if status.get("status") not in ("failed", "pending", "processing", "parsing", "analyzing"):
            raise ValueError("Document is not recoverable")
        pending.append(doc_id)
    from enum import Enum
    recovery_status = Enum("RecoveryStatus", {s.upper():s for s in ("failed", "pending", "processing", "parsing", "analyzing")}, type=str)
    unfinished = await rag.doc_status.get_docs_by_statuses(list(recovery_status), strict=True)
    for doc_id in unfinished:
        status = await rag.doc_status.get_by_id(doc_id)
        if (status.get("metadata") or {}).get("is_duplicate"):
            continue
        if doc_id not in pending:
            raise ValueError("Unrelated unfinished documents require separate inspection")
    return {"completed": completed, "pending": pending}


async def light_batch_progress(rag, texts, sources):
    """Read only the submitted sources; duplicate originals count once per source."""
    import hashlib
    counts = dict(completed=0, failed=0, processing=0, pending=0, total=len(texts))
    for source, text in zip(sources, texts):
        key = "doc-" + hashlib.sha256((source + text).encode()).hexdigest()
        if await light_document_complete(rag, key, text, source):
            counts["completed"] += 1
        else:
            row = await rag.doc_status.get_by_id(key) or {}
            state = row.get("status")
            counts["failed" if state == "failed" else "processing" if state in ("processing", "parsing", "analyzing") else "pending"] += 1
    return counts
