"""Optional local RAG sidecar. Keep its configuration and logs private."""
import base64, argparse, asyncio, hashlib, hmac, json, os, threading, time, subprocess, sys
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

CODE_HASH = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
ROOT = Path(os.environ.get("AGENTDEMO_DATA_DIR", str(Path(__file__).resolve().parent.parent / ".data"))) / "retrieval-service"
ROOT.mkdir(parents=True, exist_ok=True)
CONFIG = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
TOKEN = CONFIG["token"]
if len(TOKEN) < 32:
    raise RuntimeError("A private service token of at least 32 characters is required")
LOCK = threading.RLock()
JOURNAL = ROOT / "jobs.json"
JOBS = json.loads(JOURNAL.read_text(encoding="utf-8")) if JOURNAL.exists() else {}
for job in JOBS.values():
    if job.get("status") in ("queued","processing"): job["status"] = "unknown"
MODELS, INDEXES, RAGS = {}, OrderedDict(), {}
RAG_LOCKS = {}
JOB_LOCK = threading.RLock()
def save_jobs():
    with JOB_LOCK:
        temporary = JOURNAL.with_suffix(".tmp")
        temporary.write_text(json.dumps(JOBS),encoding="utf-8")
        os.replace(temporary,JOURNAL)
POOL = ThreadPoolExecutor(max_workers=1)
LOOP = asyncio.new_event_loop()
threading.Thread(target=LOOP.run_forever, daemon=True).start()

def model(kind):
    with LOCK:
        if kind not in MODELS:
            from sentence_transformers import SentenceTransformer, CrossEncoder
            import torch
            device = "cuda" if torch.cuda.is_available() else "cpu"
            options = dict(device=device, cache_folder=str(ROOT / "models"), trust_remote_code=False)
            if kind == "rerank":
                MODELS[kind] = CrossEncoder(CONFIG.get("rerankPath") or CONFIG["rerankModel"], max_length=8192, local_files_only=bool(CONFIG.get("rerankPath")), **options)
            else:
                MODELS[kind] = SentenceTransformer(CONFIG.get("embeddingPath") or CONFIG["embeddingModel"], local_files_only=bool(CONFIG.get("embeddingPath")), **options)
            if kind == "embedding":
                expected = {"intfloat/multilingual-e5-small":384, "intfloat/multilingual-e5-base":768, "intfloat/multilingual-e5-large":1024}[CONFIG["embeddingModel"]]
                if MODELS[kind].get_sentence_embedding_dimension() != expected:
                    del MODELS[kind]
                    raise ValueError("Local model dimensions do not match the selected E5 identity")
        return MODELS[kind]

def embeddings(texts, purpose="passage"):
    import numpy as np
    encoder = model("embedding")
    windows, groups, tokens = [], [], 0
    for text in texts:
        prefix = "query: " if text.startswith("query: ") or purpose == "query" else "passage: "
        body = text.split(": ", 1)[1] if text.startswith(("query: ", "passage: ")) else text
        ids = encoder.tokenizer.encode(body, add_special_tokens=False)
        tokens += len(ids)
        group = []
        for i in range(0, max(1, len(ids)), 448):
            group.append(len(windows))
            windows.append(prefix + encoder.tokenizer.decode(ids[i:i+480], skip_special_tokens=True))
        groups.append(group)
    with LOCK:
        values = encoder.encode(windows, normalize_embeddings=True, batch_size=8)
    out = []
    for group in groups:
        v = np.mean(values[group], axis=0)
        v /= max(float(np.linalg.norm(v)), 1e-12)
        out.append(v.tolist())
    return out, tokens

def rerank(data):
    import torch
    query, texts = data["query"], data["texts"]
    if not isinstance(query, str) or not isinstance(texts, list) or not 0 < len(texts) <= 60 or not all(isinstance(t, str) for t in texts):
        raise ValueError("Expected query and 1-60 texts")
    if sum(map(len, texts)) + len(query) * len(texts) > 200000:
        raise ValueError("Rerank input too large")
    scorer = model("rerank")
    pairs = [(query, t) for t in texts]
    lengths = scorer.tokenizer(pairs, truncation=False, padding=False, return_length=True)["length"]
    if max(lengths) > 8192:
        raise ValueError("Candidate exceeds reranker token limit; split it first")
    with LOCK:
        scores = scorer.predict(pairs, batch_size=4, activation_fn=torch.nn.Sigmoid())
    return sorted([dict(index=i, score=float(s)) for i, s in enumerate(scores)], key=lambda r: -r["score"])

def vector_search(data):
    import numpy as np
    backend, requested = data["backend"], data["index"]
    if "vectorsBase64" in data:
        ids, dim = data["ids"], data["dimensions"]
        if not isinstance(ids,list) or not 0<len(ids)<=200000 or len(set(ids))!=len(ids) or not all(isinstance(i,str) for i in ids) or not isinstance(dim,int) or not 0<dim<=16384:
            raise ValueError("Invalid packed vector metadata")
        raw = base64.b64decode(data["vectorsBase64"],validate=True)
        if len(raw)!=len(ids)*dim*4 or len(raw)>80*1024*1024: raise ValueError("Invalid packed vector length")
        x = np.frombuffer(raw,dtype="<f4").reshape(len(ids),dim).copy()
        rows = [{"id":i} for i in ids]
    else:
        rows = data["rows"]
        x = np.asarray([r["values"] for r in rows],dtype="float32")
    if not 0 < len(rows) <= 200000:
        raise ValueError("Vector request exceeds sidecar resource limit")
    q = np.asarray([data["query"]], dtype="float32")
    if x.ndim != 2 or not 0 < x.shape[1] <= 16384 or q.shape != (1, x.shape[1]) or not np.isfinite(x).all() or not np.isfinite(q).all():
        raise ValueError("Invalid dimensions or values")
    if requested not in ("flat", "hnsw", "ivf-flat", "ivf-pq") or backend not in ("faiss", "qdrant", "milvus"):
        raise ValueError("Unsupported backend/index")
    if backend == "qdrant" and requested != "hnsw":
        raise ValueError("Qdrant uses HNSW")
    x /= np.maximum(np.linalg.norm(x, axis=1, keepdims=True), 1e-12)
    q /= np.maximum(np.linalg.norm(q, axis=1, keepdims=True), 1e-12)
    if backend == "faiss" and "--vector-worker" not in sys.argv:
        # Native library faults must not kill the model/graph service.
        try:
            child = subprocess.run([sys.executable,"-X","utf8",__file__,"--vector-worker"],
                input=json.dumps(data),text=True,encoding="utf-8",capture_output=True,timeout=40,
                creationflags=getattr(subprocess,"CREATE_NO_WINDOW",0))
            if child.returncode == 0: return json.loads(child.stdout)
            failure = "Native FAISS worker failed; exact fallback"
        except subprocess.TimeoutExpired:
            failure = "Native FAISS worker timed out; exact fallback"
        scores = x @ q[0]
        order = np.argsort(-scores)[:min(int(data.get("limit",60)),60,len(rows))]
        return {"result":[{"id":rows[int(i)]["id"],"score":float(scores[i])} for i in order],
            "effectiveIndex":"flat-numpy","fallbackReason":failure}

    effective, reason = requested, None
    if requested.startswith("ivf") and (len(x) < (9984 if requested == "ivf-pq" else 2496) or (requested == "ivf-pq" and x.shape[1] % 8)):
        effective, reason = "flat", "Insufficient representative training rows or incompatible PQ dimensions; exact fallback"
    key = hashlib.sha256(x.tobytes() + json.dumps([r["id"] for r in rows]).encode() + backend.encode() + effective.encode()).hexdigest()
    top = min(int(data.get("limit", 60)), 60, len(rows))
    with LOCK:
        if backend == "faiss":
            import faiss
            key = hashlib.sha256((key + faiss.__version__).encode()).hexdigest()
            if key not in INDEXES:
                cache = ROOT / "faiss"
                cache.mkdir(exist_ok=True)
                cached = cache / (key + ".index")
                d = x.shape[1]
                if cached.exists():
                    index = faiss.read_index(str(cached))
                    INDEXES[key] = index
                    scores, indices = index.search(q, top)
                    return dict(result=[dict(id=rows[int(i)]["id"],score=float(v)) for i,v in zip(indices[0],scores[0]) if i>=0],
                        effectiveIndex=effective,fallbackReason=reason)
                faiss.omp_set_num_threads(min(4,os.cpu_count() or 1))
                if effective == "flat": index = faiss.IndexFlatIP(d)
                elif effective == "hnsw":
                    index = faiss.IndexHNSWFlat(d, 32, faiss.METRIC_INNER_PRODUCT)
                    index.hnsw.efSearch = 64
                else:
                    quantizer = faiss.IndexFlatIP(d)
                    index = faiss.IndexIVFFlat(quantizer, d, 64, faiss.METRIC_INNER_PRODUCT) if effective == "ivf-flat" else faiss.IndexIVFPQ(quantizer, d, 64, next((m for m in (64,32,16,8) if d % m == 0 and d // m >= 8), 8), 8, faiss.METRIC_INNER_PRODUCT)
                    index.train(x); index.nprobe = 16
                index.add(x); INDEXES[key] = index
                temporary = cache / (key + "." + str(os.getpid()) + ".tmp")
                faiss.write_index(index, str(temporary)); os.replace(temporary,cached)
                for old in sorted(cache.glob("*.index"),key=lambda f:f.stat().st_mtime,reverse=True)[4:]:
                    try: old.unlink()
                    except OSError: pass
                while len(INDEXES) > 2: INDEXES.popitem(last=False)
            INDEXES.move_to_end(key)
            scores, indices = INDEXES[key].search(q, top)
            hits = zip(indices[0], scores[0])
        elif backend == "qdrant":
            from qdrant_client import QdrantClient, models
            url = CONFIG.get("qdrantUrl")
            client = QdrantClient(url=url, api_key=CONFIG.get("qdrantKey")) if url else QdrantClient(path=str(ROOT / "qdrant"))
            if not url: effective, reason = "exact-local", "Embedded Qdrant local mode does not run the server HNSW index"
            name = "amadeus_" + key[:24]
            try:
                if not client.collection_exists(name):
                    client.create_collection(name, vectors_config=models.VectorParams(size=x.shape[1], distance=models.Distance.COSINE))
                for start in range(0, len(rows), 256):
                    client.upsert(name, points=[models.PointStruct(id=i, vector=x[i].tolist()) for i in range(start, min(start+256, len(rows)))], wait=True)
                found = client.query_points(name, query=q[0].tolist(), limit=top).points
                hits = [(int(p.id), p.score) for p in found]
            finally: client.close()
        else:
            from pymilvus import MilvusClient, DataType
            uri = CONFIG.get("milvusUri")
            if not uri: raise ValueError("Configure a local Milvus server URI (Milvus Lite is not supported by this Windows launcher)")
            client = MilvusClient(uri=uri, token=CONFIG.get("milvusToken", ""))
            name = "amadeus_" + key[:24]
            try:
                if not client.has_collection(name):
                    schema = client.create_schema(auto_id=False, enable_dynamic_field=False)
                    schema.add_field("id", DataType.INT64, is_primary=True)
                    schema.add_field("vector", DataType.FLOAT_VECTOR, dim=x.shape[1])
                    params = client.prepare_index_params()
                    tuning = {"M": 32, "efConstruction": 200} if effective == "hnsw" else {"nlist": 64, **({"m": 8, "nbits": 8} if effective == "ivf-pq" else {})} if effective.startswith("ivf") else {}
                    params.add_index(field_name="vector", index_type={"flat":"FLAT", "hnsw":"HNSW", "ivf-flat":"IVF_FLAT", "ivf-pq":"IVF_PQ"}[effective], metric_type="COSINE", params=tuning)
                    client.create_collection(name, schema=schema, index_params=params)
                for start in range(0, len(rows), 256):
                    client.upsert(name, data=[dict(id=i, vector=x[i].tolist()) for i in range(start, min(start+256, len(rows)))])
                client.load_collection(name)
                found = client.search(name, data=q.tolist(), limit=top, consistency_level="Strong",
                    search_params={"metric_type":"COSINE","params": {"ef":64} if effective=="hnsw" else {"nprobe":16} if effective.startswith("ivf") else {}})[0]
                hits = [(int(p["id"]), p["distance"]) for p in found]
            finally: client.close()
        return dict(result=[dict(id=rows[int(i)]["id"], score=float(s)) for i,s in hits if int(i)>=0],
                    effectiveIndex=effective, fallbackReason=reason)

async def rag_for(scope):
    if not isinstance(scope,str) or not scope or len(scope)>200: raise ValueError("Invalid scope")
    async with RAG_LOCKS.setdefault(scope,asyncio.Lock()):
        return await create_rag(scope)

async def create_rag(scope):
    if not isinstance(scope, str) or not scope or len(scope)>200: raise ValueError("Invalid scope")
    fresh = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
    if fresh.get("extraction") != CONFIG.get("extraction"):
        raise ValueError("Extraction configuration changed; restart local service first")
    extraction_id = hashlib.sha256(json.dumps(fresh.get("extraction",{}),sort_keys=True).encode()).hexdigest()
    rag_key = scope + ":" + extraction_id
    if rag_key in RAGS: return RAGS[rag_key]
    from lightrag import LightRAG
    from lightrag.utils import EmbeddingFunc, Tokenizer
    from lightrag.kg.shared_storage import initialize_pipeline_status
    llm = fresh.get("extraction", {})
    if not llm.get("apiKey"): raise ValueError("Configure extraction model before LightRAG ingestion")
    async def complete(prompt, system_prompt=None, history_messages=None, **kwargs):
        # Direct protocol adapter avoids optional SDK auto-install hooks in upstream adapters.
        import httpx
        messages = ([{"role":"system","content":system_prompt}] if system_prompt else []) + (history_messages or []) + [{"role":"user","content":prompt}]
        body = {"model":llm["model"],"messages":messages,"stream":False}
        if kwargs.get("response_format"): body["response_format"] = kwargs["response_format"]
        async with httpx.AsyncClient(timeout=120, follow_redirects=False) as client:
            response = await client.post(llm["baseUrl"].rstrip("/") + "/chat/completions",
                headers={"Authorization":"Bearer " + llm["apiKey"]}, json=body)
            response.raise_for_status()
            result = response.json()
        choice = result["choices"][0]
        if choice.get("finish_reason") != "stop" or not isinstance(choice["message"].get("content"),str):
            raise ValueError("Extraction did not return a complete text response")
        return choice["message"]["content"]
    class LocalTokenizer:
        def encode(self, text):
            with LOCK: return model("embedding").tokenizer.encode(text, add_special_tokens=False)
        def decode(self, tokens):
            with LOCK: return model("embedding").tokenizer.decode(tokens, skip_special_tokens=True)
        def __deepcopy__(self, memo): return self
    async def embed(texts, **kwargs):
        import numpy as np
        values, _ = await asyncio.to_thread(embeddings, texts)
        return np.asarray(values)
    rag = LightRAG(working_dir=str(ROOT / "lightrag" / hashlib.sha256((scope + CONFIG["embeddingModel"]).encode()).hexdigest()),
        workspace=hashlib.sha256((scope + CONFIG["embeddingModel"]).encode()).hexdigest(),
        llm_model_func=complete, embedding_func=EmbeddingFunc(embedding_dim=model("embedding").get_sentence_embedding_dimension(), max_token_size=480, func=embed),
        tokenizer=Tokenizer("local-e5", LocalTokenizer()),
        kv_storage="JsonKVStorage", vector_storage="NanoVectorDBStorage", graph_storage="NetworkXStorage",
        doc_status_storage="JsonDocStatusStorage", chunk_token_size=400, chunk_overlap_token_size=40,
        llm_model_max_async=2, max_parallel_insert=1)
    await rag.initialize_storages()
    await initialize_pipeline_status()
    RAGS[rag_key] = rag
    return rag

async def light_query(data):
    from lightrag import QueryParam
    rag = await rag_for(data["scope"])
    return await rag.aquery_data(data["query"], param=QueryParam(mode=data.get("mode","mix"),
        top_k=20, chunk_top_k=20, enable_rerank=False, hl_keywords=[data["query"]], ll_keywords=[data["query"]]))

async def light_insert(data):
    rag = await rag_for(data["scope"])
    texts, sources = data["texts"], data["file_sources"]
    if not 0 < len(texts) <= 16 or len(texts)!=len(sources) or sum(map(len,texts))>100000:
        raise ValueError("Ingest at most 16 chunks and 100000 characters per batch")
    from lightrag.base import DocStatus
    ids = ["doc-" + hashlib.sha256((source + text).encode()).hexdigest() for source,text in zip(sources,texts)]
    await rag.ainsert(texts, ids=ids, file_paths=sources)
    for doc_id in ids:
        status = await rag.doc_status.get_by_id(doc_id)
        if not status or status.get("status") not in (DocStatus.PROCESSED, "processed"):
            raise ValueError("Document pipeline did not finish successfully")
    return {"completed": len(texts)}

def run_job(key, data):
    with JOB_LOCK:
        JOBS[key] = {"status":"processing"}; save_jobs()
    future = asyncio.run_coroutine_threadsafe(light_insert(data), LOOP)
    try:
        result = future.result(timeout=1800)
        with JOB_LOCK:
            JOBS[key] = {"status":"completed", **result}; save_jobs()
    except Exception as error:
        future.cancel()
        with JOB_LOCK:
            JOBS[key] = {"status":"unknown", "error":type(error).__name__}; save_jobs()

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def send(self, status, data):
        raw = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status); self.send_header("Content-Type","application/json")
        self.send_header("Content-Length",str(len(raw))); self.end_headers(); self.wfile.write(raw)
    def do_GET(self):
        if self.path == "/health":
            return self.send(200, {"application":"Amadeus Local RAG", "ready":list(MODELS), "protocol":1, "codeHash":CODE_HASH})
        self.send(404, {"error":"Not found"})
    def do_POST(self):
        auth = self.headers.get("Authorization","").removeprefix("Bearer ") or self.headers.get("X-API-Key","")
        if not hmac.compare_digest(auth, TOKEN): return self.send(401, {"error":"Unauthorized"})
        try:
            self.connection.settimeout(60)
            size = int(self.headers.get("Content-Length","0"))
            if not 0 < size <= 128*1024*1024: raise ValueError("Invalid request size")
            data = json.loads(self.rfile.read(size))
            if self.path in ("/v1/embeddings", "/embeddings"):
                if data.get("model") and data["model"] != CONFIG["embeddingModel"]:
                    raise ValueError("Embedding model changed; restart local service before reindexing")
                texts = data["input"]
                if isinstance(texts,str): texts=[texts]
                if not 0<len(texts)<=128 or not all(isinstance(t,str) for t in texts) or sum(map(len,texts))>200000:
                    raise ValueError("Embedding input too large")
                values, tokens = embeddings(texts)
                result = {"object":"list","model":CONFIG["embeddingModel"],
                    "data":[{"object":"embedding","index":i,"embedding":v} for i,v in enumerate(values)],
                    "usage":{"prompt_tokens":tokens,"total_tokens":tokens}}
            elif self.path == "/rerank": result = rerank(data)
            elif self.path == "/vectors/search": result = vector_search(data)
            elif self.path == "/lightrag/documents/texts":
                if not isinstance(data.get("scope"),str) or not 0<len(data["scope"])<=200:
                    raise ValueError("Invalid scope")
                if not isinstance(data.get("texts"),list) or not 0<len(data["texts"])<=16 or not all(isinstance(t,str) for t in data["texts"]):
                    raise ValueError("Invalid texts")
                if not isinstance(data.get("file_sources"),list) or len(data["texts"])!=len(data["file_sources"]) or not all(isinstance(s,str) and s.startswith("amadeus-") and len(s)<200 for s in data["file_sources"]):
                    raise ValueError("Invalid source identifiers")
                key = hashlib.sha256(json.dumps(data,sort_keys=True).encode()).hexdigest()
                with JOB_LOCK:
                    if key not in JOBS:
                        if sum(j["status"] in ("queued","processing") for j in JOBS.values()) >= 8:
                            return self.send(429, {"error":"Ingestion queue full"})
                        JOBS[key]={"status":"queued"}; save_jobs(); POOL.submit(run_job,key,data)
                    result = {"jobId":key, **JOBS[key]}
            elif self.path == "/lightrag/documents/status":
                result = JOBS.get(data["jobId"], {"status":"unknown"})
            elif self.path == "/lightrag/query/data":
                future = asyncio.run_coroutine_threadsafe(light_query(data),LOOP)
                try: result = future.result(timeout=55)
                except Exception:
                    future.cancel()
                    raise
            else: return self.send(404, {"error":"Not found"})
            self.send(200,result)
        except Exception as error:
            print(type(error).__name__, flush=True)
            self.send(422, {"error":type(error).__name__, "message":"Request failed; inspect local service configuration and resource limits."})

if __name__ == "__main__":
    parser=argparse.ArgumentParser(); parser.add_argument("--warmup",action="store_true"); parser.add_argument("--vector-worker",action="store_true")
    args=parser.parse_args()
    if args.vector_worker:
        print(json.dumps(vector_search(json.load(sys.stdin)))); sys.exit(0)
    if args.warmup:
        model("embedding"); model("rerank")
    print("Amadeus local RAG listening on 127.0.0.1:8811",flush=True)
    ThreadingHTTPServer(("127.0.0.1",8811),Handler).serve_forever()
