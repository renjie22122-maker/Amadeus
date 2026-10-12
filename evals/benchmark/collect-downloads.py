"""Collect the full benchmark source/data inventory; does not run models or installers.
Python 3.10+, git, pip install huggingface_hub gdown.
Public sources are pinned on first resolution. Environments remain explicitly pending.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time

def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()

def run(*args):
    return subprocess.check_output(args, text=True, timeout=3600).strip()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--assets", action="store_true", help="Also fetch large official Drive assets")
    parser.add_argument("--catalog", default=str(Path(__file__).with_name("download-catalog.json")))
    parser.add_argument("--verify", action="store_true", help="Offline verify recorded file hashes only")
    a = parser.parse_args()
    root = Path(a.output).resolve()
    root.mkdir(parents=True, exist_ok=True)
    manifest = root / "collection.json"
    if a.verify and not manifest.exists():
        raise RuntimeError("No collection manifest; nothing to verify")
    state = json.loads(manifest.read_text()) if manifest.exists() else {"schemaVersion":1,"items":{}}
    def save():
        tmp = manifest.with_suffix(".tmp")
        tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(manifest)
    if a.verify:
        failures = []
        for item in state["items"].values():
            for rec in item.get("files", []):
                p = (root / rec["path"]).resolve()
                if not p.is_relative_to(root) or not p.is_file() or digest(p) != rec["sha256"]:
                    failures.append(rec["path"])
        pending = [k for k,v in state["items"].items() if v.get("status") != "downloaded"]
        print(json.dumps({"hashFailures":failures,"pendingDownloads":pending,"environmentSteps":state.get("environmentSteps",[]),"note":"Hash verification does not mean environments are prepared."}))
        return 1 if failures or pending else 0
    cat = json.loads(Path(a.catalog).read_text(encoding="utf-8"))
    cat_hash = hashlib.sha256(Path(a.catalog).read_bytes()).hexdigest()
    if state.get("catalogHash", cat_hash) != cat_hash:
        raise RuntimeError("Catalog changed; use a new output directory.")
    state["catalogHash"] = cat_hash
    state["environmentSteps"] = cat["environmentSteps"]
    failures = []
    def collect(kind, item, action):
        key = kind + ":" + item["id"]
        rec = state["items"].setdefault(key, {"source":item,"status":"pending"})
        print(key, flush=True)
        try:
            # Complete items are not silently updated. --verify checks transfer integrity.
            if rec["status"] != "downloaded":
                paths = action(rec)
                rec["files"] = [{"path":str(p.relative_to(root)), "bytes":p.stat().st_size, "sha256":digest(p)} for p in paths if p.is_file()]
                rec["status"] = "downloaded"
                rec["completedAt"] = time.time()
                rec.pop("error",None)
                save()
        except Exception as e:
            rec["status"] = "failed"
            rec["error"] = type(e).__name__ + ": " + str(e)[:1000]
            save()
            failures.append(key)
            print("FAILED",key,flush=True)
    for item in cat["git"]:
        def getgit(rec, item=item):
            target=root/"sources"/item["id"]
            if not target.exists():
                target.parent.mkdir(parents=True,exist_ok=True)
                run("git","clone","--depth","1",*(["--branch",item["ref"]] if item.get("ref") else []),item["url"],str(target))
            if not (target/".git").exists():
                raise RuntimeError("Incomplete clone; inspect destination before retry.")
            rec["revision"]=run("git","-C",str(target),"rev-parse","HEAD")
            save()
            # Archive committed source only; not arbitrary downloaded working-tree files.
            archive=root/"source-archives"/(item["id"]+".tar")
            archive.parent.mkdir(parents=True,exist_ok=True)
            run("git","-C",str(target),"archive","--format=tar","--output="+str(archive),"HEAD")
            return [archive]
        collect("git",item,getgit)
    for item in cat["datasets"]:
        def getdata(rec,item=item):
            from huggingface_hub import HfApi, snapshot_download
            if not rec.get("revision"):
                rec["revision"]=HfApi().dataset_info(item["repo"]).sha
                save()
            target=root/"datasets"/item["id"]
            snapshot_download(repo_id=item["repo"],repo_type="dataset",revision=rec["revision"],local_dir=str(target))
            return [p for p in target.rglob("*") if p.is_file() and ".cache" not in p.relative_to(target).parts]
        collect("dataset",item,getdata)
    for item in cat["drive"]:
        if not a.assets:
            state["items"].setdefault("drive:"+item["id"],{"source":item,"status":"pending_large_asset"})
            continue
        def getdrive(rec,item=item):
            import gdown
            target=root/"assets"/item["id"]/item["file"]
            target.parent.mkdir(parents=True,exist_ok=True)
            if not gdown.download(id=item["driveId"],output=str(target),quiet=False,resume=True):
                raise RuntimeError("Download failed; quota/sign-in may need browser download.")
            if target.stat().st_size < 1024:
                raise RuntimeError("Unexpectedly small asset")
            with target.open("rb") as f:
                prefix=f.read(512).lower()
            if b"<html" in prefix or b"<!doctype html" in prefix:
                raise RuntimeError("Received an HTML page instead of an asset")
            return [target]
        collect("drive",item,getdrive)
    save()
    print(json.dumps({"failed":failures,"manifest":str(manifest),"environments":"pending; see environmentSteps"},indent=2))
    return 1 if failures else 0

if __name__ == "__main__":
    sys.exit(main())
