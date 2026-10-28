export const quoteMysql = (value: string) => '`' + value.replaceAll('`', '``') + '`';
export interface MysqlSqlMode { noBackslashEscapes: boolean; ansiQuotes: boolean; mariaDb?: boolean; }
export interface MysqlSource { start: number; end: number; sql: string; next: number; delimiter: string; }
/** Scan one statement at a time: SET sql_mode takes effect before scanning the next. */
export function nextMysqlStatement(text: string, offset = 0, delimiter = ';', mode: MysqlSqlMode = { noBackslashEscapes: false, ansiQuotes: false }): MysqlSource | undefined {
  let start = offset, i = offset, quote = '', line = false, block = false, content = false;
  while (i < text.length) {
    const c = text[i]!, n = text[i + 1];
    if (line) { if (c === '\n' || c === '\r') line = false; i++; continue; }
    if (block) { if (c === '*' && n === '/') { block = false; i += 2; } else i++; continue; }
    if (quote) {
      const escape = quote !== '`' && !(quote === '"' && mode.ansiQuotes) && !mode.noBackslashEscapes;
      if (escape && c === '\\') i += 2;
      else if (c === quote && n === quote) i += 2;
      else { if (c === quote) quote = ''; i++; }
      continue;
    }
    if (!content && (i === 0 || /[\r\n]/.test(text[i - 1]!))) {
      const directive = /^[\t ]*DELIMITER[\t ]+(\S+)[\t ]*(?:\r?\n|$)/i.exec(text.slice(i));
      if (directive) { if (directive[1]!.length > 32 || /['"`\\]/.test(directive[1]!)) throw new Error('Unsupported DELIMITER. Use a short punctuation delimiter.'); delimiter = directive[1]!; i += directive[0].length; start = i; continue; }
    }
    if (text.startsWith(delimiter, i)) { const end = i; i += delimiter.length; if (content) return { start, end, sql: text.slice(start, end), next: i, delimiter }; start = i; continue; }
    if (c === '#' || c === '-' && n === '-' && (text[i + 2] === undefined || /\s/.test(text[i + 2]!))) { line = true; i += c === '#' ? 1 : 2; continue; }
    if (c === '/' && n === '*') { if (text[i + 2] === '!' || mode.mariaDb && /^[mM]!/.test(text.slice(i+2,i+4))) content = true; block = true; i += 2; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; content = true; i++; continue; }
    if (!/\s/.test(c)) content = true;
    i++;
  }
  return content || quote || block ? { start, end: text.length, sql: text.slice(start), next: text.length, delimiter } : undefined;
}
export function mysqlRelation(name: string, database?: string): [string, string] {
  const quoted = /^`((?:``|[^`])+)`\.`((?:``|[^`])+)`$/.exec(name);
  if (quoted) return [quoted[1]!.replaceAll('``', '`'), quoted[2]!.replaceAll('``', '`')];
  if (database && name && !name.includes('\0')) return [database, name];
  throw new Error('Select a fully qualified MySQL table from the connection tree.');
}
