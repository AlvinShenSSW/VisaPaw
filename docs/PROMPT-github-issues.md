# Prompt：在 GitHub 上创建 VisaPaw Iteration 1 的 Epic 与 Issues

> 用法：把下面代码块内的全部内容复制给 VS Code 里的 AI 编码代理（在 VisaPaw 仓库目录下执行，需已登录 `gh` CLI）。

```text
你在 VisaPaw 仓库中工作。请把 Iteration 1 的 Epic 和全部子 issue 创建到本仓库对应的 GitHub 仓库上。严格按以下步骤执行：

1. 通读 docs/EPIC-ITERATION-1.md——它包含 1 个 Epic 和 14 个 issue 的完整正文，以及每个 issue 的标题与 labels。同时浏览 mockups/ 目录（index.html 及 01–05 共 6 个高保真 UI/UX 稿页面），理解 issue 中引用的设计基准。

2. 用 gh CLI 依次执行：
   a. 创建 milestone「Iteration 1」（已存在则复用）；
   b. 确保这些 labels 存在（没有则创建）：epic、feat、ui、docs、chore、ai-provider、scraper；
   c. 先创建 Epic issue（标题、labels、正文取自文档「Epic」一节），挂 milestone；
   d. 按文档顺序创建 Issue 1–14，标题、labels、正文一字不改地使用文档内容，不要自行概括、翻译或删减；每个 issue 都挂 milestone「Iteration 1」，并在正文末尾追加一行「Epic: #<Epic 编号>」；
   e. 全部创建完成后，编辑 Epic 正文，把「子任务」一节替换为 task list，逐条列出 - [ ] #<编号> <标题>；
   f. 按文档末尾「建议的依赖关系」，在相关 issue 上追加一条评论注明前置依赖（如「Blocked by #x」）。

3. 【设计红线——必须原样保留并传达】所有 UI 相关 issue（8、9、10、11、12）的实现必须严格按照仓库 mockups/ 目录下的 UI/UX 稿：布局、配色 token（天蓝 #2E9BDF / 深色 #4FB0F0、浅灰、白）、字体层级、组件状态、浅色与深色模式，均以 mockup 为唯一视觉验收基准，不得自行发挥或"优化"设计。任何与 mockup 的偏差都需要先在 issue 中讨论确认。

4. 不要修改仓库中的任何代码或文档文件；本任务只创建 GitHub milestone、labels、issues 和评论。

5. 完成后输出一份清单：Epic 与每个 issue 的编号、标题、URL，以及创建的 milestone 和 labels。
```
