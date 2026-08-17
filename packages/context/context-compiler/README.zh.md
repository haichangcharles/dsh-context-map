# @deepseek-ai/dsh-context-compiler

[English](README.md) | 中文

`dsh-context-compiler` 是 Harness 中负责选择哪些持久 Session 消息事件进入模型请求的能力 seam。它保持 Session 日志作为唯一事实来源：provider 返回有序事件序号，registry 校验这些事件并将其投影为冻结的 `Message` 对象。

## 默认行为

当 Session 中没有 `context/compiler` 事件时，内置的 `{ id: 'surface', version: 1 }` provider 生效。它的输出与 `session.deriveMessages()` 等价，包括表层替换，以及省略空 assistant 完成锚点的行为。

## 注册 provider

```ts ignore-check
const dispose = ctx.contextCompiler.register({
  id: 'contextify',
  version: 1,
  select: ({ session, turn, step }) => ({
    eventSeqs: selectContextifyEvents(session, { turn, step }),
  }),
})

ctx.contextCompiler.select(session, 'contextify')
const compilation = ctx.contextCompiler.compile({ session, turn: 1, step: 1 })
```

仅当新的 descriptor 与 Session 当前 descriptor 不同时，`select()` 才会追加一条完整的 `context/compiler` descriptor。调用注册 disposer 会移除进程内执行权限，但不会重写持久历史；如果 Session 仍选择已移除的 provider，编译会明确失败。

## Provider 约定

Provider 必须同步且纯净。它可以读取传入的 Session 与请求坐标，但禁止发起网络或模型调用、追加事件、读取时钟或修改外部状态。它只能返回现有的、不重复的非负安全整数 seq；这些 seq 必须指向 `user/message`、非空 `assistant/message`、`tool/result` 或 `context/compiler-snapshot` 事件。Snapshot 是只记录在日志中的事件，不会进入 `Session.surface`；只有 active compiler 选择这条确切事件时，模型才会看到其中冻结的消息。Registry 保留 provider 返回的顺序，并在模型 I/O 之前拒绝所有非法选择。

Provider 不能注册保留 id `surface`。Id 必须是没有首尾空白的非空字符串，version 必须是正安全整数，重复 id 会失败。如果持久 descriptor 对应的 provider 缺失，或者其 version 与实时注册不一致，系统绝不会静默回退到 `surface`。

## 模型体验

### 编译后的对话历史

#### 模型看到的内容

模型看到 active compiler 选出的有序消息，以及 Harness 常规的请求 system prompt 和工具 schema。Compiler 元数据记录在 `request/header` 中，不会渲染为模型可见文本。

#### Token 影响

所选事件集合直接决定对话历史的输入 token。本包自身不增加任何提示词文本。

#### KV Cache 影响

保持稳定的所选前缀，就能保持对应的可复用请求前缀。对较早事件执行重排、排除或重新插入，可能从第一条变化消息开始使缓存复用失效。

## 已知限制与暂缓事项

- **不能在请求内合成**——compiler 不能在 `select` 期间创建消息或摘要；其他插件必须先追加 `context/compiler-snapshot`，compiler 才能选择复制或合成的内容。
- **同步执行**——依赖网络的检索和依赖模型的排序应发生在编译之前，而不是 provider 内部。
- **要求精确 provider 可用**——恢复 Session 后，必须在下一个 Agent Loop 步骤之前注册被选中的 provider id 和 version。
- **仅限 Session 事件**——非消息事件和只存在于内存中的任意 `Message` 对象不能进入 compilation。
