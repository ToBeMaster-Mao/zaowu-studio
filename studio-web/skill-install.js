const defaultSkillUrl = '/downloads/model-studio-skill.zip';

export function createSkillInstallGuide({ origin, skillUrl = defaultSkillUrl }) {
  const base = new URL(origin);
  const download = new URL(skillUrl, base);
  if (!['http:', 'https:'].includes(base.protocol) || download.origin !== base.origin ||
      download.username || download.password || download.search || download.hash) {
    throw new Error('Skill 下载地址无效，请刷新造物后重试。');
  }

  return {
    url: download.href,
    instructions: `请帮我安装「造物 SKILL」，用于根据参考图片和文字要求创建、修改与校验 Three.js 模型。适用于 Codex、Claude Code 或其他支持 Skills 的 Agent。

下载地址：${download.href}
技能目录名：model-studio

这是造物在本机提供的下载地址，无需请求头或访问令牌。请在运行造物的同一台电脑上下载，并保持造物服务运行；云端 Agent 或其他电脑不能通过这个本机地址下载。如果无法连接，请明确告诉我原因，不要改用其他下载来源。

安装要求：
1. 识别当前 Agent、操作系统及它实际读取的 Skills 目录。默认安装为当前用户可复用的个人技能：Codex 使用 ~/.agents/skills，Claude Code 使用 ~/.claude/skills；Windows 的 ~ 表示当前用户主目录。其他 Agent 请依据其实际配置或官方说明确定目录，不要猜测。若当前 Agent 已配置了有效的自定义或兼容目录，优先使用该有效目录；不要在多个目录重复安装。
2. 将 ZIP 下载到临时目录，检查它包含 model-studio/SKILL.md，确认没有越界路径后再解压。安装整个 model-studio 文件夹，包括 references 和 agents 等支持文件，不要只复制 SKILL.md。
3. 若目标目录已有 model-studio，先比较文件内容；完全相同则保留。内容不同时先把旧版备份到 Skills 扫描目录之外，再更新，保留用户可恢复的备份。
4. 安装后检查实际目标路径下的 model-studio/SKILL.md 及支持文件，并告诉我最终安装路径和结果。确认当前 Agent 是否已识别；只有尚未识别时，再提醒我刷新技能或新开会话，必要时重启 Agent。
5. 这次只安装技能，不安装或启动 CLI、不更改登录和模型配置、不修改任何建模项目，也不自动开始建模。

安装完成后，我可以在 Codex 中使用 $model-studio，并提供造物工程目录、参考图片和建模要求；其他 Agent 使用它们自己的技能调用方式。`,
  };
}
