# Agent Note: Context 节点选择的来源记录

Status: implemented

[English](2026-10-08-context-node-choice-provenance.md) | 中文

## 问题

Contextify 会持久化 plan 状态，但不记录选出该状态的动作。一次 plan revision 可能来自生成的建议、手动修改或程序调用 Remote 方法。把所有 revision 都当成人类偏好会污染 context selection 反馈数据集。

## 决策

成功的 `setNodeModes` 调用在提交 plan 后追加 `contextify/node-choice`。事件记录解析后的节点模式、前后 plan revision、graph revision、语义变化标记，以及调用是否匹配当前已验证的建议。应用建议时还记录建议的选择和候选节点 ID。Host 仅在待应用的模式与缓存中的已审核建议一致时接受带 graph 保护的调用；建议缺失或过期则在修改前失败。直接调用标记为 `direct`，表示调用路径，不表示人类操作者。随包发布的 Client 发起可见节点操作时声明 `uiOrigin: contextify-client`；普通 Remote 调用不带这个可选字段。生成但未应用的建议不会写入日志。

## 考虑过的替代方案

- **从 plan revision 推断反馈** — revision 缺少建议身份，也无法区分无变化、直接调用和应用建议。
- **记录每条生成的建议** — 生成方案不能证明方案曾显示或被采纳；审核操作继续保持只读。
- **把所有直接调用标为人类反馈** — 程序同样可以调用 Remote 方法。

## 后果

Session 日志可以识别建议被应用和节点模式实际变化，选择事件无需存储消息文本。Client 标记可把随包发布的 UI 路径与未标记的 Remote 调用区分开，但任何 Remote 调用方都可声明该标记；日志本身无法证明人类身份、方案曝光或对未提供方案的偏好。偏好评测仍需要参与者的留出决策。建议缓存只存在于当前进程；重启后，带保护的 Apply 需要重新请求建议。
