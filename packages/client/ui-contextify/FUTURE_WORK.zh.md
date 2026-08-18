# Context Map Agent 推荐——未来工作

[English](FUTURE_WORK.md) | 中文

这三个机会共同构成现有确定性 Context Plan 之上的推荐层，目前刻意不作为 runtime 功能实现。每条推荐都必须可检查、解释其证据，并且在改变持久 context 或 Session structure 前要求用户显式 review。

1. **推荐 context selection。** Agent 建议哪些 message node 应进入下一次 request，区分新增与移除，并解释每个 node 对当前目标的作用。用户可以接受单项修改或整份 proposal；推荐绝不能静默改变 Include、Exclude 或 Natural 状态。
2. **推荐 pruning。** Agent 识别过时、重复、已被取代或低价值的 node 与 branch。Proposal 必须区分 context exclusion 与破坏性的 deletion 或 archive，估算 context reduction，并保留恢复能力。第一版应推荐可逆的 exclusion 或 archive，而不是删除 Harness 原生 history。
3. **推荐 branch 或 main-line promotion。** 新 turn 开始前，Agent 可以建议创建原生 branch、append 到已有相关 Session，或者把有价值的 branch result promote 回 main line。Proposal 必须明确 target Session 和 branch point，展示将继承的 context，并把最终 routing 决策留给用户。

未来实现需要共同解决的产品问题包括：推荐时机、confidence 与 rationale 展示、新 turn 后 stale proposal 的失效、原子接受、undo 行为、隐私边界，以及相对于手动 Context Map 决策的评估方法。
