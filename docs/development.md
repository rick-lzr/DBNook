# Development

## 环境与构建

需要 Node.js 22.16+，推荐固定版本 22.22.2。SQLite 依赖内置 node:sqlite，不能用旧 Node.js 加装 sqlite3 命令替代。

```sh
npm ci
npm run check
npm run package
```

check 运行类型检查、单元测试和构建；pretest 先生成 SQLite runner。npm run notices 更新第三方声明。dist/、artifacts/ 不提交 Git。

构建后 F5 启动扩展开发窗口。npm run preview 启动回环地址上的真实示例数据库页面，只用于开发。

## 架构

| 路径 | 用途 |
| --- | --- |
| packages/extension | VS Code 命令、树、编辑器、存储、日志 |
| packages/webview | React 界面、表格、操作预览 |
| packages/core | 连接、事务、数据流转、DDL、历史 |
| packages/drivers | 四库适配 |
| packages/runner | 独立 SQLite 进程 |
| packages/protocol | 消息类型与输入校验 |
| packages/dev-server | 仅开发环境的本地页面服务 |

## 测试

- npm test：无需生产数据库的单元测试，包含本地 SQLite 和临时 SSH fixture。
- npm run test:postgres / test:mysql / test:mariadb：需要 Docker Linux 引擎和拉取镜像权限；创建只绑定回环端口的临时 TLS 服务，完成后清理本次容器。
- npm run test:structure-matrix：三种服务器的结构契约测试，需要 Docker。
- npm run test:extension：设置 VSCODE_EXECUTABLE，或 VSCODE_TEST_VERSION=1.95.3 下载官方测试宿主；会启动隔离窗口并占用焦点。真实服务端额外需要相应测试环境。一次 SQLite 运行不能证明四库 UI 通过。

Windows 默认使用 Docker Desktop Linux pipe，DBW_DOCKER 可指定 CLI。原生备份还需服务端工具。键盘/Webview、Reload Window 和平台验收不能用单元测试替代。

## 离线包

Windows x64 执行 npm run package:offline。脚本从官方 HTTPS 下载固定 Node.js ZIP 并检查代码内固定 SHA-256；缓存包也会重新检查。每次从已校验 ZIP 解压，避免信任手工更改的解压目录。

无网构建可预先放入 .cache/node-distributions/22.22.2/node-v22.22.2-win-x64.zip。更新运行时需要独立兼容测试。

## 仓库边界

.gitignore 使用显式清单；新增文档或脚本须更新清单。第三方 VSIX、解包资料、个人配置、数据库和缓存留在本地。npm run audit:public 检查 Git 实际拟公开的文件集合。发布步骤见 [publishing.md](publishing.md)。
