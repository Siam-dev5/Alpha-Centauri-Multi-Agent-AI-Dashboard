const ORIGIN = "https://siam-dev5.github.io";
// The Dashboard is served both from GitHub Pages and from this Worker's own origin.
const DASHBOARD_ORIGINS = [ORIGIN, "https://social-api.siamhrbp.com"];
const PLATFORMS = ["facebook","instagram","youtube","tiktok","shopee_affiliate","lazada_affiliate"];
const now = () => new Date().toISOString();
const json = (data,status=200,headers={}) => new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store",...headers}});
const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const unb64 = (value) => Uint8Array.from(atob(value.replace(/-/g,"+").replace(/_/g,"/")),c=>c.charCodeAt(0));
const random = (n=32) => { const a=new Uint8Array(n); crypto.getRandomValues(a); return b64(a); };
const sha = async (v) => b64(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(v)));
const cors = (request) => {
 const origin=request.headers.get("Origin")||"";
 const headers={"Access-Control-Allow-Methods":"GET,POST,DELETE,OPTIONS","Access-Control-Allow-Headers":"Authorization,Content-Type,X-Bootstrap-Key,Idempotency-Key","Vary":"Origin"};
 if(DASHBOARD_ORIGINS.includes(origin)) headers["Access-Control-Allow-Origin"]=origin;
 return headers;
};
const graphVersion = (env) => (env.META_GRAPH_API_VERSION||"v27.0").trim();
const metaConfigId = (env,platform) => platform==="instagram"?(env.META_IG_CONFIG_ID||"").trim():(env.META_FB_CONFIG_ID||"").trim();
const metaConfigured = (env,platform) => !!(env.META_APP_ID&&env.META_APP_SECRET&&env.META_REDIRECT_URI&&metaConfigId(env,platform));
const metaAnyConfigured = (env) => metaConfigured(env,"instagram")||metaConfigured(env,"facebook");
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
export function facebookPublishReadiness(scopes=[],tasks=[]) {
 const granted=new Set(Array.isArray(scopes)?scopes:[]);
 const assigned=new Set(Array.isArray(tasks)?tasks:[]);
 const missing=[];
 if(!granted.has("pages_manage_posts")) missing.push("pages_manage_posts");
 if(!(assigned.has("CREATE_CONTENT")||assigned.has("MANAGE"))) missing.push("Page task CREATE_CONTENT");
 return {ready:missing.length===0,missing};
}
// Text posts use the Page feed edge; photo posts use the Page photos edge.
export function facebookPublishUrl(env,pageId,kind="text") {
 return "https://graph.facebook.com/"+graphVersion(env)+"/"+encodeURIComponent(pageId)+"/"+(kind==="photo"?"photos":"feed");
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
export function buildMetaAuthorizationUrl(env,state,platform="instagram") {
 const configId=metaConfigId(env,platform);
 if(!metaConfigured(env,platform)) throw new Error("Meta "+platform+" Unified Login configuration is not configured");
 const url=new URL("https://www.facebook.com/"+graphVersion(env)+"/dialog/oauth");
 url.searchParams.set("client_id",env.META_APP_ID);
 url.searchParams.set("config_id",configId);
 url.searchParams.set("redirect_uri",env.META_REDIRECT_URI);
 url.searchParams.set("state",state);
 url.searchParams.set("response_type","code");
 return url.toString();
}
function metaResultPage(status,message) {
 const payload=JSON.stringify({type:"ALPHA_CENTAURI_META_OAUTH",status,message});
 return new Response("<!doctype html><html lang='th'><meta charset='utf-8'><title>Meta connection</title><body style='font:16px sans-serif;background:#090d1e;color:#e2e8f0;padding:32px'><p>"+(status==="connected"?"เชื่อมต่อ Meta สำเร็จ":"การเชื่อมต่อ Meta ไม่สำเร็จ")+"</p><script>const data="+payload+";if(window.opener){for(const o of "+JSON.stringify(DASHBOARD_ORIGINS)+"){try{window.opener.postMessage(data,o);}catch(e){}}}setTimeout(()=>window.close(),900);</script></body></html>",{status:200,headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
}
// ---- "แอดมินโซเชียล" auto-like: the connected Page likes its own posts only ----
const AUTO_LIKE_MAX_PER_RUN=5, AUTO_LIKE_SCAN_LIMIT=10, AUTO_LIKE_MAX_BACKFILL=5;
export function autoLikeReadiness(scopes=[],tasks=[]) {
 const granted=new Set(Array.isArray(scopes)?scopes:[]),assigned=new Set(Array.isArray(tasks)?tasks:[]),missing=[];
 if(!granted.has("pages_manage_engagement")) missing.push("pages_manage_engagement");
 if(!granted.has("pages_read_engagement")) missing.push("pages_read_engagement");
 if(!(assigned.has("CREATE_CONTENT")||assigned.has("MANAGE"))) missing.push("Page task CREATE_CONTENT");
 return {ready:missing.length===0,missing};
}
// Only posts authored by this Page: the id must be "<pageId>_<postId>" and, when present, from.id must be the Page.
export function filterOwnPagePosts(pageId,posts=[]) {
 const id=String(pageId);
 return (Array.isArray(posts)?posts:[]).filter(p=>p&&typeof p.id==="string"&&p.id.startsWith(id+"_")&&(!p.from||String(p.from.id)===id));
}
async function listOwnPagePosts(env,pageId,token,limit=AUTO_LIKE_SCAN_LIMIT) {
 const data=await graphGet(env,encodeURIComponent(pageId)+"/posts",{fields:"id,created_time,from,message,permalink_url",limit,access_token:token});
 return filterOwnPagePosts(pageId,data.data).sort((a,b)=>Date.parse(b.created_time||0)-Date.parse(a.created_time||0));
}
async function queuePageLike(env,account,post,source) {
 const stamp=now();
 const r=await env.DB.prepare("INSERT OR IGNORE INTO page_post_likes(id,owner_user_id,account_id,page_id,post_id,post_created_time,post_permalink,post_message_preview,source,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?)")
  .bind(random(16),account.owner_user_id,account.id,String(account.external_account_id),post.id,post.created_time||null,post.permalink_url||null,safeText(post.message||"",120),source,stamp,stamp).run();
 return (r.meta?.changes||0)===1;
}
async function likePagePost(env,postId,token) {
 const body=new FormData();
 body.set("access_token",token);
 if(env.META_APP_SECRET) {
  const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(env.META_APP_SECRET),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const proof=await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(token));
  body.set("appsecret_proof",Array.from(new Uint8Array(proof),b=>b.toString(16).padStart(2,"0")).join(""));
 }
 const response=await fetch("https://graph.facebook.com/"+graphVersion(env)+"/"+encodeURIComponent(postId)+"/likes",{method:"POST",body,headers:{Accept:"application/json"}});
 const meta=await response.json().catch(()=>({}));
 return {ok:response.ok&&!meta.error&&meta.success===true,error:meta.error?.message||(!response.ok?response.statusText:null)};
}
// Queue new Page posts (created after enabled_at), then like pending ledger rows. Safe to run concurrently:
// the ledger is UNIQUE(account_id,post_id) and each row is claimed with a pending->liking update.
export async function runAutoLikeForAccount(env,account,settings,actor) {
 const summary={account_id:account.id,page:account.account_name,scanned:0,queued:0,liked:0,failed:0,unknown:0};
 const readiness=autoLikeReadiness(JSON.parse(account.scopes_json||"[]"),JSON.parse(account.page_tasks_json||"[]"));
 if(account.status!=="connected"||!account.encrypted_access_token||!readiness.ready) { summary.error="Page not ready for auto-like: "+(readiness.missing.join(", ")||"not connected"); return summary; }
 const token=await decrypt(account.encrypted_access_token,env);
 try {
  const posts=await listOwnPagePosts(env,account.external_account_id,token);
  summary.scanned=posts.length;
  const since=Date.parse(settings.enabled_at||"");
  for(const post of posts) if(Number.isFinite(since)&&Date.parse(post.created_time||0)>since&&await queuePageLike(env,account,post,"auto")) summary.queued++;
 } catch(error) { summary.error=safeText(error?.message||"Could not list Page posts",300); }
 const {results:pending=[]}=await env.DB.prepare("SELECT id,post_id,source FROM page_post_likes WHERE account_id=? AND status='pending' ORDER BY post_created_time LIMIT ?").bind(account.id,AUTO_LIKE_MAX_PER_RUN).all();
 for(const row of pending) {
  const claim=await env.DB.prepare("UPDATE page_post_likes SET status='liking',updated_at=? WHERE id=? AND status='pending'").bind(now(),row.id).run();
  if((claim.meta?.changes||0)!==1) continue;
  let result;
  try { result=await likePagePost(env,row.post_id,token); }
  catch {
   await env.DB.prepare("UPDATE page_post_likes SET status='unknown',error_message=?,updated_at=? WHERE id=?").bind("Network error after like request; not retried automatically.",now(),row.id).run();
   await audit(env,account.owner_user_id,"page_post_like_unknown","page_post",row.post_id,actor,{account_id:account.id,source:row.source});
   summary.unknown++; continue;
  }
  if(result.ok) {
   await env.DB.prepare("UPDATE page_post_likes SET status='liked',error_message=NULL,liked_at=?,updated_at=? WHERE id=?").bind(now(),now(),row.id).run();
   await audit(env,account.owner_user_id,"page_post_liked","page_post",row.post_id,actor,{account_id:account.id,source:row.source});
   summary.liked++;
  } else {
   const message=safeText(result.error||"Facebook did not confirm the like",300);
   await env.DB.prepare("UPDATE page_post_likes SET status='failed',error_message=?,updated_at=? WHERE id=?").bind(message,now(),row.id).run();
   await audit(env,account.owner_user_id,"page_post_like_failed","page_post",row.post_id,actor,{account_id:account.id,source:row.source,error:message});
   summary.failed++;
  }
 }
 await env.DB.prepare("UPDATE auto_like_settings SET last_run_at=?,last_run_result=?,updated_at=? WHERE account_id=?").bind(now(),JSON.stringify(summary),now(),account.id).run();
 return summary;
}
const AUTO_LIKE_ACCOUNT_SQL="SELECT id,owner_user_id,external_account_id,account_name,status,scopes_json,page_tasks_json,encrypted_access_token FROM social_accounts";
export async function runScheduledAutoLike(env) {
 const {results=[]}=await env.DB.prepare("SELECT s.account_id,s.enabled_at FROM auto_like_settings s JOIN social_accounts a ON a.id=s.account_id WHERE s.enabled=1 AND a.platform='facebook' AND a.status='connected'").all();
 const out=[];
 for(const s of results) {
  const account=await env.DB.prepare(AUTO_LIKE_ACCOUNT_SQL+" WHERE id=? AND platform='facebook'").bind(s.account_id).first();
  if(!account) continue;
  try { out.push(await runAutoLikeForAccount(env,account,s,"auto_like_cron")); }
  catch(error) { console.error("auto-like",{account:s.account_id,message:safeText(error?.message||"unknown",200)}); }
 }
 return out;
}
async function graphGet(env,path,params={}) {
 const url=new URL("https://graph.facebook.com/"+graphVersion(env)+"/"+path.replace(/^\/+/, ""));
 const query={...params};
 if(query.access_token&&env.META_APP_SECRET) {
  const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(env.META_APP_SECRET),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const proof=await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(String(query.access_token)));
  query.appsecret_proof=Array.from(new Uint8Array(proof),b=>b.toString(16).padStart(2,"0")).join("");
 }
 for(const [key,value] of Object.entries(query)) if(value!==undefined&&value!==null) url.searchParams.set(key,String(value));
 const response=await fetch(url.toString(),{headers:{"Accept":"application/json"}});
 const body=await response.json().catch(()=>({}));
 if(!response.ok||body.error) throw new Error("Meta Graph API request failed: "+safeText(body.error?.message||response.statusText,300));
 return body;
}
async function grantedMetaPermissions(env,accessToken) {
 const result=await graphGet(env,"me/permissions",{access_token:accessToken});
 if(!Array.isArray(result.data)) throw new Error("Meta permissions response was incomplete; reconnect the account and try again.");
 return result.data.filter(item=>item&&item.status==="granted"&&typeof item.permission==="string").map(item=>item.permission).sort();
}
async function exchangeMetaCode(env,code) {
 const tokenUrl=new URL("https://graph.facebook.com/"+graphVersion(env)+"/oauth/access_token");
 tokenUrl.searchParams.set("client_id",env.META_APP_ID);
 tokenUrl.searchParams.set("client_secret",env.META_APP_SECRET);
 tokenUrl.searchParams.set("redirect_uri",env.META_REDIRECT_URI);
 tokenUrl.searchParams.set("code",code);
 const response=await fetch(tokenUrl.toString());
 const body=await response.json().catch(()=>({}));
 if(!response.ok||body.error||!body.access_token) {
  const metaMessage=safeText(body.error?.message||response.statusText||"unknown Meta token exchange error",240);
  const metaCode=body.error?.code?"; code "+body.error.code:"";
  const metaSubcode=body.error?.error_subcode?"; subcode "+body.error.error_subcode:"";
  throw new Error("Meta authorization code exchange failed: "+metaMessage+metaCode+metaSubcode);
}
 return {access_token:body.access_token,expires_in:Number(body.expires_in)||0,token_type:body.token_type||null};
}
async function saveMetaAccount(env,user,platform,externalId,name,accessToken,expiresAt,scopes,pictureUrl=null,pageTasks=[]) {
 const id=random(16),encrypted=await encrypt(accessToken,env),stamp=now();
 await env.DB.prepare("INSERT INTO social_accounts(id,owner_user_id,platform,external_account_id,account_name,profile_picture_url,status,scopes_json,page_tasks_json,token_expires_at,encrypted_access_token,encrypted_refresh_token,created_at,updated_at) VALUES(?,?,?,?,?,?,'connected',?,?,?,?,NULL,?,?) ON CONFLICT(owner_user_id,platform,external_account_id) DO UPDATE SET account_name=excluded.account_name,profile_picture_url=excluded.profile_picture_url,status='connected',scopes_json=excluded.scopes_json,page_tasks_json=excluded.page_tasks_json,token_expires_at=excluded.token_expires_at,encrypted_access_token=excluded.encrypted_access_token,updated_at=excluded.updated_at")
 .bind(id,user.id,platform,externalId,safeText(name,160),pictureUrl,JSON.stringify(scopes),JSON.stringify(pageTasks),expiresAt,encrypted,stamp,stamp).run();
 await audit(env,user.id,"meta_account_connected","account",externalId,user.email,{platform,account_name:safeText(name,160)});
}
async function finishMetaOAuth(request,env,url) {
 const error=url.searchParams.get("error");
 const state=url.searchParams.get("state");
 if(error) return metaResultPage("error","Meta authorization was cancelled or denied");
 const code=url.searchParams.get("code");
 if(!state||!code) return metaResultPage("error","Missing authorization response");
 const stateHash=await sha(state);
 const stateRow=await env.DB.prepare("SELECT owner_user_id,platform,expires_at FROM oauth_states WHERE state_hash=? AND platform IN ('meta_instagram','meta_facebook')").bind(stateHash).first();
 if(!stateRow||stateRow.expires_at<=now()) return metaResultPage("error","OAuth state is invalid or expired");
 await env.DB.prepare("DELETE FROM oauth_states WHERE state_hash=?").bind(stateHash).run();
 const platform=stateRow.platform==="meta_instagram"?"instagram":"facebook";
 let stage="token_exchange";
 try {
  if(!metaConfigured(env,platform)) throw new Error("Meta "+platform+" configuration is missing");
  const userRow=await env.DB.prepare("SELECT id,email FROM app_users WHERE id=?").bind(stateRow.owner_user_id).first();
  if(!userRow) throw new Error("Social Commerce user no longer exists");
  const token=await exchangeMetaCode(env,code);
  const expiresAt=token.expires_in>0?new Date(Date.now()+token.expires_in*1000).toISOString():null;
  stage="permission_discovery";
  const grantedScopes=await grantedMetaPermissions(env,token.access_token);
  let savedAccounts=0;
  if(platform==="instagram") {
   stage="instagram_asset_discovery";
   const accounts=await graphGet(env,"me/assigned_instagram_accounts",{fields:"id,username,profile_picture_url",limit:100,access_token:token.access_token});
   for(const account of (accounts.data||[])) {
    if(!account.id) continue;
    await saveMetaAccount(env,userRow,"instagram",account.id,account.username||"Instagram Professional",token.access_token,expiresAt,grantedScopes,account.profile_picture_url||null);
    savedAccounts++;
   }
  } else {
   stage="facebook_page_discovery";
   const pages=await graphGet(env,"me/accounts",{fields:"id,name,access_token,tasks",limit:100,access_token:token.access_token});
   let pageBatch=pages,pageBatches=0;
   while(pageBatch&&pageBatches<20) {
    for(const page of (pageBatch.data||[])) {
     if(!page.id||!page.access_token) continue;
     stage="persist_facebook_page";
     await saveMetaAccount(env,userRow,"facebook",page.id,page.name||"Facebook Page",page.access_token,expiresAt,grantedScopes,null,Array.isArray(page.tasks)?page.tasks:[]);
     savedAccounts++;
    }
    const cursor=pageBatch.paging?.cursors?.after||null;
    if(!cursor||!pageBatch.paging?.next) break;
    pageBatch=await graphGet(env,"me/accounts",{fields:"id,name,access_token,tasks",limit:100,after:cursor,access_token:token.access_token});
    pageBatches++;
   }
  }
  if(savedAccounts===0) {
   stage="empty_asset_result";
   throw new Error("OAuth completed but no assigned "+platform+" assets were returned. Check the selected Business Login configuration and asset assignments.");
  }
  await audit(env,userRow.id,"meta_oauth_completed","integration",platform,userRow.email,{platform,accounts:savedAccounts,granted_permissions:grantedScopes,token_type:token.token_type,expires_at:expiresAt});
  return metaResultPage("connected",platform==="instagram"?"Instagram accounts: "+savedAccounts:"Facebook Pages: "+savedAccounts);
 } catch(e) {
  const diagnostic=safeText(e?.message||"unknown Meta OAuth error",300);
  console.error("meta-oauth-callback",{platform,stage,message:diagnostic});
  try {
   await audit(env,stateRow.owner_user_id,"meta_oauth_failed","integration",platform,"meta-oauth-callback",{platform,stage,error:diagnostic});
  } catch(auditError) {
   console.error("meta-oauth-diagnostic-write-failed",{message:safeText(auditError?.message||"unknown",160)});
  }
  return metaResultPage("error","Meta connection failed during "+stage+". Diagnostic has been recorded for the system administrator.");
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
 const saved=await env.DB.prepare("INSERT OR IGNORE INTO meta_webhook_events(id,event_hash,object_type,entry_count,payload_json,received_at) VALUES(?,?,?,?,?,?)")
  .bind(random(16),eventHash,safeText(payload.object,80),payload.entry.length,JSON.stringify(payload),now()).run();
 return json({ok:true,duplicate:(saved.meta?.changes||0)===0});
}
// Browser navigations to the bare origin receive the Dashboard (Workers Static Assets).
// Every other request, including GET / from API clients and monitors that do not ask
// for HTML, keeps the existing JSON health response and API routes.
export function wantsDashboard(request,url,env) {
 if(!env?.ASSETS||url.pathname!=="/") return false;
 if(request.method!=="GET"&&request.method!=="HEAD") return false;
 return (request.headers.get("Accept")||"").toLowerCase().includes("text/html");
}
async function serveDashboard(request,env) {
 const asset=await env.ASSETS.fetch(new Request(new URL("/",request.url),{method:request.method,headers:request.headers}));
 if(!asset.ok) return json({error:"Dashboard unavailable"},503);
 const headers=new Headers(asset.headers);
 headers.set("Cache-Control","no-cache");
 headers.set("Vary","Accept");
 headers.set("X-Content-Type-Options","nosniff");
 headers.set("Referrer-Policy","strict-origin-when-cross-origin");
 headers.set("X-Frame-Options","DENY");
 return new Response(asset.body,{status:200,headers});
}
async function handle(request,env) {
 const url=new URL(request.url),path=url.pathname.replace(/^\/api\/social-commerce/,"")||"/",method=request.method;
 if(method==="OPTIONS") return new Response(null,{status:204,headers:cors(request)});
 if(wantsDashboard(request,url,env)) return serveDashboard(request,env);
 if(path==="/webhooks/meta") return handleWebhook(request,env,url);
 if(method==="GET"&&path==="/oauth/meta/callback") return finishMetaOAuth(request,env,url);
 if(method==="GET"&&(path==="/"||path==="/health")) {
  const setup=!!env.BOOTSTRAP_KEY&&!!env.TOKEN_ENCRYPTION_KEY;
  const users=await env.DB.prepare("SELECT COUNT(*) n FROM app_users").first();
  const {results:facebookAccounts=[]}=await env.DB.prepare("SELECT scopes_json,page_tasks_json FROM social_accounts WHERE platform='facebook' AND status='connected'").all();
  const publishReadyAccounts=facebookAccounts.filter(a=>facebookPublishReadiness(JSON.parse(a.scopes_json||"[]"),JSON.parse(a.page_tasks_json||"[]")).ready).length;
  return json({service:"Alpha Centauri Social Commerce Cloud API",status:"online",mode:"cloud",setup_ready:setup,admin_initialized:(users?.n||0)>0,publishing_enabled:publishReadyAccounts>0,publishing_adapter_enabled:true,publishing_adapter:"facebook_page_photo",publishing_formats:["text","photo"],publish_ready_accounts:publishReadyAccounts,meta_oauth_configured:metaAnyConfigured(env),meta_instagram_configured:metaConfigured(env,"instagram"),meta_facebook_configured:metaConfigured(env,"facebook"),meta_webhook_configured:webhookConfigured(env),meta_redirect_uri:env.META_REDIRECT_URI||null,platforms:Object.fromEntries(PLATFORMS.map(p=>[p,p==="instagram"?(metaConfigured(env,"instagram")?"oauth_ready":"oauth_not_configured"):p==="facebook"?(metaConfigured(env,"facebook")?"oauth_ready":"oauth_not_configured"):"oauth_not_configured"]))},200,cors(request));
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
  const body=await request.json().catch(()=>({}));
  const platform=body.platform==="facebook"?"facebook":body.platform==="instagram"?"instagram":null;
  if(!platform) return json({error:"Choose instagram or facebook for Meta Unified Login"},422,cors(request));
  if(!metaConfigured(env,platform)) return json({error:"Meta "+platform+" Login configuration is not configured on the Cloudflare Worker"},503,cors(request));
  const state=random(32),stamp=now(),expiry=new Date(Date.now()+10*60*1000).toISOString();
  await env.DB.prepare("DELETE FROM oauth_states WHERE expires_at<=?").bind(stamp).run();
  await env.DB.prepare("INSERT INTO oauth_states(state_hash,owner_user_id,platform,expires_at,created_at) VALUES(?,?,?,?,?)").bind(await sha(state),user.id,"meta_"+platform,expiry,stamp).run();
  return json({authorization_url:buildMetaAuthorizationUrl(env,state,platform),expires_at:expiry,redirect_uri:env.META_REDIRECT_URI,platform,login_mode:"unified_login_config_id"},200,cors(request));
 }
 if(method==="GET"&&path==="/accounts") {
  const {results=[]}=await env.DB.prepare("SELECT id,platform,external_account_id,account_name,profile_picture_url,status,scopes_json,page_tasks_json,token_expires_at,created_at,updated_at FROM social_accounts WHERE owner_user_id=? ORDER BY platform,account_name").bind(user.id).all();
  return json({accounts:results.map(a=>{const scopes=JSON.parse(a.scopes_json||"[]"),page_tasks=JSON.parse(a.page_tasks_json||"[]");const readiness=a.platform==="facebook"?facebookPublishReadiness(scopes,page_tasks):{ready:false,missing:["adapter not enabled"]};return {...a,scopes,page_tasks,publish_ready:readiness.ready,publish_blockers:readiness.missing};})},200,cors(request));
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
 if(method==="GET"&&path==="/automation/auto-like") {
  const {results:accounts=[]}=await env.DB.prepare("SELECT a.id,a.account_name,a.external_account_id,a.status,a.scopes_json,a.page_tasks_json,s.enabled,s.enabled_at,s.backfill_count,s.last_run_at,s.last_run_result FROM social_accounts a LEFT JOIN auto_like_settings s ON s.account_id=a.id WHERE a.owner_user_id=? AND a.platform='facebook' ORDER BY a.account_name").bind(user.id).all();
  const {results:likes=[]}=await env.DB.prepare("SELECT l.post_id,l.post_permalink,l.post_message_preview,l.post_created_time,l.source,l.status,l.error_message,l.liked_at,l.created_at,a.account_name FROM page_post_likes l JOIN social_accounts a ON a.id=l.account_id WHERE l.owner_user_id=? ORDER BY l.created_at DESC LIMIT 30").bind(user.id).all();
  return json({schedule:"every 5 minutes",accounts:accounts.map(a=>{const r=autoLikeReadiness(JSON.parse(a.scopes_json||"[]"),JSON.parse(a.page_tasks_json||"[]"));return {id:a.id,account_name:a.account_name,page_id:a.external_account_id,status:a.status,enabled:!!a.enabled,enabled_at:a.enabled_at||null,backfill_count:a.backfill_count||0,last_run_at:a.last_run_at||null,last_run_result:a.last_run_result?JSON.parse(a.last_run_result):null,ready:r.ready,missing:r.missing};}),likes},200,cors(request));
 }
 if(method==="POST"&&path==="/automation/auto-like") {
  const b=await request.json().catch(()=>({}));
  const account=await env.DB.prepare(AUTO_LIKE_ACCOUNT_SQL+" WHERE id=? AND owner_user_id=? AND platform='facebook'").bind(String(b.account_id||""),user.id).first();
  if(!account) return json({error:"Facebook Page not found"},404,cors(request));
  const stamp=now();
  if(b.enabled!==true) {
   await env.DB.prepare("INSERT INTO auto_like_settings(account_id,owner_user_id,enabled,updated_by,created_at,updated_at) VALUES(?,?,0,?,?,?) ON CONFLICT(account_id) DO UPDATE SET enabled=0,updated_by=excluded.updated_by,updated_at=excluded.updated_at").bind(account.id,user.id,user.email,stamp,stamp).run();
   await audit(env,user.id,"auto_like_disabled","account",account.id,user.email,{});
   return json({account_id:account.id,enabled:false},200,cors(request));
  }
  const readiness=autoLikeReadiness(JSON.parse(account.scopes_json||"[]"),JSON.parse(account.page_tasks_json||"[]"));
  if(account.status!=="connected"||!account.encrypted_access_token||!readiness.ready) return json({error:"Facebook Page is not ready for auto-like. Reconnect it and grant the required access.",missing_permissions:readiness.missing},403,cors(request));
  const backfill=Math.max(0,Math.min(AUTO_LIKE_MAX_BACKFILL,Number.isInteger(b.backfill_count)?b.backfill_count:2));
  const existing=await env.DB.prepare("SELECT enabled,enabled_at FROM auto_like_settings WHERE account_id=?").bind(account.id).first();
  const enabledAt=existing?.enabled&&existing.enabled_at?existing.enabled_at:stamp;
  await env.DB.prepare("INSERT INTO auto_like_settings(account_id,owner_user_id,enabled,enabled_at,backfill_count,updated_by,created_at,updated_at) VALUES(?,?,1,?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET enabled=1,enabled_at=excluded.enabled_at,backfill_count=excluded.backfill_count,updated_by=excluded.updated_by,updated_at=excluded.updated_at").bind(account.id,user.id,enabledAt,backfill,user.email,stamp,stamp).run();
  const queuedBackfill=[];
  if(backfill>0) {
   const token=await decrypt(account.encrypted_access_token,env);
   const posts=(await listOwnPagePosts(env,account.external_account_id,token)).slice(0,backfill);
   for(const post of posts) if(await queuePageLike(env,{...account,owner_user_id:user.id},post,"backfill")) queuedBackfill.push(post.id);
  }
  await audit(env,user.id,"auto_like_enabled","account",account.id,user.email,{enabled_at:enabledAt,backfill_count:backfill,backfill_post_ids:queuedBackfill});
  const run=await runAutoLikeForAccount(env,{...account,owner_user_id:user.id},{enabled_at:enabledAt},user.email);
  return json({account_id:account.id,enabled:true,enabled_at:enabledAt,backfill_queued:queuedBackfill,run},200,cors(request));
 }
 if(method==="POST"&&path==="/automation/auto-like/run") {
  const {results=[]}=await env.DB.prepare("SELECT account_id,enabled_at FROM auto_like_settings WHERE owner_user_id=? AND enabled=1").bind(user.id).all();
  const runs=[];
  for(const s of results) {
   const account=await env.DB.prepare(AUTO_LIKE_ACCOUNT_SQL+" WHERE id=? AND owner_user_id=? AND platform='facebook'").bind(s.account_id,user.id).first();
   if(account) runs.push(await runAutoLikeForAccount(env,account,s,user.email));
  }
  return json({runs},200,cors(request));
 }
 if(method==="GET"&&path==="/content") {
  const status=url.searchParams.get("status");
  const q=status?env.DB.prepare("SELECT * FROM content_items WHERE owner_user_id=? AND status=? ORDER BY updated_at DESC").bind(user.id,status):env.DB.prepare("SELECT * FROM content_items WHERE owner_user_id=? ORDER BY updated_at DESC").bind(user.id);
  const {results=[]}=await q.all();
  const published=await env.DB.prepare("SELECT p.content_id,p.status,p.external_post_id,p.permalink,p.error_message,p.updated_at,a.account_name FROM publish_records p JOIN social_accounts a ON a.id=p.account_id WHERE p.owner_user_id=? ORDER BY p.created_at DESC").bind(user.id).all();
  const byContent=new Map();
  for(const record of published.results||[]) { if(!byContent.has(record.content_id)) byContent.set(record.content_id,[]); byContent.get(record.content_id).push(record); }
  return json({items:results.map(x=>({...x,platforms:JSON.parse(x.platforms_json),account_ids:JSON.parse(x.account_ids_json),publications:byContent.get(x.id)||[]}))},200,cors(request));
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

 const publishMatch=path.match(/^\/content\/([a-zA-Z0-9_-]+)\/publish\/([a-zA-Z0-9_-]+)$/);
 if(method==="POST"&&publishMatch) {
  const contentId=publishMatch[1],accountId=publishMatch[2];
  const item=await env.DB.prepare("SELECT id,title,body,status,platforms_json,account_ids_json FROM content_items WHERE id=? AND owner_user_id=?").bind(contentId,user.id).first();
  if(!item) return json({error:"Content not found"},404,cors(request));
  if(item.status!=="approved") return json({error:"Content must be approved before publishing"},409,cors(request));
  const targetIds=JSON.parse(item.account_ids_json||"[]"),platforms=JSON.parse(item.platforms_json||"[]");
  if(!targetIds.includes(accountId)||!platforms.includes("facebook")) return json({error:"Facebook account is not an approved destination for this content"},422,cors(request));
  const account=await env.DB.prepare("SELECT id,external_account_id,account_name,status,scopes_json,page_tasks_json,encrypted_access_token FROM social_accounts WHERE id=? AND owner_user_id=? AND platform='facebook'").bind(accountId,user.id).first();
  if(!account||account.status!=="connected"||!account.encrypted_access_token) return json({error:"Facebook Page is not connected"},409,cors(request));
  const readiness=facebookPublishReadiness(JSON.parse(account.scopes_json||"[]"),JSON.parse(account.page_tasks_json||"[]"));
  if(!readiness.ready) return json({error:"Facebook Page is not authorized to publish. Reconnect it and grant the required access.",missing_permissions:readiness.missing},403,cors(request));
  // Photo post when a JPEG/PNG is attached (multipart "image"); otherwise a text-only Page feed post.
  const contentType=(request.headers.get("Content-Type")||"").toLowerCase();
  const form=contentType.startsWith("multipart/form-data")?await request.formData():null;
  const rawImage=form?form.get("image"):null;
  const image=rawImage&&typeof rawImage.arrayBuffer==="function"&&rawImage.size>0?rawImage:null;
  if(image&&!["image/jpeg","image/png"].includes(image.type)) return json({error:"Only JPEG and PNG images are supported"},415,cors(request));
  if(image&&image.size>8*1024*1024) return json({error:"Image must be smaller than 8 MB"},413,cors(request));
  const postKind=image?"photo":"text";
  if(!String(item.body||"").trim()) return json({error:"Post text is empty"},422,cors(request));
  const idempotencyKey=safeText(request.headers.get("Idempotency-Key")||"",128);
  if(!/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey)) return json({error:"A valid Idempotency-Key is required"},422,cors(request));
  const existing=await env.DB.prepare("SELECT status,external_post_id,permalink,error_message FROM publish_records WHERE content_id=? AND account_id=?").bind(contentId,accountId).first();
  if(existing) {
   if(existing.status==="published") return json({status:"published",post_id:existing.external_post_id,permalink:existing.permalink,idempotent:true},200,cors(request));
   return json({error:"A publish attempt already exists for this content and Page; check its status before retrying",publish_status:existing.status,detail:existing.error_message||null},409,cors(request));
  }
  const pageToken=await decrypt(account.encrypted_access_token,env);
  const recordId=random(16),stamp=now();
  await env.DB.prepare("INSERT INTO publish_records(id,owner_user_id,content_id,account_id,platform,idempotency_key,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'publishing',?,?)")
   .bind(recordId,user.id,contentId,accountId,"facebook",idempotencyKey,stamp,stamp).run();
  const body=new FormData();
  body.set("access_token",pageToken);
  if(env.META_APP_SECRET) {
   const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(env.META_APP_SECRET),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
   const proof=await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(pageToken));
   body.set("appsecret_proof",Array.from(new Uint8Array(proof),b=>b.toString(16).padStart(2,"0")).join(""));
  }
  body.set("message",item.body);
  body.set("published","true");
  if(image) body.set("source",image,image.name||"upload.jpg");
  let response,meta;
  try {
   response=await fetch(facebookPublishUrl(env,account.external_account_id,postKind),{method:"POST",body,headers:{Accept:"application/json"}});
   meta=await response.json().catch(()=>({}));
  } catch(error) {
   await env.DB.prepare("UPDATE publish_records SET status='unknown',error_message=?,updated_at=? WHERE id=?")
    .bind("Network error after publish request; reconcile the Page before retrying.",now(),recordId).run();
   await audit(env,user.id,"facebook_publish_unknown","content",contentId,user.email,{account_id:accountId,reason:"network_error"});
   return json({error:"The connection ended before Facebook confirmed the result. The post may have been created; check the Page before retrying.",publish_status:"unknown"},502,cors(request));
  }
  if(!response.ok||meta.error||!meta.id) {
   const message=safeText(meta.error?.message||"Facebook did not return a post ID",300);
   await env.DB.prepare("UPDATE publish_records SET status='failed',error_message=?,updated_at=? WHERE id=?").bind(message,now(),recordId).run();
   await audit(env,user.id,"facebook_publish_failed","content",contentId,user.email,{account_id:accountId,error:message});
   return json({error:"Facebook rejected the publish request: "+message,publish_status:"failed"},502,cors(request));
  }
  const postId=meta.post_id||meta.id;
  let permalink=null;
  try {
   const details=await graphGet(env,postId,{fields:"permalink_url",access_token:pageToken});
   permalink=details.permalink_url||null;
  } catch {}
  await env.DB.prepare("UPDATE publish_records SET status='published',external_post_id=?,permalink=?,updated_at=? WHERE id=?")
   .bind(String(postId),permalink,now(),recordId).run();
  const counts=await env.DB.prepare("SELECT COUNT(*) total,SUM(CASE WHEN status='published' THEN 1 ELSE 0 END) published FROM publish_records WHERE content_id=?").bind(contentId).first();
  if((counts?.published||0)>=targetIds.length) await env.DB.prepare("UPDATE content_items SET status='published',updated_at=? WHERE id=? AND owner_user_id=?").bind(now(),contentId,user.id).run();
  await audit(env,user.id,"facebook_post_published","content",contentId,user.email,{account_id:accountId,post_id:String(postId),permalink,post_kind:postKind});
  return json({status:"published",platform:"facebook",post_kind:postKind,account_name:account.account_name,post_id:String(postId),permalink},201,cors(request));
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
},
// Cron trigger (wrangler.toml [triggers]): runs the "แอดมินโซเชียล" auto-like for enabled Pages.
async scheduled(event,env,ctx) {
 ctx.waitUntil(runScheduledAutoLike(env).then(r=>console.log("auto-like-cron",{accounts:r.length,results:r.map(x=>({liked:x.liked,failed:x.failed,queued:x.queued,error:x.error||null}))})).catch(e=>console.error("auto-like-cron",{message:safeText(e?.message||"unknown",200)})));
}};
