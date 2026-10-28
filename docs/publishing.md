# 开源与 Marketplace 发布

源码仓库：https://github.com/rick-lzr/DBNook 。公开作者和 Marketplace Publisher ID 均为 rick-lzr，扩展标识为 rick-lzr.dbnook。0.28.0 通过 GitHub Releases 作为 Preview 分发，尚未发布 Marketplace。当前名称 DBNook：检索未发现同名 Marketplace 扩展，不代表商标审查结论。

## 当前发布身份

1. GitHub 仓库：rick-lzr/DBNook；公开作者：rick-lzr。
2. Marketplace Publisher ID：rick-lzr，由维护者在 Marketplace 管理后台创建。Marketplace 登录独立于 GitHub 登录。
3. 首个公开版本号：0.28.0；新名称/Publisher 改变扩展 ID，不能把旧私有版直接当同一身份。
4. 安全报告渠道推荐启用 GitHub Private vulnerability reporting，启用状态以仓库设置为准。

许可证已选 GPL-3.0-only。**不要发送密码、验证码、PAT 或私钥到聊天。** GitHub 在本机用浏览器、Desktop、CLI 或 SSH 授权；Marketplace 首次可自行登录网页上传最终 VSIX，无需交出发布令牌。

## 配置

```sh
node scripts/configure-publication.mjs --repository https://github.com/rick-lzr/DBNook --publisher rick-lzr --author rick-lzr --version 0.28.0
npm run release:check
```

脚本更新 package.json 和 lockfile，不登录、不推送、不发布。private: true 只防止误发 npm；Preview 是独立标记。身份缺失时普通本地包可用于测试，正式 release:check 会失败。

## 发布前

```sh
npm ci
npm run check
npm run audit:public
npm run release:check
npm run package
npm run package:offline
```

检查 Git 清单、许可证、README 链接、图标、包内文件和 SHA-256。针对新身份/版本跑真实回归，不复用旧私有包报告。未关闭的日用验收项写入 Release Notes。

CI 只检查；build-vsix 工作流仅手动构建并上传工作流产物，不发布市场或创建 GitHub Release。公开安装包同时提供对应标签/提交的完整源码、lockfile、构建说明和许可证。源码不提交 Node.js 二进制，固定地址/校验与许可随脚本和包提供。

## 首次上架

用 Microsoft 账号登录发布者管理页，创建/选择 Publisher，核对最终 publisher.dbnook，上传 VSIX 后核对 Preview、README、分类和图标再发布。优先发布已验证的 Windows x64 离线包；普通包可构建不等于其他平台已验收。

旧 local-db-workbench.db-workbench 与新 ID 的 SecretStorage、全局存储互相隔离。切换前导出连接元数据，新安装中导入并重新配置密码、SSH、Authentication Profiles；不能保证未保存草稿跨 ID 恢复。不要先卸载旧扩展或删除存储。

自动发布以后单独配置。官方文档提示全局 Azure DevOps PAT 于 2026-12-01 退役；长期方案应按最新文档选择 Microsoft Entra/工作负载联合身份，不把 token 写入仓库。

官方参考：[发布扩展](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)、[扩展清单](https://code.visualstudio.com/api/references/extension-manifest)、[GitHub 认证](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-authentication-to-github)。
