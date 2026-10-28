import type { ParsedConnectionString } from './connection-strings.js';
const malformed=()=>new Error('Invalid MySQL/MariaDB URI. Use mysql:// or mariadb://user@host:3306/database.');
export function parseMysqlString(text:string):ParsedConnectionString {
  let uri:URL;try{uri=new URL(text.replace(/^jdbc:/i,''));}catch{throw malformed();}
  if(!['mysql:','mariadb:'].includes(uri.protocol)||uri.hash||!uri.hostname)throw malformed();
  const seen=new Set<string>(),allowed=['sslMode','caPath','certPath','keyPath','connectTimeout','applicationName'];
  for(const [key]of uri.searchParams){if(seen.has(key)||!allowed.includes(key))throw new Error('Unknown or duplicate MySQL/MariaDB URI option. Configure supported fields explicitly.');seen.add(key);}
  let user:string,database:string,password:string;try{user=decodeURIComponent(uri.username);password=decodeURIComponent(uri.password);database=decodeURIComponent(uri.pathname.slice(1));}catch{throw malformed();}
  const mode=uri.searchParams.get('sslMode')??'disable';if(!['disable','require','verify-ca','verify-full'].includes(mode))throw new Error('Unsupported MySQL TLS mode.');
  const result:ParsedConnectionString={driver:uri.protocol==='mariadb:'?'mariadb':'mysql',storage:'server',path:'',host:uri.hostname.replace(/^\[|\]$/g,''),port:uri.port?Number(uri.port):3306,user:user||undefined,database:database||undefined,sslMode:mode as ParsedConnectionString['sslMode'],readOnly:false,createIfMissing:false,suggestedName:database||uri.hostname};
  if(uri.password||/^[^/]+:\/\/[^/@]*:[^/@]*@/.test(text))result.password=password;
  for(const key of ['caPath','certPath','keyPath','applicationName']as const)if(uri.searchParams.has(key))result[key]=uri.searchParams.get(key)!;
  if(uri.searchParams.has('connectTimeout')){const v=uri.searchParams.get('connectTimeout')!;if(!/^\d+$/.test(v)||Number(v)>120000)throw new Error('MySQL connectTimeout must be 0–120000 milliseconds.');result.connectTimeout=Number(v);}
  return result;
}
