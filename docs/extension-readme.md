# DBNook

An open-source VS Code database workbench for SQLite, PostgreSQL, MySQL and MariaDB. The first public Preview release is being prepared and is not yet published. Windows x64 is the tested platform; other platforms still need release acceptance. Original project code is GPL-3.0-only; third-party licenses are included with each package.

## Start

1. Install the VSIX using Extensions: Install from VSIX in VS Code.
2. Open the DBNook icon in the Activity Bar.
3. Choose Add Connection, then SQLite. Select an existing file or create a database, enter a name, test, and save.
4. Expand the connection and open a table. Double-click cells to edit and use Save or Ctrl+S to apply changes.
5. Use New SQL Query from a connection. Ctrl+Enter runs the selection or the full SQL script; each statement has a result tab.
6. Use Begin, Commit and Roll Back in the result view, or SQL Document Session Actions from the status bar. Transaction controls apply to that SQL document.

Explore With a Sample Database creates an independent SQLite database with sample rows.

Focus a grid cell and use Ctrl+C (Cmd+C on macOS) to copy its exact value as quoted tab-separated text, or use **Copy rows** for selected visible rows. **Paste** or Ctrl+V opens a before/after preview starting at the focused cell. Cancel leaves the draft unchanged; **Apply to draft** stages one undoable edit. Use Save to write it to the database. Pasting cannot extend beyond the currently loaded rows or visible columns.

Clipboard NULL is the unquoted marker `\N`; empty text is `""`, and literal `\N` text is quoted. Binary values use `base64:`; large integers retain their exact digits. Copy/paste is limited to 10,000 cells and 2 million characters per operation. While a cell is being edited, Save first commits its current input; Enter/Tab submit input and Escape cancels it. Entering and leaving a NULL or exact integer cell without typing preserves the original value.

## Explain and execution analysis

Use **Explain Current SQL Statement** with a selection or cursor in a bound SQL document. Plans use that document session, including temporary tables and its transaction. The frozen view includes a searchable tree, exact server properties, raw output, source SQL/context, clipboard copy and local JSON report export.

**Prepare SQL Execution Analysis** opens a read-only SQL review. Inspect the actual database/user/search path and command, then use **Execute Reviewed Analysis** and confirm execution. Analyze can execute modifications and functions; it adds no automatic commit or rollback. Source edits, other operations in the same document, connection/session/context changes or an expired review require preparing it again. Ordinary Execute does not run the read-only review. SQLite provides Explain Query Plan; its statistics-maintenance ANALYZE is not used as execution analysis. MySQL and MariaDB use their own server syntax and formats.

Cancellation requests a marked backend termination through a separate authenticated/TLS connection and closes the original session; use Reset Document Session afterward. If the server request cannot be verified or the control connection fails, the error explicitly states that backend cancellation is unconfirmed. Inspect the server and transaction before repeating interrupted analysis. Full proxy/old-version coverage and session-preserving cancellation remain pending.

## Compare table structures

Select one or two tables in Connections and run **Compare Table Structures**. A read-only native diff shows the captured source and target SQL with column/index/constraint/order/options differences. Use **Swap Structure Comparison Direction** or **Refresh Structure Comparison** to capture a new comparison.

Choose **Prepare Structure Synchronization** and select the changes to copy from source to target. Target-only column removals can discard data. The command creates a saved SQL draft bound to the target; unselected target-only fields stay. Use the existing **Preview Definition Changes** and **Apply Definition Changes** workflow to review and apply. Different column names are additions/removals until you explicitly use **Map Renamed Columns** in the draft. Source rows are never copied by structure synchronization.

Same-engine and supported cross-engine ordinary tables can prepare drafts. Cross-engine differences are not preselected: inspect type/default/constraint conversion notes before choosing them. **Configure Structure Column Conversions** supplies one complete target-dialect column definition for a source column that needs explicit handling; clear it to restore automatic conversion. Refresh keeps these choices; swapping direction resets them. Generated SQL contains the final definitions and remains editable with native Undo/Redo.

Exact decimal and unsigned 64-bit values may require SQLite TEXT storage, with different arithmetic, sorting and validation; collations, timezones, lengths, JSON/Boolean validation and identity policies also need review. Unsupported types, functions, schema dependencies and special indexes remain explicit. Existing target inline constraints or engine-specific attributes require a complete target column definition so they are not dropped incidentally. Source rows are never transferred by this workflow.

Captured table SQL does not establish equality of triggers, grants, full comments, sequence options, external dependencies or the whole database. PostgreSQL/SQLite copied index names and schema-scoped constraint names receive target prefixes to avoid source conflicts. Existing migration restrictions, target drift, read-only policy and dirty-grid protections remain in force. Multi-table planning and complete dialect/type coverage are still pending.

## Edit object definitions

Use **Open Object Definition** from a connection or an object. Supported ordinary tables, views, triggers, PostgreSQL/MySQL/MariaDB functions and procedures open as persistent native SQL drafts bound to that connection. PostgreSQL overload signatures appear in the picker. Materialized views, partitions and unsupported definition shapes remain reference definitions; the classic table designer is also available.

Saving a draft does not run SQL. Choose **Preview Definition Changes**, review the read-only SQL document, then **Apply Definition Changes**. Edits invalidate the preview. Applying confirms the actual target and rechecks the server definition, connection revision, open SQL transactions and dirty grids. Unchanged definitions do not send replacement SQL.

Server changes open an **Opened ↔ Server** diff. Accepting the current server as a new baseline preserves your SQL draft and only prepares another preview. **Reload Definition from Server** explicitly replaces the draft; native Undo remains available. Closed drafts retain a versioned sidecar under extension-host global storage; no SQL runs on reopening.

SQLite/PostgreSQL replacements use transactions. SQLite views retain associated INSTEAD OF triggers; PostgreSQL triggers retain enabled state and comments. MySQL/MariaDB DDL implicitly commits: cancellation or failure can leave completed steps, so inspect the report before retrying. MySQL routine DROP/CREATE revokes routine-specific grants; MariaDB routines use OR REPLACE. Stored programs created with a different charset/collation context remain inspectable but require a dedicated migration. Special SQL modes, arbitrary table round-trip, complete ACL restoration and broader server/platform matrices are still pending. Cancellation is checked between statements; acknowledged commits are not described as rolled back.

For table drafts, edit CREATE TABLE and CREATE INDEX definitions while keeping the opened target. Use **Map Renamed Columns** for a different logical column name. The mapping declaration is saved as a leading SQL comment and follows native Undo/Redo with the draft. Unmapped removed/new columns are treated as DROP/ADD; review the data-deletion warnings. Case-only column changes on case-insensitive engines keep the same identity. SQL-file Undo changes the draft, not the database.

Table previews generate a native ALTER or SQLite rebuild with actual validation steps. SQLite planning copies only schema into a private memory database; data is copied later under a transaction, preserving accessible rowids, sequence high-water marks and persistent triggers. PostgreSQL retains table identity and untouched grants/policies; recreated named indexes/constraints retain captured comments and supported index flags. MySQL/MariaDB use a dedicated target-database session with strict conversion checks; untouched AUTO_INCREMENT counters advanced by new rows are preserved. Successful apply refreshes canonical SQL and the open grid. PostgreSQL column reordering/custom identity options, complex USING conversions, partitions and cross-table migrations still require dedicated work.

## SQL editing and local history

Bind the SQL document using Select Connection for SQL Document. Completion offers real tables/views and columns from that connection, including direct table aliases and schema qualifiers. Refresh SQL Completion Metadata reloads cached metadata. Complex CTE/derived-table scopes and stored-function signatures are not yet supported.

Ctrl+Shift+Enter (Cmd+Shift+Enter on macOS) executes the cursor statement. Ctrl+Enter keeps executing the selection or whole script. Current statement detection handles quoted semicolons, PostgreSQL dollar strings, SQLite triggers and MySQL/MariaDB DELIMITER routines using the session SQL mode.

Named SQL templates prompt for values before execution. Use `:name`, `&name`, `$name`, `${Long Name||default||string}`, `:{id||9223372036854775807||number}` or `%(day||2026-10-28||date)`; positional `$1` is also recognized outside quoted SQL. Repeat the same prefix/name to reuse a value. Types are string, number, date and identifier. Omitted types default to String, preserving leading zeros; choose Number or Auto explicitly for numeric values. Date passes text to the database without timezone conversion or an ISO-only restriction. Select NULL explicitly. Preview SQL shows the expanded text without executing it. Identifier quotes object names, including qualified parts, rather than accepting a SQL expression. Strings/comments and PostgreSQL dollar-quoted bodies are preserved.

Parameter values are reused in memory within the current document session; each execution still asks for confirmation. Clear SQL Parameter Values, Reset, connection switching and document close clear the cache. Local Query History stores the template and a redacted error summary for parameterized failures. Disable `dbWorkbench.sqlParameters.enabled` to send SQL without template interpretation. The fourth `||` field is accepted as opaque metadata: it is not interpreted as a choice list. Same-name conflicting definitions, further metadata fields and Notebook sharing/persistence still need parity work.

MySQL/MariaDB discovery and preview follow statically known SQL mode changes. After a dynamic change, execution reads the actual session mode and may ask for the remaining parameters in another form, including when the mode flags remain unchanged. Earlier statements are not replayed if later input is cancelled. Parameter names and type names are offered by SQL completion; definitions/default text and source replacement ranges are preserved.

Use VS Code Format Document or Format Selection with a bound or default connection. The `dbWorkbench.formatting` object controls supported sql-formatter options. Quoted names, comments, parameter definitions and literal values retain their contents, including embedded newlines. A selection that cuts a parameter produces no edit. MySQL/MariaDB formatting uses the actual document session's SQL mode, connecting to the selected target when necessary, and follows literal SET sql_mode changes within a script. Dynamic/conditional mode changes and emulation syntax cannot be guessed during formatting; format the relevant selection in its established session context. Files containing actual DELIMITER directives still require formatting an inner SQL selection. External formatter configuration files and complete non-default PostgreSQL string-mode grammar are not supported yet.

Query History is disabled by default. Enable Local Query History stores submitted SQL and execution summaries in the extension host's local storage. SQL may contain sensitive literals; result rows and connection passwords are not stored. Use `dbWorkbench.history.recordsPerDatabase` (1000 by default) and `dbWorkbench.history.logFailedQueries` to control retention. Disable stops capture and keeps existing entries; delete or clear removes local files. Search matches previews, connection/database names and errors, rather than full SQL bodies. Reopening history creates a scratch bound to the unchanged original target and never executes it. If that target changed or was removed, Copy SQL lets you select a destination explicitly.

Basic completion is capped at 200,000 document characters, 5,000 objects and 2,000 columns per table. Formatting is capped at one million characters. These are editor limits, not database limits; full language-service parity remains pending.

For PostgreSQL, choose PostgreSQL in Add Connection and enter host, port, an existing database, user and password, or import a PostgreSQL URI, JDBC URL or libpq keyword string. Choose the TLS mode explicitly; new forms start with certificate and hostname verification. Certificate paths must be absolute paths on the extension host. Test uses an independent temporary connection and never updates saved credentials or disconnects existing document sessions. Save submits metadata and credential policy together; passwords can be kept in VS Code SecretStorage or only for the current extension session. Leaving the password field unchanged reuses its existing value. Passwords are excluded from Webview persisted state, settings and connection exports. Saving a changed password closes affected sessions after the same transaction/unsaved-data review used by target changes.

For MySQL or MariaDB, choose the matching source, enter host, port (3306 by default), user and password, then Test and Save. Database is optional: leaving it blank lists accessible non-system databases, including empty ones. mysql:// and mariadb:// URI/JDBC import supports sslMode, caPath, certPath, keyPath, connectTimeout (milliseconds) and applicationName. Passwords use the same secure-storage policy as PostgreSQL. Select TLS explicitly: disable, require, verify-ca or verify-full; plaintext fallback is unavailable. Full hostname verification currently requires a DNS name matching the certificate; use verify-ca for an IP endpoint. MariaDB has a separate source selection and URI scheme. Choose MariaDB for a MariaDB server; choosing the wrong engine is rejected after connecting.

MySQL tables show columns, keys, indexes and foreign keys. InnoDB tables support staged insert/update/delete with whole-batch rollback and stale-row checks; views and nontransactional engines are read-only. Generated columns cannot be edited. MySQL scripts support DELIMITER procedures, multiple CALL result sets and SQL mode changes between statements. Each SQL document owns a separate connection; DDL may commit implicitly, according to the server. Turning off autocommit keeps the session in an explicit-work state. Cancellation closes only that physical session and requires Reset; interrupted SQL is never replayed. Complete server/version, complex-type and trigger side-effect matrices remain pending.

If settings or credentials change after a form opens, saving its old draft is rejected. Reload saved settings discards the draft and retrieves the current version. Save compensates a credential write if settings cannot be written; moving profiles between settings scopes also restores earlier values on failure. If restoration itself fails, the error explicitly requests review of the affected settings or credentials. These operations do not provide a distributed transaction across VS Code settings and SecretStorage.

## Implemented in this development build

- SQLite file and in-memory connections; user and workspace profile storage, groups, duplication, editing and disconnect.
- Separate MySQL and MariaDB server connections, optional database browsing, password/command authentication, TLS, URI import, paged InnoDB grids and independent SQL transactions.
- MariaDB JSON text, executable M! comments, generated/invisible columns and composite foreign keys. Aria/MyISAM grids remain read-only. Sequences and system-versioned tables require dedicated support and are not opened as ordinary tables.
- PostgreSQL server connections, password authentication, TLS encryption/identity verification, optional certificate files, database/schema/table/view navigation, composite keys, indexes and foreign keys.
- PostgreSQL SQL document transaction isolation, aborted-transaction detection, exact bigint/numeric/bytea/timestamp transport, staged grid saving with atomic rollback and original-row conflict checks.
- Reusable username/password Authentication Profiles and SSH tunnels, with separate explorer sections, editors, shared references, deletion protection, session-only or SecretStorage secrets and logs.
- External credential commands with output mappings, memory-only TTL/expiration, concurrent-open coalescing and cache clearing; PostgreSQL pgpass files with logical-target matching and credential rotation.
- SSH password/private-key authentication, pinned SHA256 host keys, shared dynamic loopback forwarding, endpoint lease cleanup and fail-closed document sessions after tunnel loss.
- SSH Config discovery with source-labelled read-only tunnels, Include/Host matching, known_hosts verification, multiple identity files, separate password/passphrase storage and directory watching.
- SQLite connection-string import, including file URIs, JDBC SQLite and SQLite SQLAlchemy-style paths; copying a connection as a canonical SQLite string.
- PostgreSQL URI/JDBC/libpq string import with percent-encoded identifiers, IPv6, quoted keyword values, TLS/certificate paths, timeout and application name. Passwords are separated from profile metadata.
- JSON/CSV connection import with field mapping, per-row validation, conflict review, copy/replace/skip choices and an import report; selected or all connections can be exported as JSON/CSV.
- Ordered groups, moving multiple connections, group rename/removal, connection search, table/view LIKE filters, persistent object favorites, quick object opening and default-connection markers.
- Settings diagnostics for invalid rows, duplicate IDs and workspace overrides, with safeguards against silently replacing ambiguous profiles.
- Native explorer for tables, views, columns, primary keys, indexes and foreign keys.
- Data grid with server-side WHERE, paging, loaded-row search, local column filtering and sorting, visibility controls and a row inspector.
- Staged inserts, updates and deletes with undo/redo; atomic grid savepoints, unique key validation and detection of external row changes.
- Native custom table documents with dirty tabs, VS Code Undo/Redo, Save/Revert and unsaved-edit backup recovery.
- Exact 64-bit integer and BLOB transport, explicit NULL values and generated-column protection.
- Multi-statement SQL runs with per-statement results, affected row counts, source-statement diagnostics and stop-on-error behavior.
- Independent SQL document sessions, persistent scratch files, native and Webview transaction controls, explicit session reset and process-based cancellation.
- CSV/typed JSON export of the selected loaded result set.
- Streaming full-table/current SELECT CSV and typed JSON export; CSV/JSON file imports with field mapping, complete validation, reviewed append batches and failure reports.

## Join / Union captured datasets

Right-click a table/view and choose Join Datasets or Union Datasets, or select multiple objects before invoking the command. The command palette can also open an empty chooser. Capture SQL Results for Join / Union uses one or more already-executed SQL results without running them again. Select another source when starting with a single result.

Join supports Inner, Left, Right, Full Outer and Cross. Choose composite column pairs and matching by text representation, strict values, exact numeric values or boolean values. Repeated column labels show their source column number in key selectors. NULL keys do not match; duplicate keys produce all matching row pairs. By default right key columns are merged into left key columns, preserving unmatched right keys in Right/Full joins. Keep both sides' key columns retains them separately. The operation runs on captured data and never writes either source database.

Union aligns exact column names, fills missing columns with NULL and keeps duplicate rows. Duplicate-labelled query columns align by their occurrence. It adds a source label column without overwriting a real __source field. Mixed column types retain their exact individual values and display MIXED; this is not SQL UNION DISTINCT or an implicit string/number conversion.

Use result as left/right source or Add result to Union continues combining a frozen result. Show sources / recipe / SQL reveals the retained operation graph, root SQL, capture times and configured targets/revisions. It contains local business data and is not automatically uploaded. Changing or forgetting a parent does not rewrite a child's captured data. This graph is an audit aid, not an automatically replayable distributed query.

The form starts with dbWorkbench.queryRowLimit, adjustable from 1 to 100,000 input/output rows. Captures are independent sequential snapshots. Input or output truncation is shown explicitly and carried into further operations and typed JSON exports; outer-join unmatched rows can be misleading when a source is incomplete. Each input/output has a 64 MiB serialized row budget; output allows 4,096 columns and Union allows 20 sources. Page display abbreviates long values; CSV/JSON export uses the original captured values.

Finished results remain in memory for 30 minutes, up to 20 results, with a separate 256 MiB serialized resident budget; capture uses the existing comparison budget. These are not strict JavaScript heap limits. Forget result releases a saved combined result; Clear frozen SQL results clears the shared SQL capture catalog while retaining combined snapshots and their lineage. Active readers can temporarily retain cleared data. Source/operation lineage is limited to 128 nodes/4 MiB. Cancel or closing the editor stops ongoing work; completed snapshots can be used by other combination editors until forgotten, expired or the extension exits. Persistent result storage, disk-backed huge joins and complete original result-grid context-menu parity remain pending.

## Compare data and synchronize

Right-click a table/view and choose Compare Data, select two objects in Connections, or run DBNook: Compare Data from the command palette. Choose the source and target, review column mappings and select unique key columns. Add column mapping includes differently named columns. Each column can be mapped once on each side. Swap direction preserves mappings and keys and requires a new comparison.

After executing SQL, Capture SQL Result for Comparison captures one existing result without executing it again. Tables, views and captured results can be compared; only supported writable ordinary tables are synchronization targets. Captured results stay in memory until cleared, expired or the extension exits.

Matching can be strict, exact numeric or boolean. NULL keys match NULL keys; duplicate mapped keys reject comparison. Values are compared only in mapped columns. Dates/time zones, JSON and database extension types do not have full semantic normalization. Captures are sequential, not a distributed database snapshot.

Review source-only, target-only and changed rows, select differences, then Generate sync SQL. Open full script saves a local SQL file bound explicitly to the target connection. This file can contain business data and remains in extension storage; editing it does not modify the reviewed synchronization plan. Running the script independently does not include the comparison editor's transaction guards.

Apply reviewed changes asks for native confirmation with the target and counts. The host rejects read-only targets, dirty target grids and open target SQL transactions. Inside one transaction it locks and revalidates the full captured target, checks original rows, applies the selected changes and verifies explicitly written values/deleted keys before commit. Conversion, write warnings, constraints or conflicting target changes reject the batch. Other trigger side effects follow database rules. A lost connection can leave the commit outcome unknown; SQL is never automatically replayed.

Default capture limit is 10,000 rows per side, configurable up to 100,000, with 64 MiB serialized data per side. Any truncated capture disables synchronization and cannot prove full-table equality. At most 10,000 selected changes and 16 MiB SQL form one synchronization. Comparisons expire after 15 minutes and SQL captures after 30 minutes; Clear captured results frees retained result snapshots. A 256 MiB serialized resident budget bounds simultaneous work, but is not a strict JavaScript heap limit. Comparison is not intended as an unbounded large-database diff engine.

Structure comparison and a persisted comparison job center are still pending. Cross-source Join/Union is available through the separate read-only combination editor above.

## Data transfers

Right-click an ordinary table and choose Export All Saved Table Rows or Import CSV / JSON into Table. The table editor's Export panel also has full-table CSV/JSON and import buttons. Full-table export reads the table independently of the loaded page and its local filters. Existing loaded-result buttons still export only that loaded subset.

Use Export Current SELECT · All Rows from a bound SQL document to rerun its cursor statement and export all returned rows. This uses the same document session, preserving temporary tables, session variables and SQL mode. Commit or roll back its active transaction first. A single SELECT/WITH/VALUES read statement is supported; scripts, SELECT INTO, modifying CTEs and executable comments are rejected. Rerunning a query can produce different rows from an earlier displayed result. Export writes a temporary file and publishes it only after success; cancellation preserves an existing destination file.

Import accepts UTF-8 CSV (comma, semicolon or tab; optional header and configurable NULL marker) and JSON arrays of objects/arrays or the extension's columns/rows envelope. Choose the file, map source fields to writable target columns, then Validate & preview. Validation scans the whole file without writing rows. Unmapped fields use database defaults; generated fields cannot be mapped. The view shows up to 50 rows with cells clipped to 1,000 characters, and the first 500 validation failures. The normalized values written to the database are not clipped. File hashes, target structure and connection settings are checked against the reviewed plan; previews expire after 15 minutes.

Import reviewed rows appends to an existing ordinary table. Each batch commits independently (500 rows by default, maximum 2,000). A later failure or cancellation keeps already committed batches. Invalid preview rows block import unless Skip rows that failed preview validation is explicitly selected. Server constraints are checked while writing; a failing batch rolls back and stops the job. Cancel waits for the current write batch to settle. The report distinguishes committed source rows, actual affected rows, invalid rows and remaining valid rows; a lost commit acknowledgement is reported as unknown and never automatically retried. Open report shows JSONL batch boundaries and errors. Save/revert dirty grids and finish SQL transactions before importing. MySQL/MariaDB imports require an editable InnoDB target. Replace/upsert and whole-file rollback are pending.

CSV uses unquoted `\N` for NULL, quoted empty fields for empty strings, quoted `"\N"` for a literal marker, and `base64:` for binary values. Typed JSON emits the `db-workbench.rows` version 1 envelope with column metadata and tagged large integers/binary values. Big integers and decimal text avoid JavaScript Number conversion; floating-point targets retain their normal rounding behavior. Legacy columns/rows JSON and `$binary` values can be imported. Old CSV exports that already collapsed NULL and empty values cannot recover that distinction.

Transfers currently read/write file URIs on the extension host filesystem; remote/local file bridging is pending. Export uses read-only sessions; consistent snapshots for MySQL/MariaDB depend on transactional source engines. Cancelling a file-backed SQLite/PostgreSQL/MySQL/MariaDB SQL export can disconnect that document session, requiring Reset. In-memory SQLite export cancellation is cooperative between cursor steps and preserves shared data, so a long individual step may delay cancellation. Ordinary in-memory SQL execution retains the separate cancellation behavior described below.

Streaming parsers and driver batches bound retained data, but performance testing for very large files remains pending. Individual CSV/JSON records are limited to 16 million characters, JSON nesting to 128, and headers to 10,000 fields of at most 1,000 characters. SQLite/MySQL export rows have a 16 MB guard; PostgreSQL fetched batches have a 32 MB guard. Import preview data is held in private temporary files on the extension host and removed when consumed/closed; startup also removes expired preview files. A forced crash can leave temporary files. Reports store errors and indexes rather than copied row values, though server errors may contain data. Server backup/restore, comparison, new-table import, additional formats and complete type/platform matrices remain pending. SQLite backup/restore is described below.

## SQLite backup and restore

Right-click a SQLite connection and select SQLite Backup / Restore. Choose file & back up creates a consistent SQLite database file using the Online Backup API, including committed WAL content and shared in-memory data. The file contains the main database's schema, data, indexes, triggers, internal sequences and application/user version metadata. Unsaved grid edits and uncommitted SQL are excluded. Finish active write transactions if shared-cache locking prevents the backup. Attached databases are not included.

Choose backup & preview selects a SQLite source file and a new destination. The extension captures a private snapshot, runs integrity_check, and shows paths, size, SHA-256 and the first 1,000 schema objects. The displayed SQLite version is the reader runtime, not the program that originally created the file. Foreign-key violations are reported (up to 100); they are preserved, not repaired. Restore reviewed snapshot writes exactly that reviewed database state even if the original source later changes. Previews expire after 15 minutes. Add restored connection saves a file connection after successful restoration; it does not execute SQL.

Backup and restore publish a new file only after validation and flushing. Existing files, configured database paths and destination WAL/SHM/journal sidecars are rejected. No existing database is overwritten. This release requires a filesystem that supports same-directory hard links for exclusive publication. It does not replace a running database, restore into an in-memory connection, decrypt encrypted SQLite files or perform point-in-time recovery. File selection currently uses the extension host filesystem.

Cancel safely requests cooperative cancellation between backup steps and waits for acknowledgement before releasing the source session. Integrity checks run synchronously in an isolated reader process, so cancellation can wait for the current check. Closing the editor also requests cancellation. Source sessions and shared-memory data remain usable. Heavy concurrent writes may restart or delay an online backup. Open job report shows completion/cancellation, publication status, size, checksum, schema metadata, timestamps and cleanup/report warnings. A successfully published file stays successful even if later cleanup or report writing fails.

Reviewed snapshots and adjacent temporary files contain database data and are not encrypted. Consumed/closed previews are removed; startup removes private SQLite snapshots older than 15 minutes. A forced crash can leave temporary files beside the destination. Job reports contain paths and schema definitions, and are retained locally without an automatic history limit. Very large databases, unsupported SQLite extensions, remote filesystems and full platform/runtime compatibility remain to be validated. Server backups use the separate workflow below.

## PostgreSQL / MySQL / MariaDB native backup and restore

Right-click a connection and choose **Server Backup / Restore**. The saved connection must specify one database. Install native clients on the extension host, then use **Configure native tools** to set absolute executable paths. The page updates when settings change. No client download occurs. Example settings (replace with your actual installed paths):

```json
"dbWorkbench.nativeTools": {
  "postgresql": {
    "dump": "C:/Program Files/PostgreSQL/17/bin/pg_dump.exe",
    "restore": "C:/Program Files/PostgreSQL/17/bin/pg_restore.exe"
  },
  "mysql": {
    "dump": "C:/tools/mysql-8.4/bin/mysqldump.exe",
    "restore": "C:/tools/mysql-8.4/bin/mysql.exe"
  },
  "mariadb": {
    "dump": "C:/Program Files/MariaDB 11.4/bin/mariadb-dump.exe",
    "restore": "C:/Program Files/MariaDB 11.4/bin/mariadb.exe"
  }
}
```

Use matching engine/major-version clients; MySQL/MariaDB tools must also cover the server minor series. PostgreSQL uses custom archives. MySQL/MariaDB dump InnoDB databases, including routines, triggers and events; nontransactional tables need a future locking workflow. Backup reads committed data while preserving existing document transactions. Avoid concurrent DDL.

**Choose file & back up** creates a new file without overwriting. To restore, connect to an existing empty database and **Choose backup & preview**. Inspect the frozen file's digest, target, tool/server versions and contents; optionally open its full SQL. Mark the source as trusted, type the exact database name and confirm the native dialog. Preview does not execute the backup. Plans expire after 15 minutes and are consumed once. Changing the original source does not change frozen restore bytes; target/tool changes invalidate the plan.

Only restore trusted backups: they execute database code and can reference other databases. Qualified names are preserved, including when restoring under a different database name. PostgreSQL restores in a single transaction without source ownership/ACL restoration. MySQL/MariaDB DDL may commit implicitly; cancellation or an error can leave partial changes. Started operations with uncertain results report **unknown-or-partial**, with no automatic retry. **Open job report** shows outcomes, versions and warnings.

Credentials use private password/option files, not argv or the page. POSIX modes are restricted; Windows access depends on the host directory ACL. Backups/frozen SQL/reports can contain business data. Normal close/consumption cleans private snapshots; forced termination can leave job/review directories or adjacent temporary files. Local reports are retained and not uploaded.

Real CLI round trips were verified on Linux x64 with PostgreSQL 17.11, MySQL 8.4.11 and MariaDB 11.4.13. Windows VS Code tests cover the editor and missing-tool reports; actual Windows/macOS native clients and the full TLS/SSH/version matrix need further validation. MySQL/MariaDB verify-full via a loopback SSH tunnel, and MariaDB verify-ca/require-with-CA, are explicitly rejected pending validation, without a TLS downgrade. Preflight honors the connection timeout; CLI tools retain their own timeout behavior and support cancellation.

Automatic target creation/clearing, existing-object overwrite, full role/ACL policies, locking nontransactional tables, physical backups/PITR and database comparison remain pending. The Windows x64 offline VSIX includes the SQLite Node runtime, **not these server tools**.

## Table structure

Right-click a table or view and choose View / Edit Table Structure. Use Create Table from a connection/database/schema to create an ordinary table. Columns, indexes, table-level primary/unique/foreign/CHECK constraints and server CREATE SQL are shown in separate tabs. Choose one operation, Preview SQL, then Apply reviewed SQL. Editing a field invalidates its preview; previews expire after 15 minutes.

The designer supports creating/renaming/dropping ordinary tables, adding/renaming/dropping columns, changing type/NULL/default attributes, creating/dropping basic indexes and managing table-level constraints. SQLite structural rebuilds preserve data, accessible rowids, AUTOINCREMENT state, indexes, triggers and references, with validation before commit. PostgreSQL uses transactional native DDL. MySQL/MariaDB DDL commits implicitly and cannot roll back a completed change. Structure fingerprints are rechecked before application; simultaneous external MySQL/MariaDB DDL still has a race window.

Commit or roll back SQL transactions and save/revert dirty grid rows first. Grid editing pauses during managed structure changes, then clean open grids and completion metadata refresh. A deleted/renamed table or invalid old filter closes its clean grid; reopen it from Connections. Open definition in SQL editor does not execute SQL. Open SQL on a preview creates a manual migration document, which does not perform the managed token/schema check; on error use ROLLBACK and Reset Session.

PostgreSQL CREATE SQL is a catalog reconstruction, not a complete backup or pg_dump. SQLite virtual/shadow tables and PostgreSQL partition/inheritance hierarchies remain inspection-only. Managed SQL table drafts support the migration workflow above, including native expression/partial indexes and supported generated/identity changes. Arbitrary DDL round-tripping, dedicated advanced column forms, PostgreSQL column reordering, physical options and cross-object rebuilds remain pending. Stored-program creation-context and full ACL restoration limits still apply.

## When a table cannot open

This extension bundles its table scripts and styles in the VSIX. SQLite uses the selected local Node runtime's built-in node:sqlite; opening a SQLite table does not download a driver or contact an Internet service.

From version 0.15.1, activation and table opening write timestamped stages to the DBNook Output channel and a rotating local JSONL log. Failures before the custom editor exists are captured at connection, metadata, row-fetch or document-model stages, with an actionable notification. DBNook: Show Diagnostic Output opens that channel. A separate inline bootstrap reports script-load errors and initialization timeouts even if app.js fails to load; React render errors also show a diagnostic action. If the extension cannot load at all, use VS Code's Log (Extension Host), since extension-owned commands cannot handle failures before activation begins.

To collect a report in an offline environment:

1. Reproduce the failed table opening once.
2. Run DBNook: Collect Diagnostic Report from the Command Palette.
3. The command saves and opens a local JSON report. If the log directory cannot be written, it opens an untitled report for Copy or Save As instead. It includes plugin/VS Code/Node versions, trust/remote state, selected Node path, bundled-asset presence and SHA-256, recent error stages/stacks and an independent in-memory SQLite probe.

The probe does not read or modify your database file. The report does not collect saved connection definitions, SecretStorage, SQL documents or result sets. Recent error text and local paths are included; common password/token fields and URI passwords are redacted. Review the report before sharing, since arbitrary database error text can still contain application information. Reports and logs remain on the extension host and are not uploaded automatically. The current log rotates at approximately 1 MB plus one record, with one prior file retained; the report includes up to 200 current-session events. A failed log-file write does not interrupt database operations.

These diagnostics distinguish runtime/SQLite-file failures from page startup failures. The reported 0.15.1 `statement.columns is not a function` failure was reproduced with an older Node SQLite API. Version 0.15.2 validates row-reading and transaction APIs before opening your file; Test and the diagnostic probe now reject incomplete runtimes. Other editor failures still require their own diagnostic evidence.

## SQLite runtime

For an offline Windows x64 extension host, install **db-workbench-0.25.0-win32-x64-offline.vsix**. It includes the official Node.js 22.22.2 runtime (SQLite 3.51.2), its license and checksum provenance. Leave **DBNook: Node Path** empty and reload the window. Table opening needs no runtime download or separate Node installation. An explicit Node Path takes priority; clear an old override to use the bundled runtime.

The small **db-workbench-0.25.0.vsix** does not include Node. It uses the VS Code host runtime unless Node Path is configured. SQLite requires Node.js 22.16+ **with the required APIs**; a version number or sqlite_version() alone is insufficient. Before accessing the selected file, the runner checks column metadata, array results, exact integers, transaction state and backup availability using a separate in-memory database. The diagnostic report executes an actual row query and records the effective runtime source/version.

The offline package targets Windows x64. In WSL, SSH, containers or other remote workspaces, SQLite and Node Path refer to the **extension host**, not the Windows desktop. Other operating systems/architectures need a compatible host runtime or an explicit local path there; their offline packages have not been produced or validated. Browser-only VS Code is unsupported. See the project's compatibility matrix for declared versus actually tested platforms. Standard SQLite files are supported; SQLCipher/encrypted files and arbitrary loadable SQLite extensions are not currently supported.

SQLite is currently an experimental API in the Node.js 22 runtime used for development. File-backed SQL documents have independent processes. Cancelling a file query terminates its document session: uncommitted work rolls back and previously completed autocommit statements may remain committed. Reset Session opens a fresh session explicitly.

In-memory connections use separate SQLite connections inside one shared process. They share committed data and retain independent transaction state. SQLite shared-cache locking may block reads while another document holds a write transaction. Cancelling a busy in-memory query terminates that shared process and loses all data and sessions in that in-memory connection.

## Shared authentication and SSH

Use Authentication Profiles in the Activity Bar to create a username/password profile. Its password is stored separately from settings. Select that profile in a PostgreSQL connection to share it across connections. Editing identity or credentials reviews affected transactions and dirty table editors before closing their sessions. Renaming a profile preserves its existing database sessions. Profiles referenced by saved or currently saving connections cannot be deleted; references in both global and workspace connection definitions are considered.

Choose External credential command to run an executable on the trusted extension host. Enter arguments as a JSON string array; arguments are passed separately without an implicit shell. An optional working directory must be absolute. On Windows, specify an interpreter explicitly for batch/script files. The program can read DBW_AUTH_HOST, DBW_AUTH_PORT, DBW_AUTH_DATABASE and DBW_AUTH_USER, which describe the original database target before SSH forwarding. Keep secrets out of command arguments and settings.

Choose password text, user:password, or JSON output. Password text preserves spaces and removes one final newline. JSON mappings use dotted properties and array indexes, such as credentials.0.password. The optional mapped username must match Database user; changing identity requires editing the profile first. An optional expiration property accepts Unix seconds or a date string. Expired or invalid output rejects the connection. A positive cache lifetime stores successful results only in extension-host memory, scoped to the provider and target, and never beyond output expiration. Zero disables reuse across later sessions; simultaneous opens share one running command. Clear credential cache affects future sessions and preserves current transactions. Output limits are 64 KiB per stream; default timeout is 15 seconds. Errors omit stdout/stderr. Shutdown cancels the directly launched process; commands that create their own descendant processes may require their own cleanup.

Choose PostgreSQL pgpass file to read a password for every new session. An explicit file path must be absolute. Leaving it empty uses PGPASSFILE, then the extension host's default ~/.pgpass or Windows %APPDATA%/postgresql/pgpass.conf. The first matching hostname:port:database:username:password row wins, with wildcards and escaped colons/backslashes. Matching uses the original PostgreSQL host and port through SSH. No-match and read failures are explicit errors. Unix group/world access is rejected; Windows follows the secure-directory assumption used by libpq. Files are limited to 1 MiB. This does not add URI passfile/service parameters or full libpq environment defaults. External provider results are never saved in settings, Webview persisted state, exports or SecretStorage.

Create an SSH tunnel in Tunnels. Enter SSH host, port, user, authentication method and an OpenSSH-style SHA256 host key fingerprint. Read host fingerprint retrieves the public key without sending credentials; compare it with your server's known fingerprint before saving. Test SSH verifies the SSH login and host key. Test in the database connection additionally verifies the remote database destination and its authentication/TLS.

Private key files must use absolute extension-host paths. Passwords and key passphrases can be kept for the extension session or stored in SecretStorage. SSH agent/Pageant selection is wired to ssh2, but platform-specific agent behavior is not yet accepted; password and encrypted RSA private-key flows have real SSH protocol tests. Further OpenSSH versions, host-key/key formats and platform matrices remain pending.

The database Host/Port remain the destination seen by the SSH server. Forwarding binds a random local port on 127.0.0.1. Connections to the same SSH profile and destination share the listener, while SQL documents retain separate database clients and transactions. TLS verifies the original database hostname through the tunnel. The listener closes after its last lease, and errors are recorded without credential values. A tunnel drop invalidates existing SQL leases; explicit Reset establishes a new endpoint and interrupted SQL is never replayed. Automatic SSH reconnection, command tunnels, jump hosts and cloud proxy presets remain pending.

SSH Config discovery reads the extension host's user and system configuration files in a trusted workspace. Set DBNook: SSH Config Paths to replace these with an ordered list of absolute paths. Explicit Host aliases appear in Tunnels and the connection form with an SSH Config label. Their settings are read-only; open the source from the editor or context menu to edit them. Delete opens the source so you can remove its Host entry. SSH passwords and encrypted-key passphrases are stored separately through Save credentials. Removing an alias does not automatically erase its secure credentials, so temporary file replacement does not lose them; explicit orphan-secret cleanup is pending.

The initial parser supports first-value precedence, Host wildcards/negation, Include order, multiple identity files, environment/home expansions and selected connection settings. Known_hosts supports regular/hashed host names, custom ports, HostKeyAlias and revoked raw keys; a missing trusted host key blocks connection. Directory watchers refresh source changes automatically. Comment/line changes preserve sessions; changed endpoints/authentication/trust require explicit reset. Files are parsed as data without executing Match exec, ProxyCommand or other commands. Conditional Match beyond all, ProxyJump/ProxyCommand, host certificates, hardware keys, explicit cipher settings and full OpenSSH semantics remain unsupported. Other unmapped session options are not executed. Source diagnostics identify unavailable aliases. This is not a replacement for the full OpenSSH client.

Global connections referencing workspace-only profiles require that workspace to be open. JSON/CSV connection exports preserve authRef/tunnelRef, but do not include the referenced profiles or their secrets; create those profiles in the destination environment separately. Shared Authentication Profile imports/exports and additional authentication providers remain backlog items. Authentication Profiles are database credentials and do not require a product account.

## Importing connections

Use Import Connections from the explorer or command palette. Choose a UTF-8 JSON/CSV file or paste its contents, review the preview, choose global or workspace settings, and apply the selected rows. CSV headers can be mapped manually; comma, semicolon and tab delimiters are supported. Relative paths resolve from the selected workspace or source-file directory. Imports are limited to 5 MB and 10,000 records.

Conflicting IDs default to creating a copy. Replacing an existing profile uses the same transaction, in-memory data and unsaved-table protections as editing that connection. Preview never opens a database. Each profile is saved separately; the final report identifies created, replaced, skipped, invalid and failed rows. An import is not an atomic batch across settings files. Configuration changes invalidate a stale preview.

JSON accepts the extension's versioned export, an array of profiles, a connections object or its own dbWorkbench.connections settings. CSV exports round-trip supported SQLite/PostgreSQL profile fields, excluding passwords. Imports may contain a password field or credentials inside a connectionString. The preview reports only that a password is present; its value stays in a private host-side plan. Imported passwords default to session-only storage; choose Remember imported passwords to use SecretStorage. Preview and report responses never include the password, and exports exclude it.

Copying a PostgreSQL URI includes supported TLS paths, timeout and application name while omitting passwords. A nonintegral timeout in milliseconds rounds up to whole seconds in the URI; JSON/CSV preserve milliseconds. URI import supports one TCP host, IPv6, and Unix socket directories on a Unix extension host. Missing host defaults to localhost; absent user stays blank for explicit entry, and database defaults to the provided user. URI defaults to sslmode=prefer, while creating a new form defaults to verify-full. Unsupported options, multi-host failover, environment defaults, service/passfile references and GSS settings are reported rather than silently ignored. Third-party connection export formats require dedicated import adapters.

## PostgreSQL behavior and limits

This version was tested against PostgreSQL 17.11. Each SQL document and the metadata/grid service use independent pg clients. Transaction status comes from the server, including aborted transactions that require rollback. Cancelling a query terminates that document's client; reset it explicitly before continuing. Uncommitted work rolls back, while earlier autocommitted statements may remain committed. Other document clients remain usable. This version does not send PostgreSQL's non-destructive CancelRequest.

Grid saves use one database transaction with a SHARE ROW EXCLUSIVE table lock and a 10-second lock acquisition timeout. Each update/delete checks a unique match and original row values. Any failed row rolls back the entire grid batch. The lock temporarily blocks concurrent writers; views remain read-only. Primary-key columns provide stable table paging; tables without a key have no stable default row order. Numeric, JSON, array and timestamp values retain server text to avoid precision loss; structured editors are pending. Results retain up to the configured row limit while the client drains remaining server rows, so the limit is not a server query cost limit.

TLS supports disable, allow, prefer, require, verify-ca and verify-full. Allow tries plaintext first; prefer tries TLS first, with fallback only while establishing the connection. Neither mode verifies server identity. Require uses TLS and verifies a supplied CA when present; verify-ca validates the chain and verify-full also checks the hostname. The Test result reports the actual mode used. Timeout applies across fallback attempts; zero means no timeout. Both TLS-capable and plaintext-only test services are covered. Client-certificate authentication, IAM/OAuth/Entra, multiple database selection and PostgreSQL versions other than 17.11 still need implementation or acceptance coverage. Complete definition rendering for special objects and COPY streaming remain pending. Dollar-quoted function bodies and nested comments are supported in SQL scripts; SQL-standard BEGIN ATOMIC compound-body splitting is pending. SQL is validated by PostgreSQL.

## Current limitations

This is an early development release, not completion of the full functional parity roadmap. Full SQL language services and parameter options, advanced history/formatter options, production-role policies, advanced SSH/command tunnels and cloud authentication, complete DDL designers, advanced grid functions, complete database backups/comparisons, diagrams, notebooks and AI tools remain pending. Current development focuses on the existing four databases, SQL editing, table-structure management and data transfer; additional database drivers are outside the current plan.

Grid sorting, column filters and Quick Search operate on loaded rows. WHERE is executed by the connected database. Exports contain loaded saved results, not the entire table or unsaved edits. Paging size changes take effect on the next refresh or page request.

Table tabs use VS Code's custom document lifecycle for dirty state, Save/Revert, close prompts and unsaved-edit backups. Backups preserve a draft; they do not apply it to the database. Recovery checks the connection identity and uses original row values to detect database conflicts when saved. Crash and full-window restart recovery scenarios still need end-to-end acceptance tests.

SQL documents have their own transaction connections; metadata and table views use a separate connection. Closing the last native tab for a SQL document cancels its running work and rolls back its uncommitted transaction. Scratch SQL text is saved independently of database transactions. Save As / rename binding transfers and full-window restart policies still need further implementation and acceptance tests.

Runs stop at the first error and retain completed results. They do not automatically undo earlier statements; the document's explicit SQL transaction controls determine commit and rollback. A failed run may leave a transaction active. Native diagnostics currently identify the failed statement start, rather than the exact failing token. Results are delivered per statement; row-batch streaming and backpressure are pending.

Editing a connection name, group, color or storage scope preserves existing sessions. Changing its database target or read-only mode closes them; active transactions and connected in-memory data prompt before being discarded. Direct settings.json target changes require explicit reset or disconnect before an old session can execute again.

SQLite read-only connections use a read-only handle. PostgreSQL read-only connections set default_transaction_read_only and restrict transaction-mode changes. These are client protections and do not replace database roles, grants or filesystem permissions.

Third-party JavaScript runtime components and their licenses are included in THIRD_PARTY_NOTICES.txt. The Windows x64 offline package additionally includes Node.js notices in runtime/win32-x64/LICENSE.txt and binary provenance in runtime/win32-x64/provenance.json. This build uses AG Grid Community; the additional grid capabilities in the roadmap remain pending.
