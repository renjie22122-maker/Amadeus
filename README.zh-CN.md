# Amadeus

[English](README.md) | [简体中文](README.zh-CN.md)

本地优先的 AI 工作台，用于对话、编程、研究与创意任务。在同一个界面连接模型 API、操作项目文件，使用 Skills、知识库、媒体和 Agent 团队。

名称灵感来自《命运石之门》的 Amadeus，原名 AgentDemo。基于 TypeScript、Node.js、React、Fastify 和 SQLite。

## 快速开始

安装**包含 npm 的 Node.js 24+**，下载并完整解压仓库。

**Windows：**双击 **First-Start-Amadeus.cmd**，自动安装锁定依赖、检查／构建、启动守护进程并打开 http://127.0.0.1:8810。以后使用 **Start-Amadeus.cmd**，无需全局安装 pnpm 或 Corepack。原生模块构建失败时可能需要 Python 和 Visual Studio C++ Build Tools；安装依赖需要联网。

**命令行：**准备 pnpm **11.19.0**，然后：

```sh
git clone https://github.com/renjie22122-maker/Amadeus.git
cd Amadeus
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

在设置中添加模型端点、模型 ID 和 API 密钥，再测试连接。模型能力字段不保证实际端点一定支持。

## 日常使用

- **普通对话**用于聊天及会话产物；选择**项目**后授权本地目录与命令。项目支持最多 12 个互不重叠的文件夹。
- 在输入框附近选择模型支持的推理等级、协作、审批与执行隔离。获批宿主命令仍有宿主账号权限。
- 添加附件、选择 Skill；全局提醒菜单可定位其他对话里的问答／审批。
- 查看可折叠步骤、轮次导航、文件差异、上下文和用量。HTML 演示及 Mermaid 图默认预览，可切换到内部滚动的代码。
- 媒体服务独立配置。图片、视频、音频、3D 产物可检查／导出，兼容的图片／音频／视频可继续作为生成参考。语音输入先形成可编辑草稿。
- 按需开启范围内自动记忆或知识库文件夹维护。普通对话共享资料、项目资料和私有会话文档保持分开。

界面支持中英文、自定义助手名、自动字号及 25–150% 档位。详见[完整双语文档](docs/README.zh-CN.md)。

## 更新

先结束活动任务、停止服务，更新代码后运行快速启动。它会识别依赖和源码变化。服务运行时首次启动拒绝替换依赖；快速启动只打开已有服务，不热更新。启动失败查看 .data/logs。

旧 AgentDemo 启动文件仍兼容，已有数据和自定义助手名保留。内部 AGENTDEMO_* 环境变量、Cookie／存储键、签名文件名有意保留兼容名字，本地检出目录不必改名。

## 安全与本地数据

新配置在 Windows 默认 AppContainer、其他平台默认 Docker；命令执行前需准备对应环境。旧配置保留原后端，不自动退回宿主。浏览器／MCP／桌面适配器有独立宿主权限。见[安全](docs/SECURITY.zh-CN.md)与[执行配置](docs/MIGRATION.zh-CN.md)。

.data 保存私有配置、会话与产物，.diagnostics 保存本机测试输出，均不提交 Git。Windows 密钥使用当前用户 DPAPI，其他平台使用受限文件。迁移前备份私有状态。模型／embedding／媒体调用向所选服务发送输入；本地 embedding 不代表生成回答的 LLM 也在本地。

## 开发

```sh
pnpm dev
# 另一个终端：
pnpm web
```

后端端口 8810，Vite 端口 8811 并代理 API。检查命令：

```sh
pnpm check
pnpm test
pnpm build
```

CI 在 Windows 和 Ubuntu 运行。公开测试已脱敏；可选桌面／浏览器测试需宿主明确开启。历史结果不是通用能力评分。

| 目录                    | 内容                           |
| ----------------------- | ------------------------------ |
| src                     | React 界面                     |
| server/core             | 运行时、上下文、生命周期和团队 |
| server/providers        | 模型适配                       |
| server/tools            | 工具契约与调用                 |
| server/services         | 执行、审批、检索和集成         |
| server/storage / shared | 持久存储／共享类型             |
| tests / evals           | 回归测试／评测工具             |
| docs                    | 当前指南及独立历史目录         |

## 排错与变更

反馈问题时附操作系统、Node 版本、后端、复现步骤和脱敏错误。不要上传密钥或私有聊天。沙箱依赖缺失、操作中断结果不明，不能靠盲目重跑解决。

- [文档目录](docs/README.zh-CN.md)
- [更新日志](CHANGELOG.zh-CN.md)
- [历史原文与报告](docs/history/README.zh-CN.md)
- [测试与证据边界](docs/VERIFICATION.zh-CN.md)

## 构建与发布状态

标准构建产出 build/ 下的服务端 JavaScript、原生适配器与工作进程资源，以及 dist/ 下的前端资源。pnpm start 和 Windows 守护进程运行编译后的后端；tsx 用于开发和测试。运行时需保留 build/、dist/、包元数据和已安装依赖；CI 产物不是独立安装包。

本仓库采用 [MIT 许可证](LICENSE)。第三方依赖、模型和数据集仍遵循各自许可证。0.1.0 是开发期包标识，不表示按日期记录的每次变更都是一个编号发布版本。

## 本地检索

[本地 LightRAG、GPU embedding 与重排配置](docs/LOCAL-RAG.zh-CN.md)

可选隔离计算与媒体分析：Docker 运行后执行 `Setup-Analysis.cmd`，再在设置中选择 Docker 和准备好的镜像。普通启动不下载此镜像。详见[通用工作链](docs/TOOL-ECOSYSTEM.zh-CN.md)。

本地中英语音转写、语音合成与回复朗读：[Guide](docs/LOCAL-VOICE.zh-CN.md).
