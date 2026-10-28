import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {open,readdir,realpath,stat} from 'node:fs/promises';
import {homedir,userInfo} from 'node:os';
import {dirname,isAbsolute,join,parse,resolve} from 'node:path';
import {TunnelSchema,type TunnelDefinition} from '../../protocol/src/index.js';

interface Directive {key:string;args:string[];file:string;line:number;root:string;children?:Directive[];issue?:string;}
export interface SshConfigSnapshot {tunnels:TunnelDefinition[];files:string[];directories:string[];diagnostics:string[];}
interface ConfigOptions {home?:string;user?:string;env?:NodeJS.ProcessEnv;systemPaths?:string[];}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fingerprint=(key:Buffer)=>'SHA256:'+createHash('sha256').update(key).digest('base64').replace(/=+$/,'');
const missing=(error:unknown)=>['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code??'');

/** Tokenize data only. Backslashes in Windows paths remain literal; quoted spaces and comments work. */
export function sshConfigWords(line:string):string[]{
  const words:string[]=[];let word='',quote=false,started=false;
  for(let i=0;i<line.length;i++){const c=line[i]!;
    if(c==='\\'&&['"',' ','\t','#'].includes(line[i+1]??'')){word+=line[++i];started=true;}
    else if(c==='"'){quote=!quote;started=true;}
    else if(!quote&&c==='#')break;
    else if(!quote&&(/\s/.test(c)||c==='='&&words.length===0&&Boolean(word))){if(started){words.push(word);word='';started=false;}}
    else if(!quote&&c==='='&&words.length===1&&!started)continue;
    else{word+=c;started=true;}
  }
  if(quote)throw new Error('Unclosed quote in SSH Config.');if(started)words.push(word);return words;
}
const pattern=(value:string)=>new RegExp('^'+[...value].map(c=>c==='*'?'.*':c==='?'?'.':'\\^$+?.()|{}[]'.includes(c)?'\\'+c:c).join('')+'$','i');
export function sshPatternsMatch(value:string,patterns:string[]):boolean{let found=false;for(const p of patterns){const negative=p.startsWith('!'),matches=pattern(negative?p.slice(1):p).test(value);if(matches&&negative)return false;if(matches)found=true;}return found;}
export function knownHostFingerprints(text:string,host:string):{trusted:string[];revoked:string[]}{
  const trusted=new Set<string>(),revoked=new Set<string>();
  for(const line of text.split(/\r?\n/)){const parts=line.trim().split(/\s+/);if(!parts[0]||parts[0].startsWith('#'))continue;const marker=parts[0].startsWith('@')?parts.shift():undefined;
    const [names,type,encoded]=parts;if(!names||!type||!encoded||marker&&marker!=='@revoked')continue;
    let matches=false;if(names.startsWith('|1|')){const values=names.split('|'),salt=Buffer.from(values[2]??'','base64'),expected=Buffer.from(values[3]??'','base64');const actual=createHmac('sha1',salt).update(host).digest();matches=values.length===4&&salt.length===20&&expected.length===actual.length&&timingSafeEqual(actual,expected);}else matches=sshPatternsMatch(host,names.split(','));
    if(!matches||!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))continue;const key=Buffer.from(encoded,'base64');if(key.length<4)continue;const length=key.readUInt32BE();if(length>key.length-4||key.subarray(4,4+length).toString()!==type)continue;
    (marker==='@revoked'?revoked:trusted).add(fingerprint(key));
  }return {trusted:[...trusted],revoked:[...revoked]};
}
async function readBounded(path:string,limit:number):Promise<string>{const file=await open(path,'r');try{const info=await file.stat();if(!info.isFile()||info.size>limit)throw new Error('SSH file is not a regular file or exceeds its size limit.');const buffer=Buffer.alloc(limit+1);let size=0;while(size<buffer.length){const result=await file.read(buffer,size,buffer.length-size,null);if(!result.bytesRead)break;size+=result.bytesRead;}if(size>limit)throw new Error('SSH file exceeds its size limit.');return buffer.toString('utf8',0,size);}finally{await file.close();}}

export function defaultSshConfigPaths(home=homedir(),env:NodeJS.ProcessEnv=process.env):string[]{return [join(home,'.ssh','config'),process.platform==='win32'?join(env.PROGRAMDATA||'C:\\ProgramData','ssh','ssh_config'):'/etc/ssh/ssh_config'];}

/** Parse OpenSSH data without running ssh -G, Match exec, ProxyCommand or other programs. */
export async function discoverSshConfigs(paths:string[]=defaultSshConfigPaths(),options:ConfigOptions={}):Promise<SshConfigSnapshot>{
  const home=options.home??homedir(),localUser=options.user??userInfo().username,env=options.env??process.env,files=new Set<string>(),directories=new Set<string>(),diagnostics:string[]=[],aliases=new Map<string,Directive>();let fileCount=0;
  const expand=(value:string,tokens:Record<string,string>):string=>{
    let result=value.replace(/\$\{([^}]+)\}/g,(_,name:string)=>{if(env[name]===undefined)throw new Error('SSH Config references an unset environment variable.');return env[name]!;}).replace(/%([%A-Za-z])/g,(_,key:string)=>{if(tokens[key]===undefined)throw new Error('SSH Config uses an unsupported expansion token.');return tokens[key]!;});
    if(result==='~')result=home;else if(/^~[/\\]/.test(result))result=join(home,result.slice(2));else if(result.startsWith('~'))throw new Error('SSH Config named-user home expansion is not supported.');return result;
  };
  const glob=async(value:string):Promise<string[]>=>{
    const absolute=resolve(value),root=parse(absolute).root,segments=absolute.slice(root.length).split(/[\\/]/).filter(Boolean);let candidates=[root];
    for(const segment of segments){const next:string[]=[];for(const directory of candidates){if(!/[*?\[\]]/.test(segment)){next.push(join(directory,segment));continue;}directories.add(directory);
        let names:string[]=[];try{names=await readdir(directory);}catch(error){if(!missing(error))throw error;}
        // Include globs support *, ? and ordinary bracket ranges. Dotfiles require a leading dot.
        const expression='^'+segment.replace(/[.+^${}()|\\]/g,'\\$&').replace(/\*/g,'.*').replace(/\?/g,'.').replace(/\[!/g,'[^')+'$';let matcher:RegExp;try{matcher=new RegExp(expression);}catch{throw new Error('Invalid SSH Include glob.');}
        next.push(...names.filter(name=>(!name.startsWith('.')||segment.startsWith('.'))&&matcher.test(name)).sort().map(name=>join(directory,name)));
      }candidates=next;if(candidates.length>128)throw new Error('SSH Include matches too many paths.');}
    return candidates.sort();
  };
  const load=async(file:string,root:string,stack:string[],system:boolean):Promise<Directive[]>=>{
    files.add(file);directories.add(dirname(file));if(stack.length>=16)throw new Error('SSH Include nesting exceeds 16 levels.');let canonical:string;try{canonical=await realpath(file);}catch(error){if(missing(error))return [];throw new Error('Cannot read an SSH Config file.');}
    if(stack.includes(canonical))throw new Error('SSH Include cycle detected.');if(++fileCount>128)throw new Error('SSH Config exceeds the 128-file limit.');let text:string;try{text=await readBounded(file,1024*1024);}catch{throw new Error('Cannot read SSH Config, or it exceeds the 1 MiB limit.');}
    const result:Directive[]=[];for(const [index,line]of text.replace(/^\uFEFF/,'').split(/\r?\n/).entries()){
      let words:string[];try{words=sshConfigWords(line);}catch{throw new Error(`Invalid SSH Config quoting at ${file}:${index+1}.`);}if(!words.length)continue;const key=words.shift()!.toLowerCase();if(!words.length)throw new Error(`Missing SSH Config value at ${file}:${index+1}.`);const node:Directive={key,args:words,file,line:index+1,root};result.push(node);
      if(key==='host')for(const alias of words)if(!/[*!?]/.test(alias)&&!aliases.has(alias.toLowerCase())){if(aliases.size>=512)throw new Error('SSH Config exceeds the 512-alias limit.');aliases.set(alias.toLowerCase(),node);}
      if(key==='include'){
        node.children=[];for(const entry of words){try{const path=expand(entry,{'%':'%',d:home,u:localUser});const base=system?dirname(root):join(home,'.ssh');for(const include of await glob(isAbsolute(path)?path:join(base,path)))node.children.push(...await load(include,root,[...stack,canonical],system));}catch(error){node.issue=error instanceof Error?error.message:'Cannot parse SSH Include.';}}
      }
    }return result;
  };
  const roots:Directive[][]=[];for(const input of paths){const path=resolve(expand(input,{'%':'%',d:home,u:localUser}));try{roots.push(await load(path,path,[],(options.systemPaths??defaultSshConfigPaths(home,env).slice(1)).includes(path)));}catch(error){diagnostics.push(error instanceof Error?error.message:'Cannot parse SSH Config.');}}
  const tunnels:TunnelDefinition[]=[];
  for(const [normalized,location]of aliases){const alias=location.args.find(p=>p.toLowerCase()===normalized)!,values=new Map<string,string[]>(),identities:string[]=[],issues=[...diagnostics];
    const apply=(nodes:Directive[],initial=true)=>{let active=initial;for(const node of nodes){const {key,args}=node;
      if(key==='host'){active=initial&&sshPatternsMatch(alias,args);continue;}
      if(key==='match'){if(args.length===1&&args[0]?.toLowerCase()==='all')active=initial;else{active=false;if(initial)issues.push('Conditional Match blocks are not supported; this alias requires source review.');}continue;}
      if(!active)continue;if(node.issue)issues.push(node.issue);
      if(key==='include'){apply(node.children??[],active);continue;}
      if(key==='identityfile'){identities.push(...args);continue;}
      if(!values.has(key))values.set(key,args);
    }};for(const root of roots)apply(root);
    const first=(key:string,fallback='')=>values.get(key)?.[0]??fallback;
    for(const key of ['proxycommand','proxyjump','canonicalizehostname','certificatefile','knownhostscommand','revokedhostkeys','hostkeyalgorithms','kexalgorithms','ciphers','macs','pkcs11provider','securitykeyprovider','bindaddress','bindinterface','addressfamily'])if(values.has(key)&&!['none','no','any'].includes(first(key).toLowerCase()))issues.push(`SSH Config ${key} is not supported. Edit the source before using this alias.`);
    let host=alias,user=localUser,port=22,agent='',identityFiles:string[]=[],knownHostsFiles:string[]=[],fingerprints:string[]=[];
    try{
      host=expand(first('hostname',alias),{'%':'%',h:alias}).toLowerCase();user=expand(first('user',localUser),{'%':'%',d:home,u:localUser,h:host,n:alias});port=Number(first('port','22'));if(!Number.isInteger(port)||port<1||port>65535)throw new Error('SSH Config has an invalid port.');
      const tokens={'%':'%',d:home,u:localUser,h:host,n:alias,p:String(port),r:user,k:first('hostkeyalias',alias)};
      const identityAgent=first('identityagent');if(identityAgent.startsWith('$')&&!identityAgent.startsWith('${')&&env[identityAgent.slice(1)]===undefined)throw new Error('SSH IdentityAgent references an unset environment variable.');agent=identityAgent==='SSH_AUTH_SOCK'?env.SSH_AUTH_SOCK??'':identityAgent.startsWith('$')&&!identityAgent.startsWith('${')?env[identityAgent.slice(1)]??'':identityAgent?expand(identityAgent,tokens):env.SSH_AUTH_SOCK??'';
      const requested=first('pubkeyauthentication','yes')==='no'||!first('preferredauthentications','publickey,password').split(',').includes('publickey')?[]:identities.length?identities:[join(home,'.ssh','id_rsa'),join(home,'.ssh','id_ecdsa'),join(home,'.ssh','id_ed25519')];
      for(const raw of requested){if(raw.toLowerCase()==='none')continue;const path=resolve(expand(raw,tokens));files.add(path);directories.add(dirname(path));try{if((await stat(path)).isFile())identityFiles.push(path);}catch(error){if(!missing(error))issues.push('Cannot inspect an SSH identity file.');}}
      knownHostsFiles=[...(values.get('userknownhostsfile')??[join(home,'.ssh','known_hosts'),join(home,'.ssh','known_hosts2')]),...(values.get('globalknownhostsfile')??(process.platform==='win32'?[join(env.PROGRAMDATA||'C:\\ProgramData','ssh','ssh_known_hosts')]:['/etc/ssh/ssh_known_hosts','/etc/ssh/ssh_known_hosts2']))].filter(p=>p.toLowerCase()!=='none').map(p=>resolve(expand(p,tokens)));
      const lookup=first('hostkeyalias')||(port===22?host:`[${host}]:${port}`),trusted=new Set<string>(),revoked=new Set<string>();
      for(const path of knownHostsFiles){files.add(path);directories.add(dirname(path));try{const found=knownHostFingerprints(await readBounded(path,4*1024*1024),lookup);for(const key of found.trusted)trusted.add(key);for(const key of found.revoked)revoked.add(key);}catch(error){if(!missing(error))issues.push('Cannot read a known_hosts file, or it exceeds the 4 MiB limit.');}}
      fingerprints=[...trusted].filter(key=>!revoked.has(key)).sort();if(!fingerprints.length)issues.push('No trusted host key matches this SSH host in known_hosts. Review the host key in the source files.');
    }catch(error){issues.push(error instanceof Error?error.message:'SSH Config expansion failed.');}
    const authMethods:('publickey'|'agent'|'password')[]=[],preferred=first('preferredauthentications','publickey,password').split(',');
    for(const method of preferred){if(method==='publickey'&&first('pubkeyauthentication','yes')!=='no'){if(first('identitiesonly','no')!=='yes'&&agent!=='none'&&(agent||process.platform==='win32'))authMethods.push('agent');if(identityFiles.length)authMethods.push('publickey');}else if(method==='password'&&first('passwordauthentication','yes')!=='no')authMethods.push('password');else if(!['publickey','password'].includes(method))issues.push('SSH Config requests an unsupported authentication method.');}
    if(!authMethods.length)issues.push('SSH Config has no usable authentication method.');
    const timeout=Number(first('connecttimeout','15'))*1000;if(!Number.isFinite(timeout)||timeout<1000||timeout>120000)issues.push('SSH ConnectTimeout must be between 1 and 120 seconds.');
    const parsed=TunnelSchema.safeParse({id:'ssh-config:'+digest([resolve(paths[0]??location.root),alias]),name:alias,kind:'ssh',host,user,port:Number.isInteger(port)&&port>0&&port<=65535?port:22,auth:identityFiles.length?'key':authMethods[0]==='agent'?'agent':'password',privateKeyPath:identityFiles[0],agent:agent==='none'?undefined:agent||undefined,fingerprint:fingerprints[0]??'',readyTimeout:Number.isFinite(timeout)&&timeout>=1000&&timeout<=120000?timeout:15000,scope:'global',source:{kind:'ssh-config',root:location.root,path:location.file,line:location.line,alias,identityFiles,knownHostsFiles,fingerprints,authMethods:[...new Set(authMethods)],issues:[...new Set(issues)]}});
    if(parsed.success)tunnels.push(parsed.data);else diagnostics.push(`SSH alias ${alias} contains invalid connection values.`);
  }
  return {tunnels,files:[...files],directories:[...directories],diagnostics:[...new Set(diagnostics)]};
}
