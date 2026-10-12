# Zaowu Studio · 造物 Studio

[简体中文](README.md) · [English](README.en.md)

**An MIT-licensed local workspace for Three.js modeling.** Let Codex write model code from reference images and text, then preview it in the browser, refine individual parts, browse versions, and export GLB. The construction logic stays in a readable, editable `model.js` file.

[Source on GitHub](https://github.com/ToBeMaster-Mao/zaowu-studio) · [MIT License](LICENSE) · [Illustrated walkthrough and model screenshots, in Chinese](docs/share/README.md) · [Sharing assets, in Chinese](docs/share/package-metadata.txt)

**Status: v0.1.0, experimental local application.** Zaowu connects to your configured model service through the local Codex CLI and asks the Agent to write Three.js geometry code. It does not include dedicated image-to-3D model weights. It is suited to experiments with everyday objects, regular shapes, architectural massing, and parametric models. Realistic people, complex organic forms, production-ready topology, and photorealistic reconstruction remain limitations. It does not promise to replace dedicated services such as Tripo, Meshy, or Rodin.

## Why model with code?

Shapes that can be described as parts, dimensions, curves, or repeated structures can be expressed in code and adjusted through further instructions. Zaowu brings that process into a workspace with previews and recoverable versions:

- **Editable source:** the Agent changes `model.js`; you can also read and edit its construction logic directly.
- **Context for revisions:** a conversation can include the selected part, camera view, viewport screenshot, and named groups of reference images to describe a local change.
- **Inspection and recovery:** inspect parts, adjust basic properties, and preview historical versions. A new version updates the current model after passing preview validation.
- **Export and reuse:** export the current or a historical version as GLB, while keeping the source and project data for further revisions.

Procedural code gives you a way to edit a model; it does not automatically provide correct proportions, realistic materials, or a production-ready asset. Project files are stored locally, while AI inference uses the service configured for Codex. See [Local data and privacy](#local-data-and-privacy).

## Screenshots from the workspace

These images show actual model previews in the workspace. They illustrate the interface and example results, not a guarantee for arbitrary inputs. Polygon counts shown in the screenshots are not quality scores.

**Teapot: model preview and part inspection**

![Teapot model and part list in Zaowu Studio](docs/share/assets/teapot-workspace.jpg)

**Canton Tower: an architectural structure example**

![Canton Tower model preview in Zaowu Studio](docs/share/assets/canton-tower.jpg)

## Quick start

You need Node.js **22 or later**, a modern browser with WebGL support, and an installed, authenticated Codex CLI. The same npm commands work on Windows, macOS, and Linux.

1. Install the CLI using the [official Codex CLI instructions](https://learn.chatgpt.com/docs/codex/cli), then run `codex login` in a terminal. Codex manages authentication; see the [official authentication documentation](https://learn.chatgpt.com/docs/auth).
2. Download the [repository source](https://github.com/ToBeMaster-Mao/zaowu-studio), or clone it and enter the directory:

```sh
git clone https://github.com/ToBeMaster-Mao/zaowu-studio.git
cd zaowu-studio
```

3. Run:

```sh
npm ci
npm start
```

Open [http://127.0.0.1:4174](http://127.0.0.1:4174). `npm start` first builds the downloadable Skill ZIP from source, then starts the local service. On Windows, after installing dependencies, you can also double-click `START-STUDIO.cmd`.

You can browse local models without connecting Codex. AI modeling requires a successful connection. The workspace uses your existing Codex authentication and applicable usage allowance; no model-service credits are included. Codex's `app-server` protocol is still evolving. If the connection fails, first check that your CLI supports `codex app-server`.

### Optional configuration

| Environment variable | Purpose |
| --- | --- |
| `STUDIO_PORT` | Local HTTP port; defaults to `4174` |
| `STUDIO_DATA_DIR` | Project data root; defaults to `.studio/projects` in this repository. An absolute path is recommended. |
| `CODEX_BIN` | Path to the Codex executable when it is not available on PATH |

For example, in Windows PowerShell:

```powershell
$env:STUDIO_PORT = '4180'
npm start
```

On macOS / Linux:

```sh
STUDIO_PORT=4180 npm start
```

The service listens on the local loopback address. This version is not intended to be exposed directly to the public internet.

## Architecture and workflow

The browser workspace handles images, conversations, task status, and project actions. A separate sandbox iframe runs the Three.js preview. The Node.js service manages local projects, communicates with the Agent through Codex's `app-server`, and sends results and progress to the page over HTTP / SSE.

```mermaid
flowchart LR
  UI["Browser workspace"] <-->|HTTP / SSE| Server["Local Node.js service"]
  UI <-->|postMessage| Viewer["Sandbox iframe · Three.js preview"]
  Server <-->|app-server| Codex["Local Codex CLI"]
  Codex <--> Model["User-configured model service"]
  Server <--> Files["Local projects, images, source and versions"]
  Codex -->|Read context and edit model.js| Files
  Server -->|Serve model source| Viewer
```

1. Select a project and the images for this task. Start modeling a new subject, or describe a change to the current model.
2. The server validates the request and image references, then prepares `task-context.json`. Local edits can include the selected part, camera, and current screenshot.
3. Codex reads the project instructions, Skill, and task context, then edits `model.js`. The workspace displays progress and any operations that need approval.
4. When the task ends, the service checks for source changes. If there is a new model, it creates a pending version and loads it in the viewport for validation.
5. A version that passes preview validation becomes available; a failed version leaves the previous valid model intact. Continue editing parts or export GLB.

This workflow checks whether a model can load and preview. It does not automatically assess visual similarity, engineering accuracy, or topology quality. Project storage and preview run locally; Codex model calls follow its configuration.

## Create a model and continue editing

The current workspace interface uses Chinese labels; key labels are included below to help you find the controls.

- Use the top `＋` button to create an independent project. Uploading images saves them to the current project; it does not create another project.
- Project references support PNG, JPEG, and WebP, up to **12 MiB per image**. Select or drag in multiple images. The project library holds up to **128 images**.
- Select reference images and click **开始建模** (Start modeling). Text is optional. This rebuilds the project's subject from the selected images; previous models remain accessible in the version history.
- In a conversation, **添加图片** (Add images), drag-and-drop, or paste appends images to the ordinary attachment area. To separate purposes, explicitly choose **添加图片组** (Add image group), then use its `＋` button or drop images into it. Name groups by purpose, such as “front, side, and back views,” “handle details,” or “materials.” A task allows up to **8 groups**, including the ordinary attachment area. Empty groups are not sent.
- A task can include up to **16 distinct images** across project references and conversation attachments. An image reused across groups is passed to the model only once. The current viewport screenshot for a local edit is identified separately and is not a target reference image.
- Before sending, check whether the selected project references should be included. Historical messages retain their images and grouping; removing an image from the library does not erase a sent attachment.
- The status panel shows startup, processing, approval, stopping, validation, completion, or failure. Operations requiring approval appear in the interface. Stopping a task waits for confirmation from the Agent.

Modeling a new subject does not include the old viewport screenshot, selected part, or property overrides. A continuing conversation can include the current part selection, camera, properties, and viewport screenshot to support local edits.

## Preview, versions, and export

The viewport supports drag-to-orbit, scroll-to-zoom, part selection, wireframe, a grid, and playback of existing animations. The view cube and XYZ axes at the upper right follow the actual camera; click a visible cube face to switch direction. Reset-view and part-panel controls sit on the same upper row, with keyboard support. The model convention uses **−X as the front direction**.

The **部件** (Parts) tab supports search, group expansion, and visibility toggles. **属性** (Properties) lets you change the selected part's color, position, and visibility. `Ctrl / Cmd + K` focuses part search; `Ctrl / Cmd + Enter` sends the conversation input.

In **版本** (Versions), **预览此版本** (Preview this version) changes only what is displayed, not the working version. **返回当前版本** (Return to current version) leaves the read-only preview. Only **恢复此版本** (Restore this version) changes the current working version. You can browse history while a task runs, but restoring or editing is blocked. When a new model enters validation, the workspace returns to the current version. Loading or validation failures preserve the previous valid model.

**导出 GLB** (Export GLB) exports the displayed model and its existing animations. Historical previews can also be exported independently. Exported files are also saved in the project's `exports/` directory.

## Local data and privacy


Project files are stored by default in `.studio/projects/<project-id>/`:

| Path | Contents |
| --- | --- |
| `work/model.js` | Current editable model source |
| `work/task-context.json` | This task's request, image groups, selection, and camera context |
| `work/references/` | Uploaded images and viewport screenshots used by tasks |
| `work/.agents/skills/model-studio/` | Modeling instructions used by this project |
| `versions/` | Version snapshots of model source and property overrides |
| `project.json` | Conversations, task state, image indexes, and version metadata |
| `exports/` | Exported GLB files |

“Stored locally” describes where project files live; **it does not mean AI inference runs offline**. Starting a task gives Codex the selected images, text, applicable viewport screenshot, and project context. Codex sends requests according to your model and service configuration. Source files and tool results read during the task, and history from a continued conversation, may also be processed. Submit only content you have the right to use and permission to send to the configured service.

Codex manages login credentials itself. The workspace does not ask you to paste account tokens into the page. The repository ignores project data, logs, test output, design-process files, and generated ZIPs by default; still inspect staged files before committing. Do not attach `.studio`, credentials, or conversations containing images to public issues.

To back up a project, copy its data directory after stopping tasks and the service. A GLB export does not contain the complete source, conversation, or version history and is not a substitute for a project backup.

## Skill and model contract

Open **造物 SKILL** in the top bar and choose **复制 Agent 安装指令** (Copy Agent installation instructions). Paste the instructions into a local Codex, Claude Code, or other Skill-capable Agent conversation so the Agent can download and install the Skill. The instructions use the running service's actual address without requiring a token. Keep Zaowu running during the download; the address is accessible only on the same computer. You can also choose **下载 ZIP** (Download ZIP) for manual installation, or run:

```sh
npm run pack:skill
```

The output is `public-downloads/model-studio-skill.zip`, containing the complete `model-studio/` Skill directory. Default personal installation directories are `~/.agents/skills/` for Codex and `~/.claude/skills/` for Claude Code; use an existing valid custom directory if configured. After installation, invoke `$model-studio` in Codex and provide the project directory, images, and requirements. Other Agents use their own Skill invocation method. See [INSTALL.md, in Chinese](studio-skill/model-studio/INSTALL.md) for the full steps.

Projects created by the workspace already contain a project-level Skill, so no additional installation is needed for the built-in Codex connection. The Skill supplies modeling and validation instructions; the local bridge handles communication. Downloading or installing the Skill does not log in, install or start an Agent, or start modeling automatically.

Model entry point:

```js
import * as THREE from 'three';

export function createModel() {
  const root = new THREE.Group();
  // Add Mesh / Group objects with stable names.
  return { root, animations: [] };
}
```

Model code runs in a separate sandbox iframe and uses only permitted `three` / `three/addons/` imports. Do not put network requests, filesystem access, process operations, or page UI code in a model. See the [model contract, in Chinese](studio-skill/model-studio/references/model-contract.md).

## Development and checks

```sh
npm run check
npm test
npm run pack:skill
npm run test:ui
```

- `check`: checks JavaScript syntax and package-metadata consistency.
- `test`: runs all `*.test.mjs` unit tests. It does not connect to a real Codex session and removes inherited `STUDIO_TEST_ORIGIN` to avoid accidentally enabling live tests.
- `test:ui`: starts an independent in-memory fixture at [http://127.0.0.1:4176](http://127.0.0.1:4176). Simulated tasks exercise image groups, status feedback, stopping, approvals, and versions. It neither changes real projects nor calls Codex.
- `smoke:http`: checks the APIs of an already running local workspace; start the service separately, then run `npm run smoke:http`.

`studio-server/integration-run.mjs` is a live model-integration script. It creates projects and consumes the current Codex account's usage allowance. It is excluded from the default tests and CI; understand its purpose before running it. CI runs checks, unit tests, and Skill packaging with Node.js 22 on Windows, macOS, and Linux. Browser behavior and live model integration still require manual verification.

### Repository layout

| Directory / file | Responsibility |
| --- | --- |
| `studio-web/` | Workspace interface, images, conversation, task status, versions, and properties |
| `studio-viewer/` | Three.js rendering, selection, camera controls, model validation, and GLB export |
| `studio-server/server.mjs` | Local HTTP / SSE APIs and task coordination |
| `studio-server/codex-bridge.mjs` | Codex app-server process and protocol communication |
| `studio-server/project-store.mjs` | Persistence for projects, images, conversations, versions, and overrides |
| `studio-server/task-contract.mjs` | Input validation, image-group mapping, and model-task context |
| `studio-skill/model-studio/` | Distributable Skill source |
| `scripts/` | Cross-platform checks, test entry point, and ZIP packaging |
| `model.js` | Procedural airliner example source; original private reference images are not included |

## Current limitations

Start with shapes that can be described through parts, dimensions, and repeated structures: everyday objects, regular shapes, architectural massing, and parametric forms. Structures hidden in a reference image require approximation. There is no guarantee of recovering complete, accurate geometry from a single photograph.

Only one modeling task runs at a time, and each project uses a single `model.js` entry point. This version does not provide accounts, multi-user collaboration, billing, public hosting, dedicated image-to-3D inference, automatic rigging, or a complete digital content creation (DCC) editor. A high polygon count does not imply high quality. Human proportions, clothing, textures, and topology still need a dedicated asset workflow.

Realistic people and complex organic models usually require additional modeling, retopology, UV work, materials, rigging, and asset validation. Zaowu does not promise production-ready topology or a replacement for Tripo, Meshy, Rodin, or professional DCC tools.

Browser isolation, input validation, and loopback binding limit the scope of accidental operations; they are not a security guarantee against arbitrary malicious model code. Review the source and Agent permissions before running an unfamiliar project. See [SECURITY.md](SECURITY.md) for security reporting and [CONTRIBUTING.md](CONTRIBUTING.md) for contributions.

## License

The project source is available under the [MIT License](LICENSE). Third-party dependencies retain their own licenses. The repository license does not automatically change rights to reference images, user inputs, or generated assets. This is not an official product of OpenAI, Three.js, Tripo, Meshy, or Rodin.
