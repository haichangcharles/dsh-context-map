# 详情栏重新展开控件设计

[English](2026-08-18-details-reveal-control-design.md) | 中文

**日期：** 2026-08-18

**范围：** 用户关闭 Context Map 或 Tool 详情后，恢复一个可持续使用的入口，用于重新打开 Harness 原生右侧详情栏。

## 产品行为

当存在活动的非空 Session，并且原生详情栏在视觉上处于关闭状态时，Harness 在框架右侧边缘显示一个小型悬浮左箭头控件。点击后调用现有原生 `openDetails()` action。详情栏会回到最后选择的子页，因此关闭并重新打开 Context Map 时保留其视口和选择；关闭 Tool 详情时也保留选中的 Tool。

详情栏打开后，重新展开控件消失，此时仍由现有关闭按钮和拖拽手柄负责交互。这样重新展开控件与调整尺寸手柄互斥，不会出现重叠的指针目标。

没有可用的活动 Session 时不显示重新展开控件。如果当前视口下原生栏宽度求解器无法为详情栏分配宽度，仍以现有求解器为准；本功能不会增加 overlay drawer，也不会修改最小宽度规则。

## 归属

重新展开控件归 `ui-layout/AppFrame` 管理，因为它已经知道详情栏的最终宽度，并拥有 `openDetails()`、`closeDetails()` 和调整尺寸手柄。Contextify 不会再增加一层悬浮 overlay，也不会复制布局状态。Context Map 仍是 `ui-contextify` 提供的子页，Tool 选择仍由 `ui-conversation` 管理。

## 无障碍与测试

该控件使用真实 button，无障碍名称为 `Open details panel`，具有键盘焦点样式和可见左箭头。AppFrame 测试证明：它只在存在活动 Session 且详情栏关闭时出现；通过原生 action 打开；打开后消失；不会与详情栏调整尺寸手柄同时出现。浏览器验证覆盖关闭 Context Map、使用箭头重新打开，然后选择一个 Tool 并点击 Details 子页。
