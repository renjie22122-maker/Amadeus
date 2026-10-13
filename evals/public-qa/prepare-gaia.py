import pandas as pd,json,pathlib,hashlib,sys
root=pathlib.Path(sys.argv[1]);out=pathlib.Path(sys.argv[2]);out.mkdir(parents=True,exist_ok=True)
source=root/"datasets/gaia/2023/validation/metadata.parquet"
df=pd.read_parquet(source)
eligible=df[df.file_name.eq("")].copy()
eligible["hash"]=eligible.task_id.map(lambda x:hashlib.sha256(("amadeus-gaia-v1:"+x).encode()).hexdigest())
rows=eligible.sort_values("hash").head(6).to_dict("records")
cases=[{"id":r["task_id"],"level":r["Level"],"prompt":r["Question"]+"\nReturn the final answer in the form FINAL ANSWER: <answer>. Use available tools when needed."} for r in rows]
(out/"cases.json").write_text(json.dumps({"kind":"GAIA 2023 validation no-attachment web subset","selection":"sha256(amadeus-gaia-v1:id), lowest six without attachments","eligible":len(eligible),"total":len(df),"sourceSha256":hashlib.sha256(source.read_bytes()).hexdigest(),"cases":cases},ensure_ascii=False),encoding="utf-8")
(out/"references.json").write_text(json.dumps([{"id":r["task_id"],"answer":r["Final answer"]} for r in rows],ensure_ascii=False),encoding="utf-8")
print(len(cases),"selected; eligible",len(eligible),"total",len(df))

