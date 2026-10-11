# Amadeus 文档

[English](README.md) | [简体中文](README.zh-CN.md)

这是当前维护的一套中英文档，核对日期为 2026-10-05，代码基线 d663030。下列主题两种语言逐一对应；旧记录单独归档，不用于描述当前功能。

[安装与快速开始](../README.zh-CN.md) · [更新日志](../CHANGELOG.zh-CN.md) · [历史原文](history/README.zh-CN.md)

## 当前指南

- [本地检索与 GPU](LOCAL-RAG.zh-CN.md)
- [架构](ARCHITECTURE.zh-CN.md)
- [功能指南](FEATURES.zh-CN.md)
- [对话、进度与恢复](INTERACTION.zh-CN.md)
- [自动审批](AUTO-REVIEW.zh-CN.md)
- [安全模型](SECURITY.zh-CN.md)
- [记忆、知识库与检索](MEMORY.zh-CN.md)
- [安装、升级与执行后端](MIGRATION.zh-CN.md)
- [测试与证据](VERIFICATION.zh-CN.md)
- [规划与经验反馈调度](PLANNING-AND-ROUTING.zh-CN.md)
- [前缀缓存与 Token 效率](DEEPSEEK-CACHE.zh-CN.md)
- [文件夹导入与自动维护](knowledge-import-resilience.zh-CN.md)
- [工具生态](TOOL-ECOSYSTEM.zh-CN.md)
- [对话排版与媒体](CHAT-FORMATTING.zh-CN.md)

## 评测与历史结果

- [编码试点](../evals/coding/README.zh-CN.md)
- [上下文／控制探针](../evals/context-control/README.zh-CN.md)
- [规划比较](../evals/planning/README.zh-CN.md)
- [历史审批结果](APPROVAL-EVALUATION.zh-CN.md)
- [历史规划结果](PLANNING-EVALUATION-20261001.zh-CN.md)

## 维护约定

行为变化需同时更新对应双语指南；统计结果标记日期、代码／评分器版本和验证边界。旧事实移入历史，不用新测试数覆盖旧报告。命令只引用公开可用入口，跳过不写为通过。本轮只整理文档，不代表重新运行所有历史 API／OS 实验。
