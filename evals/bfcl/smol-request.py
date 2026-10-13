"""Capture the native smolagents first-step request; never run benchmark tools."""
import json,sys,copy,pathlib
from smolagents import Tool,ToolCallingAgent,Model
class Captured(BaseException): pass
class SpecTool(Tool):
    skip_forward_signature_validation=True
    output_type="string"
    def __init__(self,spec):
        self.name=spec["name"]; self.description=spec["description"]
        self.inputs=copy.deepcopy(spec["parameters"]["properties"])
        for k,v in self.inputs.items():
            v.setdefault("description","")
            if k not in spec["parameters"].get("required",[]): v["nullable"]=True
        super().__init__()
    def forward(self,**kwargs): raise RuntimeError("Benchmark functions must never execute")
class Capture(Model):
    def generate(self,messages,**kwargs):
        payload=self._prepare_completion_kwargs(messages,**kwargs)
        # Standardized provider broker uses identical BFCL JSON schemas in both arms.
        result={"messages":payload["messages"],"nativeToolChoice":payload.get("tool_choice"),
                "nativeTools":payload.get("tools",[])}
        pathlib.Path(sys.argv[2]).write_text(json.dumps(result,ensure_ascii=False),encoding="utf-8")
        raise Captured()
case=json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
agent=ToolCallingAgent(tools=[SpecTool(t) for t in case["tools"]],model=Capture(),
                       max_steps=1,verbosity_level=-1,add_base_tools=False)
try: agent.run("\n".join(m["content"] for m in case["question"][0]))
except Captured: pass

