import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
let executable = process.env.VSCODE_EXECUTABLE;
if (!executable && process.env.VSCODE_TEST_VERSION) {
  const { downloadAndUnzipVSCode } = await import('@vscode/test-electron');
  executable = await downloadAndUnzipVSCode({ version: process.env.VSCODE_TEST_VERSION, cachePath: resolve('.vscode-test'), timeout: 30000 });
}
if (!executable) throw new Error('Set VSCODE_EXECUTABLE to an installed executable, or VSCODE_TEST_VERSION to download an official isolated test runtime.');
const root = resolve('.cache/extension-test', String(Date.now()));
const workspace = join(root, 'workspace'); const userData = join(root, 'user-data'); const extensions = join(root, 'extensions');
await Promise.all([workspace, userData, extensions].map(path => mkdir(path, { recursive: true })));
await build({ entryPoints: ['tests/extension/integration.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['vscode', 'node:sqlite'], outfile: 'dist/integration.cjs' });
const manifest = JSON.parse(await readFile(resolve(process.env.DBW_EXTENSION_DEVELOPMENT_PATH || '.', 'package.json'), 'utf8'));
const env = { ...process.env, DBW_TEST_OUTPUT: root, DBW_TEST_NODE:process.execPath, DBW_TEST_EXTENSION_ID: `${manifest.publisher}.${manifest.name}` }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, [workspace, '--new-window', `--user-data-dir=${userData}`, `--extensions-dir=${extensions}`, '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--disable-updates', '--disable-extensions', `--extensionDevelopmentPath=${resolve(process.env.DBW_EXTENSION_DEVELOPMENT_PATH||'.')}`, `--extensionTestsPath=${resolve('dist/integration.cjs')}`], { env, windowsHide: true, stdio: 'inherit' });
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
console.log(`VS Code test exit: ${code}`);
await mkdir('artifacts', { recursive: true });
const { writeFile } = await import('node:fs/promises');
const reportPath=env.DBW_DIAGNOSTICS_ONLY==='1'?'artifacts/diagnostics-native.json':env.DBW_BACKUP_ONLY==='1'?'artifacts/backup-native.json':env.DBW_DATA_ONLY==='1'?'artifacts/data-native.json':env.DBW_STRUCTURE_ONLY==='1'?'artifacts/structure-native.json':env.DBW_SQL_ONLY==='1'?'artifacts/sql-editing-native.json':env.DBW_MYSQL_ONLY==='1'?`artifacts/${env.DBW_TEST_ENGINE==='mariadb'?'mariadb':'mysql'}-native-integration.json`:'artifacts/extension-integration.json';
try { const report = await readFile(join(root, 'extension-integration.json'), 'utf8'); console.log(report); await writeFile(reportPath, report); }
catch (error) { if (error.code !== 'ENOENT') throw error; console.error('VS Code did not reach the integration test entry point. Inspect its startup diagnostics above.'); await writeFile(reportPath, JSON.stringify({ passed: false, startupFailure: true, executable, exitCode: code, testedAt: new Date().toISOString() }, null, 2)); process.exitCode = 1; }
if (code !== 0) process.exitCode = 1;
