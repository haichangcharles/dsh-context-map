# 原生 Session Context Map 设计

[English](2026-08-17-native-session-context-map-design.md) | 中文

**状态：** 批准实施

**范围：** 将 Contextify 的相同 Session 虚拟路径替换为从本机 Harness Session 分叉投影的图形，并让活动的 Session 从该图形中的消息节点编译其模型上下文。

## 产品成果

Harness 左侧呈现可折叠的 Workspace 和 Session 树，中间呈现现有对话流，右侧呈现真正的交互式 Context Map。该地图可视化了一个相互连接的原生 Session 系列。中间流和右侧映射公开相同的消息级 Branch 和上下文选择操作，因此用户可以在不离开对话的情况下导航和控制上下文。

该功能重用 `/Users/haichangli/Documents/ChatGPT/harness/context_map` 中独立的 Context Map 实现来实现图形布局和交互模式。 Harness 对于 Session 身份、沿袭、日志、导航和模型请求仍然具有权威性。

## 条款

- **Workspace：** 现有 Harness 工作区。它是产品级容器，并替换独立的 Context Map 项目的 `Project` 对象。
- **Session：** 原生 Harness Session 具有自己的持久日志和 Agent 生命周期。
- **Session 系列：** 一个根 Session 以及通过 `parentSession` 连接的所有后代。
- **Context Map：** Session 系列之一的可视化。
- **消息节点：** 一个可见的 `user/message` 或 `assistant/message` 事件。推理和工具事件不是图形节点。
- **Natural 节点：** 有关活动 Session 的继承或本地附加历史记录的消息。
- **Included 节点：** 来自活动 Session 显式导入的同一系列中的另一个 Session 的消息。
- **Excluded 节点：** 活动 Session 从模型上下文中显式省略的 Natural 消息。
- **Context Plan：** 活动 Session 的持久、修订的 Include 和 Exclude 决策。

## 产品层次结构

左侧边栏呈现本机 Session 谱系，而不是解析标题：

```text
Workspace A
├── Session A
│   ├── Session A.1
│   │   └── Session A.1.1
│   └── Session A.2
└── Session B
    └── Session B.1
```

`Session A` 及其后代形成一个 Context Map。 `Session B` 及其后代形成了另一个。每个 Workspace、根 Session 和 Session 行都可以独立折叠。 `Session A.1` 等标题仍然是普通显示标题； `parentSession` 定义层次结构。

初始版本不会跨断开连接的根 Session 选择消息。仅当同级或表兄弟 Session 属于活动 Session 家族时，它才支持在它们之间导入消息。

## 本机 Branch 行为

Contextify 不维护第二个分支模型。每个 Branch 操作都会调用现有的本机 `sessions.fork` 操作并创建新的子 Session。

用户可以从中心流或右侧地图中的用户或助理消息调用 Branch。 UI 将所选消息解析为包含已完成的回合，并将已完成的回合边界传递给 `sessions.fork`。子级成为真正的 Session，具有自己的 ID、日志、Agent 生命周期、标题、导航条目和 `parentSession` 元数据。

成功分叉后，客户端打开子 Session，并且 Session 系列投影添加分支边缘。失败的分叉会使活动的 Session 和映射保持不变，并显示现有的 Harness 错误处理。

子级继承由 `ctx.sessions.fork` 复制的本机稳定消息前缀。子级不会继承父级的显式 Include 或 Exclude 决策。 Contextify 在创建子项后附加重置的 Context Plan 修订版，因为本机种子可能包含父 Contextify 事件。

## 消息图投影

### 输入数据

图形投影读取家族成员资格的 Session 摘要以及可见消息和分叉边界的相关 Session 事件窗口。它没有引入可变图数据库。

### 规范消息

本机分叉将稳定事件前缀复制到每个子 Session 中。渲染每个副本都会重复节点，因此投影会为每个继承的可见消息分配一个规范图标识。

规范消息引用包含家族根、拥有祖先 Session、拥有事件序列、角色、内容哈希以及在继承该消息的任何 Session 中定位消息所需的出处。投影从根向后代移动，并将每个子项的 `seedLength` 内的事件映射回父项的规范身份。 `seedLength` 之后的事件属于子级。

投影从图形视图中拒绝不一致的谱系，而不是猜测。缺少父代的 Session 在其父代摘要到达之前仍然是侧栏中的根。复制的前缀不匹配会产生诊断，并将第一个不匹配的可见事件视为子拥有的事件，从而保留导航而不合并不相关的内容。

### 节点和边

每个可见的 `user/message` 或 `assistant/message` 都成为一个图形节点。推理块、辅助块、工具调用、工具结果、转向标记、步骤标记、目标和其他事件保留在可见图表之外。

边沿 Session 路径连接连续的可见消息。子边缘在已解析的分叉转弯边界处留下规范消息，并输入第一个子节点拥有的可见消息。如果子级还没有子级拥有的消息，则该图将呈现一个轻量级 Session 端点，以便新分支保持可发现状态，而无需创建消息节点。

强调了活动的 Session 路径。其他家庭路径仍然可见，但视觉重量减轻了。在用户调用导航之前，选择另一个分支不会更改活动的 Session。

## Context Plan 语义

活动的 Session 拥有一个修订版的 Context Plan。中心对话流和右图都读取并改变了这个计划。

对于活动 Session 路径上的消息：

- `natural` 表示消息遵循默认历史记录选择。
- `exclude` 表示编译器忽略该消息并记录显式覆盖。
- 不存储 `include`，因为已包含 Natural 消息。

对于活动 Session 路径之外但在同一 Session 系列内的消息：

- `natural` 表示消息未导入。
- `include` 表示编译器导入消息的持久快照。
- 不存储 `exclude`，因为默认情况下不存在偏离路径消息。

节点操作在 Natural 和对其位置有意义的覆盖之间循环。批量操作公开 Include、Exclude、Natural 和反转。无效组合在服务方法中标准化，而不仅仅是通过 UI 隐藏。

重置为 Natural 会附加新的空 Context Plan 修订版。撤消和重做附加新的完整计划修订，重现所选的历史计划；他们从不删除或重写 Session 事件。

## 耐用的家庭进口产品

现有 Context Compiler 选择已属于活动 Session 的事件序列。同级 Session 的消息不满足该规则，因此编译器协定必须支持持久的本地表示，而不是在模型请求期间读取同级日志。

Include 突变首先将不可变的 `context/compiler-snapshot` 事件写入活动的 Session 日志中。该事件记录稳定项目 ID、源 Session ID、源事件序列、源规范消息 ID、角色、消息、时间戳和内容哈希。以下 Context Plan 修订版选择该本地快照事件。删除 Include 会更改下一个完整计划修订版，但不会改变旧事件。

Context Compiler 继续返回事件序列：

```ts
interface ContextSelection {
  readonly eventSeqs: readonly number[]
}
```

Context Compiler 注册表接受普通表面消息事件和 `context/compiler-snapshot` 事件。它从冻结在该确切本地事件中的消息中解析出快照。提供程序无法选择没有当前 Session 事件序列的内存中消息，因此每个模型可见输入仍然可以从活动 Session 日志中重建。

Contextify 编译器按活动 Session 序列对选定的 Natural 事件进行排序。 Included 快照事件序列保留显式计划顺序并插入到其配置位置。第一个实现默认将新的 Included 快照放置在可见消息中由其源时间戳选择的位置，并允许用户使用现有的 Context Map 排序交互重新排序选定的节点。

## 隐藏工具和推理数据

推理和工具事件不是图形节点，不能直接选择。

排除辅助消息不会暴露或单独选择其推理。推理仍然受现有消息派生策略的约束。 Importing a sibling assistant message imports only the durable assistant message content snapshot, not raw reasoning chunks.

工具协议的有效性仍然是编译器的责任。当选定的活动 Session 消息包含工具调用时，编译器会包含所需的匹配工具结果或拒绝会创建无效模型转录的计划。在第一个版本中，同级导入不会导入工具调用；包含特定于提供商的工具调用部分的助手快照会被拒绝，并带有用户可见的解释，而不是产生不完整的工具交换。

## 用户界面

### 三列布局

现有固定详细信息区域继续在右侧托管 Context Map。其默认宽度和最小宽度遵循独立的 Context Map 的可用画布比例。用户可以调整其大小并折叠它。折叠地图不会放弃选择、视口或 Context Plan 状态。

### 真实图形画布

右侧面板用 `@xyflow/react` 和改编自独立存储库的基于 Dagre 的布局替换了垂直卡片列表。它提供：

- 平移、缩放、适合视图、居中和重新排列；
- 树、思维导图和时间线布局；
- 可拖动节点，无需更改 Session 沿袭；
- 具有下一个和上一个结果导航的节点搜索；
- 单击、多选和选取框选择；
- 主动 Session 路径和叉边突出显示；
- Natural、Included 和 Excluded 除颜色外还使用文本或图标进行状态；
- 找到 Chat，导航到 Session、Branch、Include、Exclude 和 Natural 操作；
- 批量 Include、Exclude、Natural 和反转操作；
- 重置为 Natural 和 Context Plan 撤消或重做。

图端口布局算法和交互组件，而不是独立的 Zustand 域存储。 Harness Session data, slot composition, remote calls, and CSS tokens remain authoritative.

### 对话流集成

用户和助理消息悬停操作公开 Branch、上下文状态和在地图中定位。这些操作调用图形节点使用的相同注入回调。上下文状态更新出现在映射中，并从一个反应式 Contextify 视图流中；这两个组件都不会将外部数据镜像到私有 React 状态。

选择“在地图中查找”会在必要时打开右侧面板，更改消息的系列地图，聚焦规范节点，并保留当前的 ​​Chat Session。选择导航到 Session 显式更改 Chat Session。

### 侧边栏集成

侧边栏从现有 Workspace 和 Session 摘要挂钩派生出递归树。折叠状态是存储在客户端插件存储中的 UI 查看状态。业务 Session 摘要和沿袭保留在客户端运行时对象层中。

## 服务职责

### Session 家族投影

纯投影模块根据 Session 摘要和事件输入构建根、父子关系、规范消息、路径和图形边缘。它没有 Cordis 或 React 依赖性，并且由根、子、兄弟、孙、空子、延迟父和复制前缀不匹配情况的确定性固定装置覆盖。

### Contextify 服务

服务器端 Contextify 插件拥有持久的 Context Plan 突变、比较和交换修订、快照验证、fork 后重置行为和编译器注册。它删除了 `ContextPath`、`pathId`、`createBranch`、`selectPath`、`returnToMainline` 和 `contextify/route`，因为本机 Session 拥有这些职责。

该服务根据活动 Session 和规范消息引用公开读取和突变。跨系列 Include 请求在附加事件之前失败。过时的计划修订会因现有的比较和交换冲突响应而失败，因此客户端可以刷新并保留用户的待处理选择。

### Remote API

远程 API 公开族图读取、活动 Context Plan、节点模式突变、批量突变、重置、撤消和重做。本机 Branch 和导航继续通过现有的 Session API 而不是 Contextify RPC 方法。

### 客户端插件

客户端插件通过 Harness 插槽组成。它的存储仅包含查看状态，例如面板宽度、活动布局、选定的图形节点、搜索查询、视口恢复键和折叠的侧边栏行。实时家庭数据和 Context Plan 状态通过框架绑定的挂钩或注入的回调到达。

## 独立的Context Map功能适配

| 独立功能 | Harness 行为 |
|---|---|
| 图节点和边 | 移植到 Session 系列投影。 |
| 树形图、思维导图和时间线布局 | 端口布局算法和控制。 |
| 搜索、定位、缩放、平移、居中、适合 | 直接使用 Harness 样式进行移植。 |
| 选择、多选、选取框 | 直接端口。 |
| Include、Exclude、Natural、反转 | 应用于活动的 Session Context Plan。 |
| DSHProtectedTOKEN13ENDTOKEN | 调用本机 `sessions.fork`。 |
| 重新 Branch | 从选定的已完成转弯处再次分叉。 |
| 返回父级 | 浏览 `parentSession`。 |
| 撤消和重做 | 附加完整的 Context Plan 修订版。 |
| 重置为 Natural | 附加空的 Context Plan 修订版。 |
| 编辑留言 | 优惠编辑和 Branch；永远不要改变现有的日志事件。 |
| 删除节点 | 提供 Exclude 或仅演示隐藏；永远不要删除持久消息。 |
| 推广分支 | 设置显示首选项或从 Session 继续；永远不要重写血统。 |
| 定制主线 | 存储显示首选项而不更改本地血统。 |
| 模式或SOP提取 | 通过稍后的工件提供程序对选定的消息快照进行操作；保留扩展操作但不阻止图形释放。 |
| 自动 Include 建议 | 此实现中的 Excluded。 |

在 Harness 持久性允许的情况下，迁移会保留用户功能。它使用仅附加 Session 或 Context Plan 操作替换破坏性图突变。

## 错误处理

- 过时的 Context Plan 修订版会刷新视图并报告在操作完成之前上下文已更改。
- 跨系列 Include 请求失败，且未附加事件。
- 缺少源消息或内容哈希不匹配会导致快照创建失败，而不是导入更改的内容。
- 不支持的同级工具调用消息保留为 Natural，并显示无法导入它的原因。
- 分叉故障会保留图形选择和活动 Session。
- 不可用的后代日志会呈现带有正在加载或不可用端点的 Session 分支；它不会删除已知的血统。
- 格式错误的持久 Context Plan 会阻止 Contextify 编译器选择并显示诊断。它永远不会默默地退回到不同的环境。

## 测试策略

### 纯单位覆盖率

- Session 为根、兄弟姐妹、孙子、失踪父母和周期构建家庭。
- 跨一代或多代分叉的规范消息重复数据删除。
- 通过完成的转弯边界将叉边放置在用户和助理消息处。
- Natural、Include、Exclude、批处理、反转、重置、撤消和重做计划转换。
- 快照出处、内容哈希、同族检查和过时修订冲突。
- Context Compiler 事件和快照验证、排序、重播和工具协议拒绝。
- 子计划在包含父 Contextify 事件的种子后重置。

### 元件覆盖率

- 图表为每个用户或助理消息呈现一个节点，并且没有推理或工具节点。
- 搜索、选择、布局、定位、导航、Branch 和节点模式控件调用预期的注入回调。
- Chat 和地图反映了一项 Context Plan 更新。
- 详细信息面板和每个 Workspace 或 Session 树行正确折叠和恢复。
- 键盘和指针交互仍然适用于大家庭。

### 组装浏览器覆盖范围

支持重放的 E2E 场景创建根对话，从不同的消息分叉两个子 Session，打开映射，验证规范共享前缀节点，更改 Chat 和映射的上下文，在分支之间导航，重新加载应用程序，并验证同一棵树和 Context Plan。然后，该场景提交子请求并检查记录的模型输入，以证明 Excluded Natural 消息不存在并且 Included 同级快照存在。

现有详细信息生命周期 E2E 保持绿色。可见的更改会更新无密钥网络重放快照。最终的验证阶梯包括重点包测试、`pnpm run test:gui`、更改包的类型检查和 lint、`DSH_SNAPSHOT=replay pnpm run test:web`、文档门和生产 Web 构建。

## 实施边界

此实现包括本机 Session 系列可视化、递归侧边栏层次结构、图形和 Chat 操作、消息级上下文控制、系列内导入、持久重播以及通过浏览器进行的服务测试。

它不包括跨地图导入、自动上下文推荐、物理 Session 日志编辑或删除、本机谱系重写以及用于模式或 SOP 提取的工件后端。 UI 可以为以后的提供程序保留禁用或扩展点可供性，但不得将排除的行为呈现为可用。

## 验收标准

1. Contextify 不包含相同的 Session 虚拟分支或路由模型。
2. 来自用户或助理消息的 Branch 在包含已完成的轮次时创建并打开本机子 Session。
3. 左侧边栏显示可折叠的 Workspace 和递归 Session 沿袭。
4. 右侧面板使用真实的交互式图表，每个可见用户或助理消息都有一个节点。
5. 共享分叉前缀出现一次，分支边缘连接到正确的规范消息。
6. 推理和工具事件不会显示为图形节点。
7. Chat 和 Map 发生变异并显示相同的活动 Session Context Plan。
8. Natural、Include、Exclude、批处理、反转、重置、撤消和重做在重新加载后仍有效。
9. Session 可以从同一系列中的另一个 Session 获取 Include 消息快照，并且无法从其他系列导入。
10. 每个模型可见的导入消息都可以从活动的 Session 日志中重建。
11. 新的子项以 Natural Context Plan 开始，即使其分叉种子复制了父项 Contextify 事件。
12. 单元、组件、支持回放的 E2E、GUI、类型、lint、文档和生产构建检查，涵盖更改的行为通道。
