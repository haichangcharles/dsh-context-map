# @deepseek-ai/dsh-client-ui-brand-official

[English](README.md) | 中文

本包保留上游 `@deepseek-ai/dsh-client-ui-brand-official` 标识，使 DSH Context Map 合并 DeepSeek Harness 模块图时不需要改写包依赖边。在本发行版中，可替换的 occupant 将产品标识为 DSH Context Map；这个包标识并不代表产品是 DeepSeek 官方发行版。

仅当 `DSH_CLIENT_BUILD_PROFILE` 为 `official` 时，本包才填充 `sidebar.brand.mark`、`sidebar.brand.name` 和 `conversation.hero.brand.mark`。其他构建仍会加载插件，但不注册 occupant，因此显示 shell fallback。

三个占位者通过嵌套的 `slots.inject()` 作为一组声明感知注册安装。因此无论该包的条目先于还是后于侧边栏和会话声明方激活，它都能工作；任一声明折叠时会撤回全部占位者，HMR 期间不会留下混合品牌。它不保留运行时状态。node 半边是空的 Loader seat；浏览器标题仍属于本包之外的构建环境事项。

## 模型体验

无，因为本包只贡献浏览器呈现；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；本包既不组装也不发送 provider 请求。

## 已知限制与暂缓事项

- **包 ID 只是上游兼容细节** —— 产品身份由 slot occupant 和构建时选择的浏览器标题决定。
- **本包只提供一组 occupant** —— 其他发行版可以使用占用相同 slot 的 Cordis 包替换这一行。
- **浏览器标题相互独立** —— `DSH_CLIENT_TITLE` 在构建期选择标题文字，而不经过 UI slot。
