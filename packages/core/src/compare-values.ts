import type {CellValue,ColumnMeta,DataRow} from '../../protocol/src/index.js';
import type {ComparePair,CompareRow} from '../../protocol/src/comparisons.js';

export function numeric(value:CellValue):{digits:string;exponent:number;negative:boolean}{
  if(value===null||typeof value==='boolean'||typeof value==='object'&&value.type!=='integer')throw new Error('Numeric matching requires numeric values on both sides.');
  const text=typeof value==='object'?value.value:String(value),match=/^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(text);
  if(!match||!((match[2]??'')+(match[3]??'')).length||text.length>10000)throw new Error('A numeric comparison value is not a finite decimal. Use strict matching for special values.');
  let digits=((match[2]??'')+(match[3]??'')).replace(/^0+/,''),exponent=Number(match[4]??0)-(match[3]?.length??0);if(!Number.isSafeInteger(exponent)||Math.abs(exponent)>10000)throw new Error('Numeric comparison exponent exceeds the supported exact range.');
  if(!digits)return {digits:'0',exponent:0,negative:false};while(digits.endsWith('0')){digits=digits.slice(0,-1);exponent++;}return {digits,exponent,negative:match[1]==='-'};
}
export function canonicalCell(value:CellValue,mode:ComparePair['mode']='strict'):string{
  if(value===null)return 'null';
  if(mode==='boolean'){if(value===true||value===1||value==='true'||value==='1')return 'boolean:1';if(value===false||value===0||value==='false'||value==='0')return 'boolean:0';throw new Error('Boolean matching accepts true/false and 1/0 only.');}
  if(mode==='numeric'||typeof value==='number'||typeof value==='object'&&value.type==='integer'){const n=numeric(value);return `number:${n.negative?'-':''}${n.digits}e${n.exponent}`;}
  if(typeof value==='object'){const data=Buffer.from(value.base64,'base64');if(data.toString('base64')!==value.base64)throw new Error('A binary value has invalid canonical base64.');return 'binary:'+value.base64;}
  return typeof value+':'+JSON.stringify(value);
}
export function columnFamily(column:ColumnMeta):'integer'|'decimal'|'float'|'boolean'|'binary'|'text'{
  const type=column.dataType.toUpperCase();if(type.includes('[]'))return 'text';
  if(/\bBOOL(?:EAN)?\b/.test(type))return 'boolean';if(/BLOB|BYTEA|BINARY|\bBIT\b/.test(type))return 'binary';
  if(/\b(?:TINYINT|SMALLINT|MEDIUMINT|INTEGER|BIGINT|INT[248]?|SERIAL|BIGSERIAL|TINY|SHORT|LONG|LONGLONG)\b/.test(type))return 'integer';
  if(/\b(?:NUMERIC|DECIMAL|NEWDECIMAL|NUMBER)\b/.test(type))return 'decimal';if(/\b(?:REAL|FLOAT[48]?|DOUBLE)\b/.test(type))return 'float';return 'text';
}
export function defaultPairs(source:ColumnMeta[],target:ColumnMeta[]):ComparePair[]{const used=new Set<string>();return source.flatMap(s=>{const t=target.find(c=>c.name===s.name&&!used.has(c.key));if(!t)return [];used.add(t.key);const sf=columnFamily(s),tf=columnFamily(t);return [{source:s.key,target:t.key,key:Boolean(s.primaryKey),mode:(sf==='boolean'&&tf==='boolean'?'boolean':['integer','decimal','float'].includes(sf)&&['integer','decimal','float'].includes(tf)?'numeric':'strict') as ComparePair['mode']}];});}

export function compareRows(source:DataRow[],target:DataRow[],pairs:ComparePair[]):CompareRow[]{
  const keys=pairs.filter(p=>p.key);if(!keys.length)throw new Error('Select at least one mapped key column before comparing.');
  for(const [side,rows]of [['source',source],['target',target]] as const)for(const row of rows)for(const pair of pairs)if(!Object.hasOwn(row,pair[side]))throw new Error('A mapped comparison value is missing.');
  const index=(rows:DataRow[],side:'source'|'target')=>{const map=new Map<string,DataRow>();for(const row of rows){const key=JSON.stringify(keys.map(p=>{const name=p[side];if(!Object.hasOwn(row,name))throw new Error('A mapped key value is missing.');return canonicalCell(row[name]!,p.mode);}));if(map.has(key))throw new Error(`The ${side} contains duplicate mapped keys (including NULL keys). Choose unique key columns.`);map.set(key,row);}return map;};
  const left=index(source,'source'),right=index(target,'target'),rows:CompareRow[]=[];
  for(const [key,l]of left){const r=right.get(key);right.delete(key);const changed=r?pairs.filter(p=>canonicalCell(l[p.source]!,p.mode)!==canonicalCell(r[p.target]!,p.mode)).map(p=>p.target):[];rows.push({id:'d'+rows.length,kind:r?changed.length?'changed':'equal':'source-only',source:l,target:r,changed});}
  for(const r of right.values())rows.push({id:'d'+rows.length,kind:'target-only',target:r,changed:[]});return rows;
}
/** Conversion is explicit and checked before SQL. No implicit string-to-number rounding. */
export function synchronizeCell(value:CellValue,source:ColumnMeta,target:ColumnMeta,driver:string):CellValue{
  if(value===null){if(!target.nullable)throw new Error(`${target.name}: target does not allow NULL.`);return null;}
  const sf=columnFamily(source),tf=columnFamily(target);if(tf==='binary'){if(typeof value!=='object'||value.type!=='binary')throw new Error(`${target.name}: binary target requires binary data.`);canonicalCell(value);return value;}
  if(tf==='boolean'){const c=canonicalCell(value,'boolean');return c==='boolean:1';}
  if(['integer','decimal','float'].includes(tf)){
    if(!['integer','decimal','float'].includes(sf)&&typeof value!=='number'&&!(typeof value==='object'&&value.type==='integer'))throw new Error(`${target.name}: numeric synchronization requires numeric source metadata or an exact numeric wire value.`);
    const n=numeric(value),canonical=canonicalCell(value,'numeric'),literal=(n.negative?'-':'')+n.digits+'e'+n.exponent;
    if(tf==='integer'){
      if(n.exponent<0||typeof value==='number'&&!Number.isSafeInteger(value))throw new Error(`${target.name}: fractional or imprecise values cannot be synchronized to an integer.`);
      const integer=BigInt((n.negative?'-':'')+n.digits)*10n**BigInt(n.exponent);let bits=64;
      if(driver!=='sqlite'){const t=target.dataType.toUpperCase();bits=/TINYINT/.test(t)?8:/SMALLINT|INT2/.test(t)?16:/MEDIUMINT/.test(t)?24:/BIGINT|BIGSERIAL|INT8|LONGLONG/.test(t)?64:32;}
      const unsigned=/UNSIGNED/i.test(target.dataType),low=unsigned?0n:-(1n<<BigInt(bits-1)),high=(1n<<BigInt(unsigned?bits:bits-1))-1n;if(integer<low||integer>high)throw new Error(`${target.name}: integer is outside the target range.`);
      return integer>=BigInt(Number.MIN_SAFE_INTEGER)&&integer<=BigInt(Number.MAX_SAFE_INTEGER)?Number(integer):{type:'integer',value:integer.toString()};
    }
    if(tf==='float'||driver==='sqlite'){
      const number=Number(literal);if(!Number.isFinite(number)||canonicalCell(number,'numeric')!==canonical)throw new Error(`${target.name}: target floating representation would lose numeric precision.`);
      const single=(c:ColumnMeta)=>/\b(?:REAL|FLOAT4|FLOAT)\b/i.test(c.dataType)&&!/DOUBLE|FLOAT8/i.test(c.dataType);
      if(driver!=='sqlite'&&single(target)&&!single(source)&&canonicalCell(Math.fround(number),'numeric')!==canonical)throw new Error(`${target.name}: narrowing to a single-precision float would lose precision.`);return number;
    }
    const precision=/(?:NUMERIC|DECIMAL|NUMBER)\s*\((\d+)(?:\s*,\s*(-?\d+))?\)/i.exec(target.dataType),scale=Number(precision?.[2]??0);if(precision&&n.digits!=='0'&&(n.exponent<-scale||n.digits.length+n.exponent>Number(precision[1])-scale))throw new Error(`${target.name}: numeric value would exceed the target precision or scale.`);
    return typeof value==='object'&&value.type==='integer'?value.value:String(value);
  }
  if(sf!=='text'||typeof value!=='string')throw new Error(`${target.name}: incompatible source/target types require an explicit conversion outside this sync plan.`);
  const width=/(?:VAR)?CHAR(?:ACTER)?(?:\s+VARYING)?\s*\((\d+)\)/i.exec(target.dataType);if(driver!=='sqlite'&&width&&[...value].length>Number(width[1]))throw new Error(`${target.name}: text exceeds the target character length.`);
  if(driver==='postgresql'&&value.includes('\0'))throw new Error(`${target.name}: PostgreSQL text cannot contain NUL.`);return value;
}
