/** Statement boundaries only; PostgreSQL performs all grammar/type validation. */
export function postgresStatements(sql: string): { start: number; end: number; sql: string }[] {
  const result: { start: number; end: number; sql: string }[] = [];
  let start = 0, index = 0, quote = '', dollar = '', comment = 0, line = false, escape = false, content = false;
  const push = (end: number) => { if (content) result.push({ start, end, sql: sql.slice(start, end) }); start = end; content = false; };
  while (index < sql.length) {
    const ch = sql[index]!, next = sql[index + 1];
    if (line) { if (ch === '\n' || ch === '\r') line = false; index++; continue; }
    if (comment) { if (ch === '/' && next === '*') { comment++; index += 2; } else if (ch === '*' && next === '/') { comment--; index += 2; } else index++; continue; }
    if (dollar) { if (sql.startsWith(dollar, index)) { index += dollar.length; dollar = ''; } else index++; continue; }
    if (quote) {
      if (escape && ch === '\\') index += 2;
      else if (ch === quote && next === quote) index += 2;
      else { if (ch === quote) quote = ''; index++; }
      continue;
    }
    if (ch === '-' && next === '-') { line = true; index += 2; continue; }
    if (ch === '/' && next === '*') { comment = 1; index += 2; continue; }
    if (ch === "'" || ch === '"') { quote = ch; escape = ch === "'" && /(?:^|[^\w$])[eE]$/.test(sql.slice(Math.max(0, index - 2), index)); content = true; index++; continue; }
    if (ch === '$' && (index === 0 || !/[\w$]/.test(sql[index - 1]!))) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z_\d]*)?\$/.exec(sql.slice(index));
      if (tag) { dollar = tag[0]; content = true; index += dollar.length; continue; }
    }
    if (ch === ';') { push(index + 1); index++; continue; }
    if (!/\s/.test(ch)) content = true;
    index++;
  }
  // Let the server report unterminated literals/comments at the actual statement.
  if (content || quote || dollar || comment) push(sql.length);
  return result;
}
export const quotePg = (identifier: string) => '"' + identifier.replaceAll('"', '""') + '"';
