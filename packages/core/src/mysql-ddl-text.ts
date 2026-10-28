import {sqlTokens,sqlIdentifier} from './sql-editing.js';
import {ddlQuote} from './ddl-syntax.js';
type Mode={noBackslashEscapes:boolean;ansiQuotes:boolean;mariaDb?:boolean};
/** Convert literal values and quoted identifiers; SQL words and expressions remain in their dialect. */
export function mysqlDdlModeText(text:string,driver:'mysql'|'mariadb',from:Mode,to:Mode){
 const ts=sqlTokens(text,driver,from);let result='',at=0;
 for(const token of ts){result+=text.slice(at,token.start);let value=token.text;
  if(token.kind==='identifier')value=ddlQuote(sqlIdentifier(value),driver);
  else if(token.kind==='string'){
   const quote=value[0]!;value=value.slice(1,-1).replaceAll(quote+quote,quote);
   if(!from.noBackslashEscapes)value=value.replace(/\\([\s\S])/g,(_m,c:string)=>({0:'\0',b:'\b',n:'\n',r:'\r',t:'\t',Z:'\x1a','%':'\\%','_':'\\_'}[c]??c));
   if(value.includes('\0'))throw new Error('A NUL-containing MySQL literal needs an explicit binary expression.');
   if(!to.noBackslashEscapes)value=value.replaceAll('\\','\\\\');value="'"+value.replaceAll("'","''")+"'";
  }
  result+=value;at=token.end;
 }return result+text.slice(at);
}
