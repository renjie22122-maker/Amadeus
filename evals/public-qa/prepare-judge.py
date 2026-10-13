"""Use the upstream LongMemEval rubric with a disclosed DeepSeek judge."""
import ast,json,pathlib,sys,hashlib
root=pathlib.Path(sys.argv[1]);out=pathlib.Path(sys.argv[2])
source=root/"sources/longmemeval/src/evaluation/evaluate_qa.py"
tree=ast.parse(source.read_text(encoding="utf-8")); fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=="get_anscheck_prompt")
ns={};exec(compile(ast.Module(body=[fn],type_ignores=[]),str(source),"exec"),ns)
refs=json.loads((out/"references.json").read_text(encoding="utf-8"));prompts=[]
for r in refs:
 for arm in ["amadeus","smolagents"]:
  p=out/(r["question_id"]+"-"+arm)/"result.json"
  if not p.exists():continue
  result=json.loads(p.read_text(encoding="utf-8"));m=result.get("message",{})
  finals=[c for c in m.get("calls",[]) if c["name"]=="final_answer"]
  hyp=str(finals[0]["arguments"].get("answer","")) if finals else m.get("content","")
  prompts.append({"id":r["question_id"],"arm":arm,"hypothesis":hyp,"sourceError":result.get("error") or ("EMPTY_SUBMISSION" if not hyp.strip() else None),
     "prompt":ns["get_anscheck_prompt"](r["question_type"],r["question"],r["answer"],hyp,abstention=r["question_id"].endswith("_abs"))})
(out/"judge-prompts.json").write_text(json.dumps(prompts,ensure_ascii=False),encoding="utf-8")
print(len(prompts),"judge prompts; source",hashlib.sha256(source.read_bytes()).hexdigest())

