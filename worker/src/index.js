// RakuTools: non-official GigaFile upload relay for Cloudflare Workers.
// Security: fixed upstream domain, strict origin, small chunks, no file persistence.
const CHUNK_LIMIT = 12 * 1024 * 1024;
function cors(origin, env) {
 const allowed = (env.ALLOWED_ORIGINS || 'https://alicetel-u.github.io').split(',').map(s => s.trim());
 return allowed.includes(origin) ? {'Access-Control-Allow-Origin':origin,'Vary':'Origin'} : null;
}
const json = (data,status=200,headers={}) => new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers}});
async function getServer(){
 const r=await fetch('https://gigafile.nu/',{redirect:'follow',headers:{'User-Agent':'Mozilla/5.0'}});
 if(!r.ok)throw new Error('ギガファイル便に接続できません');
 const html=await r.text();
 const match=html.match(/var\s+server\s*=\s*["']([^"']+)["']/);
 if(!match)throw new Error('アップロード先を取得できません');
 const host=match[1].replace(/^https?:\/\//,'').replace(/\/$/,'');
 if(!/^(?:[a-z0-9-]+\.)?gigafile\.nu$/.test(host))throw new Error('アップロード先が無効です');
 return host;
}
export default {async fetch(request,env){
 const origin=request.headers.get('Origin')||'';
 const headers=cors(origin,env);
 if(!headers)return json({error:'許可されていない送信元です'},403);
 if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{...headers,'Access-Control-Allow-Methods':'GET,POST,OPTIONS','Access-Control-Allow-Headers':'Content-Type','Access-Control-Max-Age':'3600'}});
 const path=new URL(request.url).pathname;
 if(path==='/api/health'&&request.method==='GET')return json({ok:true},200,headers);
 if(path==='/api/server'&&request.method==='GET'){
  try{return json({server:await getServer()},200,headers)}catch(e){return json({error:e.message},502,headers)}
 }
 if(path==='/api/chunk'&&request.method==='POST'){
  const len=Number(request.headers.get('content-length'));
  if(!Number.isFinite(len)||len<=0||len>CHUNK_LIMIT)return json({error:'チャンクサイズが上限を超えています'},413,headers);
  const contentType=request.headers.get('content-type')||'';
  if(!/^multipart\/form-data;\s*boundary=/.test(contentType))return json({error:'送信形式が無効です'},400,headers);
  const upstream=new URL(request.url).searchParams.get('server')||'';
  if(!/^(?:[a-z0-9-]+\.)?gigafile\.nu$/.test(upstream))return json({error:'送信先が無効です'},400,headers);
  // Enforce that the host still matches the current upload server.
  try{if(upstream!==await getServer())return json({error:'送信先が変わりました。最初からやり直してください'},409,headers)}
  catch(e){return json({error:e.message},502,headers)}
  try{
   const response=await fetch('https://'+upstream+'/upload_chunk.php',{
    method:'POST',headers:{'Content-Type':contentType},
    body:request.body,redirect:'manual'
   });
   if(!response.ok)return json({error:'送信先がエラーを返しました ('+response.status+')'},502,headers);
   const body=await response.text();
   if(body.length>65536)return json({error:'送信先から想定外の応答がありました'},502,headers);
   let result;try{result=JSON.parse(body)}catch{return json({error:'送信結果を確認できませんでした'},502,headers)}
   if(result.status!==0)return json({error:'アップロードが完了しませんでした',detail:result.status},502,headers);
   // Never expose upstream JWT or arbitrary fields.
   const share=typeof result.url==='string'?result.url:'';
   if(share){const u=new URL(share);if(u.protocol!=='https:'||!(u.hostname==='gigafile.nu'||u.hostname.endsWith('.gigafile.nu')))return json({error:'共有URLが不正です'},502,headers)}
   return json({url:share,deleteKey:typeof result.delkey==='string'?result.delkey:''},200,headers);
  }catch{return json({error:'通信エラーが発生しました。時間をおいて再試行してください'},502,headers)}
 }
 return json({error:'見つかりません'},404,headers);
}};
