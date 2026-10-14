# Agent Note: 持久化 Branch 建议选择

Status: implemented

[English](2026-10-08-durable-branch-choice.md) | 中文

## 问题

Contextify 会保存 Turn 结束后生成的建议，但 Branch 卡片的 Keep 操作原先只改变 React 本地状态。重载后同一建议可能再次出现，Session 里也没有用户明确拒绝它的证据。成功的搬迁可以从其他事件推断，但 Keep 和 Move 缺少统一的显式选择记录。

## 决定

用户明确点击 Keep 或成功完成 Move 后，源 Session 记录 `contextify/branch-choice`，包含建议 ID、已完成 Turn 的边界和 `keep` 或 `move`。随包发布的 Client 为两种操作声明 `uiOrigin: contextify-client`；未标记的 Remote 调用可区分，但该标记不认证操作者身份。Host 拒绝过期或相互矛盾的选择；重复执行相同操作不会产生第二条事件。`get` 在重载后不再返回已决定的建议。Client 等 Host 成功记录 Keep 后才隐藏卡片；记录失败时仍显示卡片。

选择事件仅作日志，不改变 family graph revision 或模型可见的 Context Plan。它代表明确的操作，不代表曝光：仅生成建议、但没有点击时不能标记为拒绝。现有 `contextify/plan` revision 仍记录手动 Include/Exclude 修改；本事件自身不能衡量 folding 偏好。

## 考虑过的替代方案

- **继续只在本地关闭卡片**：重载后选择消失，无法形成可靠的个人反馈历史，因此未采用。
- **从没有搬迁推断 Keep**：卡片可能根本没有被看到，用户也可能只是离开页面，因此未采用。
- **写入自由文本 `feedback/record`**：结构化 Contextify 决策应在所属 Session 词表里保存建议身份和类型化选择，因此未采用。

## 结果

现有卡片无需改变可见布局即可产生持久化的分支选择标签。这并不证明个性化策略有效：尚未采集同一参与者的历史选择和留出选择，当前界面也没有逐节点 `fold` 操作。定向 Host 与 Client 测试覆盖重复、冲突选择、重载投影和记录失败。
