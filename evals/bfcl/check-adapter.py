"""No model calls: scorer controls and prompt-capture contract checks."""
import json,pathlib,sys,types,subprocess,tempfile
root=pathlib.Path(sys.argv[1]);python=sys.argv[2]
sys.path.insert(0,str(root))
shim=types.ModuleType("bfcl_eval.constants.model_config")
shim.MODEL_CONFIG_MAPPING={"diagnostic":types.SimpleNamespace(underscore_to_dot=True)}
sys.modules[shim.__name__]=shim
from bfcl_eval.eval_checker.ast_eval.ast_checker import ast_checker
from bfcl_eval.constants.enums import Language
func=[{"name":"calc.add","parameters":{"type":"dict","properties":{"x":{"type":"integer"},"y":{"type":"integer"}},"required":["x","y"]}}]
answer=[{"calc.add":{"x":[2],"y":[3]}}]
def check(calls,category="simple_python",answers=answer):return ast_checker(func,calls,answers,Language.PYTHON,category,"diagnostic")["valid"]
assert check([{"calc_add":{"x":2,"y":3}}])
assert not check([{"calc_add":{"x":2,"y":4}}])
assert not check([{"calc_add":{"x":2}}])
assert not check([{"missing_tool":{"x":2,"y":3}}])
assert not check([])
assert check([{"calc_add":{"x":4,"y":5}},{"calc_add":{"x":2,"y":3}}],"parallel",answer+[{"calc.add":{"x":[4],"y":[5]}}])
case={"question":[[{"role":"user","content":"Add two and three."}]],"tools":[{"name":"calc_add","description":"Add two integers","parameters":{"type":"object","properties":{"x":{"type":"integer","description":"first"},"y":{"type":"integer","description":"second"}},"required":["x","y"]}}]}
with tempfile.TemporaryDirectory() as folder:
 p=pathlib.Path(folder);(p/"case.json").write_text(json.dumps(case),encoding="utf-8")
 subprocess.run([python,"evals/bfcl/smol-request.py",str(p/"case.json"),str(p/"request.json")],check=True)
 request=json.loads((p/"request.json").read_text(encoding="utf-8"))
 assert request["messages"] and {t["function"]["name"] for t in request["nativeTools"]}=={"calc_add","final_answer"}
 assert request["nativeTools"][0]["function"]["parameters"]["required"]==["x","y"]
print("8 offline grader / prompt controls passed; no model calls")

