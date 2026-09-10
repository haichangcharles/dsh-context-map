/** Bilingual product copy; screenshots open at their original resolution. */
const zh = {
  "skip": "跳至正文",
  "navHow": "如何使用",
  "navDocs": "使用文档",
  "eyebrow": "开源项目 · 基于 DEEPSEEK HARNESS",
  "hero1": "让想法自由分岔。",
  "hero2": "让上下文始终清晰。",
  "heroCopy": "对话不只有一条滚动长页。看清每条分支，选择模型接下来能看到的内容，让每个想法都有迹可循。",
  "start": "开始使用",
  "try": "看看能做什么",
  "heroNote": "历史完整保留。下一次请求的上下文，由你掌控。",
  "galleryLabel": "同一个工作区，容纳不同方向。",
  "sample": "真实应用截图 · 示例数据",
  "galleryTitle": "同一个问题，<br>可以有不同的探索路径。",
  "galleryCopy": "从同一个起点，分别探索「社区发布」和「企业试点」。看清两条分支，在它们之间切换，再决定下一次请求带上哪些内容。",
  "overviewCaption": "共享一个起点，分成两条原生会话分支。点击任意截图，可以查看清晰原图。",
  "branchTitle": "从这一条消息，<br>试试另一个方向。",
  "branchCopy": "一个回答引出了新的可能？就在这条消息上创建分支。原对话保留，新会话继承分叉点之前的历史，不必重新交代背景。",
  "branchAction": "右键消息 → Branch from Here（从这里分叉）。",
  "enlarge": "点击查看清晰原图 ↗",
  "contextTitle": "跨分支取用好想法。<br>自己决定模型看到什么。",
  "contextCopy": "当前在企业试点分支，也可以取用社区发布分支里有价值的回答。勾选它，再排除不需要的企业销售方案。下一次请求按你的选择组合上下文，各分支原文仍保留。",
  "contextAction": "勾选 Context 纳入消息；取消勾选则从下一次上下文中排除。",
  "reviewTitle": "先看建议和理由。<br>再决定要不要应用。",
  "reviewCopy": "Fast Review 做有限范围的快速检查，Deep Review 检查完整对话树快照。建议先展示，确认后才改变上下文；应用后还可以 Undo / Redo。",
  "reviewAction": "Recommend → 审阅变更 → Apply；之后可以撤销。",
  "archiveTitle": "归档过时内容。<br>仍然找得到它的来路。",
  "archiveCopy": "Archive 将消息的上下文内容替换为占位符，节点、连接和原始记录仍保留。需要回看时点 Show original，想重新使用时点 Restore node。",
  "archiveAction": "归档节点 → 查看原文／恢复节点。",
  "promptsTitle": "让审阅遵循<br>你的工作习惯。",
  "promptsCopy": "为 Context、Archive、Branch 审阅器添加自己的规则，同时保留可查看的默认提示词。需要时可明确解锁完整覆盖。还可开启 Automatic Branch review，让它建议将适合独立探索的一轮对话移到分支；默认关闭。",
  "promptsAction": "设置 → Context Map prompts（提示词面板）。",
  "galleryDisclosure": "截图来自实际运行的应用，使用预先准备的示例会话。审阅截图中的建议是用于展示确认界面的预设示例，并非实时 AI 结果。",
  "foundationLabel": "熟悉的 HARNESS，更清晰的视野。",
  "foundationTitle": "基于 DeepSeek Harness。",
  "foundationCopy": "沿用原有的 Agent 循环、工具、模型路由与会话持久化。Context Map 在此基础上提供可视工作区与对话上下文控制。",
  "upstream": "了解上游项目",
  "startLabel": "开源，运行在你的工作区。",
  "startTitle": "给下一个想法，<br>留一点空间。",
  "startCopy": "从源码在本地运行，配置你的模型，然后开启一段全新的对话。",
  "viewGithub": "在 GitHub 查看",
  "readDocs": "阅读使用文档 →",
  "terminal": "终端 · 从源码运行",
  "copy": "复制",
  "requirements": "需要 Node.js ^22.19 或 ≥24，以及 pnpm。在本地应用中配置模型提供商。",
  "migration": "正在升级旧版 Context Map？兼容迁移可用之前，请继续用旧运行时保留并访问现有会话数据。",
  "migrationLink": "阅读升级说明 ↗",
  "independent": "独立社区项目，与 DeepSeek 无隶属关系，未获其背书。",
  "feedback": "反馈建议 ↗"
};
const textNodes=[...document.querySelectorAll('[data-i18n]')];
const en=Object.fromEntries(textNodes.map(el=>[el.dataset.i18n,el.innerHTML]));
let language=new URLSearchParams(location.search).get('lang')==='zh'?'zh':'en';
function renderLanguage(){textNodes.forEach(el=>{el.innerHTML=(language==='zh'?zh:en)[el.dataset.i18n];});document.documentElement.lang=language==='zh'?'zh-CN':'en';document.getElementById('language').textContent=language==='zh'?'EN':'中文';document.getElementById('language').setAttribute('aria-label',language==='zh'?'Switch to English':'切换到中文');document.title=language==='zh'?'DSH Context Map — 让上下文清晰可见':'DSH Context Map — Make context visible.';document.querySelectorAll('[data-i18n="navDocs"],[data-i18n="readDocs"]').forEach(el=>el.href=language==='zh'?'./guide/quickstart':'./en/');}
document.getElementById('language').addEventListener('click',()=>{language=language==='en'?'zh':'en';const url=new URL(location.href);if(language==='zh')url.searchParams.set('lang','zh');else url.searchParams.delete('lang');history.replaceState(null,'',url);renderLanguage();});
document.getElementById('copy').addEventListener('click',async()=>{const button=document.getElementById('copy');try{await navigator.clipboard.writeText(document.getElementById('install-command').textContent);button.textContent=language==='zh'?'已复制':'Copied';document.getElementById('copy-status').textContent=language==='zh'?'安装命令已复制':'Installation commands copied';}catch{const range=document.createRange();range.selectNodeContents(document.getElementById('install-command'));const selected=window.getSelection();selected.removeAllRanges();selected.addRange(range);document.getElementById('copy-status').textContent=language==='zh'?'请手动复制选中的命令':'Select and copy these commands manually';}});
renderLanguage();
