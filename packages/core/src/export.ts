import { type QueryResult } from '../../protocol/src/index.js';
export function exportResult(result: QueryResult, format: 'csv' | 'json'): string {
  if (format === 'json') return JSON.stringify({format:'db-workbench.rows',version:1,columns:result.columns,rows:result.rows.map(row=>result.columns.map(column=>row[column.key]??null)),truncated:result.truncated},null,2);
  const quote = (value: string): string => !value||value==='\\N'||/[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  const lines = [result.columns.map(column => quote(column.name)).join(',')];
  for (const row of result.rows) lines.push(result.columns.map(column => {
    const value = row[column.key];
    return value===null||value===undefined?'\\N':quote(typeof value==='object'?value.type==='integer'?value.value:'base64:'+value.base64:String(value));
  }).join(','));
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}
