# dsh-skillmanager

DSH web 标准插件：在「设置 → 固定提示词」里管理存放在 **Obsidian 仓库** 中的技能笔记（固定提示词），并支持在**单个对话里**临时开关技能。启用的技能内容会在每次模型请求时自动注入系统提示。

## 两层开关

| 层级 | 位置 | 作用范围 | 存哪里 |
|---|---|---|---|
| 全局默认 | 设置 → 固定提示词 里的「注入 / 停用」 | 所有对话 | 笔记 frontmatter 的 `enabled` |
| 对话级 | 对话**左上角**的小药丸「技能提示词」 | **仅当前对话** | `~/.dsh-skillmanager/sessions.json` |

- 设置页面永远是默认值：对话级开关既能把默认停用的技能在**这一个对话**里打开，也能把默认注入的技能在**这一个对话**里关掉。
- 对话级开关不改笔记、不改设置页；点「跟随设置」就回到全局默认。
- 子代理（subagent）会继承父对话的对话级开关。
- 设置页会显示当前有多少个对话带临时开关，并提供「清除所有对话的临时开关」。

## 功能

- 技能 = 仓库 `skills/` 文件夹里的一份 Markdown 笔记，**放进文件夹即自动识别**，无需注册表
- 设置 → 「固定提示词」：
  - 读取/预览：文件名、描述、字数、正文
  - 修改 / 创建 / 删除 / 导入 `.md`
  - 控制：每个技能独立「注入 / 停用」开关（写入笔记 frontmatter 的 `enabled`）
  - 更改仓库地址并保存；打开 skills 文件夹
  - 对话级开关总览 + 一键清除
- 对话左上角的小药丸「技能提示词」：
  - 收起时是一行小药丸（`▸ 技能提示词 6/6 · 本会话`），**不占对话布局空间**（绝对定位浮在消息列左侧空白处）
  - 展开时向下生长一张 320px 宽的卡片；超过 `min(52vh, 460px)` 时卡片内部滚动，不会推挤正文
  - 逐个技能显示「默认注入/默认停用 · 本会话注入/本会话停用 · 字数」
  - 每行开关只改当前对话；「跟随设置」清除该技能的对话级决定；「全部恢复默认」清除本对话全部决定
  - 新对话（还没有第一条消息、框架隐藏标题栏时）这条入口临时出现在输入框上方，首条消息后回到左上角
- 完全 Obsidian 原生：直接改笔记文件（含 `enabled: true/false`）下个请求即生效
- 数据持久化：仓库地址与对话级开关存于 `~/.dsh-skillmanager/`，技能笔记存于仓库

## 存储位置

```
<obsidian-vault>/skills/   ← 技能笔记（每个技能一个 .md）
~/.dsh-skillmanager/config.json     ← { vaultDir: "E:\\dsh\\DSH-Memory" }
~/.dsh-skillmanager/sessions.json   ← { version: 1, sessions: [{ id, updatedAt, skills }] }
```

`sessions.json` 只存「对话里显式点过的决定」，删掉它只是让所有对话回到全局默认。最多保留最近 300 个对话。

笔记 frontmatter：

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 推荐 | 小写 kebab-case，符合 DSH 标准技能名 |
| `description` | 推荐 | 何时使用 |
| `enabled` | 否 | 默认 `true`；`false` = 停用不注入（全局默认，可被对话级开关覆盖） |
| 其他 | 否 | 原样保留（tags/aliases 等） |

仓库默认内置：`SKILL-GUIDE.md`（使用指南 + 创建技能标准流程 + 空白模板，一份文档即全）、`REFLECTION.md`、`test.md`（示例，均默认停用）。想全局注入时在设置页打开对应「注入」开关；只想在某个对话用，就在那个对话的「技能提示词」栏里打开。

## HTTP 接口

设置页与对话栏都只走本插件自己的路由：

| 路由 | 说明 |
|---|---|
| `GET /api/dsh-skillmanager/state` | 全局状态（含 `sessionOverrideCount` / `sessionOverrides`） |
| `POST /api/dsh-skillmanager/config` | 改仓库地址 |
| `POST /api/dsh-skillmanager/add` / `import` / `update` / `remove` | 笔记增删改 |
| `POST /api/dsh-skillmanager/toggle` | 全局默认开关（写回 frontmatter） |
| `POST /api/dsh-skillmanager/open-folder` | 打开 skills 文件夹 |
| `POST /api/dsh-skillmanager/session` | `{ sessionId }` → 该对话的解析结果 |
| `POST /api/dsh-skillmanager/session-override` | `{ sessionId, file, enabled }`，`enabled: null` = 回到默认 |
| `POST /api/dsh-skillmanager/session-reset` | `{ sessionId }` 清除该对话全部开关 |
| `POST /api/dsh-skillmanager/session-reset-all` | 清除所有对话的开关 |

## 注入是怎么算的

每次模型请求都会重新组装系统提示：

```
生效 = 本对话的显式决定（含父对话继承） ?? 笔记 enabled（设置页的全局默认）
```

对话 id 取自组装上下文里的 agent（`context.agent.id`，也就是会话 id）；没有会话信息的调用（例如标题生成）按全局默认处理。

## 安装

```bash
dsh plugin --profile web add file:E:/dsh/椤圭洰/dsh-skillmanager
```

并把 `dsh-skillmanager` 加入 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 数组，然后**重启 dsh** 生效。修改插件源码后需重新同步安装副本（或重跑安装命令）再重启。

## 迁移

旧版数据（`~/.dsh-skillmanager.json`、`~/.dsh-skillmanager/` 文件夹、插件内 `skills/`）会在插件启动时自动迁移到当前仓库的 `skills/` 文件夹；迁移后旧注册表被重命名标记，不会覆盖仓库里的后续修改。

## 开发

```bash
npm test          # 宿主 + 浏览器两半的本地测试（无需 DSH 宿主）
npm run smoke     # 宿主：路由注册、frontmatter 读写、注入文本、对话级覆盖、路径安全
npm run client-test # 浏览器：插槽注册、对话栏渲染与开关交互、设置页
```

`test/client.mjs` 用一个手写的极小 hooks 运行时 + 打桩 `fetch` 直接跑 `lib/client.js`，所以浏览器半边也能离线验证。

## 仓库

https://github.com/AppliedYuu/dsh-skillmanager
