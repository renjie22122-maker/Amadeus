"""Fixed host search adapter: no generated code or model key is accepted."""
import json,sys
from ddgs import DDGS
query=json.loads(sys.stdin.readline())
print(json.dumps(DDGS(timeout=20).text(query['query'],max_results=min(12,query.get('limit',6))),ensure_ascii=False))
