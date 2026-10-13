import pathlib,sys,json,yaml,types
source=pathlib.Path(sys.argv[1]);folder=pathlib.Path(sys.argv[2]);arm=sys.argv[3]
sys.path.insert(0,str(source))
from swebench.types import TestSpec
# Skip eager Docker/cloud SDK imports; the pure grader itself is unmodified.
harness=types.ModuleType("swebench.harness");harness.__path__=[str(source/"swebench/harness")]
sys.modules["swebench.harness"]=harness
from swebench.harness.grading import get_eval_report
task=folder/"grader/pylint-dev__pylint-7277"
meta=yaml.safe_load((task/"task.yaml").read_text())
tests=json.loads((task/"tests.json").read_text())
spec=TestSpec(instance_id=meta["instance_id"],image=meta["image"],eval_script_list=[],repo=meta["repo"],version=str(meta["version"]),
 FAIL_TO_PASS=tests["FAIL_TO_PASS"],PASS_TO_PASS=tests["PASS_TO_PASS"],log_parser=meta["log_parser"],eval_type=meta["eval_type"])
p=folder/arm
patch=(p/"patch.diff").read_text(encoding="utf-8") if (p/"patch.diff").exists() else ""
report=get_eval_report(spec,{"instance_id":meta["instance_id"],"model_name_or_path":arm,"model_patch":patch},str(p/"test-output.txt"),True)
(p/"grade.json").write_text(json.dumps(report,indent=2),encoding="utf-8")
print(arm,report[meta["instance_id"]]["resolved"],"infra_failure",report[meta["instance_id"]]["infra_failure"])

