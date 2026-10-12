# 工具生态

[English](TOOL-ECOSYSTEM.md) | [简体中文](TOOL-ECOSYSTEM.zh-CN.md) · [文档目录](README.zh-CN.md)

当前说明核对日期：2026-10-05；代码基线: `d663030`.

## 发现与组合

search_tools 渐进暴露匹配定义，支持中英文关键词及可选仅本地 embedding 融合；本地失败明确回退。search_capabilities 合并范围内工具／技能／记忆／知识发现，不授予权限。

glob 与 UTF-8 字面 grep 保持 FileScope 并报告限制。read_json 返回结构化数据，read_file 带行号。batch_read_tools 最多 20 项并行安全读取、四工作者；tool_workflow 最多 12 步、布尔条件、前序结果引用、20 项循环，总调用最多 40。拒绝未来／原型引用、递归组合和任意代码执行；每个子调用保留审批／审计，部分失败不是事务。

transform_data 支持有界计数／字段投影／等值过滤／去重／求和（1,000 项／1 MB）。inspect_file_version 与 apply_patch 支持最多 20 个已有文件的哈希绑定精确片段，部分写入明确报告。Git 检查走普通命令后端，不使用特权子进程，不自动恢复或猜测作者归属。

## 浏览器与桌面

在设置 → 工具生态添加默认禁用的适配器，核对权限后开启。Playwright 在 Windows 使用已安装 Edge，其他平台需准备 Chromium。浏览器配置按会话隔离；可选保存 Cookie／本地存储，不等于保存完整标签页。重置／删除清理所属状态。

支持导航、点击、填表、按键、选择、等待、滚动、截图和保留弹出页。browser_tabs／select_tab／close_tab 使用上下文内稳定 ID。上传／下载桥接限制 10 MiB 与授权路径；上传需批准，下载不覆盖、不执行。非空精确域名白名单阻止重定向／WebSocket；空列表使用已批准宿主网络，不是固定 DNS 式 SSRF 隔离。

interaction_capabilities 不启动进程，只报告配置；enabled-unverified 不等于探测成功。Windows Computer Use 用 .NET Framework 编译器构建本地 C# 适配器，不修改 PowerShell 策略。支持窗口／UI Automation 枚举、截图、鼠标、输入、基本按键、滚动和拖拽。互斥锁串行输入；目标必须已在前台，失焦停止，不强行切窗。

无 windowId 时截图可见像素；有 ID 时用 PrintWindow 尝试遮挡窗口截图。最小化／无效／不支持时失败，不自动转为全桌面截图。有 20 秒时限和 1,600 万像素上限。GPU／受保护内容仍可能黑屏或陈旧，contentVerified 为 false。它是宿主桌面控制，不是自动 VM 隔离或所有应用的能力认证。

## Skills、技能包与 Hooks

技能按需加载，资源可物化；依赖通过获批的项目内 pip/npm 环境准备，禁用 npm 生命周期脚本。依赖就绪不证明完整技能可用，也不会自动获取账号。

支持本地包预览、哈希绑定安装／升级／回滚及停用，新修订默认禁用，保留源版本。agentdemo-signature.json 是兼容文件名；Ed25519 使用用户信任的 PEM 密钥验证原始 SHA-256 清单摘要，不认证代码安全。来源目录不是在线市场、自动远程下载器或 OAuth 生命周期。

Hooks 覆盖 Tool、Command、Compaction、TaskComplete、MemoryWrite 前后阶段，支持前置拒绝和审计。命令钩子仅用于工具／命令阶段，保留权限且阻止递归，每次外层调用最多八条钩子命令。Skill 不能启用宿主钩子。

## 来源、产物与策略

research_sources 最多收集六个公开 URL；crosscheck_sources 检查引文、模型指定的支持／反对立场、重复正文与域名数。来源不证明真假或发布者独立。有界压缩保留来源警告哈希，启发式注入警告不是完整污点跟踪。

产物登记路径／哈希／大小／类型／生产者；检查发现失效／缺失，停用不删文件。所有工具有审计和进度，命令另有流式输出；进度不虚构完成百分比。

操作规则只能拒绝或要求人工；专家角色限制继承的 Skill／工具。计划审核将同意绑定到任务板哈希／版本，不授予工具权。模型能力检查区分配置与端点实测。

## 生成媒体

list_media 找到同会话历史／当前任务，media_status 回执提供 media:jobId:outputId。inspect_media 查元数据与完整性，read_image(mediaRef) 发送规范化像素；export_media 将原字节写到授权项目新路径，拒绝覆盖／保护路径。不应仅因媒体位于私有存储而要求用户重新上传。

图片／音频／视频引用可进入获批生成字段，内联上限 25 MB，仍取决于服务商格式支持。3D 支持导出，不是通用参考输入。MP4 检查可读音轨是否存在，不保证可听或浏览器解码；其他／旧／不可读结果保持未知。HTTP 单段字节范围支持拖动播放，界面不默认静音。检查／导出不转码、不补造音轨、不发起付费生成。

见[互动排版](CHAT-FORMATTING.zh-CN.md)、[安全](SECURITY.zh-CN.md)与[验证](VERIFICATION.zh-CN.md)。仍待完善：可靠多文件事务恢复、带用户修改归属的 Git 恢复、远程市场生命周期、VM 自动准备和广泛桌面应用评测。

## 公开网页与协议配置

web_search 使用单独配置的 DeepSeek Messages 搜索通道，默认 https://api.deepseek.com/anthropic/v1，只接受结构化搜索证据，不把模型散文当搜索结果。默认时限 60 秒，不自动付费重试；辅助调用记录到当前运行并占用模型容量。fetch_url 读取公开文本和链接，不执行网页 JavaScript；命令网络仍由所选后端决定。

媒体适配器覆盖 OpenAI 兼容、fal.ai、Replicate、Gemini、ElevenLabs、Deepgram、AssemblyAI、Meshy、Tripo 和 MiniMax。MiniMax 直连端点为 https://api.minimax.io，语音需 voice_setting.voice_id；账号授权和具体模型选项以实际连接为准，不把适配器列表当实测模型列表。图片工具支持 PNG/JPEG/WebP/GIF，按字节识别后规范化到最多 640,000 像素／1 MiB，动画只取首帧。SVG/PDF/视频需先转成图片。媒体读取／导出另有 150 MB 输出边界；这不等于生成服务的尺寸上限。

技能包签名清单按路径排序，项为 {path,bytes,sha256}，路径使用正斜杠；排除隐藏／构建目录和签名文件。对该清单 JSON 的 SHA-256 原始 32 字节做 Ed25519 签名，signature 以 base64 保存。发布者公钥必须由用户信任，不自签即自信任。

## 本地媒体嵌入对话（2026-10-12）

可以让 Agent 展示授权项目目录中已有的图片、视频或音频。新增 `import_media({path})` 通过 FileScope 读取文件、保存副本，并嵌入当前这轮对话；不会回到用户待发送附件区。同一运行中相同名称和内容重复导入复用引用，导入本身不调用外部服务。

选择文件与拖拽上传也支持媒体。图片直接显示，音视频提供播放器、拖动进度和下载入口；默认不静音、不自动播放。支持识别 PNG/JPEG/GIF/WebP、MP3/WAV/FLAC/Ogg、MP4/M4A、WebM；具体编码能否播放取决于浏览器，失败时保留下载入口。每个文件仍限制为 25 MB。批量上传中单个文件失败不丢弃其他已成功附件。

两种入口统一使用 `attachment:<id>`：`inspect_media` 检查元数据，`read_image({mediaRef})` 向视觉模型传入图片像素，`export_media` 不覆盖地导出到项目，后续生成可通过 `generate_media.references` 引用，仍受服务商能力和正常审批约束。引用限定在本对话，新附件校验内容哈希。音视频能播放不代表模型已理解内容，转写与抽帧仍需单独的授权处理；不会把媒体说明当作转写文本导入知识库。
