# 造物 Studio · Zaowu Studio

[简体中文](README.md) · [English](README.en.md)

**MIT 开源的本地 Three.js 建模工作台。** 通过 Codex CLI 或配置的模型 API，根据参考图片和文字生成模型代码，在浏览器里预览、按部件继续修改、浏览版本并导出 GLB。模型的构造逻辑保留在可阅读、可修改的 `model.js` 中。

[GitHub 源码](https://github.com/ToBeMaster-Mao/zaowu-studio) · [MIT License](LICENSE) · [图文介绍与实际模型截图](docs/share/README.md) · [分享素材说明](docs/share/package-metadata.txt)

**状态：v0.1.0，实验性本地应用。** 造物支持本地 Codex CLI，以及 OpenAI、DeepSeek、Gemini 和 Grok（xAI）的 API 接入，让模型生成 Three.js 几何代码；API 模式不依赖 Codex。项目不包含专用图生 3D 模型权重。适合尝试器物、规则物体、建筑体块和参数化模型。写实人物、复杂有机形体、生产级拓扑与照片级还原仍是短板，不承诺替代 Tripo、Meshy、Rodin 等专用服务。

## 为什么用代码建模

当形状能拆成部件、尺寸、曲线或重复结构时，可以把它们表达为代码，再按要求继续调整。造物把这个过程放进一个可预览、可回退的工作台：

- **保留可编辑源码**：Agent 修改 `model.js`；你也可以直接阅读和修改模型的构造逻辑。
- **带着上下文修改**：对话可附上选中部件、当前视角、截图和多组参考图片，便于描述局部修改。
- **检查与回退**：查看部件、调整基础属性，预览历史版本；新版本通过预览校验后更新当前模型。
- **交付与复用**：导出当前或历史版本的 GLB；保留源码和工程数据，继续迭代。

程序化表达提供了修改入口，不等于自动获得正确比例、真实材质或生产可用资产。项目文件保存在本地，AI 推理使用你为 Codex 或 API 接入配置的服务，详见[本地数据与隐私](#本地数据与隐私)。

## 实际工作台截图

以下图片来自实际工作台中的模型预览，展示界面与示例结果；它们不是对任意输入效果的承诺，截图中的面数也不是质量评分。

**茶壶：模型预览与部件检查**

![造物 Studio 中的茶壶模型和部件列表](docs/share/assets/teapot-workspace.jpg)

**广州塔：建筑结构示例**

![造物 Studio 中的广州塔模型预览](docs/share/assets/canton-tower.jpg)

## 快速开始

需要 Node.js **22 或更新版本**和支持 WebGL 的现代浏览器。Windows、macOS、Linux 使用相同的 npm 命令。AI 建模可选择已登录的 Codex CLI，或相应服务的 API Key；仅使用 API 时无需安装 Codex。

1. 下载[仓库源码](https://github.com/ToBeMaster-Mao/zaowu-studio)或克隆仓库，进入 `zaowu-studio` 文件夹：

```sh
git clone https://github.com/ToBeMaster-Mao/zaowu-studio.git
cd zaowu-studio
```

2. 运行：

```sh
npm ci
npm start
```

打开 [http://127.0.0.1:4174](http://127.0.0.1:4174)。`npm start` 会先从源码生成可下载的 Skill ZIP，再启动本地服务。Windows 完成依赖安装后，也可以双击 `START-STUDIO.cmd`。

打开页面后，选择一种建模方式：

- **Codex CLI**：按 [Codex CLI 官方安装说明](https://learn.chatgpt.com/docs/codex/cli)安装 CLI，运行 `codex login`，再在工作台连接。登录方式由 Codex 管理，参见[官方身份验证说明](https://learn.chatgpt.com/docs/auth)。连接失败时，检查 CLI 是否支持 `codex app-server`。
- **模型 API**：打开顶部「工作空间与模型服务」设置，填写服务的 API Key，获取或手填模型 ID，保存后在输入区选择该服务。Codex 未连接不影响 API 任务。

无需连接任何模型服务，也可以浏览本地已有模型。平台不附带模型服务额度；Codex 与各 API 服务使用各自账户的权限、额度和计费规则。

## 工作空间、模型服务与并发

顶部设置可以修改工作空间的本地绝对路径，也可以从历史目录切回之前的工作空间。切换只打开所选目录，**不会迁移或删除旧目录中的项目**。有运行、排队中的任务或模型等待预览校验时，需先完成或停止任务并完成校验，再切换目录。

Codex 与 API 的并发上限分别设置为 **1–8**，默认均为 **1**；四种 API 服务共用 API 并发额度。不同项目可以同时提交任务，超过对应上限后按该类别的先入先出顺序排队，排队任务可以取消。同一项目只能有一项运行或排队中的任务，模型校验完成前也不能继续编辑。服务重启后，未完成的执行和排队任务会按中断恢复；已保存的候选模型仍可继续预览校验，**不会自动重发模型请求造成重复调用**。

API 设置支持 API Key、Base URL、默认模型 ID 和图片输入开关，也可选择默认模型服务。模型列表从配置的服务动态获取，不内置一份固定模型名单；列表不可用时可以手动填写模型 ID。输入区可为本轮选择服务和模型。预置地址为：

| 服务 | 默认 Base URL |
| --- | --- |
| OpenAI | `https://api.openai.com/v1` |
| DeepSeek | `https://api.deepseek.com` |
| Gemini | `https://generativelanguage.googleapis.com/v1beta` |
| Grok（xAI） | `https://api.x.ai/v1` |

自定义地址须使用 HTTPS，本机地址可使用 HTTP；不能包含用户名、密码、查询参数或片段。**获取模型和测试连接都只执行模型列表的 GET 请求，不发起生成任务**。测试通过说明模型列表可访问，不保证所选模型的生成权限、余额、图片能力或建模效果。

请按实际所选模型设置图片输入能力；开启开关不会赋予模型本身不支持的能力。仅文字配置遇到带图任务时会明确拒绝，不能靠丢弃图片继续生成。API Key 留空表示保留已保存值；勾选「清除已保存的密钥」才会删除。

### 可选配置

| 环境变量 | 用途 |
| --- | --- |
| `STUDIO_PORT` | 本地 HTTP 端口，默认 `4174` |
| `STUDIO_DATA_DIR` | 首次初始化的工作空间目录，默认仓库中的 `.studio/projects`；保存过设置后，以设置中的工作空间为准 |
| `STUDIO_SETTINGS_PATH` | 设置文件的本地绝对路径，必须位于工作空间之外 |
| `CODEX_BIN` | CLI 不在 PATH 中时，指定 Codex 可执行文件路径 |

例如 Windows PowerShell：

```powershell
$env:STUDIO_PORT = '4180'
npm start
```

macOS / Linux：

```sh
STUDIO_PORT=4180 npm start
```

服务监听本机回环地址。当前版本不用于直接暴露到公网。

未指定 `STUDIO_SETTINGS_PATH` 时，设置默认保存在仓库的 `.studio/settings.json`；若指定了 `STUDIO_DATA_DIR`，默认设置文件改为该目录绝对路径后追加 `.settings.json`，即 `${root}.settings.json`。更改 `STUDIO_DATA_DIR` 会改变默认设置文件位置；同一设置文件已经保存的工作空间配置优先于初始目录值。

## 架构与工作流程

浏览器工作台负责图片、对话、任务状态和项目操作；独立的 sandbox iframe 负责 Three.js 预览。Node.js 服务管理本地工程与任务队列，按本轮选择使用 Codex 的 `app-server` 或 API 执行器，并使用 HTTP / SSE 将结果和进展送回页面。

```mermaid
flowchart LR
  UI["浏览器工作台"] <-->|HTTP / SSE| Server["本地 Node.js 服务"]
  UI <-->|postMessage| Viewer["sandbox iframe · Three.js 预览"]
  Server <-->|app-server| Codex["本地 Codex CLI"]
  Codex <--> Model["Codex 配置的模型服务"]
  Server <--> API["本地 API 执行器"]
  API <-->|HTTPS| Provider["配置的 API 模型服务"]
  Server <--> Files["本地项目、图片、源码与版本"]
  Codex -->|读取上下文、修改 model.js| Files
  API -->|语法检查、原子保存 model.js| Files
  Server -->|提供模型源码| Viewer
```

1. 选择项目、模型服务与本轮参考图，开始新主体建模，或输入针对当前模型的修改要求。
2. 服务端校验图片与请求，整理 `task-context.json` 并提交队列；局部修改可附带选中部件、视角和当前截图。
3. Codex 读取工程约定、Skill 和任务上下文来修改 `model.js`；API 执行器则将本轮完整上下文、当前源码、工程约定、Skill、模型契约与确切图片一起提交给模型。API 模型没有终端或文件工具，需要返回完整 `model.js` 源码；仅回答问题时可不修改源码。
4. 任务结束后，服务检查源码变化；有新模型时建立待校验版本，并让视口加载预览。
5. 新版本通过预览检查后成为可用版本；校验失败时保留上一有效模型。继续按部件修改，或导出 GLB。

API 返回的源码先通过不执行代码的 JavaScript 语法检查，再原子替换工作文件，之后进入同一套版本与预览校验。截断、格式错误、取消或生成期间文件已被其他操作修改时，不会用该输出覆盖当前源码。

这条流程检查模型能否加载和预览，不会自动判定外观还原程度、工程精度或拓扑质量。项目存储与预览在本机完成，模型调用发往所选服务。

## 创建与继续修改

- 顶部 `＋` 创建独立项目。上传图片会保存到当前项目，不会自动新建项目。
- 项目参考图支持 PNG、JPEG、WebP，单张最多 **12 MiB**；可以多选或拖动多张图片上传。图库最多保存 **128 张**。
- 勾选参考图后点击 **开始建模**，文字可以留空。这会按本次选图重建当前项目主体；旧模型仍可在版本记录中查看。
- 继续对话时，点击「添加图片」、拖入或粘贴会追加到普通附件区；需要区分用途时，手动点击「添加图片组」，再通过组内「＋」或拖入图片，为其命名如“正侧背视图”“杯柄细节”“材质参考”。每轮最多 **8 组**（普通附件区占一组），空组不会发送。
- 每轮项目参考图和补充图片合计最多 **16 张不同图片**；跨组复用同一张图只作为一个图像输入。用于局部修改的当前视口截图另行标记，不算作目标参考图。
- API 模式最多发送 **17 张图片**（16 张用户图片加 1 张视口截图），单张最多 **10 MiB**；包含文字、源码和 base64 图片后的完整请求最多 **18 MiB**。图库上传的 12 MiB 上限不代表图片一定能直接用于 API；超限需压缩或减少输入，不会静默删图。实际模型还可能有更严格的能力和大小限制。
- 发送前确认是否同时带上已选项目参考图。历史消息会保留本轮图片及组别，之后从图库移除图片不会抹去已发送附件。
- 状态面板显示排队、启动、处理、待确认、停止、校验、完成或失败。Codex 需要操作许可时会显示确认入口；停止运行任务会等待执行器确认，排队任务可直接取消。

新主体建模不携带旧模型截图、旧部件选择或属性覆盖。继续对话可以携带当前选中部件、相机、属性和视口截图，方便局部修改。

## 预览、版本与导出

视口支持拖动旋转、滚轮缩放、点击部件、线框、网格和已有动画播放。右上角视角立方体及 XYZ 坐标轴随实际相机转动，点击立方体可见面可切换对应方向；上方同排放置复位与部件面板按钮，也支持键盘操作。模型约定以 **−X 为正面**。

右侧“部件”支持搜索、分组展开和显示/隐藏；“属性”可调整所选部件的颜色、位置和可见性。`Ctrl / Cmd + K` 聚焦部件搜索，`Ctrl / Cmd + Enter` 发送对话。

在“版本”中，**预览此版本**只切换展示，不改变工作版本；**返回当前版本**退出只读预览；**恢复此版本**才会切换当前工作版本。任务运行时允许浏览历史，但禁止恢复或编辑；新模型进入校验时会回到当前版本。加载或校验失败时保留上一份有效模型。

**导出 GLB** 导出当前展示的模型及已有动画；历史预览也可单独导出。导出文件同时保存在该项目的 `exports/` 目录中。

## 本地数据与隐私

项目文件默认保存在 `.studio/projects/<项目 ID>/`：

| 路径 | 内容 |
| --- | --- |
| `work/model.js` | 当前可编辑模型源码 |
| `work/task-context.json` | 本轮要求、图片分组、选择和视角上下文 |
| `work/references/` | 上传的图片和任务使用的视口截图 |
| `work/.agents/skills/model-studio/` | 当前工程使用的建模规范 |
| `versions/` | 模型源码及属性的版本快照 |
| `project.json` | 对话、任务状态、图片索引和版本元数据 |
| `exports/` | 导出的 GLB 文件 |

“保存在本地”指项目文件的存储位置，**不表示 AI 推理离线进行**。Codex 模式将本轮图片、文字、适用的视口截图和工程上下文交给 Codex；它会按自身配置发送请求，任务中读取的源码、工具结果及续接历史也可能参与处理。API 模式由本地服务直接发送完整任务上下文、当前源码、建模规范和本轮图片，适用时包含有限的近期对话。请仅提交有权使用、允许发送给相应服务的内容。

Codex 登录凭据仍由 Codex 管理；API Key 则在设置中输入并保存到本地设置文件，独立于工程目录，不能把设置文件放进工作空间。公开设置接口只返回 `hasApiKey`，不会回显密钥；API 请求由后端携带密钥，不把它写进模型提示词。

设置文件以原子方式保存，Windows 使用当前用户的独占文件 ACL，POSIX 使用 `0600` 权限。**文件权限保护不是加密**，有权限读取该文件的本机程序仍能取得密钥；Windows 无法设置权限时会拒绝写入。损坏的设置文件不会自动重置，以免丢失密钥。

仓库默认忽略项目数据、日志、测试输出、设计过程文件和生成压缩包；提交前仍需检查暂存文件，尤其是自定义位置的设置文件。不要把 `.studio`、设置文件、凭据或带图片的对话记录附到公开 Issue。

备份时复制项目数据目录；关闭任务和服务后再操作。导出的 GLB 不包含完整的源码、对话或版本历史，不能替代工程备份。

## Skill 与模型约定

在顶部打开「造物 SKILL」，点击「复制 Agent 安装指令」，粘贴到本机 Codex、Claude Code 或其他支持 Skills 的 Agent 对话中，由 Agent 下载并安装。指令使用当前服务的实际地址，无需令牌；下载期间保持造物运行，该地址仅在本机可用。也可以点击「下载 ZIP」手动安装，或执行：

```sh
npm run pack:skill
```

输出为 `public-downloads/model-studio-skill.zip`，完整技能目录为 `model-studio/`。个人安装目录默认是 Codex 的 `~/.agents/skills/`、Claude Code 的 `~/.claude/skills/`；已有有效自定义目录时使用其实际配置。安装后，在 Codex 中使用 `$model-studio` 并提供工程目录、图片和要求；其他 Agent 使用各自的技能调用方式。完整步骤见 [INSTALL.md](studio-skill/model-studio/INSTALL.md)。

平台新建的建模工程已自带项目级技能，使用内置 Codex 或 API 模式时无需额外安装；API 模式会把技能内容附入请求。Skill 提供建模与校验规范，执行器负责通信；下载或安装 Skill 不会自动登录、安装或启动 Agent，也不会自动开始建模。

模型入口：

```js
import * as THREE from 'three';

export function createModel() {
  const root = new THREE.Group();
  // 添加具有稳定名称的 Mesh / Group。
  return { root, animations: [] };
}
```

模型代码在独立的 sandbox iframe 内执行，仅使用允许的 `three` / `three/addons/` 依赖。请勿在模型中编写网络请求、文件系统、进程或页面 UI 操作。详细约定见 [model-contract.md](studio-skill/model-studio/references/model-contract.md)。

## 开发与检查

```sh
npm run check
npm test
npm run pack:skill
npm run test:ui
```

- `check`：检查 JavaScript 语法及包元数据一致性。
- `test`：运行所有 `*.test.mjs` 单元测试；使用模拟 Codex 和 API 响应，不调用真实模型，并屏蔽继承的 `STUDIO_TEST_ORIGIN`，以免意外触发在线测试。
- `test:ui`：在 [http://127.0.0.1:4176](http://127.0.0.1:4176) 启动独立内存场景，用模拟任务检查图片组、状态反馈、停止、审批与版本交互。它不修改真实项目、不调用 Codex。
- `smoke:http`：检查已经启动的本地工作台接口，需单独运行服务。

`studio-server/integration-run.mjs` 是真实模型联调脚本，会创建项目并消耗当前 Codex 账户额度，未包含在默认测试与 CI 中。不要在不了解用途时执行。CI 在 Windows、macOS 和 Linux 上运行 Node.js 22 的检查、单元测试和 Skill 打包；浏览器和真实模型联调仍需人工验证。

### 代码结构

| 目录 / 文件 | 职责 |
| --- | --- |
| `studio-web/` | 工作台界面、图片与对话、任务状态、版本和属性面板 |
| `studio-viewer/` | Three.js 渲染、选择、视角控件、模型校验和 GLB 导出 |
| `studio-server/server.mjs` | 本地 HTTP / SSE 接口及任务协调 |
| `studio-server/codex-bridge.mjs` | Codex app-server 的进程与协议通信 |
| `studio-server/api-provider.mjs` | API 模型列表、连接测试、多模态生成与源码校验保存 |
| `studio-server/settings-store.mjs` | 工作空间、服务配置与密钥的本地存储和脱敏读取 |
| `studio-server/task-scheduler.mjs` | 同项目排他、Codex / API 并发限制与任务排队 |
| `studio-server/project-store.mjs` | 项目、图片、对话、版本和属性持久化 |
| `studio-server/task-contract.mjs` | 输入校验、图片组映射和模型任务上下文 |
| `studio-skill/model-studio/` | 可分发的 Skill 源码 |
| `scripts/` | 跨平台检查、测试入口和 ZIP 打包 |
| `model.js` | 程序化客机示例源码，不包含原始私人参考图 |

## 当前边界

更适合从可描述的部件、尺寸和重复结构入手，例如器物、规则物体、建筑体块与参数化形状。参考图片未显示的结构需要近似处理；这里没有从单张照片恢复真实完整几何的保证。

每个项目以单个 `model.js` 为入口，同一项目一次处理一项任务；多个项目可在设定的 Codex / API 并发上限内运行。API 接入不保证所有模型都支持图片或所需的结构化输出，自定义地址也必须兼容所选服务的接口。尚未提供账号系统、多人协作、计费、公共托管、专用图片转 3D 推理服务、自动绑骨或完整 DCC 编辑能力。高面数不等于高质量，人物比例、衣物结构、贴图和拓扑仍需要专门的资产流程。

写实人物与复杂有机模型通常需要额外的建模、重拓扑、UV、材质、绑定和资产验证工作。造物不承诺直接产出生产级拓扑，也不承诺替代 Tripo、Meshy、Rodin 或专业 DCC 工具。

浏览器隔离、输入校验和本地监听降低误操作范围，但不构成对任意恶意模型代码的安全承诺。运行来源未知的项目之前，应先审查源码和 Agent 权限。安全问题见 [SECURITY.md](SECURITY.md)，贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可

本项目源码采用 [MIT License](LICENSE)。第三方依赖各自遵循其许可证；参考图片、用户输入和生成资产的权利不因本仓库许可证而自动改变。本项目不是 OpenAI、Three.js、Tripo、Meshy 或 Rodin 的官方产品。
