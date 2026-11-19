const ORIGIN = "https://siam-dev5.github.io";
const PLATFORMS = ["facebook","instagram","youtube","tiktok","shopee_affiliate","lazada_affiliate"];
const DEFAULT_META_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "pages_manage_metadata",
  "instagram_basic",
  "instagram_content_publish"
];
const now = () => new Date().toISOString();
const json = (data,status=200,headers={}) => new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store",...headers}});
const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const unb64 = (value) => Uint8Array.from(atob(value.replace(/-/g,"+").replace(/_/g,"/")),c=>c.charCodeAt(0));
const random = (n=32) => { const a=new Uint8Array(n); crypto.getRandomValues(a); return b64(a); };
const sha = async (v) => b64(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(v)));
const cors = (request) => {
 const origin=request.headers.get("Origin")||"";
 const headers={"Access-Control-Allow-Methods":"GET,POST,DELETE,OPTIONS","Access-Control-Allow-Headers":"Authorization,Content-Type,X-Bootstrap-Key","Vary":"Origin"};
 if(origin===ORIGIN) headers["Access-Control-Allow-Origin"]=origin;
 return headers;
};
const graphVersion = (env) => (env.META_GRAPH_API_VERSION||"v27.0").trim();
const metaScopes = (env) => (env.META_OAUTH_SCOPES||DEFAULT_META_SCOPES.join(",")).split(",").map(x=>x.trim()).filter(Boolean);
const metaConfigured = (env) => !!(env.META_APP_ID&&env.META_APP_SECRET&&env.META_REDIRECT_URI);
const webhookConfigured = (env) => !!(env.META_APP_SECRET&&env.META_WEBHOOK_VERIFY_TOKEN);
const safeText = (value,max=240) => String(value||"").slice(0,max);
async function audit(env,userId,type,entityType,entityId,actor,details={}) {
 await env.DB.prepare("INSERT INTO audit_events(id,owner_user_id,event_type,entity_type,entity_id,actor,details_json,created_at) VALUES(?,?,?,?,?,?,?,?)")
 .bind(random(16),userId,type,entityType,entityId,actor,JSON.stringify(details),now()).run();
}
async function sessionUser(request,env) {
 const token=(request.headers.get("Authorization")||"").replace(/^Bearer\s+/i,"");
 if(!token) return null;
 const row=await env.DB.prepare("SELECT u.id,u.email,s.expires_at FROM user_sessions s JOIN app_users u ON u.id=s.user_id WHERE s.token_hash=?").bind(await sha(token)).first();
 if(!row || row.expires_at<=now()) return null;
 return {id:row.id,email:row.email};
}
async function passwordHash(password,salt,env) {
 const pepper=unb64(env.TOKEN_ENCRYPTION_KEY);
 const pepperKey=await crypto.subtle.importKey("raw",pepper,{name:"HMAC",hash:"SHA-256"},false,["sign"]);
 const prehash=await crypto.subtle.sign("HMAC",pepperKey,new TextEncoder().encode(password));
 let material=prehash;
 const saltBytes=unb64(salt);
 for(let round=0;round<3;round++) {
  const key=await crypto.subtle.importKey("raw",material,"PBKDF2",false,["deriveBits"]);
  material=await crypto.subtle.deriveBits({name:"PBKDF2",salt:new Uint8Array([...saltBytes,round]),iterations:100000,hash:"SHA-256"},key,256);
 }
 return b64(material);
}
async function newSession(env,user) {
 const token=random(48), expiry=new Date(Date.now()+7*86400000).toISOString();
 await env.DB.prepare("INSERT INTO user_sessions(id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)")
 .bind(random(16),user.id,await sha(token),expiry,now()).run();
 await env.DB.prepare("UPDATE app_users SET last_login_at=? WHERE id=?").bind(now(),user.id).run();
 return {token,expires_at:expiry,user:{id:user.id,email:user.email}};
}
async function encrypt(value,env) {
 const raw=unb64(env.TOKEN_ENCRYPTION_KEY);
 const key=await crypto.subtle.importKey("raw",raw,{name:"AES-GCM"},false,["encrypt"]);
 const iv=crypto.getRandomValues(new Uint8Array(12));
 const data=await crypto.subtle.encrypt({name:"AES-GCM",iv,additionalData:new TextEncoder().encode("alpha-centauri-social-v1")},key,new TextEncoder().encode(value));
 return b64(new Uint8Array([...iv,...new Uint8Array(data)]));
}
async function decrypt(value,env) {
 const raw=unb64(env.TOKEN_ENCRYPTION_KEY);
 const key=await crypto.subtle.importKey("raw",raw,{name:"AES-GCM"},false,["decrypt"]);
 const bytes=unb64(value);
 const plain=await crypto.subtle.decrypt({name:"AES-GCM",iv:bytes.slice(0,12),additionalData:new TextEncoder().encode("alpha-centauri-social-v1")},key,bytes.slice(12));
 return new TextDecoder().decode(plain);
}
export async function verifyMetaSignature(rawBody,signature,appSecret) {
 if(!rawBody||!signature||!appSecret||!/^sha256=[a-f0-9]{64}$/i.test(signature)) return false;
 const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(appSecret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
 const digest=await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(rawBody));
 const expected="sha256="+Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,"0")).join("");
 const a=new TextEncoder().encode(expected.toLowerCase()),b=new TextEncoder().encode(signature.toLowerCase());
 if(a.length!==b.length) return false;
 let diff=0; for(let i=0;i<a.length;i++) diff|=a[i]^b[i];
 return diff===0;
}
export function buildMetaAuthorizationUrl(env,state) {
 if(!metaConfigured(env)) throw new Error("Meta OAuth is not configured");
 const url=new URL("https://www.facebook.com/"+graphVersion(env)+"/dialog/oauth");
 url.searchParams.set("client_id",env.META_APP_ID);
 url.searchParams.set("redirect_uri",env.META_REDIRECT_URI);
 url.searchParams.set("state",state);
 url.searchParams.set("response_type","code");
 url.searchParams.set("scope",metaScopes(env).join(","));
 url.searchParams.set("auth_type","rerequest");
 return url.toString();
}
function metaResultPage(status,message) {
 const payload=JSON.stringify({type:"ALPHA_CENTAURI_META_OAUTH",status,message});
 return new Response("<!doctype html><html lang='th'><meta charset='utf-8'><title>Meta connection</title><body style='font:16px sans-serif;background:#090d1e;color:#e2e8f0;padding:32px'><p>"+(status==="connected"?"เชื่อมต่อ Meta สำเร็จ":"การเชื่อมต่อ Meta ไม่สำเร็จ")+"</p><script>const data="+payload+";if(window.opener){window.opener.postMessage(data,'"+ORIGIN+"');}setTimeout(()=>window.close(),900);</script></body></html>",{status:200,headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
}
async function graphGet(env,path,params={}) {
 const url=new URL("https://graph.facebook.com/"+graphVersion(env)+"/"+path.replace(/^\/+/,""));
 for(const [key,value] of Object.entries(params)) if(value!==undefined&&value!==null) url.searchParams.set(key,String(value));
 const response=await fetch(url.toString(),{headers:{"Accept":"application/json"}});
 const body=await response.json().catch(()=>({}));
 if(!response.ok||body.error) throw new Error("Meta Graph API request failed: "+safeText(body.error?.message||response.statusText,300));
 return body;
}
async function exchangeMetaCode(env,code) {
 const tokenUrl=new URL("https://graph.facebook.com/"+graphVersion(env)+"/oauth/access_token");
 tokenUrl.searchParams.set("client_id",env.META_APP_ID);
 tokenUrl.searchParams.set("client_secret",env.META_APP_SECRET);
 tokenUrl.searchParams.set("redirect_uri",env.META_REDIRECT_URI);
 tokenUrl.searchParams.set("code",code);
 let response=await fetch(tokenUrl.toString());
 let body=await response.json().catch(()=>({}));
 if(!response.ok||body.error||!body.access_token) throw new Error("Meta authorization code exchange failed");
 const longUrl=new URL("https://graph.facebook.com/"+graphVersion(env)+"/oauth/access_token");
 longUrl.searchParams.set("grant_type","fb_exchange_token");
 longUrl.searchParams.set("client_id",env.META_APP_ID);
 longUrl.searchParams.set("client_secret",env.META_APP_SECRET);
 longUrl.searchParams.set("fb_exchange_token",body.access_token);
 response=await fetch(longUrl.toString());
 const longBody=await response.json().catch(()=>({}));
 if(!response.ok||longBody.error||!longBody.access_token) throw new Error("Meta long-lived token exchange failed");
 return {access_token:longBody.access_token,expires_in:Number(longBody.expires_in)||0};
}
async function saveMetaAccount(env,user,platform,externalId,name,accessToken,expiresAt,scopes,pictureUrl=null) {
 const id=random(16),encrypted=await encrypt(accessToken,env),stamp=now();
 await env.DB.prepare("INSERT INTO social_accounts(id,owner_user_id,platform,external_account_id,account_name,profile_picture_url,status,scopes_json,token_expires_at,encrypted_access_token,encrypted_refresh_token,created_at,updated_at) VALUES(?,?,?,?,?,?,'connected',?,?,?,NULL,?,?) ON CONFLICT(owner_user_id,platform,external_account_id) DO UPDATE SET account_name=excluded.account_name,profile_picture_url=excluded.profile_picture_url,status='connected',scopes_json=excluded.scopes_json,token_expires_at=excluded.token_expires_at,encrypted_access_token=excluded.encrypted_access_token,updated_at=excluded.updated_at")
 .bind(id,user.id,platform,externalId,safeText(name,160),pictureUrl,JSON.stringify(scopes),expiresAt,encrypted,stamp,stamp).run();
 await audit(env,user.id,"meta_account_connected","account",externalId,user.email,{platform,account_name:safeText(name,160)});
}
async function finishMetaOAuth(request,env,url) {
 const error=url.searchParams.get("error");
 const state=url.searchParams.get("state");
 if(error) return metaResultPage("error","Meta authorization was cancelled or denied");
 const code=url.searchParams.get("code");
 if(!state||!code) return metaResultPage("error","Missing authorization response");
 const stateHash=await sha(state);
 const stateRow=await env.DB.prepare("SELECT owner_user_id,expires_at FROM oauth_states WHERE state_hash=? AND platform='meta'").bind(stateHash).first();
 if(!stateRow||stateRow.expires_at<=now()) return metaResultPage("error","OAuth state is invalid or expired");
 await env.DB.prepare("DELETE FROM oauth_states WHERE state_hash=?").bind(stateHash).run();
 try {
  if(!metaConfigured(env)) throw new Error("Meta OAuth credentials are not configured");
  const userRow=await env.DB.prepare("SELECT id,email FROM app_users WHERE id=?").bind(stateRow.owner_user_id).first();
  if(!userRow) throw new Error("Social Commerce user no longer exists");
  const token=await exchangeMetaCode(env,code);
  const scopes=metaScopes(env);
  const expiresAt=token.expires_in>0?new Date(Date.now()+token.expires_in*1000).toISOString():null;
  const profile=await graphGet(env,"me",{fields:"id,name",access_token:token.access_token});
  const pages=await graphGet(env,"me/accounts",{fields:"id,name,access_token,tasks,instagram_business_account{id,username,profile_picture_url}",limit:100,access_token:token.access_token});
  let savedPages=0,savedInstagram=0;
  for(const page of (pages.data||[])) {
   if(!page.id||!page.access_token) continue;
   await saveMetaAccount(env,userRow,"facebook",page.id,page.name||"Facebook Page",page.access_token,expiresAt,scopes);
   savedPages++;
   const ig=page.instagram_business_account;
   if(ig?.id) {
    await saveMetaAccount(env,userRow,"instagram",ig.id,ig.username||"Instagram Professional",page.access_token,expiresAt,scopes,ig.profile_picture_url||null);
    savedInstagram++;
   }
  }
  await audit(env,userRow.id,"meta_oauth_completed","integration",profile.id,userRow.email,{facebook_pages:savedPages,instagram_accounts:savedInstagram,scopes});
  return metaResultPage("connected","Facebook Pages: "+savedPages+" · Instagram: "+savedInstagram);
 } catch(e) {
  console.error("meta-oauth-callback",{message:safeText(e?.message||"unknown",240)});
  return metaResultPage("error","Meta connection could not be completed. Check Worker logs and app configuration.");
 }
}
async function handleWebhook(request,env,url) {
 if(request.method==="GET") {
  const mode=url.searchParams.get("hub.mode");
  const challenge=url.searchParams.get("hub.challenge");
  const verify=url.searchParams.get("hub.verify_token");
  if(mode==="subscribe"&&challenge&&env.META_WEBHOOK_VERIFY_TOKEN&&verify===env.META_WEBHOOK_VERIFY_TOKEN) return new Response(challenge,{status:200,headers:{"Content-Type":"text/plain","Cache-Control":"no-store"}});
  return new Response("Forbidden",{status:403});
 }
 if(request.method!=="POST") return new Response("Method Not Allowed",{status:405});
 if(!env.META_APP_SECRET) return json({error:"Meta webhook secret is not configured"},503);
 const raw=await request.text();
 if(raw.length>1024*1024) return json({error:"Webhook payload too large"},413);
 const signature=request.headers.get("X-Hub-Signature-256")||"";
 if(!await verifyMetaSignature(raw,signature,env.META_APP_SECRET)) return json({error:"Invalid webhook signature"},401);
 let payload;
 try { payload=JSON.parse(raw); } catch { return json({error:"Invalid JSON payload"},400); }
 if(!payload||typeof payload.object!=="string"||!Array.isArray(payload.entry)) return json({error:"Invalid Meta webhook shape"},422);
 const eventHash=await sha(raw);
 await env.DB.prepare("INSERT OR IGNORE INTO meta_webhook_events(id,event_hash,object_type,entry_count,payload_json,received_at) VALUES(?,?,?,?,?,?)")
  .bind(random(16),eventHash,safeText(payload.object,80),payload.entry.length,JSON.stringify(payload),now()).run();
 return json({ok:true,duplicate:false});
}
async function handle(request,env) {
 const url=new URL(request.url),path=url.pathname.replace(/^\/api\/social-commerce/,"")||"/",method=request.method;
 if(method==="OPTIONS") return new Response(null,{status:204,headers:cors(request)});
 if(path==="/webhooks/meta") return handleWebhook(request,env,url);
 if(method==="GET"&&path==="/oauth/meta/callback") return finishMetaOAuth(request,env,url);
 if(method==="GET"&&path==="/health") {
  const setup=!!env.BOOTSTRAP_KEY&&!!env.TOKEN_ENCRYPTION_KEY;
  const users=await env.DB.prepare("SELECT COUNT(*) n FROM app_users").first();
  return json({service:"Alpha Centauri Social Commerce Cloud API",status:"online",mode:"cloud",setup_ready:setup,admin_initialized:(users?.n||0)>0,publishing_enabled:false,meta_oauth_configured:metaConfigured(env),meta_webhook_configured:webhookConfigured(env),meta_redirect_uri:env.META_REDIRECT_URI||null,platforms:Object.fromEntries(PLATFORMS.map(p=>[p,p==="facebook"||p==="instagram"?(metaConfigured(env)?"oauth_ready":"oauth_not_configured"):"oauth_not_configured"]))},200,cors(request));
 }
 if(method==="POST"&&path==="/auth/bootstrap") {
  if(!env.BOOTSTRAP_KEY||(request.headers.get("Authorization")||"").replace(/^Bootstrap\s+/i,"")!==env.BOOTSTRAP_KEY) return json({error:"Invalid bootstrap key"},403,cors(request));
  const count=await env.DB.prepare("SELECT COUNT(*) n FROM app_users").first();
  if(count.n>0) return json({error:"Initial administrator already exists"},409,cors(request));
  const body=await request.json();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email||"")||(body.password||"").length<14) return json({error:"Valid email and password of at least 14 characters are required"},422,cors(request));
  const id=random(16),salt=random(16),hash=await passwordHash(body.password,salt,env);
  await env.DB.prepare("INSERT INTO app_users(id,email,password_hash,password_salt,created_at) VALUES(?,?,?,?,?)").bind(id,body.email.toLowerCase(),hash,salt,now()).run();
  await audit(env,id,"admin_bootstrapped","user",id,body.email);
  return json(await newSession(env,{id,email:body.email.toLowerCase()}),201,cors(request));
 }
 if(method==="POST"&&path==="/auth/login") {
  const body=await request.json();
  const user=await env.DB.prepare("SELECT id,email,password_hash,password_salt FROM app_users WHERE email=?").bind((body.email||"").toLowerCase()).first();
  if(!user||await passwordHash(body.password||"",user.password_salt,env)!==user.password_hash) return json({error:"Invalid email or password"},401,cors(request));
  return json(await newSession(env,user),200,cors(request));
 }
 const user=await sessionUser(request,env);
 if(!user) return json({error:"Authentication required"},401,cors(request));
 if(method==="GET"&&path==="/auth/me") return json({user},200,cors(request));
 if(method==="POST"&&path==="/auth/logout") {
  const token=(request.headers.get("Authorization")||"").replace(/^Bearer\s+/i,"");
  await env.DB.prepare("DELETE FROM user_sessions WHERE token_hash=?").bind(await sha(token)).run();
  return json({ok:true},200,cors(request));
 }
 if(method==="POST"&&path==="/oauth/meta/start") {
  if(!metaConfigured(env)) return json({error:"Meta OAuth credentials are not configured on the Cloudflare Worker"},503,cors(request));
  const state=random(32),stamp=now(),expiry=new Date(Date.now()+10*60*1000).toISOString();
  await env.DB.prepare("INSERT INTO oauth_states(state_hash,owner_user_id,platform,expires_at,created_at) VALUES(?,?,'meta',?,?)").bind(await sha(state),user.id,expiry,stamp).run();
  return json({authorization_url:buildMetaAuthorizationUrl(env,state),expires_at:expiry,redirect_uri:env.META_REDIRECT_URI,scopes:metaScopes(env)},200,cors(request));
 }
 if(method==="GET"&&path==="/accounts") {
  const {results=[]}=await env.DB.prepare("SELECT id,platform,external_account_id,account_name,profile_picture_url,status,scopes_json,token_expires_at,created_at,updated_at FROM social_accounts WHERE owner_user_id=? ORDER BY platform,account_name").bind(user.id).all();
  return json({accounts:results.map(a=>({...a,scopes:JSON.parse(a.scopes_json)}))},200,cors(request));
 }
 if(method==="POST"&&path==="/accounts") {
  const b=await request.json();
  if(!PLATFORMS.includes(b.platform)||!b.external_account_id||!b.account_name) return json({error:"OAuth-created account identity is required"},422,cors(request));
  return json({error:"Manual account creation is disabled; connect through verified OAuth or an approved affiliate adapter."},409,cors(request));
 }
 const accountMatch=path.match(/^\/accounts\/([a-zA-Z0-9_-]+)$/);
 if(method==="DELETE"&&accountMatch) {
  const a=await env.DB.prepare("SELECT id,platform FROM social_accounts WHERE id=? AND owner_user_id=?").bind(accountMatch[1],user.id).first();
  if(!a) return json({error:"Account not found"},404,cors(request));
  await env.DB.prepare("UPDATE social_accounts SET status='disconnected',encrypted_access_token=NULL,encrypted_refresh_token=NULL,updated_at=? WHERE id=? AND owner_user_id=?").bind(now(),a.id,user.id).run();
  await audit(env,user.id,"account_disconnected","account",a.id,user.email,{platform:a.platform});
  return json({id:a.id,status:"disconnected"},200,cors(request));
 }
 if(method==="GET"&&path==="/content") {
  const status=url.searchParams.get("status");
  const q=status?env.DB.prepare("SELECT * FROM content_items WHERE owner_user_id=? AND status=? ORDER BY updated_at DESC").bind(user.id,status):env.DB.prepare("SELECT * FROM content_items WHERE owner_user_id=? ORDER BY updated_at DESC").bind(user.id);
  const {results=[]}=await q.all();
  return json({items:results.map(x=>({...x,platforms:JSON.parse(x.platforms_json),account_ids:JSON.parse(x.account_ids_json)}))},200,cors(request));
 }
 if(method==="POST"&&path==="/content") {
  const b=await request.json();
  if(!b.title||!b.body||!Array.isArray(b.platforms)||!Array.isArray(b.account_ids)||!b.account_ids.length) return json({error:"Title, body, platforms and target accounts are required"},422,cors(request));
  if(b.platforms.some(p=>!PLATFORMS.includes(p))) return json({error:"Unsupported platform"},422,cors(request));
  if(b.platforms.some(p=>p.endsWith("_affiliate"))&&!String(b.disclosure||"").trim()) return json({error:"Affiliate disclosure is required"},422,cors(request));
  const marks=b.account_ids.map(()=>"?").join(",");
  const {results:accounts=[]}=await env.DB.prepare("SELECT id,platform FROM social_accounts WHERE owner_user_id=? AND id IN ("+marks+")").bind(user.id,...b.account_ids).all();
  if(accounts.length!==b.account_ids.length||accounts.some(a=>!b.platforms.includes(a.platform))) return json({error:"Invalid account destinations"},422,cors(request));
  const id=random(16),stamp=now();
  await env.DB.prepare("INSERT INTO content_items(id,owner_user_id,title,body,affiliate_url,disclosure,platforms_json,account_ids_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
   .bind(id,user.id,b.title,b.body,b.affiliate_url||null,b.disclosure||"",JSON.stringify(b.platforms),JSON.stringify(b.account_ids),"draft",stamp,stamp).run();
  await audit(env,user.id,"content_draft_created","content",id,user.email,{platforms:b.platforms});
  return json({id,status:"draft"},201,cors(request));
 }
 const submit=path.match(/^\/content\/([a-zA-Z0-9_-]+)\/submit$/);
 if(method==="POST"&&submit) {
  const item=await env.DB.prepare("SELECT status FROM content_items WHERE id=? AND owner_user_id=?").bind(submit[1],user.id).first();
  if(!item) return json({error:"Content not found"},404,cors(request));
  if(!["draft","rejected"].includes(item.status)) return json({error:"Invalid content state"},409,cors(request));
  await env.DB.prepare("UPDATE content_items SET status='pending_approval',updated_at=? WHERE id=? AND owner_user_id=?").bind(now(),submit[1],user.id).run();
  await audit(env,user.id,"content_submitted_for_approval","content",submit[1],user.email);
  return json({id:submit[1],status:"pending_approval"},200,cors(request));
 }
 const decision=path.match(/^\/content\/([a-zA-Z0-9_-]+)\/decision$/);
 if(method==="POST"&&decision) {
  const b=await request.json(),status=b.decision==="approve"?"approved":b.decision==="reject"?"rejected":null;
  if(!status) return json({error:"Invalid decision"},422,cors(request));
  const item=await env.DB.prepare("SELECT status FROM content_items WHERE id=? AND owner_user_id=?").bind(decision[1],user.id).first();
  if(!item) return json({error:"Content not found"},404,cors(request));
  if(item.status!=="pending_approval") return json({error:"Content is not awaiting approval"},409,cors(request));
  await env.DB.prepare("UPDATE content_items SET status=?,updated_at=?,approved_at=?,approved_by=?,rejection_reason=? WHERE id=? AND owner_user_id=?")
   .bind(status,now(),status==="approved"?now():null,status==="approved"?user.email:null,b.reason||null,decision[1],user.id).run();
  await audit(env,user.id,"content_"+b.decision,"content",decision[1],user.email,{reason:b.reason||""});
  return json({id:decision[1],status},200,cors(request));
 }
 if(method==="GET"&&path==="/audit") {
  const {results=[]}=await env.DB.prepare("SELECT id,event_type,entity_type,entity_id,actor,details_json,created_at FROM audit_events WHERE owner_user_id=? ORDER BY created_at DESC LIMIT 200").bind(user.id).all();
  return json({events:results.map(e=>({...e,details:JSON.parse(e.details_json)}))},200,cors(request));
 }
 return json({error:"Not found"},404,cors(request));
}
export default { async fetch(request,env) {
 const headers=cors(request);
 try { return await handle(request,env); }
 catch(e) { console.error("social-commerce-api",{name:e?.name||"Error",message:safeText(e?.message||"unknown",300)}); return json({error:"Internal server error"},500,headers); }
}};
