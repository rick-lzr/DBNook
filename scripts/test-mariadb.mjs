// Reuse lifecycle and isolation, while selecting an independent engine/image/report.
process.argv.push('--mariadb');
await import('./test-mysql.mjs');
