# Agent Note：不完整 Context 血缘与策略边界

Status: implemented

[English](2026-10-14-contextify-partial-lineage-and-policy-boundaries.md) | 中文

## Problem

原生子 Session 可以在父 Session 检查数据不可用时被检查。此时，所有权验证将继承消息保留为子 Session 的本地节点。若把这个回退后的所有者当作规范父节点，就会错误地产生自己指向自己的父子关系。偏好投影还为内部构造保证非空的数组保留空数组回退；伪造输入或覆盖率豁免会掩盖这些真正的不变量。

## Decision

当继承的分支事件解析出的所有者就是子 Session 本身时，family projector 保留原生声明的父 ID。只有复制事件验证确认另一个规范所有者后，才将分支归并到该所有者下。因此，父数据缺失不会制造自指边；在继承边界上经过验证的分支仍保留原来的兄弟分支位置。

旧审核等待模型期间，恢复缺失的父 Session 可能改变 family root。随后启动的新审核可以在恢复后的根下拥有同一个 Session。清理只释放仍属于旧根的 Session 到根映射。同一根的 operation 所有权仍然互斥，但这个保证不能跨越恢复后的根。

个人 Context 策略通过非空 reduction 读取近期首个 mode。matching filter 产生稠密数组，长度守卫要求至少十项，所以 recent slice 必有五项。axis scorer 对至少包含 source、topology、cell 的字面量数组做 reduction。只有分数严格更高时才替换胜者，保留稳定排序在平分时选择首项的行为。未知图特征、稀疏评审证据与冲突选择仍保留已有守卫和阈值。

## Alternatives considered

**把未验证的本地所有权当成祖先关系。** 当前投影中消息的所有权无法证明子 Session 的父节点；复制事件验证不能确认其他所有者时，原生 header 仍是父关系的依据。

**强行制造不可能的内部空数组，或将其排除在覆盖率之外。** 稀疏数组 fixture、私有 mock 与 ignore 注释并不能验证真正的公共输入处理。实现直接表达可证明的构造不变量，原生事件测试则验证实际可达的拒绝与回退行为。

## Consequences

不完整检查保留真实的本地图和原生父身份。源事件、Context Plan、已确认偏好、模型请求和审批要求均不改变。策略简化保留个性化建议的顺序与灵敏度。缺失的祖先仍不可用；projector 不会编造其内容，也不会验证没有观察到的复制前缀。

## Testing

原生测试在修复前复现缺失父节点造成的本地自指关系，并在修复后验证正确的父 ID。已有的继承边界分支归并仍受测试覆盖。公共检查测试覆盖图片与 worker 消息、失败 Web 结果的来源信息、空与循环父元数据、旧生命周期时间戳以及同时发生的选择。策略测试覆盖完整评审单验证、撤销证据、空目标、失去来源的节点、no-op、稳定与反转偏好、明确路由选择及词法回退。八个受影响的策略和 family 模块均满足不变的逐文件 100% 覆盖要求，没有模型调用或覆盖率豁免。

两个原生模型流屏障在修复前复现恢复父节点后的清理失败。修复后，旧审核报告图已过期，新审核则可以完成或收到针对自己的取消。两种结果都不会丢失恢复后根的所有权。

## Related

[经过评审的 Context 语义](../feature/2026-08-19-context-map-reviewed-semantics.zh.md)仍负责 family freshness 与审批行为。[个人 Context 校准](../feature/2026-10-09-personal-context-calibration.zh.md)仍负责偏好算法。本说明补充失败处理和构造证明，不取代这两项决策。
