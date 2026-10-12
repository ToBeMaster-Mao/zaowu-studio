# 造物 Studio 建模实践

上传参考图，在同一个工作台生成、查看和修改可编辑的 Three.js 模型。本次分享介绍造物如何连接本地 Codex CLI，也说明如何安装造物 SKILL，在 Codex 或其他支持 Skills 的 Agent 中建模。

![造物 Studio 建模实践概念封面](assets/cover-generated.png)

正文以 **HTML** 保存：[查看文章源文件](index.html)。文章包含茶壶、广州塔的实际模型截图，SKILL 安装入口、两种使用方式、实现原理、内部任务与版本工作流、启动步骤及固定提交的源码依据。

封面为内置生图工具生成的概念图；正文效果图来自实际工作台。模型面数不代表质量评分，几何与预览检查也不代表建模质量验证。

- [团队仓库](http://192.168.17.55:3001/3k-development/zaowu-studio)：需要内网与团队访问权限。
- [GitHub](https://github.com/ToBeMaster-Mao/zaowu-studio)：MIT 开源仓库，可公开访问。
- 实现证据基线：`1db5ff49c1946a65b05d145e4741acb753461933`。

## 发布材料

- 正文：`index.html`
- 封面：`assets/cover-generated.png`
- 效果图：`assets/teapot-cover.jpg`、`assets/teapot-workspace.jpg`、`assets/canton-tower.jpg`
- 安装窗口：`assets/skill-install.jpg`
- 标题、摘要与发布信息：`package-metadata.txt`

仓库页面显示 HTML 源码时，可下载本目录后用浏览器打开 `index.html`。

在仓库根目录运行 `node scripts/pack-share.mjs`，生成 `exports/zaowu-studio-share.html`。这个单文件包含全部图片，可直接提交群智，不依赖同目录图片或外部脚本。群智发布工具对 HTML 的大小限制为 10 MiB，打包时会检查。

封面提示词与生成方式记录于 [cover-prompt.txt](cover-prompt.txt)。
