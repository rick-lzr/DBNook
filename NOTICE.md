# Source and third-party notices

DBNook 项目代码按 GPL-3.0-only 发布，完整许可证见 LICENSE.txt。第三方组件继续适用其自身许可证。

- 界面使用 AG Grid Community；生产 JavaScript 依赖声明由 scripts/generate-notices.mjs 从 lockfile 与已安装依赖生成，见 THIRD_PARTY_NOTICES.txt。
- Windows x64 离线包包含 Node.js 运行时；其 LICENSE.txt、下载地址、版本及 SHA-256 随包放在 runtime/win32-x64 中，源码仓库不提交该二进制。
- 工作目录中的第三方原始 VSIX、解包分析资料、历史测试证据、数据库和缓存不属于公开仓库，也不由本项目许可证重新授权，不得加入分发包。
- 新增内容需要保留来源和许可证；对来源不明确的内容先完成权利核对，再公开分发。

源码发布须与安装包的版本/提交对应，并包含 lockfile、构建脚本和声明。
