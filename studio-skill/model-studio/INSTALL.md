# 安装造物 SKILL

在造物顶部打开「造物 SKILL」，点击「复制 Agent 安装指令」，将完整指令发送给本机 Codex、Claude Code 或其他支持 Skills 的 Agent。指令使用当前造物服务的实际下载地址，由 Agent 下载、检查和安装。

下载地址仅在运行造物的同一台电脑上可用。下载期间保持造物运行，无需添加令牌或请求头；云端 Agent 和其他电脑不能直接访问这个本机地址。

## 手动安装

也可以点击「下载 ZIP」，把压缩包里的完整 `model-studio/` 文件夹放入当前 Agent 实际读取的 Skills 目录。默认使用个人技能目录，供不同项目复用：

| Agent | 个人技能目录 | 项目技能目录（可选） |
| --- | --- | --- |
| Codex | `~/.agents/skills/` | `<项目>/.agents/skills/` |
| Claude Code | `~/.claude/skills/` | `<项目>/.claude/skills/` |
| 其他 Agent | 使用该工具实际配置或官方说明中的目录 | 使用该工具支持的项目目录 |

`~` 表示当前用户的主目录；Windows 中通常是 `%USERPROFILE%`，macOS / Linux 中通常是 `$HOME`。若 Agent 已配置了有效的自定义或兼容目录，优先使用该目录，不要在多个被扫描的目录重复安装同名技能。

安装后应存在 `<Skills 目录>/model-studio/SKILL.md`，并保留包内 `references/`、`agents/` 等支持文件。已有同名技能时先比较内容，相同则保留；需要更新时先将旧版备份到 Skills 扫描目录之外，再替换。

检查 Agent 是否已识别技能。尚未识别时刷新技能或新开会话，必要时重启 Agent。目录约定参考 [Codex Skills 文档](https://learn.chatgpt.com/docs/build-skills) 与 [Claude Code Skills 文档](https://code.claude.com/docs/en/skills)。

## 使用

Codex 中可明确调用：

```text
使用 $model-studio，在我指定的造物工程目录中，按参考图片和本次要求修改 model.js，并检查结果。
```

若工程有 `task-context.json`，技能会按其中的本轮上下文工作。Claude Code 可使用 `/model-studio`，其他 Agent 使用各自的技能调用方式。没有平台任务文件时，也可以提供工程路径、参考图片和修改要求，用于现有 Three.js 工程。

## 与本地 CLI 配合

造物的本地连接程序负责调用 Codex CLI、传递任务上下文和检测模型源码变化；技能负责建模与校验规范。平台新建的建模工程已带有项目级 `.agents/skills/model-studio/`，使用平台内置 Codex 连接时无需再安装个人技能。

安装技能不会安装或启动 CLI、建立平台连接、修改登录配置，也不会自动开始建模。登录与模型服务仍由所用 Agent 管理。
