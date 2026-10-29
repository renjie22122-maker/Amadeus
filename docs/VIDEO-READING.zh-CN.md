# 通用视频读取与桌面交互

[English](VIDEO-READING.md) | [简体中文](VIDEO-READING.zh-CN.md)

## 视频工具

普通对话、项目、接入聊天共用工具；sourceId 限原对话使用，不跨群或会话。工具不发评论、不关注账号，也不授予电脑权限。

1. `video_probe`：探测 B站（保留分P）、YouTube 或原会话视频附件。工作区文件先经 `import_media` 授权导入。元信息不等于看过画面。
2. `read_video_transcript`：读取已列出的作者字幕、自动字幕或内嵌字幕；支持分页和文字定位。无字幕不会伪造内容。
3. `video_storyboard`：按时间窗返回编号画面；单格用于放大查看。在线视频使用有界 HTTP Range 读取，返回传输字节数、请求次数与实际帧时间。服务器不支持 Range 时明确失败，不隐式下载整片。本地附件使用 FFmpeg 采样及缓存。抽帧不是完整连续运动理解，也不保证看到所有镜头。
4. `extract_video_audio`：只提取指定片段为附件，在线音频同样按 Range 读取。随后调用 `transcribe_media`、`media_status`，沿用已有审批、排队及完成通知；转写时间戳需加片段起点。
5. `read_video_social`：分页读取 B站、YouTube 评论；支持 B站评论回复、单条动态/opus。保留作者和父消息ID，标记为部分、不可信来源内容；动态图片URL可交给 `read_image`。

在线解码使用 CPU 单线程和共享队列，不加载额外 GPU 模型。窗口最多600秒、16格，远端传输最多64 MiB。2 GiB／7天缓存清理只处理派生产物，不删除原附件。取消会终止工作进程树；严格研究来源策略下不启用无法遵守策略的提取器。网络目标必须解析为公网地址；FFmpeg/PyAV 不直接接收远端URL，而读取经过检查的文件式字节流。

## 安装和账号

独立环境安装，不能改动RAG或语音环境：

```powershell
python -m venv .data/video-reader-env
.data/video-reader-env/Scripts/python.exe -m pip install -r scripts/video-reader-requirements.txt
```

Unix使用 `.data/video-reader-env/bin/python`。另行安装FFmpeg/ffprobe至PATH。`.data/video-reader.json` 支持python、ffmpeg、ffprobe路径，以及账号授权：

```json
{"accounts":{"bilibili":{"cookiesFile":"D:/private/bilibili-cookies.txt","conversationIds":["明确授权的会话ID"]}}}
```

YouTube配置同形。会话列表为空表示不向任何会话提供账号。模型不能自行指定凭据文件路径。仅载入对应平台域名的Cookies，临时文件用后清除；不得提交配置或凭据到Git。不会自动扫描浏览器资料。使用审核过的扩展，仅导出当前网站的Netscape格式Cookies，安装权限可能需要用户确认。`credentialsProvided` 仅表示提供了Cookies，不代表已通过站点认证。412／403／429／567及视频不可用均明确报告，登录不能保证站点放行。

## 桌面能力和限制

已启用的computer MCP新增窗口激活、可调有界无障碍树、焦点信息、60秒观测ID、元素点击、右键／中键、组合键和横向滚动。先观察并选择返回的窗口，再激活、检查焦点、执行一个动作，随后重新观察。元素点击要求同会话同窗口，运行时ID、位置、名称和角色未变；输入后旧观测失效。坐标检查遮挡窗口，密码控件不接受自动输入。

保留现有审批与宿主权限边界，不是隔离桌面。截图仍为应用依赖的PrintWindow，尚非Windows.Graphics.Capture，可能黑屏或过期。因此不能宣称已经全面达到Codex Computer Use；应用启动发现、更丰富的无障碍动作及WGC仍需后续实现。原生编译和模拟测试不代表全部真实应用兼容性验证。

## 项目语言

核心系统提示词与提供商实现为英文；新增工具契约与诊断为英文。UI翻译、面向用户的接入通知、双语检索别名、匹配规则、测试样本、文档和用户记忆保留相应语言。UI语言不应改写用户数据，也不强制模型用英文回答。这次核查不代表仓库所有字符串均为英文。

## 设计与验证依据

参考 [插件主分支](https://github.com/SAOS-3624/dsh-video-storyboard/blob/main/src/fetch.js)、[性能分支](https://github.com/SAOS-3624/dsh-video-storyboard/tree/feature/high-performance)、[PyAV](https://pyav.org/docs/stable/api/container.html)、[yt-dlp Cookies说明](https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp)。插件实际采用低清全片缓存供反复扫描、高清局部直读；其耗时与图像token估算不是本项目承诺。

测试覆盖本地视频／字幕／音频、分页解析、账号与来源隔离、DNS限制、Range读取缓存及不支持Range的拒绝、过期桌面观测。真实站点可能拒绝请求；元信息、字幕、画面、音频和评论必须分别报告验证结果。

实际桌面验收：`pnpm exec tsx scripts/test-desktop-live.ts` 创建并仅操作临时测试窗口，验证激活、控件点击、文字输入、Ctrl+A 替换、按钮回调与窗口截图；本机已通过，不代表所有应用都兼容。

### 本机实测（2026-10-29）

YouTube 公开样本读取到 6 条字幕、20 条评论、4 帧实际画面（传输 256 KiB）和 4 秒音频片段（传输 256 KiB），重复画面请求命中缓存。B站样本读取到自动中文字幕及 12 秒窗口中的 4 帧画面（传输 512 KiB）。B站直接使用元数据与播放接口，最多尝试两个平台提供的备用 CDN 地址，无需先加载 HTML 播放器；平台返回的 HTTP 字幕链接升级为 HTTPS。访问限制会明确报错，不绕过限制，也不静默退回完整视频下载。

合成样本通过 Range 响应验证了实际画面时间戳和音频时长。临时 Windows 编辑器通过激活、控件定位、文字、Ctrl+A、按钮回调与截图测试。部署主服务无需重启检索、语音或 NapCat。验证凭据不提交，也不会自动开放给其他会话。

账号授权还支持 `allowLocalConversations`（默认关闭）和 `privateChatTransports`（默认空）。可授权现有及未来本地／项目对话，或指定平台已启用的私聊入口。群聊必须逐一加入 `conversationIds` 白名单；已移除入口的外部会话不会被误当成本地对话。每个账号在本地配置中独立选择，模型不能扩大授权。
