"""Create a new frozen benchmark plus desktop controls, without starting paid work."""
import argparse, hashlib, json, os, pathlib, shutil, subprocess, sys
from desktop import save, read, profile_signature, now


def main():
    p = argparse.ArgumentParser()
    for name in ['repo','root','python','data-python','settings','download','scorer-dir','desktop']:
        p.add_argument('--' + name, required=True)
    p.add_argument('--profile-id'); p.add_argument('--image', default='amadeus-evaluation:local'); p.add_argument('--concurrency', type=int, default=2)
    a = p.parse_args(); repo = pathlib.Path(a.repo).resolve(); root = pathlib.Path(a.root).resolve()
    if root.exists(): raise ValueError('Use a new run directory; existing results are never overwritten')
    if a.concurrency < 1: raise ValueError('Concurrency must be positive')
    settings = read(a.settings); profile_id = a.profile_id or settings['defaultProfileId']
    profile = profile_signature(settings, profile_id)
    root.mkdir(parents=True); runtime = root / 'runtime'; runtime.mkdir()
    files = subprocess.check_output(['git','ls-files','-z'], cwd=repo).decode().split('\0')
    files += ['evals/full-suite/desktop.py','evals/full-suite/prepare-desktop.py']
    hashes = {}
    for name in sorted(set(filter(None, files))):
        source = repo / name
        if not source.is_file(): continue
        target = runtime / name; target.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(source, target)
        hashes[name] = hashlib.sha256(target.read_bytes()).hexdigest()
    revision = subprocess.check_output(['git','rev-parse','HEAD'], cwd=repo).decode().strip()
    save(root / 'source-freeze.json', {'commit': revision, 'at': now(), 'files': hashes, 'note': 'Working tree source captured; harness changes may be newer than commit. No production database or credentials copied.'})
    # Keep modules available without installing packages or copying user configuration.
    if os.name == 'nt':
        command = "New-Item -ItemType Junction -Path '" + str(runtime / 'node_modules').replace("'", "''") + "' -Target '" + str(repo / 'node_modules').replace("'", "''") + "' | Out-Null"
        subprocess.run(['powershell','-NoProfile','-Command',command], check=True)
    else: (runtime / 'node_modules').symlink_to(repo / 'node_modules', target_is_directory=True)
    subprocess.run([a.data_python,'-X','utf8',str(runtime / 'evals/full-suite/prepare.py'),a.download,str(root / 'prepared'),'--protocol','native-evidence-v1'], cwd=runtime, check=True)
    prepared = root / 'prepared'; queue = read(prepared / 'queue.json'); coverage = read(prepared / 'coverage.json')
    for group, tracks in [('text',['bfcl','longmem-s','longmem-oracle']),('gaia',['gaia'])]:
        out = root / group; out.mkdir(); (out / 'jobs').mkdir()
        for track in tracks: shutil.move(str(prepared / track), str(out / track))
        selected = []
        for item in queue:
            if item['track'] not in tracks: continue
            old = pathlib.Path(item['job']); job = read(old)
            directory = out / item['track'] / pathlib.Path(item['directory']).name
            job['directory'] = str(directory); file = out / 'jobs' / old.name; save(file, job)
            selected.append(dict(item, job=str(file), directory=str(directory)))
            old.unlink()
        save(out / 'queue.json', selected)
        save(out / 'coverage.json', dict(coverage, tracks={k:v for k,v in coverage['tracks'].items() if k in tracks}))
    receipt = read(pathlib.Path(a.scorer_dir) / 'scorer-receipt.json')
    scorer = pathlib.Path(a.scorer_dir) / 'official-scorer.py'
    if hashlib.sha256(scorer.read_bytes()).hexdigest() != receipt['sha256']: raise ValueError('Scorer hash mismatch')
    for name in ['official-scorer.py','scorer-receipt.json']: shutil.copy2(pathlib.Path(a.scorer_dir) / name, root / 'gaia/gaia' / name)
    # Remove only empty preparation directories; retain small provenance files.
    (prepared / 'jobs').rmdir()
    config = dict(root=str(root), runtime=str(runtime), python=str(pathlib.Path(a.python).resolve()), dataPython=str(pathlib.Path(a.data_python).resolve()), settings=str(pathlib.Path(a.settings).resolve()), download=str(pathlib.Path(a.download).resolve()), profileId=profile_id, profile=profile, image=a.image, concurrency=a.concurrency, dependencyLock=str(repo / 'pnpm-lock.yaml'), dependencySha256=hashes['pnpm-lock.yaml'])
    save(root / 'desktop-config.json', config)
    desktop = pathlib.Path(a.desktop); desktop.mkdir(parents=True, exist_ok=True)
    for action, label in [('start','Start-Resume'),('stop','Stop'),('report','Results')]:
        script = desktop / ('Amadeus-Benchmark-' + label + '.cmd')
        if script.exists(): shutil.copy2(script, script.with_suffix('.cmd.previous'))
        # Quoted local paths only; no secrets or user text embedded.
        script.write_text('@echo off\r\nchcp 65001 >nul\r\n"' + config['python'] + '" -X utf8 "' + str(runtime / 'evals/full-suite/desktop.py') + '" ' + action + ' "' + str(root / 'desktop-config.json') + '"\r\npause\r\n', encoding='utf8')
    (desktop / 'Amadeus-Benchmark-README.txt').write_text('启动/继续：Amadeus-Benchmark-Start-Resume.cmd\n结束/暂停：Amadeus-Benchmark-Stop.cmd（当前题保存后停止派发，不强杀进程）\n统计结果：Amadeus-Benchmark-Results.cmd\n\n关闭 Codex 或脚本窗口不会停止后台测试。关机、注销、休眠或断网会中断；开机后再次点启动可继续未开始题，不会自动重放结果不明的题。\n停止后请等 status.json 为 paused 再继续。GAIA 等待 Docker 并通过容器预检后开始；文本评测独立进行。\n运行中不要修改所选模型连接或项目 Node 依赖。已完成记录不覆盖。每分钟自动更新 SUMMARY.md/summary.json。\n\n本次输出：' + str(root) + '\n源码及评测协议已冻结；LongMemEval 为完整历史问答，不代表持久记忆召回。评分模型沿用已授权连接，非官方 GPT-4o 分数。\n', encoding='utf-8-sig')
    print(root / 'desktop-config.json')

if __name__ == '__main__': main()
