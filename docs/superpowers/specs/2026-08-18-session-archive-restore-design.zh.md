# Session 归档恢复设计

[English](2026-08-18-session-archive-restore-design.md) | 中文

**状态：** 已批准实施

**范围：** 增加原生已归档 Session 列表和可逆恢复操作，同时保留 Workspace 记账、Session 谱系、Context Plan 与 Context Map 查看状态。

## 产品结果

用户可以在侧边栏查看已归档 Session 并恢复其中一项，且不会打断当前对话。恢复让同一个 Session 身份回到活动 Workspace 树和连接的 Context Map family；系统不会创建副本，也不会回放归档时快照。

归档仍然是单 Session 的可见性操作。归档父 Session 不会归档后代；父 Session 处于归档状态时，后代仍然可以接收消息或增加分支。

## 权威状态

注册表级全局 `archivedSessionIds` 集合仍然是唯一持久归档状态。Session 日志、`parentSessionId`、Context Plan 与 Workspace `sessionIds` 记账继续由现有所有者负责。

`unarchiveSession(sessionId)` 是与 `archiveSession(sessionId)` 使用同一串行队列的逆操作。对于已归档 Session，它先确认 Session 仍然存在，然后以原子方式只从归档集合删除该 ID。不在归档集合中的 Session 按幂等成功处理，使重复恢复和过期标签页操作保持安全。归档项存在但 Session 不可用时，操作失败且不改变集合。

RPC 响应与 `host/archived-sessions-changed` 帧继续携带完整的已提交归档集合。Host 仅在成员关系改变时发送帧。并发归档、恢复、Workspace 与注册表操作使用现有注册表操作队列；最后提交的操作决定成员关系。

## 已归档列表

Workspace 侧边栏 Header 提供带当前数量的“已归档 Session”控件。控件打开由 browser 持有的侧边栏子视图，其中包含返回导航、本地标题过滤，以及按当前 Workspace 记账分组的列表。Workspace 注册已被删除的 Session 显示在 Ungrouped 下。

列表行显示 Session 标题，并在可用时显示父 Session 标题。每个 Workspace 内使用平铺列表，因为原生谱系中可能只有部分成员被归档；缺少可见祖先时使用缩进会暗示错误的树关系。列表依据 Host 归档顺序让最近归档的 ID 优先显示。

每行只有一个“恢复”操作。恢复等待期间仅禁用当前行。成功后，列表行在权威归档集合回声到达时消失，并返回普通树；操作不会打开 Session，也不会改变当前 selection。失败时保留该行并显示可重试的行内错误。缺少 summary 时使用稳定 Session ID 作为回退，避免损坏的列表投影让归档项无法查看。

## 树与 Workspace 位置

恢复使用当前持久记账，而不是归档时的位置快照。保留的 Workspace 席位让列表行回到相应 Workspace 和共享顺序。如果 Session 归档期间对应 Workspace 注册被删除，列表行回到 Ungrouped。之后发生的 Workspace 重排或记账变化优先于历史位置。

原生 `parentSessionId` 元数据恢复谱系。子 Session 保持活动时被归档的父 Session 会回到该子 Session 上方；归档期间创建或扩展的子 Session 仍然保持连接。恢复一个 Session 不会恢复任何已归档父项、子项或同级项。

## Context Map 重新连接

Contextify 继续从实时和持久化 Header 与日志加载完整原生 Session family。归档过滤仍然是客户端投影。从归档集合移除 ID 会重新投影完整 family，恢复规范 owner 和 edge，并加入归档期间创建的消息或分支。

规范节点 ID 继续由原始 owner Session ID 与事件序号组成，因此恢复不会重映射 Context Plan 条目。Include、Exclude、Natural、Undo 与 Redo 状态留在原 Session 日志中，绝不会从其他分支复制。

Context Map store 根据可见节点清理画布 selection，但为完整 family 中的所有节点保留位置覆盖。因此，归档会让隐藏节点退出临时批量选择，但不会删除用户安排的位置。恢复继续使用这些位置。真正从完整 family 消失、而不只是被归档投影隐藏的节点，仍然可以执行普通位置清理。

## 冲突行为

| 归档或恢复期间发生的变化 | 必须得到的结果 |
| --- | --- |
| 后代收到消息 | 恢复把父 Session 加入最新 family，且不丢弃后代消息。 |
| 创建新的后代分支 | 恢复使用持久化谱系，并在恢复后的 family 下显示新分支。 |
| 实时后代的 Context Plan 改变 | 每个 Session 保留自己的 Plan；恢复不复制或重写 Plan。 |
| Workspace 重排或 Session 记账改变 | 恢复遵循最新持久 Workspace 记账和顺序。 |
| Workspace 注册被删除 | 恢复将 Session 放入 Ungrouped。 |
| 两个标签页恢复同一 Session | 第一次成员变化生效；第二次根据完整集合幂等完成。 |
| 归档与恢复竞争 | 注册表串行执行并按顺序提交；最后提交的成员关系是权威状态。 |
| 恢复回声或帧之后到达过期 `workspace.list` 响应 | 现有 generation guard 阻止过期归档集合覆盖较新状态。 |
| Session 变为不可用 | 恢复失败并保留归档项。 |
| 恢复的 Session 不是当前 Session | 当前对话和详情面板保持不变。 |

## 测试

Workspace domain 测试覆盖恢复持久性、幂等、Session 不可用、重启恢复以及有序归档与恢复竞争。API 测试覆盖 schema 校验、完整集合响应、仅在成员变化时发送事件和重连基线。

客户端 runtime 测试覆盖一元回声、跨标签页帧、过期列表响应、当前 selection 稳定性和错误传播。Workspace UI 测试覆盖分组、过滤、缺失 summary、单行 pending 与重试行为、Workspace 删除，以及回到普通原生谱系。

Context Map 测试覆盖后代增加消息和新分支后恢复已归档父 Session、规范 owner 与 edge 恢复、Context Plan 保持不变、节点位置保留、隐藏 selection 清除，以及未归档后代处于活动状态时立即重新投影。一个无密钥的组装 browser 测试通过真实 Host 和客户端组合执行归档、后代演进、恢复、树位置与 Context Map 导航。

## 验收标准

1. 用户可以在专用侧边栏列表中发现和恢复已归档 Session。
2. 恢复只改变归档成员关系，绝不会自动打开 Session。
3. 同一个 Session ID、日志、Context Plan、原生谱系与当前 Workspace 记账在归档和恢复之间保持不变。
4. 归档期间创建的后代消息和分支出现在恢复后的 family 中。
5. 并发、重复、跨标签页与过期基线操作最终收敛到 Host 的完整已提交归档集合。
6. 恢复失败绝不会删除归档行或发布错误的活动状态。
7. Context Map 位置在归档可见性变化间保留，而隐藏节点会退出临时画布 selection。
8. Workspace 被删除后，恢复的 Session 出现在 Ungrouped，且不会重建 Workspace。
