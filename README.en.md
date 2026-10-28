# DBNook

**A database workbench inside VS Code.** Connect to SQLite, PostgreSQL, MySQL and MariaDB, browse tables, run SQL and stage data changes before saving.

[中文](README.md) · [User guide](docs/extension-readme.md) · [Development](docs/development.md) · [Roadmap](docs/roadmap.md)

The first public release is **0.28.0 Preview**, distributed through [GitHub Releases](https://github.com/rick-lzr/DBNook/releases/tag/v0.28.0). It is not yet on Marketplace. The full four-database daily acceptance suite still has six open cases.

## Features

- Connection testing, groups, colors, favorites, import/export, TLS, SSH tunnels and reusable database credentials.
- Schema explorer, paged grids, server-side WHERE and a row inspector.
- Staged insert/update/delete, Undo/Redo, explicit Save and original-row conflict detection.
- Exact-value clipboard copy and paste preview, including NULL, empty text, integers and binary values.
- SQL selection/script/current-statement execution, independent document transactions, basic completion, formatting and opt-in local query history.
- Supported object DDL editing with review before execution, table structure comparison, import/export and supported backup workflows.
- Local logs and diagnostic reports. No product account is required.

## Compatibility and installation

The tested platform is Windows x64 desktop VS Code, with a declared minimum of 1.95.0. Previous native regression used 1.95.3 and 1.143.0-insider. Server baselines are PostgreSQL 17.11, MySQL 8.4.11 and MariaDB 11.4.13. MariaDB has its own adapter. Other platforms and server versions are not yet release-qualified; VS Code for the Web is unsupported.

Download a VSIX from this repository's Releases and run **Extensions: Install from VSIX**. The extension ID is `rick-lzr.dbnook`, maintained by `rick-lzr`. The Windows x64 offline package includes Node.js 22.22.2 with SQLite 3.51.2. The generic package needs compatible Node.js 22.16+ SQLite APIs in VS Code or an absolute `dbWorkbench.nodePath` setting. Installing the sqlite3 command does not supply those APIs.

Open **DBNook → Add Connection → Test → Save**, then expand the connection and open a table. Double-click cells to edit and use Save / Ctrl+S to commit. Try **Explore With a Sample Database** for an independent SQLite fixture. New SQL Query opens a bound document; Ctrl+Enter executes its selection or script.

## Limits and privacy

Grid edits remain drafts until saved. Views and nontransactional MySQL/MariaDB engines are read-only. Loaded-row search/sort is not a whole-table query. DDL may implicitly commit on MySQL/MariaDB; query cancellation can close the affected document session. Complex types, platform coverage and recovery behavior need further acceptance.

Passwords use session memory or VS Code SecretStorage and are excluded from connection exports. Connection metadata can contain hostnames and file paths. Query history is disabled by default; enabling it stores SQL locally on the extension host. Diagnostic reports are local and should be reviewed before sharing. See [privacy](docs/privacy.md) and the [user guide](docs/extension-readme.md).

## Build

Use Node.js 22.16+ (22.22.2 recommended):

```sh
npm ci
npm run check
npm run package
```

Press F5 after building to launch an extension development window. Use `npm run package:offline` on Windows x64 for the offline package; the initial runtime download needs network access. See [development](docs/development.md) and [contributing](CONTRIBUTING.md).

## License

Original project code is GPL-3.0-only; see [LICENSE.txt](LICENSE.txt). Third-party components retain their licenses in [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt). Binary distributions must be accompanied by the corresponding source and build instructions.
