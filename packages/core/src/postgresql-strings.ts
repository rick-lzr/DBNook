import type { ConnectionProfile } from '../../protocol/src/index.js';
import type { ParsedConnectionString, PathContext } from './connection-strings.js';

const bad = () => new Error('The PostgreSQL connection string is malformed. Check encoding, quoting and parameter names.');
const decode = (text: string) => { try { const value=decodeURIComponent(text); if(value.includes('\0')) throw bad(); return value; } catch { throw bad(); } };
function keywordValues(text: string): Map<string,string> {
  const values=new Map<string,string>();let i=0;
  while(i<text.length) {
    while(/\s/.test(text[i]??'') && i<text.length)i++; if(i===text.length)break;
    const key=/^[A-Za-z_][A-Za-z_\d]*/.exec(text.slice(i));if(!key)throw bad();i+=key[0].length;
    while(i<text.length&&/\s/.test(text[i]!))i++;if(text[i++]!=='=')throw bad();while(i<text.length&&/\s/.test(text[i]!))i++;
    let value='',quoted=text[i]==="'",closed=!quoted;if(quoted)i++;
    while(i<text.length) {
      const ch=text[i++]!;
      if(ch==='\\') {if(i===text.length)throw bad();value+=text[i++]!;}
      else if(quoted&&ch==="'"){closed=true;break;}
      else if(!quoted&&/\s/.test(ch)){break;}
      else value+=ch;
    }
    if(!closed||(quoted&&i<text.length&&!/\s/.test(text[i]!)))throw bad();values.set(key[0].toLowerCase(),value);
  }
  return values;
}
export function parsePostgresString(input: string, context: PathContext={}): ParsedConnectionString {
  const jdbc=/^jdbc:postgresql:/i.test(input);let text=jdbc?input.slice(5):input,values:Map<string,string>;
  if(/^postgres(?:ql)?:/i.test(text)) {
    if(!/^postgres(?:ql)?:\/\//i.test(text)) {
      if(!jdbc||!/^postgresql:[^/?#]+$/i.test(text))throw bad();
      values=new Map([['dbname',decode(text.slice('postgresql:'.length))]]);
    } else {
      text=text.replace(/^postgres(?:ql)?:\/\//i,'');if(text.includes('#'))throw bad();
      const question=text.indexOf('?'),location=question<0?text:text.slice(0,question),query=question<0?'':text.slice(question+1);
      const slash=location.indexOf('/'),authority=slash<0?location:location.slice(0,slash),database=slash<0?'':location.slice(slash+1);
      values=new Map();if(database)values.set('dbname',decode(database));
      let host=authority;const at=authority.lastIndexOf('@');
      if(at>=0) {const info=authority.slice(0,at);if(info.includes('@'))throw bad();const colon=info.indexOf(':');values.set('user',decode(colon<0?info:info.slice(0,colon)));if(colon>=0)values.set('password',decode(info.slice(colon+1)));host=authority.slice(at+1);}
      if(host.includes(','))throw new Error('Multi-host PostgreSQL connections are not implemented yet. Configure a single host.');
      if(host.startsWith('[')) {const end=host.indexOf(']');if(end<0)throw bad();values.set('host',decode(host.slice(1,end)));const port=host.slice(end+1);if(port&&!/^:\d+$/.test(port))throw bad();if(port)values.set('port',port.slice(1));}
      else {const colon=host.lastIndexOf(':');if(colon>=0){if(host.slice(0,colon).includes(':'))throw bad();values.set('host',decode(host.slice(0,colon)));values.set('port',host.slice(colon+1));}else if(host)values.set('host',decode(host));}
      // URI components use percent encoding, not HTML form '+' decoding.
      for(const pair of query?query.split('&'):[]) {const equal=pair.indexOf('=');if(equal<1)throw bad();values.set(decode(pair.slice(0,equal)).toLowerCase(),decode(jdbc?pair.slice(equal+1).replaceAll('+',' '):pair.slice(equal+1)));}
    }
  } else values=keywordValues(text);
  const supported=new Set(['host','port','dbname','database','user','password','sslmode','ssl','sslrootcert','sslcert','sslkey','connect_timeout','connecttimeout','application_name','applicationname']);
  for(const key of values.keys())if(!supported.has(key))throw new Error('Unsupported PostgreSQL connection option. Configure supported fields explicitly.');
  const host=values.get('host')||'localhost',user=values.get('user')??'',database=values.get('dbname')??values.get('database')??user;
  if(host.includes(','))throw new Error('Multi-host PostgreSQL connections are not implemented yet.');
  if(host.startsWith('/')&&(context.platform??process.platform)==='win32')throw new Error('Unix-domain socket directories require a Unix extension host.');
  if(!host.startsWith('/')&&(/[\s@?#\[\]]/.test(host)||host.startsWith('@')))throw bad();
  const portText=values.get('port')||'5432';if(!/^\d+$/.test(portText)||Number(portText)<1||Number(portText)>65535)throw new Error('PostgreSQL port must be between 1 and 65535.');
  const mode=values.get('sslmode')??(values.has('ssl')?(values.get('ssl')===''||values.get('ssl')==='true'?jdbc?'verify-full':'require':values.get('ssl')==='false'?'disable':undefined):'prefer');
  if(!mode||!['disable','allow','prefer','require','verify-ca','verify-full'].includes(mode))throw new Error('Unsupported PostgreSQL TLS mode.');
  const timeout=values.get('connect_timeout')??values.get('connecttimeout');let connectTimeout:number|undefined;
  if(timeout!==undefined){if(!/^\d+$/.test(timeout)||Number(timeout)>120)throw new Error('Connection timeout must be 0 to 120 seconds.');connectTimeout=Number(timeout)*1000;}
  const caPath=values.get('sslrootcert'),certPath=values.get('sslcert'),keyPath=values.get('sslkey');
  if(mode==='disable'&&(caPath||certPath||keyPath))throw new Error('TLS certificates cannot be used with sslmode=disable.');
  if(Boolean(certPath)!==Boolean(keyPath))throw new Error('Provide both the client certificate and private key.');
  const result: ParsedConnectionString={driver:'postgresql',storage:'server',path:'',host,port:Number(portText),database,user,sslMode:mode as ConnectionProfile['sslMode'],readOnly:false,createIfMissing:false,suggestedName:database||host};
  if(caPath)result.caPath=caPath;if(certPath)result.certPath=certPath;if(keyPath)result.keyPath=keyPath;
  if(connectTimeout!==undefined)result.connectTimeout=connectTimeout;
  const app=values.get('application_name')??values.get('applicationname');if(app!==undefined)result.applicationName=app;
  if(values.has('password'))result.password=values.get('password');
  return result;
}
