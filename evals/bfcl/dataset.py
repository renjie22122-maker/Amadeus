"""BFCL first-decision diagnostic: fixed samples and upstream Python AST grading.
No dataset-described function is executed. model_config shim only avoids importing
every provider SDK; it supplies the one underscore_to_dot flag used by AST grading.
"""
import hashlib, json, pathlib, sys, types
ROOT=pathlib.Path(sys.argv[2])
DATA=ROOT/"bfcl_eval/data"
def rows(p): return [json.loads(x) for x in p.read_text(encoding="utf-8").splitlines() if x.strip()]
def digest(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def schema(x):
    if isinstance(x,list): return [schema(v) for v in x]
    if not isinstance(x,dict): return x
    out={k:schema(v) for k,v in x.items()}
    if "type" in out: out["type"]={"dict":"object","float":"number","tuple":"array","any":"string"}.get(out["type"],out["type"])
    return out
def prepare(out):
    chosen=[]; hashes={}
    for cat in ["simple_python","multiple","parallel","irrelevance"]:
        p=DATA/("BFCL_v4_"+cat+".json")
        hashes[str(p.relative_to(ROOT))]=digest(p)
        items=sorted(rows(p),key=lambda x:hashlib.sha256(("amadeus-bfcl-v1:"+x["id"]).encode()).hexdigest())[:5]
        for item in items:
            names={f["name"].replace(".","_"): f["name"] for f in item["function"]}
            assert len(names)==len(item["function"])
            chosen.append({"id":item["id"],"category":cat,"question":item["question"],
                "functions":item["function"],"names":names,
                "tools":[{"name":f["name"].replace(".","_"),"description":f["description"],
                "parameters":schema(f["parameters"]),"effect":"read"} for f in item["function"]]})
    out.write_text(json.dumps({"selection":"sha256(amadeus-bfcl-v1:id), lowest five per category","hashes":hashes,"cases":chosen},ensure_ascii=False,indent=2),encoding="utf-8")
def grade(folder):
    sys.path.insert(0,str(ROOT))
    shim=types.ModuleType("bfcl_eval.constants.model_config")
    shim.MODEL_CONFIG_MAPPING={"diagnostic":types.SimpleNamespace(underscore_to_dot=True)}
    sys.modules[shim.__name__]=shim
    from bfcl_eval.eval_checker.ast_eval.ast_checker import ast_checker
    from bfcl_eval.constants.enums import Language
    manifest=json.loads((folder/"cases.json").read_text(encoding="utf-8"))
    grades=[]; hashes={}
    for case in manifest["cases"]:
        p=DATA/"possible_answer"/("BFCL_v4_"+case["category"]+".json")
        if "irrelevance" not in case["category"] and case["category"]!="live_relevance":
            hashes[str(p.relative_to(ROOT))]=digest(p)
            answer=next(r["ground_truth"] for r in rows(p) if r["id"]==case["id"])
        for arm in ["amadeus","smolagents"]:
            path=folder/(case["id"]+"-"+arm)/"result.json"
            if not path.exists(): continue
            r=json.loads(path.read_text(encoding="utf-8"))
            calls=r.get("message",{}).get("calls",[])
            final=[c for c in calls if c["name"]=="final_answer"] if arm=="smolagents" else []
            actual=[{c["name"]:c["arguments"]} for c in calls if c not in final]
            if r.get("error"): g={"valid":False,"error":[r["error"]]}
            elif final and len(calls)>1: g={"valid":False,"error":["final_answer mixed with action"]}
            elif "irrelevance" in case["category"]: g={"valid":len(actual)==0}
            elif case["category"]=="live_relevance": g={"valid":bool(actual)}
            else: g=ast_checker(case["functions"],actual,answer,Language.PYTHON,case["category"],"diagnostic")
            grades.append({"id":case["id"],"category":case["category"],"arm":arm,"grade":g,
                           "usage":r.get("usage"),"elapsedMs":r.get("elapsedMs"),"error":r.get("error")})
    scorer=ROOT/"bfcl_eval/eval_checker/ast_eval/ast_checker.py"
    hashes[str(scorer.relative_to(ROOT))]=digest(scorer)
    (folder/"grades.json").write_text(json.dumps({"hashes":hashes,"grades":grades},ensure_ascii=False,indent=2),encoding="utf-8")
    for arm in ["amadeus","smolagents"]:
        rs=[r for r in grades if r["arm"]==arm]
        print(arm,sum(r["grade"]["valid"] for r in rs),"/",len(rs))
if sys.argv[1]=="prepare": prepare(pathlib.Path(sys.argv[3]))
elif sys.argv[1]=="grade": grade(pathlib.Path(sys.argv[3]))

