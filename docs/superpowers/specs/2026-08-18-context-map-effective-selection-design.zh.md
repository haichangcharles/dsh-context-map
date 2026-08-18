# Context Map 有效上下文选择设计

[English](2026-08-18-context-map-effective-selection-design.md) | 中文

**状态：** 已批准实施

**范围：** 在 Context Map 中用一个有效上下文 checkbox 取代并列的 Natural、Include 和 Exclude 控件，同时保留原生 Context Plan 表示。

## 产品结果

每个消息节点只呈现一个主要事实：该消息是否进入下一次模型请求。用户可以临时加入其他分支消息或移除当前路径消息，让选择持续若干轮，并且无需理解 Context Plan 的存储值即可恢复 Harness 自动行为。

## 两层状态模型

可见 checkbox 表示有效上下文结果。勾选节点进入模型上下文，未勾选节点不进入。

Harness 继续存储可选的手动覆盖。不存在覆盖时，系统使用从当前原生 Session 路径推导出的自动结果；Include 或 Exclude 覆盖该结果。因此 Natural 表示不存在手动覆盖，而不是第三种有效选择状态。

| 自动结果 | 手动覆盖 | Checkbox |
| --- | --- | --- |
| 进入上下文 | 无 | 勾选 |
| 进入上下文 | Exclude | 未勾选 |
| 不进入上下文 | 无 | 未勾选 |
| 不进入上下文 | Include | 勾选 |

## Checkbox 行为

Checkbox 取代每个节点上的 Natural、Include 或 Exclude 标记。Checkbox 上的指针事件不会启动 React Flow 拖拽或画布选择。

当 checkbox 的值偏离自动结果时，系统写入所需的 Include 或 Exclude 覆盖。当 checkbox 回到自动结果时，系统删除覆盖并自动让节点恢复 Natural。点击已经解析出的相同值不会执行操作，也不会创建冗余覆盖。

Checkbox 先乐观更新，在 mutation 等待期间不可用，并在 mutation 失败时回滚。面板显示 mutation 错误。Checkbox 以外的节点区域仍可拖拽，因此 click 与 drag 的区分不会延迟上下文操作。

## 手动覆盖生命周期

手动覆盖属于当前原生 Session Context Plan，并且跨轮次、页面刷新以及面板关闭或重新打开持续存在。Harness 不会在隐含的轮次数之后让它过期。

用户可以让节点回到自动 checkbox 值、对节点选择“恢复自动”，或者通过 Reset 清除全部手动覆盖来恢复自动行为。这些操作删除覆盖，不会强制所有节点全部勾选或全部取消勾选。

## Reset 与菜单操作

Reset 显示为“清除手动修改”，并删除当前 Session Context Plan 中全部 Include 和 Exclude 覆盖。Undo 和 Redo 继续恢复 Context Plan revision。

节点右键菜单保留“在 Chat 中定位”和“从此处创建分支”。仅当节点存在手动覆盖时，菜单显示“恢复自动”。Include 和 Exclude 不再作为并列的节点状态呈现，因为 checkbox 已经表达有效结果。

## 画布选择

有效上下文状态与画布多选保持独立。Checkbox 状态表达模型输入；Selection mode 使用独立描边，并且只在批量目标的语境中使用“已选择节点”。

面板 Header 以 `6 / 8 已进入上下文` 等本地化形式报告有效结果。批量操作可以让所选节点进入上下文、不进入上下文或恢复自动行为。当请求的有效结果已经等于节点自动结果时，批量操作删除冗余覆盖。

## 原生状态所有权

Contextify service 继续负责自动路径成员关系、手动覆盖、Plan revision 和上下文编译。UI 根据当前 Session 路径和存储的覆盖推导 checkbox 状态，并发送现有 Natural、Include 或 Exclude mutation。系统不引入第二个上下文选择存储，也不增加模型侧分类步骤。

## 测试

组件测试覆盖自动勾选和自动未勾选节点、checkbox 事件与拖拽及画布选择的隔离、乐观 pending 状态、失败时回滚并显示错误，以及 checkbox 回到默认结果时自动删除覆盖。

Service 与浏览器测试覆盖手动选择跨轮次和刷新持续存在、单节点恢复自动、清除手动修改、Undo 和 Redo、批量标准化，以及等价原生 Context Plan 生成不变的编译上下文。

## 验收标准

1. 每个消息节点显示一个有效上下文 checkbox，不再显示三个并列状态控件。
2. Checkbox 操作不会启动节点拖拽、画布选择或分支导航。
3. 与自动结果不同的 checkbox 值会保存为正确的手动 Include 或 Exclude 覆盖。
4. 与自动结果相同的 checkbox 值会删除手动覆盖并恢复 Natural。
5. 手动覆盖一直持续到用户明确执行单节点或整个 Plan 的恢复操作。
6. 清除手动修改会删除所有手动覆盖，但不会改变布局、节点位置或 Session 谱系。
7. Mutation 等待期间阻止重复写入；操作先乐观更新，失败时回滚并显示错误。
8. Header、批量选择和节点菜单明确区分有效上下文与画布多选。
