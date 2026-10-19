# 本地语音与回复朗读

[English](LOCAL-VOICE.md) | [简体中文](LOCAL-VOICE.zh-CN.md)

## 架构与隐私

可选服务监听 `127.0.0.1:8812`，通过令牌鉴权，提供 OpenAI 兼容转写和语音合成接口，复用现有媒体任务、播放、下载和工作区导出。推理时音频与正文留在本机；准备阶段下载公开代码和模型。不自动回退云端，公共设置不暴露密钥。

SenseVoice 用于短录音多语言转写，faster-whisper 提供片段时间戳，CosyVoice 3 使用本地参考 WAV 和准确文字合成语音。它们不是实时语音对话模型；当前返回完整 WAV，不是流式语音，不承诺说话人分离或自动配音对齐。

## 安装和启动

准备 Python 3.10/3.11、Git，以及 PATH 中可访问的 FFmpeg。Windows 可运行 `Setup-Local-Voice.cmd`（Python 需在 PATH）。跨平台入口，也适用于 PowerShell AllSigned 阻止未签名脚本的环境：

```text
python scripts/local_voice/manage.py setup
python scripts/local_voice/manage.py start
```

使用三个独立环境：`.data/voice-asr-python`（SenseVoice）、`.data/voice-whisper-python`（Whisper，不安装 PyTorch）、`.data/voice-tts-python`（CosyVoice）。隔离 CTranslate2 与 PyTorch，避免 Windows OpenMP 冲突；固定兼容的原生依赖，包括 SentencePiece 0.2.0、CTranslate2 4.4.0。旧版双环境安装需要重跑 setup 迁移。不修改 RAG、ComfyUI、评测环境。`--asr-only` 仅准备转写；`--skip-download` 仅装依赖，不下载模型。中断后重新运行可续传。记录实际模型 revision 和 CosyVoice 源码 revision。上游原生依赖可能需要编译工具或平台配置，安装失败不等于服务就绪。

配置与权重在 `.data/voice-service`（或 `AGENTDEMO_DATA_DIR` 下）。离线用户可把完整模型快照放到 `config.json` 的 `models` 路径。推理使用本地路径与 Hugging Face 离线模式，不自动下载缺失权重。推理进程通过 Python 审计钩子阻止网络连接，包括上游可选文本规范化器的隐式下载；这不是任意原生代码的安全沙箱。

没有已配置音色且上游示例录音存在时，安装使用该示例作为默认音色。设置 → 媒体与语音 → **本地音色**支持上传 3–30 秒录音（最多 25 MiB），填写名称和准确原文，保存后中英文试听、设为默认朗读音色。上传文件在本机统一为 24 kHz 单声道 WAV，以随机 ID 保存，不使用上传文件名作为路径。保存后下次请求即时生效，无需重启；选择默认音色只更新本地语音连接，表单中其他未保存修改保留。试听会运行本地推理，CPU 可能耗时一两分钟。这是参考音色条件合成，不是训练新模型。

高级用户也可在 `config.json` 配置音色：

```json
{
  "voices": {
    "default": { "audio": "D:/Voices/reference.wav", "text": "这段参考录音的准确文字。" }
  }
}
```

使用有权使用的录音。客户端不能通过合成接口传入任意磁盘路径。启动后，在设置 → 媒体与语音中选择“添加本地语音连接”（先保存其他修改），添加 SenseVoice、Whisper、CosyVoice，不重复添加、不覆盖原有录音服务选择。可另外选择默认转写服务。添加连接不等于依赖、权重和音色已通过实际推理验证。

配置后 `Start-Amadeus` 一并启动轻量服务；首次启动支持 `-LocalVoice -Python <解释器路径>`。普通启动不安装依赖、不加载语音模型。后台进程独立于 Codex，关闭 Codex 不会随之退出；不会自动重启已有服务。

## 资源管理

新安装默认 `device: "auto"`，保留已有设备选择，默认两个 CPU 线程。`device: "cpu"` 不分配显存。每个请求单独启动模型进程，成功、失败、超时均退出进程释放资源。代价是每次冷加载增加延迟；空闲监听服务不常驻大模型。

`device: "auto"` 会检查本机 `comfyUrls` 队列及 NVIDIA 可用显存，忙碌或状态未知时使用 CPU。准入后如 GPU 不可用或显存不足，待 GPU 进程退出后仅尝试一次 CPU，两个尝试共享 150 秒时限；其他错误不自动重放。`device: "cuda"` 在不满足条件时拒绝执行，不自动回退。`gpuIndex` 选择显卡，`minFreeMiB` 默认 8192，是准入余量而非实测最低需求。不会中断 ComfyUI、清队列或卸载其模型。检查不是与外部应用共享的互斥锁：ComfyUI 可能在检查后开始任务；要求严格避免显存争用时使用 CPU。

安装匹配的 NVIDIA 依赖可使用 `python scripts/local_voice/manage.py setup --cuda` 或 `Setup-Local-Voice.ps1 -Cuda`，此前应停止语音服务。CUDA 12.1 的 Torch 2.3.1 包同时提供 Windows CTranslate2 4.4 所需的 CUDA/cuDNN 库。普通启动不下载这些大包。CPU/GPU 主要差别是速度，但精度、量化和合成采样也可能导致输出不同，不能承诺完全一致。

同时仅运行一个语音请求，其余返回 `VOICE_BUSY`，不自动重放。上传最多 25 MiB，录音最多十分钟，合成正文最多 4000 字符，模型进程最多 150 秒（小于现有媒体 HTTP 超时）。超时清理包括本次工作进程的子进程树，涵盖 Windows 虚拟环境解释器转发进程。CPU 冷加载可能超时，此时缩短录音或分段合成。超长音频报错，不悄悄截断。FFmpeg 统一浏览器录音/WebM/MP3 格式。依赖缺失、权重缺失、超时和 GPU 准入错误提供不同诊断。

## 朗读助手回复

每条助手消息下方复制、分支、点赞和点踩后增加朗读按钮。选择语音服务并点击开始，只发送该条回复的正文；跳过代码块、图片地址及尚未发送的草稿。长回复逐段生成和播放。本地连接设置 `read_aloud_units: 20`，非 ASCII 字符计 1 单位，ASCII 计 1/4，优先在句子边界断开，降低 CPU 长段超时风险，但不保证发音时长。其他服务保留常规分段，此界面提示不会发给语音服务商。同时仅一条消息朗读。停止或切换对话会停止播放并禁止后续提交；已经提交的生成可能继续，产物保留在媒体历史，停止播放不等于服务商取消或退款。开始按钮旁提示远程服务可能收费。浏览器禁止自动播放时可在播放器手动点击。新回复不会自动朗读。

## 验证边界

单元/HTTP 测试覆盖鉴权、空闲不加载、忙碌拒绝、超时释放、临时文件清理、二进制上传、CPU 准入、WAV 格式。TypeScript 测试覆盖配置保留、仅回环允许 HTTP 和正文分段。测试使用替身工作进程，不代表实际识别准确率、发音质量或硬件性能；安装模型与参考音色后仍需实测中英录音和合成。CI 不下载模型、不运行付费服务。

## 上游来源

- [SenseVoice](https://github.com/FunAudioLLM/SenseVoice)
- [faster-whisper](https://github.com/SYSTRAN/faster-whisper)
- [CosyVoice 安装与推理示例](https://github.com/FunAudioLLM/CosyVoice)

集成由 Amadeus 维护，模型与上游代码保留各自许可证。

## 本机实测（2026-10-19）

Windows 上六项鉴权 HTTP 请求通过，均实际验证了 CUDA 不可用后自动回退 CPU：

| 请求                  | 总耗时          | 结果                                    |
| --------------------- | --------------- | --------------------------------------- |
| SenseVoice 中文／英文 | 13.62／13.56 秒 | 正确转写短句                            |
| Whisper 中文／英文    | 19.58／15.83 秒 | 正确文本及片段时间戳                    |
| CosyVoice 中文／英文  | 59.34／86.03 秒 | 24 kHz 单声道 WAV，音频长 2.64／5.24 秒 |

直接合成后再次转写也恢复了中英文测试句子。这是短样本冒烟测试，不代表总体准确率或人工听感认证。GPU 准入与显存不足回退有确定性测试；**独立复制已有运行库后，GPU 六项真实 HTTP 测试也全部通过**，没有向来源环境安装依赖。没有修改 benchmark 或 ComfyUI 环境。每次冷加载、两个 CPU 线程下，CPU 合成明显慢于实时。

GPU HTTP 总耗时：SenseVoice 中文／英文 **11.17／11.44 秒**，Whisper **6.88／4.41 秒**，CosyVoice **32.83／25.28 秒**（输出音频 2.84／4.52 秒）。短样本包含冷启动，不能推广成所有任务的提速比例。SenseVoice/CosyVoice 复用了独立复制的 **PyTorch 2.6.0+cu118、CPython 3.11** 包；Whisper 使用独立复制的 CUDA 12/cuDNN 8 DLL。ComfyUI 的 PyTorch 2.11.0+cu128 仅检查，未修改或采用。已停止不再需要的 CUDA 下载。

可选高级字段 `torchRuntimePath` 指向独立复制的兼容包目录，仅 GPU Torch 工作进程使用，CPU 仍用原环境；`cudaLibraryDirectory` 指向 Windows CTranslate2 所需的 CUDA 12/cuDNN 8 DLL。这两项不修改全局 PATH 或来源环境。复用前应核对 Python ABI、依赖和 CUDA/cuDNN 版本，并实际推理验证，不能直接认为新版本必然兼容。默认配置没有硬编码用户名或本机来源目录。
