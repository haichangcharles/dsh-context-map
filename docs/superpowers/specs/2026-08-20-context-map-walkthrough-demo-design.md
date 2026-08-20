# Context Map Walkthrough Demo Design

Status: proposed

## 目标

在当前本地 Harness profile 中创建一棵可删除的原生 Session tree，让用户无需自己准备历史数据，即可验收 `5fe33c31d9` 中新增或改变的 Context Map 行为。

演示数据必须走 Harness 原生 Session、Turn、fork 与 Contextify persistence。删除演示 Session 后，不得留下 Demo 专用状态、Profile 设置或第二套 branch 数据。

## 演示数据结构

Seeder 创建以下原生 Session tree，所有标题统一带 `🧪 Context Map Walkthrough` 前缀：

```text
🧪 Context Map Walkthrough — Start Here
├── 01 Archive and Context Diff
├── 02 Sibling Branch
└── 03 Branch-owned Child
```

`01` 与 `02` 从 Root 的同一个继承 boundary fork，因此在左侧 tree 和 Context Map 中互为同级。`03` 从 `02` 自己新增的 completed Turn boundary fork，因此是 `02` 的 child。

Root 包含一个带 assistant 中间步骤的 Turn 和一个长 Final Output，用于验证节点过滤与高度布局。各 Branch 中的消息正文使用 `【操作】`、`【预期】` 和 `【恢复】` 明确指导验收。

## 实现边界

- 使用一次性本地 Seeder 通过 Harness Session primitives 和官方 persistence 写入事件。
- Seeder 生成稳定、唯一的 Session ID；重复运行时拒绝创建第二份，避免列表污染。
- 不修改现有用户 Session、Workspace archive set 或 Contextify Profile settings。
- 不自动开启 `Automatic Branch review`。
- 不 Mock `Recommend` 或 Branch review。用户主动调用时继续使用当前 Harness 模型路由和 API。
- Seeder 完成后不保留产品代码改动；演示数据作为普通原生 Session 存在。
- 用户可通过原生 Session 归档/删除流程移除整棵演示 tree。

## 文字验收测试流程

### 0. 找到演示会话

1. 刷新 `http://127.0.0.1:3080/`。
2. 在左侧找到并打开 `🧪 Context Map Walkthrough — Start Here`。
3. 打开右侧 `Context Map`。

通过标准：左侧能够折叠演示 Session tree；右栏顶部可以手动切换 `Context Map` 与 `Details`。

### 1. 验证每个 Turn 只显示 Input 和 Final Output

1. 阅读 Root Session 的第一轮对话。
2. 对照 Chat 的轨迹，确认该 Turn 中存在 assistant 中间步骤。
3. 查看 Context Map。

通过标准：Map 只显示用户最初 Input 和最终 assistant Output。Reasoning、tool、runtime injection、assistant 中间步骤及未完成输出均不生成节点。

### 2. 验证长节点不会重叠

1. 在 Map 中找到正文较长的 Final Output。
2. 检查它和上下节点的边界。
3. 拖动该节点。
4. 点击 `Re-layout`。

通过标准：节点间距按上一节点底部到下一节点顶部计算；拖拽时节点实时跟随指针；`Re-layout` 恢复确定性布局且没有 overlap。

### 3. 验证 Include、Exclude、Clear 与 Undo

1. 取消一个较早节点右上角的 `Context` checkbox。
2. 确认计数和节点状态立即变化。
3. 再勾选一个当前 branch 之外的节点。
4. 点击一次 `Undo`，再点击 `Redo`。
5. 点击 `Clear manual changes`。

通过标准：checkbox 只有选中/未选中两种有效显示；操作写入真实 Context Plan；Undo/Redo 以完整 revision 工作；Clear 恢复自动 path 结果但不改变节点位置和 branch。

### 4. 验证多选和右键菜单

1. 使用 Shift 框选至少两个节点，或累加点击形成多选。
2. 批量 Exclude，再执行 `Restore automatic`。
3. 右键任意节点。

通过标准：多选可批量修改；右键菜单背景不透明且可读；菜单包含 `Locate in Chat`、`Branch from Here` 和符合节点状态的 Archive/Restore 操作。

### 5. 验证 Locate in Chat

1. 在 `02 Sibling Branch` 的节点上右键。
2. 点击 `Locate in Chat`。

通过标准：Harness 打开该节点所属的原生 Session，切换到 Chat，并滚动、高亮对应持久消息。

### 6. 验证单节点 Archive 与 Placeholder

1. 打开 `01 Archive and Context Diff`。
2. 右键带 `ARCHIVE ME` 标记的 assistant Final Output。
3. 点击 `Archive node` 并确认。
4. 再次右键，点击 `Show original`。
5. 关闭原文弹层后点击 `Restore node`。
6. 对带 `ARCHIVE INPUT` 标记的 user Input 重复上述步骤。

通过标准：Archive 后节点、edge、role、node ID 与 fork boundary 保持不变；正文变为服务端固定的 `[Placeholder: intentionally empty]` 语义；原文可查看；Restore 后原文完整恢复。Input 与 Output 均可独立 Archive，且不会影响另一节点。

### 7. 验证完整 Context 推荐版本

1. 保留至少一个已 Include 节点，并确保另一个 branch 有未 Include 节点。
2. 点击 `Recommend`。
3. 等待 `Current → Proposed` review sheet。
4. 阅读 Added、Removed 和 Archive candidates。
5. 点击 Apply，然后点击一次 `Undo`。
6. 再次 Recommend，在结果出现前或出现后改变一个 checkbox，观察 stale 行为。

通过标准：推荐不会立即修改 checkbox；已 Include 节点被重复建议 Include 时作为 no-op 过滤，不报错；Apply 原子替换整个版本；一次 Undo 恢复旧版本；Context 变化后旧 proposal 不可继续应用。Archive candidate 只能逐项确认，不能随 Context diff 自动执行。

说明：本步骤使用 Harness 当前配置的真实模型 API，因此推荐内容可能不同，但状态机和操作语义必须一致。

### 8. 验证原生 Branch 层级

1. 展开左侧演示 tree。
2. 在 Map 中观察 Root、`01`、`02` 和 `03` 的连接。
3. 比较 `01` 与 `02` 的层级。
4. 比较 `02` 与 `03` 的层级。

通过标准：`01` 与 `02` 是同级 sibling；`03` 是 `02` 的 child。Map 和左侧列表均映射原生 Session fork lineage，没有 Context Map 私有 branch。

### 9. 验证 Branch from Here

1. 在任一可 fork 的 user 或 assistant 节点上右键。
2. 点击 `Branch from Here`。

通过标准：创建并打开一个新的原生 Session；新 Session 出现在正确的左侧层级与 Context Map 连接位置。测试完成后可以删除这个额外 branch。

### 10. 验证自动 Branch 推荐与 Prompt Dashboard

1. 打开 `设置 → Context Map 提示词`。
2. 确认 Context、Archive、Branch 的 package prompt 默认灰色只读。
3. 在 Branch 的 `Additional instructions` 添加一条临时规则并保存。
4. 开启 `Automatic Branch review`。
5. 回到演示对话，发送一个与当前主题明显无关的问题。
6. 等待主 Agent 完成 Final Output。
7. 如果出现 suggestion，先测试 `Keep here`；再发送另一条离题问题测试 `Move to new branch`。
8. 测试完成后关闭开关并删除临时 Additional instructions。

通过标准：Branch review 不阻塞主回答，不创建可见 subagent；低置信度时允许不展示；接受建议后把准确的 Q&A 搬到原生 child Session，源节点保留结构性 placeholder；Prompt 自定义走当前 Profile 且可恢复。

说明：本步骤使用 Harness 当前配置的真实模型 API。是否出现 suggestion 由置信度决定，不能以“每轮必现”作为通过标准。

### 11. 验证右栏恢复入口

1. 关闭 Context Map 右栏。
2. 点击页面右侧悬浮箭头重新打开。
3. 缩窄窗口后重复操作。
4. 手动切换 `Context Map` 与 `Details`。

通过标准：关闭后始终存在可恢复入口；窄窗口默认收起但允许手动打开；Context Map 不覆盖原生 Details。

### 12. 清理

1. 关闭 `Automatic Branch review`，清除测试用 Additional instructions。
2. 在 Map 中执行 `Clear manual changes`。
3. Restore 仍处于 Archived 状态的单节点。
4. 使用原生 Session 管理操作删除或归档 `🧪 Context Map Walkthrough` 整棵 tree。

通过标准：演示 Session 从左侧和 Map 消失，其他 Session 与 Profile 设置保持不变。

## 失败处理

Seeder 在写入前检查所有目标 Session ID。只要其中一个已经存在，就停止且不写入任何新数据。写入过程中任何 persistence 失败都视为失败，不继续创建后续 branch。演示数据只使用已验证的 Session event shape，启动后的 Host 会再次按原生边界加载和校验。

## 验证实现

创建后需要确认：Root 与三个 branch 都能从当前 Host 加载；左侧层级符合 seed boundary；Context Map 只投影预期 Input/Final Output；Archive/Restore 在演示节点上成功；删除演示 Session 不影响既有会话。最终 Git 工作区必须保持干净。
