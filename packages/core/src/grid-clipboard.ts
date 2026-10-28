import {parseCell,type CellValue,type ColumnMeta} from '../../protocol/src/index.js';

export const CLIPBOARD_LIMIT=2_000_000,CLIPBOARD_CELLS=10_000;
export interface ClipboardField {text:string;null:boolean;}
/** Quoted TSV: unquoted \N is NULL; quoted \N and quoted empty text remain strings. */
export function copyGridValues(rows:readonly (readonly CellValue[])[]):string{
 if(rows.reduce((n,row)=>n+row.length,0)>CLIPBOARD_CELLS)throw new Error('Copy at most 10,000 cells at a time.');
 const text=rows.map(row=>row.map(value=>{
  if(value===null)return '\\N';
  const s=typeof value==='object'?value.type==='integer'?value.value:'base64:'+value.base64:String(value);
  return !s||s==='\\N'||/[\t\r\n"]/.test(s)?'"'+s.replaceAll('"','""')+'"':s;
 }).join('\t')).join('\r\n');
 if(text.length>CLIPBOARD_LIMIT)throw new Error('Clipboard data exceeds 2 million characters. Use Export instead.');
 return text;
}
export function parseGridClipboard(text:string):ClipboardField[][]{
 if(text.length>CLIPBOARD_LIMIT)throw new Error('Clipboard data exceeds 2 million characters. Use Import instead.');
 const rows:ClipboardField[][]=[];let row:ClipboardField[]=[],value='',quoted=false,inside=false,closed=false,count=0;
 function field(){if(++count>CLIPBOARD_CELLS)throw new Error('Paste at most 10,000 cells at a time.');row.push({text:value,null:!quoted&&value==='\\N'});value='';quoted=false;closed=false;}
 for(let i=0;i<text.length;i++){
  const c=text[i]!;
  if(inside){if(c==='"'){if(text[i+1]==='"'){value+='"';i++;}else{inside=false;closed=true;}}else value+=c;continue;}
  if(c==='"'&&!value&&!closed){inside=quoted=true;continue;}
  if(c==='\t'){field();continue;}
  if(c==='\r'||c==='\n'){field();rows.push(row);row=[];if(c==='\r'&&text[i+1]==='\n')i++;continue;}
  if(closed)throw new Error('Unexpected text after a quoted clipboard field.');
  value+=c;
 }
 if(inside)throw new Error('Unclosed quoted clipboard field.');
 if(row.length||value||quoted||!rows.length){field();rows.push(row);}
 if(rows.some(row=>row.length!==rows[0]!.length))throw new Error('Paste a rectangular tab-separated range.');
 return rows;
}
export function pastedCell(field:ClipboardField,column:ColumnMeta,original?:CellValue):CellValue{
 if(column.generated)throw new Error(`${column.name} is generated and cannot be pasted into.`);
 if(field.null){if(!column.nullable)throw new Error(`${column.name} does not allow NULL.`);return null;}
 if(/BLOB|BINARY|BYTEA/i.test(column.dataType)||typeof original==='object'&&original?.type==='binary'){
  const base64=field.text.replace(/^base64:/,'');
  if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64))throw new Error(`${column.name} requires Base64 binary data.`);
  return {type:'binary',base64};
 }
 if(typeof original==='boolean'||/BOOL/i.test(column.dataType)){
  if(/^(true|1)$/i.test(field.text))return true;if(/^(false|0)$/i.test(field.text))return false;
  throw new Error(`${column.name} requires true or false.`);
 }
 if(/DECIMAL|NUMERIC/i.test(column.dataType)&&!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i.test(field.text))throw new Error(`${column.name} requires an exact numeric value.`);
 return parseCell(field.text,column,original);
}
