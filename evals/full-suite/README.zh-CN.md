# 本地赛道完整评测

[English](README.md) | [简体中文](README.zh-CN.md)

本执行器将已支持的评测协议从抽样扩展为全量，**不代表所有下载仓库的全部赛道均已适配**。

| 赛道               | 每个 Agent 的题数 | 协议                                                                                              |
| ------------------ | ----------------: | ------------------------------------------------------------------------------------------------- |
| BFCL               |             3,491 | 11 个 Python／实时单轮类别全部题目；评分首个结构化响应，使用上游 AST 检查器，不执行题目描述的函数 |
| LongMemEval-S      |               500 | 完整配套历史、首响应问答，使用本地下载的原始快照                                                  |
| LongMemEval-Oracle |               500 | 提供标准相关历史的上界对照，单独报告，不能当作记忆检索成绩                                        |
| GAIA 2023 验证集   |               165 | 三组原生能力，或单独报告的共用工具实验；官方评分器                                                |

双方沿用同一个 DeepSeek 连接。基线是 smolagents 1.26.0 的原生提示词／循环，通过共享 Provider 适配层连接模型，并非其默认 SDK 开箱配置。每次尝试使用独立存储。全量批次使用 32,768 输出 token；GAIA 最多 16 次模型调用。首响应赛道不能衡量 Runtime 自动恢复能力。不为匹配答案而改写原始提交。

GAIA 主评测使用 Amadeus 生产工具及 smolagents 原生搜索／页面／Python 工具和配置的文件／图片工具，smolagents 整个求解进程在离线 Docker 中运行。辅助共用工具协议提供裁剪、表格样式、远程 PDF、Python／FFmpeg 和有限格式纠正。浏览器交互及转录未在此配置启用；来源过滤不能证明零污染。详见[协议说明](../../docs/BENCHMARKS.zh-CN.md)。

LongMemEval-M 需要单独确定上下文或历史入库协议，不能截短后冒称完整历史；profile-context.py 可逐题进行有界内存预算估计，但不是服务商精确分词。BFCL 多轮、记忆、网页搜索、Java／JavaScript、格式敏感性未纳入本协议。SWE-bench 可独立暂缓；只有源码的浏览器、桌面和终端赛道仍需要实际运行环境。

## 执行与恢复

准备独立 Python 环境安装 smolagents 1.26.0、unidiff。数据准备及 GAIA 评分所用 Python 还需 pandas、pyarrow、PyYAML、NumPy。数据和结果放在仓库之外。

```powershell
<data-python> evals/full-suite/prepare.py <下载根目录> <全新输出目录>
<eval-python> evals/bfcl/check-adapter.py <BFCL源码> <eval-python>
```

将固定版本的 GAIA 官方 scorer.py 及来源收据放进输出目录的 gaia 子目录。冻结 server/shared/evals 源码并记录哈希、依赖版本；为快照配置 Node 依赖解析，不复制生产数据库或明文密钥。模型连接由宿主读取已授权配置。

```powershell
<eval-python> <源码快照>/evals/full-suite/run.py <输出目录> <源码快照> <eval-python> <配置文件> --download <下载根目录> --prepare-python <data-python> --concurrency 4 --analysis-image <immutable-image-sha256>
```

progress.json 显示当前尝试及计数；逐题保存输入、启动收据、模型结果和进程状态。runner.lock 防止双执行器占用。创建名为 STOP 的文件后，当前尝试收尾，不再派发新题。恢复前先确认旧进程已退出；已启动但结果未知的尝试也不会悄悄重跑。协议、代码或模型变更使用全新目录。

解题完成后自动进行 BFCL／GAIA 评分及 LongMemEval 评分。LongMemEval 使用上游提示词，但以配置的 DeepSeek 替代官方 GPT-4o 裁判，必须披露，不能称为盲评或独立人工评价。空提交／运行错误先判定交付失败；裁判未返回合法结论则保留未评分状态。REPORT.md 和 report.json 区分应测、已尝试、已评分、通过；用量缺失时计数只是已测下界，缓存 token 属于输入的一部分，价格未知就不报精确费用。

这些可选评测脚本不改变正常启动与首次启动流程，也不会在首次启动时安装大型评测环境。

用 `--protocol native-evidence-v1`（默认）或 `--protocol shared-evidence-v2` 选择协议；辅助实验可用 `--tracks gaia`。必须使用新目录，准备过程不会覆盖已有队列。设置 `AMADEUS_EVAL_PYTHON` 与 `AMADEUS_TEST_NATIVE_IMAGE`，先运行 `tests/shared-broker.test.ts` 的三组容器合成预检，再启动付费原生评测。

慢速网络可用 `Setup-Evaluation.ps1 -PipIndexUrl https://mirrors.aliyun.com/pypi/simple/ -DownloadTimeout 120 -DownloadRetries 10` 指定 HTTPS 镜像源；默认仍是 PyPI。BuildKit 缓存可复用已下载内容，保留 TLS 和包哈希校验。这些选项只准备依赖，不启动付费评测。

传输／附件诊断：新批次记录脱敏 Provider 错误类别、阶段、底层错误码与失败调用耗时。基线包装后的生成错误保留最后一次失败请求的诊断，不能把已经恢复的早期故障当作最终原因。评测自身的总期限记为 `EVAL_DEADLINE`，与用户取消区分。原生预检通过各组自己的读取工具或解释器读取随机 XLSX；仅计算算术的预检不能验证文件访问。运行状态与任务工作区采用并列目录，继续执行 FileScope 安全检查。改动仅用于新冻结批次，不能将修复后的尝试混入旧成绩、覆盖回执或修改正在运行的冻结环境。旧 `TypeError` 记录缺少原因，不能事后确定地全部归为网络问题。
