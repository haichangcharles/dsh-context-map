# Agent Note: 有界的文档片段索引

Status: implemented

[English](2026-10-20-documentation-fragment-memory.md) | 中文

## Problem

构建站点的片段验证器需要跨页面检查目标 ID 和锚点 href。为每个生成页面保留浏览器 DOM，会让文档验收耗尽堆内存，即使站点本身已经构建成功。

## Decision

[验证器](../../../../scripts/verify-doc-site-fragments.ts) 将 JSDOM 已使用的维护中 HTML 解析器 parse5 8.0.1 声明为直接开发依赖。每份完整 HTML 文档只解析一次，并禁用脚本解析，保持 JSDOM 的 noscript 行为。跨页面索引仅保留 ID/name 字符串和带片段的 href 字符串，页面树随后释放。遍历保持文档顺序，排除 template 内容并忽略命名空间中的 href。路由别名、URL 解析、片段解码和缺文件诊断保持原有语义。验证器不创建浏览器窗口，也不增加异步资源生命周期。

## Alternatives considered

**提高每项文档检查的堆上限。** 这仍保留不必要的页面树，增加本机与 CI 的内存压力。

**逐页关闭 JSDOM 窗口或共用一个 DOMParser。** 两种方式在实际站点上仍耗尽有界堆；避免保留窗口和文档是更小的实现。

**用正则表达式提取链接。** 这会重复实现 HTML 解析，并错误处理惰性标记、实体和命名空间。

## Consequences

验证器直接依赖维护中的解析器，并对其类型化语法树进行简单遍历。原有片段样例以及完整文档、实体、惰性内容和命名空间样例检查语义兼容性。全站验收使用同一份已发布 HTML 输出；验证器减少内存消耗属于工程结果，与 Agent 准确性或个性化无关。站点打包与 TypeScript 文档检查有各自的内存需求。
