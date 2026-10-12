# 测试与证据

[English](VERIFICATION.md) | [简体中文](VERIFICATION.zh-CN.md) · [文档目录](README.zh-CN.md)

当前说明核对日期：2026-10-12。

## 当前验证基线

2026-10-05 的 Amadeus 改名提交 d663030：333 项测试通过，2 项环境依赖测试明确跳过，类型检查与生产构建通过。本轮文档整理不构成新增付费模型或 OS 隔离实测；构建仍提示较大分块。

在仓库根目录运行：

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
```

使用 pnpm 11.19.0、Node.js 24+。CI 在 Ubuntu 与 Windows 执行这些检查，本机通过不等于之后的远端 CI 已通过。

可选宿主集成测试：

```powershell
$env:AGENTDEMO_BROWSER_TEST = '1'
node --import tsx --test tests/browser-tabs.test.ts
$env:AGENTDEMO_DESKTOP_TEST = '1'
node --import tsx --test tests/window-capture.test.ts
```

桌面夹具创建自己的窗口，测试遮挡截图及最小化拒绝，不是广泛应用基准；跳过不算通过。

## 证据的含义

工具回执证明在所记录产物上发生了观察，不证明语义正确。文件覆盖来自真实匹配读取，命令退出码 0 不代表检查了全部声明文件。验证任务 done 前需通过的观察；作者自检与另一个运行的检查分开记录，但不同运行不必然意味着推理独立。

快照覆盖声明产物／读取路径、包和配置清单，以及可识别的相对 JS/TS 导入。边界为 512 项、单文件 4 MB、合计 16 MB；输入不完整拒绝绑定。动态导入、外部解析和未声明依赖不完全覆盖。前后哈希能发现很多陈旧情况，不是抗恶意 TOCTOU 证明。

测试包括负对照、崩溃窗口、未知副作用、启动状态组合、权限、来源范围和防重放，不穷尽所有状态序列，也不认证隔离安全。

## 基准

- [编码试点](../evals/coding/README.zh-CN.md)：生产运行时执行小型合成任务，两组 10/10，但未触发复用／压缩。
- [规划](../evals/planning/README.zh-CN.md)：提案协议与图检查，不测代码交付或工作者吞吐。
- [上下文／控制](../evals/context-control/README.zh-CN.md)：配对合成探针，没有证明实现收益。
- [审批历史](APPROVAL-EVALUATION.zh-CN.md)：小型平衡样本上人工率增量下降为 0 个百分点。

API 用量缺失、价格未配置保持未知。缓存 tokens 属于输入子集，不能额外相加。[历史目录](history/README.zh-CN.md)按日期保留结果，不据此给能力打分。

CI 新增当前双语文档配对与本地链接检查，构建后端产物并冒烟验证编译后的 HTTP／独立解析进程、图像编解码及 ONNX 模块加载。这不等于证明文档语义实时正确、干净装机 embedding 推理或沙箱正确性。

## 明确区分验收层次

任务 done 表示附有观察记录的执行完成；record_verification 将成功检查绑定到当前输入；record_task_acceptance 则单独保存有权限的审核者作出的 accepted／rejected／uncertain 语义判断、理由、反例尝试和证据 ID，明确标记为 reviewer-judgment-not-proof。

对有实质验收条件的实现／交付契约设置 requireSemantic 后，必须有 accepted 判断才能交付；明确 rejected 即使在可选契约上也会阻止交付。条件变化或产物检查过期会使判断失效。requireIndependent 还会拒绝作者自己作语义审核、或只引用作者的检查。执行权限审批不会填成人工验收，后者保持 not-recorded。团队黑板与交付投影分别展示这些状态。这是受证据约束的审核，不是软件正确性的自动证明。

2026-10-12 边界／回执／模块拆分更新的验证：共 425 项测试，423 项通过、2 项因环境条件跳过；TypeScript、生产构建及编译后 HTTP／文档／图片／ONNX 冒烟检查通过。未使用付费模型请求；前端大包警告仍存在。本机严格原生隔离拒绝执行、Docker 不可用的检查记录于安全文档，不能算隔离成功测试。

## 慢刷新界面回归

构建后运行 node scripts/check-chat-ui.mjs；需先安装 Playwright 浏览器，或设置 BROWSER_CHANNEL=msedge 使用已安装的 Edge。测试使用临时数据库和假模型，挂起发送后的刷新 GET，验证收到确认即结束转圈、下一条草稿可编辑，再放开刷新检查消息显示。不使用真实会话或付费模型。

chat-performance 回归还覆盖：旧检查点损坏时仅通过元数据查询活跃状态、会话范围过滤、增量事件和 SSE 缺口补齐。这些是行为验证，不是生产环境延迟基准。

本次验证：428 项测试，426 通过、2 项跳过；TypeScript、生产构建、编译后服务冒烟及隔离 Edge 慢刷新回归通过。跳过的原生桌面测试不能算作隔离证据。

向量与图表更新验证：434 项测试，432 通过、2 项跳过。新增损坏向量、索引修复、取消、数据库故障、范围隔离和并发轨迹用例。scripts/check-chart-ui.mjs 使用临时假模型服务检查四种图表、源码切换、移动端宽度和恢复对话初始化；scripts/check-chat-ui.mjs 继续验证慢刷新不阻塞发送确认。两者均通过已安装 Edge 验证（BROWSER_CHANNEL=msedge）。不代表全部渲染格式或 OS 隔离已通过认证。
