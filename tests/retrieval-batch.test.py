"""Exercise isolated batch orchestration without loading/downloading ML models."""
import ast, json, sys, subprocess, unittest, tempfile, hashlib, os, threading
from pathlib import Path
from unittest.mock import patch
source=Path(__file__).resolve().parents[1]/"scripts/retrieval_service.py"
node=next(n for n in ast.parse(source.read_text(encoding="utf-8")).body if isinstance(n,ast.FunctionDef) and n.name=="cached_vector_batch")
class Batch(unittest.TestCase):
 def make(self,search):
  env={"sys":sys,"subprocess":subprocess,"json":json,"__file__":str(source),"cached_vector_search":search}
  exec(compile(ast.Module(body=[node],type_ignores=[]),str(source),"exec"),env)
  return env["cached_vector_batch"]
 def test_single_isolated_worker_for_many_shards(self):
  calls=[]
  def child(args,**kw):
   calls.append(json.loads(kw["input"]));return subprocess.CompletedProcess(args,0,json.dumps({"results":[]}),"")
  with patch.object(subprocess,"run",child): self.make(None)({"backend":"faiss","generations":["a"*64,"b"*64]})
  self.assertEqual(len(calls),1);self.assertTrue(calls[0]["batch"])
 def test_worker_processes_all_shards_without_recursive_spawn(self):
  calls=[]
  def search(d): calls.append(d);return {"result":[],"cacheMiss":d["generation"]=="b"*64}
  with patch.object(sys,"argv",["test","--vector-worker"]):
   result=self.make(search)({"backend":"faiss","generations":["a"*64,"b"*64]})
  self.assertEqual(len(calls),2);self.assertTrue(all(d["cachedOnly"] for d in calls));self.assertTrue(result["results"][1]["cacheMiss"])
 def test_reject_paths_duplicates_and_unbounded_batch(self):
  for ids in [["../secret"],["a"*64]*2,[],[str(i).zfill(64) for i in range(65)]]:
   with self.assertRaises(ValueError):self.make(None)({"backend":"faiss","generations":ids})
class Snapshot(unittest.TestCase):
 def test_complete_reuse_partial_failure_and_deleted_collection(self):
  node=next(n for n in ast.parse(source.read_text(encoding="utf-8")).body if isinstance(n,ast.FunctionDef) and n.name=="ensure_vector_snapshot")
  with tempfile.TemporaryDirectory() as tmp:
   env={"ROOT":Path(tmp),"hashlib":hashlib,"os":os,"threading":threading}
   exec(compile(ast.Module(body=[node],type_ignores=[]),str(source),"exec"),env)
   ensure=env["ensure_vector_snapshot"];state={"count":0,"uploads":0}
   def upload():state["count"]=5;state["uploads"]+=1
   self.assertTrue(ensure("identity",5,False,lambda:state["count"],upload))
   self.assertFalse(ensure("identity",5,True,lambda:state["count"],upload));self.assertEqual(state["uploads"],1)
   state["count"]=2
   def fail():raise RuntimeError("partial")
   with self.assertRaises(RuntimeError):ensure("identity",5,True,lambda:state["count"],fail)
   self.assertTrue(ensure("identity",5,True,lambda:state["count"],upload))
   self.assertTrue(ensure("identity",5,False,lambda:state["count"],upload))
   self.assertTrue(ensure("changed-target",5,True,lambda:state["count"],upload))
if __name__=="__main__":unittest.main()
