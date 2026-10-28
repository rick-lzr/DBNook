# DBNook

**你的 VS Code 数据库工作台。** 连接 SQLite、PostgreSQL、MySQL 和 MariaDB，在编辑器里浏览表、运行 SQL、编辑数据和管理结构。

[English](README.en.md) · [使用说明](docs/extension-readme.md) · [开发指南](docs/development.md) · [开发路线](docs/roadmap.md)

DBNook 正在准备首个公开预览版本，目前尚未发布到 Marketplace。完整的四库日用验收尚未关闭，已知限制见下文。

## 能做什么

| 工作 | 当前能力 |
| --- | --- |
| 连接管理 | 连接测试、分组、颜色、收藏、复制、导入导出、默认连接；TLS、SSH 隧道、共享数据库凭据配置 |
| 数据浏览 | 数据库/Schema/表/视图导航，字段、主键、索引、外键；分页、服务端 WHERE、行检查器 |
| 数据编辑 | 暂存新增/修改/删除，撤销重做，显式保存，原始行冲突检查；只读连接和生成字段保护 |
| 复制粘贴 | 单元格及选中行复制、粘贴前后预览、一次性暂存；区分 NULL、空字符串、大整数和二进制 |
| SQL | 执行选择/全文/当前语句、多结果、文档独立事务、基础表名字段补全、格式化、可选本地历史 |
| 表结构 | 查看与编辑受支持对象的 DDL；预览后执行，字段重命名映射、普通表结构比较与同步草稿 |
| 数据流转 | CSV/JSON 导入预览与字段映射、数据导出、受支持的备份恢复和比较流程；边界见使用说明 |
| 排错 | Output 日志、本地诊断报告、Webview 启动故障和 SQLite 运行时检查 |

不需要注册产品账号。Authentication Profiles 用于数据库认证，不是产品账号。

## 数据库与兼容性

| 数据库 | 当前测试基线 | 注意事项 |
| --- | --- | --- |
| SQLite | 文件/内存数据库；离线运行时 SQLite 3.51.2 | 依赖 Node.js 22.16+ 的 node:sqlite API，不是系统 sqlite3 命令 |
| PostgreSQL | 17.11 | 独立驱动；视图只读；取消查询会关闭对应文档会话 |
| MySQL | 8.4.11 | 独立驱动；InnoDB 可暂存编辑，非事务引擎和视图只读 |
| MariaDB | 11.4.13 | 单独适配并经过真实服务验证；不能以 MySQL 模式替代 |

当前验证重点是 **Windows x64 桌面版 VS Code**，最低声明版本 1.95.0；此前回归使用 1.95.3 和 1.143.0-insider。macOS、Linux、ARM、WSL/Remote SSH 尚未完成发布验收。网页版 VS Code 不支持。

## 安装与开始

公开预览包发布后，从仓库 Releases 获取 VSIX，在 VS Code 中运行 **Extensions: Install from VSIX**。

- **Windows x64 离线包**：包含固定版本 Node.js SQLite 运行时；安装后打开 SQLite 不需要联网下载驱动。
- **普通包**：不携带运行时。VS Code 自带 Node.js 必须具有所需 API，或在 `dbWorkbench.nodePath` 设置兼容 Node.js 可执行文件的绝对路径。仅安装系统 sqlite3 无法解决运行时不兼容。

1. 打开左侧 **DBNook → Connections → Add Connection**。
2. 选择数据库类型、填写参数，依次 **Test → Save**。SQLite 可以选择文件或内存数据库。
3. 展开连接并打开表；双击单元格编辑，使用 **Save / Ctrl+S** 提交。
4. 从连接打开 **New SQL Query**。Ctrl+Enter 执行选择内容或全文；当前语句可从命令面板执行。
5. 也可以选择 **Explore With a Sample Database**，在独立示例 SQLite 数据库中试用。

编辑、撤销和粘贴首先改变草稿，**保存才写入数据库**。SQL 文件保存与 SQL 执行是两个独立动作；DDL 和分析操作需阅读执行预览。

## 数据与凭据

密码可以只留在本次扩展会话，或交由 VS Code SecretStorage 保存；连接导出不包含密码。连接元数据使用用户或工作区设置，可能包含主机名和文件路径。

查询历史默认关闭，启用后会在扩展宿主本地保存 SQL；SQL 可能含敏感字面量。诊断报告在本地生成，分享前请检查路径和错误文本。[存储与网络说明](docs/privacy.md)

## 当前限制

- 四库固定日用验收还有 6 项未关闭：日期与时区边界、真实补全/格式化交互、复制粘贴、编辑中保存、连续撤销重做、Reload Window 恢复。[验收计划](docs/roadmap.md)
- Quick Search、列过滤和排序只作用于已加载行，WHERE 在服务端执行；不同导出入口的范围不同，导出前检查预览。
- MySQL/MariaDB DDL 可能隐式提交，失败后需检查已完成步骤。查询取消不保证保留当前会话。
- 复杂 DDL、跨库类型转换、完整备份/比较及语言服务仍在完善，不宣称覆盖所有数据库版本。

## 从源码开发

需要 Node.js 22.16+ 和 npm，建议使用固定版本 22.22.2。

```sh
npm ci
npm run check
npm run package
```

构建后按 F5 启动扩展开发窗口。`npm run preview` 在回环地址启动连接真实示例数据库的开发页面。打离线包需在 Windows x64 执行 `npm run package:offline`；首次准备运行时需要联网，后续使用已校验缓存。

架构为 TypeScript 扩展宿主 + React Webview + AG Grid Community，SQLite 使用独立 Node.js runner；PostgreSQL 使用 pg，MySQL/MariaDB 使用 mysql2 并有各自的行为适配。[贡献指南](CONTRIBUTING.md)

## 许可证

项目原创代码采用 **GPL-3.0-only**，见 [LICENSE.txt](LICENSE.txt)。第三方依赖保留原许可证与声明，见 [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt) 和 [NOTICE.md](NOTICE.md)。发布二进制时应同时提供相应版本源码与构建说明。
