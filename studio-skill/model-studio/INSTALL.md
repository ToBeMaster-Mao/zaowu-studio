# 安装 Model Studio 技能

下载的压缩包包含 `model-studio/` 文件夹。将这个完整文件夹放入 Codex 的 `skills` 目录；设置了 `CODEX_HOME` 时使用其下的 `skills`，否则使用用户目录下的 `.codex/skills`。若同名技能已经存在，先查看和备份原版本，再决定是否替换。

Windows PowerShell：在下载文件夹内运行下面的命令。它发现已有同名目录时会停止，不会覆盖现有技能。

```powershell
$studioSkillBase = if ($env:CODEX_HOME) {
  Join-Path $env:CODEX_HOME 'skills'
} else {
  Join-Path $env:USERPROFILE '.codex/skills'
}
$studioSkillTarget = Join-Path $studioSkillBase 'model-studio'
if (Test-Path -LiteralPath $studioSkillTarget) {
  throw "已有技能：$studioSkillTarget。请先查看并备份，再决定是否替换。"
}
New-Item -ItemType Directory -Path $studioSkillBase -Force | Out-Null
Expand-Archive -LiteralPath './model-studio-skill.zip' -DestinationPath $studioSkillBase
```

重新启动本地 Codex 会话后，可以在指定项目目录中使用：

```text
使用 $model-studio，读取当前工程的 task-context.json，按本次要求修改 model.js。
```

也可以直接说明工程路径、参考图片和修改要求。没有平台任务文件时，该技能仍可辅助编辑现有 Three.js 工程。

## 与平台连接

技能是给 Agent 的工作说明，不是连接器，不会自行启动任务、下载模型或建立网站与电脑之间的连接。

要让平台发送建模任务并显示结果，还需要运行平台提供的本地连接程序，并在平台中连接到该程序。连接程序负责调用本地 Codex、传递项目路径和任务上下文、检测源码变化；平台负责模型预览与版本记录。具体启动命令以当前平台版本提供的说明为准。

无需将本地登录凭据粘贴到网页。使用 OpenAI 模型时仍需相应登录方式和网络连接；安装技能本身不附带模型服务或额度。
