# 本地检索

[English](LOCAL-RAG.md) | [简体中文](LOCAL-RAG.zh-CN.md)

## 安装

可选 Python 服务提供 E5 small/base/large（384/768/1024 维）、BGE cross-encoder 重排、FAISS、嵌入式 Qdrant、LightRAG。保留内置 SQLite FTS 与混合检索。Milvus 需独立部署服务端。

联网运行 Setup-Local-RAG.cmd，再运行 Start-Local-RAG.cmd。Windows x64、Python 3.11 的离线安装：

```powershell
./Setup-Local-RAG.ps1 -Python C:/Path/python.exe -OfflineBundle D:/Path/Amadeus-offline
# NVIDIA GPU：
./Setup-Local-RAG.ps1 -Python C:/Path/python.exe -OfflineBundle D:/Path/Amadeus-offline -Gpu
```

离线包须包含 wheelhouse、constraints.txt、models 下的两个模型目录。GPU 另需 wheelhouse-gpu 和 constraints-gpu.txt。不要复制虚拟环境。只向 .data/retrieval-python 安装，不修改系统 Python。启动使用 UTF-8，不修改执行策略。

在设置中先保存其他改动，再选择本地模型绝对路径、模型身份、提取连接和范围。配置变化后重启检索服务。普通启动会拉起已配置的服务；普通首次启动不会强制安装这些大依赖。

## 数据边界与检索

embedding、重排在本机运行。LightRAG 使用本机 JSON、NetworkX、NanoVectorDB；实体抽取及整理把所选正文发送给已配置的生成模型 API。应单独授权目标范围，不替主模型生成最终答案。

长文本使用重叠窗口和归一化均值，并添加 query/passage 前缀；避免仅截取开头，但不等于原生长上下文模型。维度更换需要重新建立向量。

融合后 cross-encoder 最多重排 60 条候选，分数不是校准概率；阈值应使用中英样本评测。

FAISS 支持 flat/HNSW/IVF-flat/IVF-PQ；样本不足回退 flat（IVF/PQ 训练下限分别 2496/9984 条，PQ 另要求维度兼容）。原生库在有时限的独立进程执行，崩溃或超时明确报告精确回退。成功建立的原生索引按向量内容哈希持久缓存，最多保留四代。嵌入式 Qdrant 是精确检索，不是服务端 HNSW。

适配器按查询传送授权范围的向量快照（最多 80 MiB float32 数据、128 MiB 请求、20 万条），不是百万向量流式索引。外部旧集合仍需保留清理策略。安装 Milvus 客户端不等于安装服务端。

LightRAG 持久记录批次 ID，结果未知不盲目重放。即使本地图保留旧数据，引用也必须匹配当前授权分块及原文。检索不等于验证。

inspect_retrieval_status 提供范围内总量、向量覆盖与维度、诊断状态；索引建议不是切换或重建授权。investigate_knowledge 支持有界多查询调查。

## 本机验证，2026-10-11

RTX 4090 CUDA、E5-large 1024 维和中文查询／英文文档重排已通过真实请求。提供的 Windows FAISS 1.15.1 包会崩溃；Windows 安装现固定为实测通过的 1.12.0。HNSW 通过，IVF-flat/IVF-PQ 已用一万条 64 维合成向量完成训练和查询。图谱入库与其他服务测试以本次交付记录为准。

LightRAG 合成资料入库及查询也已通过：3 个实体、2 条关系、1 个来源分块；Qdrant 嵌入式检索通过。这是接入冒烟测试，不是检索质量基准。

## 统一安装与模型管理

离线包仅为可选安装来源。Setup 将 Python 依赖安装到应用数据目录，并将模型准备到 retrieval-service/models；没有本地来源时从 Hugging Face 下载，重新运行会复用已完成的下载。本地模型复制并通过 SHA-256 校验后才更新配置，后续启动不依赖离线包；安装成功前保留原文件。在线 GPU 安装支持 -Gpu，并可用 -TorchIndexUrl 指定与驱动兼容的 PyTorch 源；默认使用 CPU。下载失败保留已有数据。

## 损坏向量容错

知识检索逐条校验已存向量：JSON 与对象结构、有限数字、非零且有限的范数、模型及查询维度。损坏或不兼容的条目不会拖垮正常语义候选；对应正文仍可通过词法检索返回。查询 embedding 失败时明确降级为词法检索；取消操作和数据库故障仍传播，不伪装成查无结果。

混合检索结果和检索轨迹包含各自的 retrievalDiagnostics，记录扫描、可用、损坏和不兼容数量；并行请求不混用诊断。正常文档索引不再只认模型名，损坏向量会重新生成，也不能被当成可复用缓存；索引状态增加 invalid 数量。记忆向量缓存复用相同校验，只对这类派生记录的 RECORD_CORRUPT 容错，不吞掉普通数据库故障。维度不兼容在查询时跳过，不自动迁移模型或重建整个语料。外部 ANN、重排、LightRAG 服务故障不在此策略下统一隐藏。

### 查询通道与单条片段来源

`retrievalDiagnostics` 提供整次查询的 embedding 模型、维度、语义通道状态、候选数量和返回通道数量。片段的 `retrievalChannels` 和 `ranking.embeddingModel` 仅描述该片段：某条结果只有词法命中，不代表整次查询没有向量参与。语义状态区分主动关闭、策略关闭、未配置、embedding 或后端失败、没有兼容候选、索引变化及已执行检索。两路都命中的结果在返回计数中会重叠。大库流式路径与小库统一使用从 1 开始的 RRF 排名：1/(60+rank)。向量参与及重排分数不保证相关性，同词异义仍可能产生无关候选。本次不需调整启动项或安装依赖，重启主服务后生效。

修复大库结果转换时遗漏 scope 的问题：此前语义候选虽然计算成功，却可能因缺少范围信息被最终权限过滤剔除。现在保留数据库中的范围，仍严格执行权限过滤。
