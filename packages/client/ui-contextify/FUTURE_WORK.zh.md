# Context Map Agent 推荐——未来工作

[English](FUTURE_WORK.md) | 中文

前两个机会现在已经构成确定性 Context Plan 之上的手动、仅供 review 的 runtime 层；第三个仍是未来工作。每条推荐都保持可检查、解释证据，并且在改变持久 context 或 Session structure 前要求用户显式 review。

1. **已实现：推荐 context selection。** 隔离的 Harness Agent 会给出新增/移除建议、confidence 与 rationale。用户可以接受单项或勾选的多项；推荐绝不会静默改变 Include、Exclude 或 Natural 状态。Revision 或 graph watermark 变化后 proposal 会变成 stale。
2. **已实现：推荐语义 cleanup。** Agent 会识别 obsolete、conflict 或 redundant message node。Cleanup 永远不能批量执行：用户每次只确认一个可编辑、保持 role 的 placeholder。同一个 node、edge、fork point、原始 Session event 以及 Restore、Reset、Undo、Redo 都会保留。
3. **推荐 branch 或 main-line promotion。** 新 turn 开始前，Agent 可以建议创建原生 branch、append 到已有相关 Session，或者把有价值的 branch result promote 回 main line。Proposal 必须明确 target Session 和 branch point，展示将继承的 context，并把最终 routing 决策留给用户。

剩余产品问题包括：自动推荐时机、branch routing、当前有界同 family projection 之外的隐私控制，以及相对于手动 Context Map 决策的评估方法。
