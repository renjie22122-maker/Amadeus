# Benchmark 下载与离线搬运清单

[English](BENCHMARK-DOWNLOADS.md) | [简体中文](BENCHMARK-DOWNLOADS.zh-CN.md) · [评测设计](BENCHMARKS.zh-CN.md)

## 本电脑保存位置

统一使用 **D:\Amadeus-Benchmarks**：

- incoming：其他电脑拷来的完整包，建议 incoming\swe-smoke-v1。
- datasets：运行时数据；含标准答案的原始数据只向评分器开放。
- images：docker save 导出的 tar 文件。
- runs：日志、补丁、报告；可能有源码，不自动上传。
- cache：模型／数据下载缓存。
- manifests：版本、任务清单与 SHA256。
- wsl：可选专用 Linux 发行版。

不要放源码仓库、.data、Amadeus-offline，也不要导入成日常知识库。离线包可删除的前提是内容已经导入到运行环境并验证；保留 manifest。

2026-10-12 本机 D 盘约 195 GiB 空闲，C 盘约 32 GiB。Docker 默认 WSL 目录位于 C 盘；**tar 文件位置不决定 Docker 镜像安装位置**。先在 Docker Desktop 设置中检查 Disk image location，建议移动到 **D:\DockerData**，使用 Docker 自身的迁移入口，不手动移动正在使用的 VHDX。重新预检后再导入大包。完整镜像缓存可能远超当前空间；[官方容量说明](https://www.swebench.com/SWE-bench/guides/docker_setup/)。

## 完整下载入口（按用户要求：全部赛道）

在网好的电脑上将本仓库 evals/benchmark/collect-downloads.py 和 download-catalog.json 放在同一个目录。安装 Python 3.10+ 和 Git 后运行：

```powershell
python -m pip install huggingface_hub gdown
python collect-downloads.py --output E:\Amadeus-Benchmark-Pack --assets
python collect-downloads.py --output E:\Amadeus-Benchmark-Pack --verify
```

输出盘可修改。采集器覆盖所有候选赛道的源码、Verified/Lite/LongMemEval 全量数据、WebArena 五个大型资源和 OSWorld 初始文件缓存；不是只下载 10 题。首次固定 Git commit/HF revision，记录字节数和 SHA256，失败继续其他来源并以非零码退出；重跑不更新已完成来源。Google Drive 限额时使用下面官方链接在浏览器下载，不能把登录页当作成功文件。--verify 核对已记录文件，并报告仍未完成的项；尚未下载或尚需环境准备不算完整。

**源码/数据下载不等于完整可运行环境。** collection.json 的 environmentSteps 还会明确列出每题镜像、地图服务、VM、Python/浏览器环境的准备缺口。下面所有赛道都纳入交付范围；在下载机按对应官方固定版本准备，再把环境一并导出。没有 API key 也能下载公开材料，但付费模型、私有账号、网站实时服务不能打包。

完整包拷到 **D:\Amadeus-Benchmarks\incoming\full-v1**；我之后从中选题。下载机应准备充足外置存储，完整环境可能超过本机剩余空间，不要求一次全部 docker load。

## SWE 环境准备（可先验证 10 题，完整包用全部题）

建议在网好的 **Windows + Docker Desktop + 独立 Ubuntu 24.04 WSL，x86_64** 上准备。Linux x86_64 也可以，但整套 WSL 导出只适用于 Windows 下载机。不要在 ARM Mac 上直接准备不同架构镜像，或拿 Windows wheel 当 Linux wheel。

| 内容                     | 官方位置／准备方式                                               | 交付文件                                            |
| ------------------------ | ---------------------------------------------------------------- | --------------------------------------------------- |
| SWE-bench 源码与评分器   | https://github.com/SWE-bench/SWE-bench                           | source commit.txt、源码和许可证                     |
| Python 3.12 + 全部依赖   | 在 Ubuntu 24.04 venv 中从已固定源码安装；见下文                  | wheels/、requirements.lock、环境导出                |
| Verified 数据 test split | https://huggingface.co/datasets/princeton-nlp/SWE-bench_Verified | HF 缓存、完整 dataset.jsonl、dataset-revision.txt   |
| 固定 10 题               | 下列脚本按仓库均匀选取，固定哈希种子，不读结果挑题               | tasks.txt                                           |
| 这 10 题的真实环境       | 用官方 gold 评分预热；成功后导出所有新建 sweb 镜像               | images/swe-smoke-images.tar、images.json、gold 日志 |
| 小型诊断镜像             | docker.io/library/alpine:3.22                                    | images/alpine.tar（本机已有，可省略）               |
| 完整性                   | SHA256                                                           | SHA256SUMS                                          |
| 可选 WSL 整套环境        | wsl --export                                                     | AmadeusBench.tar，保留 venv 和依赖                  |

不需要再下载 E5、reranker、LightRAG、CUDA 或应用日常依赖来跑这一批。HF 数据含 gold 和隐藏测试，不能给执行 Agent 读取。费用：准备阶段不调用模型；会耗网络、CPU、磁盘。下面是可执行准备流程，**本机只验证了 Docker/评分器预检，尚未验证这套公共环境包**；上游依赖变化可能需要按日志修复。

### 1. 在下载机的专用 Ubuntu 中准备

Ubuntu 首次安装若未配置：通过 Microsoft Store 安装 Ubuntu 24.04 LTS，然后在 Docker Desktop 开启该发行版 WSL integration。用 wsl -l -v 记录实际发行版名称，后文不要照抄一个不存在的名字。

在 Ubuntu Bash 执行：

```bash
set -euo pipefail
mkdir -p "$HOME/amadeus-benchmark-pack"/{images,wheels,manifests,runs}
cd "$HOME/amadeus-benchmark-pack"
sudo apt-get update
sudo apt-get install -y python3-venv python3-pip git build-essential
git clone https://github.com/SWE-bench/SWE-bench source
git -C source rev-parse HEAD > manifests/swebench-commit.txt
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install ./source
python -m pip freeze --exclude-editable > manifests/requirements.lock
python -m pip wheel --wheel-dir wheels ./source
python -m pip list --format=json > manifests/python-packages.json
python --version > manifests/python-version.txt
docker version > manifests/docker-version.txt
```

第一次解析上游版本后锁定并交付这些文件；不是声称 main 永远可复现。复现必须使用该 commit/相同 wheels。pip wheel 收集项目及依赖的 Linux wheel；保留日志，失败不得当作包已齐。整套 WSL 导出还能保留 apt 依赖，不能只拷 .venv 到 Windows Python。

### 2. 下载固定数据并生成首批任务名单

同一 Bash / venv：

```bash
export HF_HOME="$HOME/amadeus-benchmark-pack/hf-cache"
python - <<'PY'
import hashlib, json
from pathlib import Path
from collections import defaultdict
from huggingface_hub import HfApi
from datasets import load_dataset
name = "princeton-nlp/SWE-bench_Verified"
revision = HfApi().dataset_info(name).sha
ds = load_dataset(name, revision=revision, split="test")
Path("manifests/dataset-revision.txt").write_text(name + "\n" + revision + "\n")
with open("dataset.jsonl", "w") as f:
    for row in ds:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")
groups = defaultdict(list)
for row in ds:
    groups[row["repo"]].append(row["instance_id"])
def key(s):
    return hashlib.sha256(("amadeus-smoke-v1:" + s).encode()).hexdigest()
for group in groups.values():
    group.sort(key=key)
selected = []
while len(selected) < min(10, len(ds)):
    for repo in sorted(groups, key=key):
        if groups[repo] and len(selected) < 10:
            selected.append(groups[repo].pop(0))
Path("manifests/tasks.txt").write_text("\n".join(selected) + "\n")
print("revision", revision, "tasks", len(selected))
PY
```

完整数据与缓存都交付；默认流程先拉 tasks.txt 对应环境验证。完整包请将选题脚本中两处 10 都改为 len(ds)，生成全部任务 ID，再分批预热和导出；不要只交付十题镜像。名单在看 Amadeus 答案前冻结。若仓库搬迁导致别名变化，按官方数据页确认新地址并记录，不能替换数据后仍沿用旧 revision。

### 3. 官方 gold 环境预热，不调用 Agent

先查看锁定版本的入口，确认下述选项存在：

```bash
python -m swebench.harness.run_evaluation --help
mapfile -t TASKS < manifests/tasks.txt
docker image ls --format '{{.ID}}' | sort -u > manifests/images-before.txt
HF_HUB_OFFLINE=1 python -m swebench.harness.run_evaluation \
  --dataset_name princeton-nlp/SWE-bench_Verified \
  --predictions_path gold \
  --instance_ids "${TASKS[@]}" \
  --max_workers 1 --cache_level instance \
  --run_id amadeus-smoke-gold-v1
```

离线数据读取若未命中缓存，先停止核对 revision/cache，不要悄悄换成新版。HF_HUB_OFFLINE 只关闭 HF 查询，不阻止 Docker 拉取/构建任务依赖。上游若改变 gold 参数，按固定源码生成官方 JSONL predictions（instance_id、model_name_or_path、model_patch=gold patch），仅用于评分器自检。

检查每题官方 report：10 个任务都应产生报告，gold 失败要区分环境和数据问题；**gold 通过不是 Amadeus 通过**。不要把隐藏测试或 gold 暴露到未来 solver 容器。完整复制 logs。空补丁控制和 solver/grader 分离在本机适配器阶段继续验证。

### 4. 导出镜像与 Linux 环境

在专用下载环境中，只导出 SWE 镜像（不导出其他个人容器），Bash：

```bash
mapfile -t IMAGES < <(docker image ls --format '{{.Repository}}:{{.Tag}}' | grep 'sweb\.' | sort -u)
test "${#IMAGES[@]}" -gt 0
docker image inspect "${IMAGES[@]}" > manifests/images.json
docker save --output images/swe-smoke-images.tar "${IMAGES[@]}"
docker pull --platform linux/amd64 alpine:3.22
docker save --output images/alpine.tar alpine:3.22
find images wheels manifests -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS
sha256sum dataset.jsonl >> SHA256SUMS
```

核对 images.json 覆盖 tasks.txt 的全部任务；命名改变或没有匹配镜像就停止检查，不把空 tar 交付。共享层会被 docker save 去重。大小取实际文件值，不事先承诺固定 GB。

Windows PowerShell 中退出/关闭此专用 WSL 后：

```powershell
wsl --list --verbose
# 将 Ubuntu-24.04 替换为下载机的实际专用发行版名
wsl --terminate Ubuntu-24.04
wsl --export Ubuntu-24.04 E:\AmadeusBench.tar
Get-FileHash E:\AmadeusBench.tar -Algorithm SHA256
```

同时从 \\wsl.localhost\Ubuntu-24.04\home\你的Linux用户名\amadeus-benchmark-pack 拷出文件夹，或者在本机导入 WSL 后从该目录取文件。**两者都会占空间**，不需要重复留两份全套。整套发行版导出可能含该发行版其他私人资料，因此务必用专用干净发行版、不要放 API key；HF 公共数据无需私人令牌。tar 的哈希另写在传输清单。

### 5. 拷回本电脑

推荐交付 **D:\Amadeus-Benchmarks\incoming\swe-smoke-v1\AmadeusBench.tar** 和对应 SHA256；如果用分文件方式，整个 pack 放同目录。先核验 SHA256，再导入。先完成 Docker Disk image location 调整。

```powershell
wsl --import AmadeusBench D:\Amadeus-Benchmarks\wsl\AmadeusBench D:\Amadeus-Benchmarks\incoming\swe-smoke-v1\AmadeusBench.tar --version 2
# 在 Docker Desktop 中打开 AmadeusBench 的 WSL integration
wsl -d AmadeusBench
```

导入发行版常默认 root；用原 Linux 用户进入，激活原 venv，按清单运行 sha256sum -c SHA256SUMS。执行 docker load -i images/swe-smoke-images.tar，然后逐个比对 image ID/digest。不要手动复制 Docker 的运行中 VHDX。在断网条件下重新运行同一组 gold（使用**新 run_id**，避免读取旧评分缓存），才算离线环境通过；此阶段仍不能得出 Amadeus 成功率。

如果另一台只有 Linux，没有 WSL export：交付整个 pack + 系统版本清单；本机需另备相同 Ubuntu 环境，并从 wheels 离线安装。单有 wheelhouse 不包含 apt/git/系统动态库，也不等于完整离线环境。

## 完整交付还包括以下环境

| 赛道           | 下载入口                                                                                           | 应完整带回什么                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Terminal-Bench | https://github.com/laude-institute/terminal-bench 、https://www.harborframework.com/               | 固定 2.0 任务 snapshot、Harbor 版本/依赖、每题环境镜像、oracle/verifier 运行日志；不可只拷任务 YAML |
| BFCL           | https://github.com/ShishirPatil/gorilla/tree/main/berkeley-function-call-leaderboard               | 固定 commit 的数据、官方评分代码/依赖、许可；网络型用例另标                                         |
| τ²-bench       | https://github.com/sierra-research/tau2-bench                                                      | 固定 release 的 domain 数据、模拟器与依赖；用户模拟仍有 API 成本                                    |
| WebArena       | https://github.com/web-arena-x/webarena                                                            | 固定配置的站点镜像、数据库/媒体初始快照、reset脚本、浏览器镜像；按官方 setup 完整准备               |
| LongMemEval    | https://github.com/xiaowu0162/LongMemEval 、https://huggingface.co/datasets/xiaowu0162/longmemeval | 测试历史/问题/答案、代码 commit、模型评分配置；V2 不混入原版                                        |
| OSWorld        | https://github.com/xlang-ai/OSWorld                                                                | 官方对应 VM 镜像、任务数据、初始快照/应用；大型，留最后准备                                         |

这些都是待接入赛道；按用户要求全部纳入下载包，但镜像/VM 准备必须保留独立状态，不能把源码下载成功标成环境齐全。每批沿用“固定版本 → oracle/控制检查 → save镜像/系统依赖 → manifest+SHA256 → 本机断网复验”。下载机与本机 CPU 架构一致。所有基准的数据、代码、镜像许可独立保留，不因 Amadeus MIT 而重新授权。

## WebArena / OSWorld 大文件精确链接

采集器使用下列官方文档列出的资源，遇到 Drive 限额可浏览器下载，放进相应 assets 子目录。来源：[WebArena 环境说明](https://github.com/web-arena-x/webarena/blob/main/environment_docker/README.md)、[OSWorld](https://github.com/xlang-ai/OSWorld)。

| 输出路径（完整包内）                                         | 下载地址                                                               |
| ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| assets/webarena-shopping/shopping_final_0712.tar             | https://drive.google.com/file/d/1gxXalk9O0p9eu1YkIJcmZta1nvvyAJpA/view |
| assets/webarena-admin/shopping_admin_final_0719.tar          | https://drive.google.com/file/d/1See0ZhJRw0WTTL9y8hFlgaduwPZ_nGfd/view |
| assets/webarena-forum/postmill-populated-exposed-withimg.tar | https://drive.google.com/file/d/17Qpp1iu_mPqzgO_73Z9BnFjHrzmX9DGf/view |
| assets/webarena-gitlab/gitlab-populated-final-port8023.tar   | https://drive.google.com/file/d/19W8qM0DPyRvWCLyQe0qtnCWAHGruolMR/view |
| assets/webarena-wiki/wikipedia_en_all_maxi_2022-05.zim       | https://drive.google.com/file/d/1Um4QLxi_bGv5bP6kt83Ke0lNjuV9Tm0P/view |
| assets/osworld-cache/osworld_cache.zip                       | https://drive.google.com/file/d/1XlEy49otYDyBlA3O9NbR0BpPfr2TXgaD/view |

WebArena 还需 ghcr.io/kiwix/kiwix-serve:3.3.0 镜像、对应 Playwright Chromium、地图前端及 tile/geocoding/routing 后端。地图按源码 environment_docker 下固定版本的 setup YAML 准备，官方当前说明单地图后端下载约 180 GB。只拷上述五份文件**不算完整 WebArena**；数据库 volume 要单独备份，docker save 不包含运行时 volume。不开放测试站点到公网。

OSWorld 的 cache zip **不是虚拟机**；按固定仓库的 DesktopEnv provider 下载对应 Ubuntu VM，保留整个磁盘文件、配置、快照及初始化缓存。VMware/VirtualBox/Docker provider 不能混用磁盘格式，先记录 provider。本机 Docker 工作不代表 KVM 已验证；涉及 OAuth 的题单列待配置，不能装包后自动取得账号。当前仓库可能已是 OSWorld-Verified，成绩按实际固定 commit 标注，不写成旧版原始成绩。

## Python 与浏览器依赖：完整而不混装

每个赛道独立 venv，按各自锁定源码中的 pyproject.toml / requirements / uv.lock 安装。分别生成 pip freeze、pip wheel（全部传递依赖）、Python/Ubuntu版本和安装日志；不能把所有项目硬塞一个 venv。Browser 赛道还需同版本 python -m playwright install --with-deps chromium，保留浏览器缓存和 apt 库。BFCL、τ² 的数据目录随源码带回；若固定版本脚本引用外部数据，再完成该版本的官方数据下载流程并记入 collection.json 附加清单。

推荐最终导出专用 WSL，把各个 venv、系统库、浏览器缓存和数据都包含；Docker 镜像另 save，数据库 volume 另备份。下载前后列出 image inspect、volume清单和所有外部 URL 缓存。不要将“pip wheel 成功”当成系统依赖已齐。上游系统组合尚未在此机器验证，准备日志必须原样带回，我再检查缺项和实际可运行性。

完整包验收：每个赛道都有源码/版本、全量任务、依赖、环境资产、许可证、哈希、准备日志；任何缺项标 missing/needs-account/needs-build，不写 ready。内部 RAG 与故障测试用本仓库已有测试和后续独立标注留出集，无需下载用户的私人聊天或文档。

## 覆盖补充（同一下载包）

采集器另收录 AgentBench v0.2 源码与 GAIA 全量数据。AgentBench 必须按 v0.2/docs 下载 DB/KG/游戏环境数据，不与当前 FC 主分支混用。GAIA 如需访问授权，在官方 HF 页面接受条件并于下载机本地登录；不要把令牌拷入包。缺权限会被记录为失败，不影响其他下载。相关来源与测量方法见[维度覆盖](BENCHMARKS.zh-CN.md)。
