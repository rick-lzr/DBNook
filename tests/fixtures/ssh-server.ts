import ssh2,{type Connection} from 'ssh2';
const {Server,utils}=ssh2;
import {createConnection,type Socket} from 'node:net';
import {sshFingerprint} from '../../packages/core/src/tunnels.js';
const hostKeys=utils.generateKeyPairSync('rsa',{bits:2048});
export async function sshFixture(options:{publicKey?:string;mapHost?:(host:string)=>string;allowedPort?:number}={}){
  const host=utils.parseKey(hostKeys.private);if(host instanceof Error)throw host;
  const allowed=options.publicKey?utils.parseKey(options.publicKey):undefined;if(allowed instanceof Error)throw allowed;
  const connections=new Set<Connection>(),sockets=new Set<Socket>();let forwards=0,authentications=0;
  const server=new Server({hostKeys:[hostKeys.private]},client=>{
    connections.add(client);client.on('error',()=>{});client.once('close',()=>connections.delete(client));
    client.on('authentication',ctx=>{authentications++;if(ctx.method==='password'&&ctx.username==='ssh-user'&&ctx.password==='ssh-test-password')return ctx.accept();
      if(ctx.method==='publickey'&&ctx.username==='ssh-user'&&allowed&&ctx.key.data.equals(allowed.getPublicSSH())&&(!ctx.signature||allowed.verify(ctx.blob!,ctx.signature,ctx.hashAlgo)))return ctx.accept();ctx.reject();
    });
    client.on('ready',()=>client.on('tcpip',(accept,reject,info)=>{
      if(options.allowedPort!==undefined&&info.destPort!==options.allowedPort){reject();return;}forwards++;
      const socket=createConnection({host:options.mapHost?.(info.destIP)??info.destIP,port:info.destPort},()=>{const channel=accept();if(!channel){socket.destroy();return;}channel.on('error',()=>socket.destroy());channel.once('close',()=>socket.destroy());socket.pipe(channel).pipe(socket);});sockets.add(socket);socket.on('error',()=>{reject();socket.destroy();});socket.once('close',()=>sockets.delete(socket));
    }));
  });server.on('error',()=>{});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=(server.address() as {port:number}).port;
  return {port,fingerprint:sshFingerprint(host.getPublicSSH()),publicHostKey:host.type+' '+host.getPublicSSH().toString('base64'),forwards:()=>forwards,authentications:()=>authentications,drop:()=>{for(const client of connections)client.end();},close:async()=>{for(const socket of sockets)socket.destroy();for(const client of connections)client.end();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}
