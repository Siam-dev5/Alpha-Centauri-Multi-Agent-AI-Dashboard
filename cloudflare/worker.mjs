import { createShopeeSellerModule } from "./shopee_seller.mjs";
import CAMPAIGN_BANK from "../content/routine-content-bank.json" with { type: "json" };
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
function oauthResultPage(type,label,status,message) {
 const payload=JSON.stringify({type,status,message}).replace(/</g,"\\u003c");
 return new Response("<!doctype html><html lang='th'><meta charset='utf-8'><title>"+label+" connection</title><body style='font:16px sans-serif;background:#090d1e;color:#e2e8f0;padding:32px'><p>"+(status==="connected"?"เชื่อมต่อ "+label+" สำเร็จ":"การเชื่อมต่อ "+label+" ไม่สำเร็จ")+"</p><script>const data="+payload+";if(window.opener){for(const o of "+JSON.stringify(DASHBOARD_ORIGINS)+"){try{window.opener.postMessage(data,o);}catch(e){}}}setTimeout(()=>window.close(),900);</script></body></html>",{status:200,headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
}
function metaResultPage(status,message) { return oauthResultPage("ALPHA_CENTAURI_META_OAUTH","Meta",status,message); }
// Shopee Seller (shop owner) module lives in its own file; read-only, separate from Shopee Affiliate.
const shopeeSeller=createShopeeSellerModule({encrypt,decrypt,random,sha,now,audit,safeText,resultPage:oauthResultPage});
// ---- TikTok Login Kit (web): connect TikTok accounts. Connection only; publishing is NOT enabled here. ----
// Docs: developers.tiktok.com/doc/login-kit-web, /doc/oauth-user-access-token-management, /doc/tiktok-api-v2-get-user-info
const TIKTOK_AUTH_URL="https://www.tiktok.com/v2/auth/authorize/";
const TIKTOK_API="https://open.tiktokapis.com/v2";
const TIKTOK_DEFAULT_REDIRECT="https://social-api.siamhrbp.com/api/social-commerce/oauth/tiktok/callback";
const TIKTOK_USER_FIELDS="open_id,union_id,avatar_url,display_name";
export const tiktokRedirectUri=(env)=>String(env.TIKTOK_REDIRECT_URI||TIKTOK_DEFAULT_REDIRECT).trim();
export const tiktokConfigured=(env)=>!!(String(env.TIKTOK_CLIENT_KEY||"").trim()&&String(env.TIKTOK_CLIENT_SECRET||"").trim());
export function tiktokScopes(env) {
 const scopes=String(env.TIKTOK_SCOPES||"user.info.basic").split(/[\s,]+/).filter(s=>/^[a-z0-9_.]+$/i.test(s));
 return [...new Set(["user.info.basic",...scopes])];
}
export function buildTikTokAuthorizationUrl(env,state) {
 if(!tiktokConfigured(env)) throw new Error("TikTok Login Kit is not configured");
 const url=new URL(TIKTOK_AUTH_URL);
 url.searchParams.set("client_key",String(env.TIKTOK_CLIENT_KEY).trim());
 url.searchParams.set("scope",tiktokScopes(env).join(","));
 url.searchParams.set("response_type","code");
 url.searchParams.set("redirect_uri",tiktokRedirectUri(env));
 url.searchParams.set("state",state);
 url.searchParams.set("disable_auto_auth","1");
 return url.toString();
}
function tiktokResultPage(status,message) { return oauthResultPage("ALPHA_CENTAURI_TIKTOK_OAUTH","TikTok",status,message); }
async function tiktokTokenRequest(env,params) {
 const body=new URLSearchParams({client_key:String(env.TIKTOK_CLIENT_KEY).trim(),client_secret:String(env.TIKTOK_CLIENT_SECRET).trim(),...params});
 const response=await fetch(TIKTOK_API+"/oauth/token/",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded","Cache-Control":"no-cache"},body});
 const data=await response.json().catch(()=>({}));
 if(!response.ok||data.error||!data.access_token||!data.open_id) throw new Error("TikTok token request failed: "+safeText(data.error_description||data.error||response.statusText||"no access token",240));
 return data;
}
export async function tiktokUserInfo(accessToken) {
 const response=await fetch(TIKTOK_API+"/user/info/?fields="+TIKTOK_USER_FIELDS,{headers:{Authorization:"Bearer "+accessToken,Accept:"application/json"}});
 const data=await response.json().catch(()=>({}));
 if(!response.ok||(data.error&&data.error.code!=="ok")||!data.data?.user?.open_id) throw new Error("TikTok user info request failed: "+safeText(data.error?.message||data.error?.code||response.statusText||"no user",240));
 return data.data.user;
}
const tiktokExpiry=(seconds)=>Number(seconds)>0?new Date(Date.now()+Number(seconds)*1000).toISOString():null;
const tiktokScopeList=(scope)=>String(scope||"").split(",").map(s=>s.trim()).filter(Boolean).sort();
async function saveTikTokAccount(env,user,profile,token) {
 const id=random(16),stamp=now(),scopes=tiktokScopeList(token.scope);
 const name=safeText(profile.display_name||"TikTok account",160);
 const meta=JSON.stringify({union_id:profile.union_id||null,refresh_expires_at:tiktokExpiry(token.refresh_expires_in),verified_at:stamp});
 await env.DB.prepare("INSERT INTO social_accounts(id,owner_user_id,platform,external_account_id,account_name,profile_picture_url,status,scopes_json,page_tasks_json,token_expires_at,encrypted_access_token,encrypted_refresh_token,created_at,updated_at) VALUES(?,?,'tiktok',?,?,?,'connected',?,?,?,?,?,?,?) ON CONFLICT(owner_user_id,platform,external_account_id) DO UPDATE SET account_name=excluded.account_name,profile_picture_url=excluded.profile_picture_url,status='connected',scopes_json=excluded.scopes_json,page_tasks_json=excluded.page_tasks_json,token_expires_at=excluded.token_expires_at,encrypted_access_token=excluded.encrypted_access_token,encrypted_refresh_token=excluded.encrypted_refresh_token,updated_at=excluded.updated_at")
  .bind(id,user.id,String(token.open_id),name,profile.avatar_url||null,JSON.stringify(scopes),meta,tiktokExpiry(token.expires_in),await encrypt(token.access_token,env),token.refresh_token?await encrypt(token.refresh_token,env):null,stamp,stamp).run();
 await audit(env,user.id,"tiktok_account_connected","account",String(token.open_id),user.email,{platform:"tiktok",account_name:name,scopes});
 return {name,scopes};
}
async function finishTikTokOAuth(request,env,url) {
 const state=url.searchParams.get("state"),code=url.searchParams.get("code");
 const stateHash=state?await sha(state):null;
 const stateRow=stateHash?await env.DB.prepare("SELECT owner_user_id,platform,expires_at FROM oauth_states WHERE state_hash=? AND platform='tiktok'").bind(stateHash).first():null;
 if(stateRow) await env.DB.prepare("DELETE FROM oauth_states WHERE state_hash=?").bind(stateHash).run();
 if(url.searchParams.get("error")) return tiktokResultPage("error","TikTok authorization was cancelled or denied");
 if(!stateRow||stateRow.expires_at<=now()) return tiktokResultPage("error","OAuth state is invalid or expired");
 if(!code) return tiktokResultPage("error","Missing authorization response");
 let stage="token_exchange";
 try {
  if(!tiktokConfigured(env)) throw new Error("TikTok configuration is missing");
  const userRow=await env.DB.prepare("SELECT id,email FROM app_users WHERE id=?").bind(stateRow.owner_user_id).first();
  if(!userRow) throw new Error("Social Commerce user no longer exists");
  const token=await tiktokTokenRequest(env,{code,grant_type:"authorization_code",redirect_uri:tiktokRedirectUri(env)});
  stage="user_info";
  const profile=await tiktokUserInfo(token.access_token);
  if(String(profile.open_id)!==String(token.open_id)) throw new Error("TikTok user info did not match the authorized account");
  stage="persist_account";
  const saved=await saveTikTokAccount(env,userRow,profile,token);
  await audit(env,userRow.id,"tiktok_oauth_completed","integration","tiktok",userRow.email,{granted_scopes:saved.scopes,expires_at:tiktokExpiry(token.expires_in)});
  return tiktokResultPage("connected","TikTok: "+saved.name);
 } catch(e) {
  const diagnostic=safeText(e?.message||"unknown TikTok OAuth error",300);
  console.error("tiktok-oauth-callback",{stage,message:diagnostic});
  try { await audit(env,stateRow.owner_user_id,"tiktok_oauth_failed","integration","tiktok","tiktok-oauth-callback",{stage,error:diagnostic}); } catch {}
  return tiktokResultPage("error","TikTok connection failed during "+stage+". Diagnostic has been recorded for the system administrator.");
 }
}
// Returns a usable access token, refreshing it (refresh tokens rotate) when it expires within 5 minutes.
async function tiktokAccessToken(env,account) {
 if(account.status!=="connected"||!account.encrypted_access_token) throw new Error("TikTok account is not connected");
 if(account.token_expires_at&&Date.parse(account.token_expires_at)>Date.now()+5*60000) return decrypt(account.encrypted_access_token,env);
 if(!account.encrypted_refresh_token) throw new Error("TikTok access token expired and no refresh token is stored; reconnect the account");
 let token;
 try { token=await tiktokTokenRequest(env,{grant_type:"refresh_token",refresh_token:await decrypt(account.encrypted_refresh_token,env)}); }
 catch(e) { await env.DB.prepare("UPDATE social_accounts SET status='expired',updated_at=? WHERE id=?").bind(now(),account.id).run(); throw e; }
 const meta={...JSON.parse(account.page_tasks_json||"{}"),refresh_expires_at:tiktokExpiry(token.refresh_expires_in)};
 await env.DB.prepare("UPDATE social_accounts SET encrypted_access_token=?,encrypted_refresh_token=?,token_expires_at=?,scopes_json=?,page_tasks_json=?,updated_at=? WHERE id=?")
  .bind(await encrypt(token.access_token,env),token.refresh_token?await encrypt(token.refresh_token,env):account.encrypted_refresh_token,tiktokExpiry(token.expires_in),JSON.stringify(tiktokScopeList(token.scope)),JSON.stringify(meta),now(),account.id).run();
 return token.access_token;
}
const TIKTOK_ACCOUNT_SQL="SELECT id,owner_user_id,external_account_id,account_name,status,scopes_json,page_tasks_json,token_expires_at,encrypted_access_token,encrypted_refresh_token FROM social_accounts";
// ---- TikTok "Upload to TikTok" (inbox draft, scope video.upload). Allowed for unaudited/sandbox apps: the clip lands in the
// creator's TikTok inbox and the creator finishes and posts it in the TikTok app. Nothing is published by this code.
// Docs: developers.tiktok.com/doc/content-posting-api-reference-upload-video, /doc/content-posting-api-media-transfer-guide
const TIKTOK_MAX_SINGLE_CHUNK=64*1024*1024;
export function tiktokInboxProblems(account,bytes) {
 const p=[];
 if(!account) return ["no connected TikTok account"];
 if(account.status!=="connected") p.push("TikTok account is "+account.status+"; reconnect it");
 if(!JSON.parse(account.scopes_json||"[]").includes("video.upload")) p.push("TikTok account was not authorized for video.upload; reconnect TikTok after enabling Content Posting API (Upload) for the app");
 if(!(bytes>=50*1024&&bytes<=TIKTOK_MAX_SINGLE_CHUNK)) p.push("video must be 50 KB–64 MB (single chunk), got "+bytes+" bytes");
 return p;
}
async function tiktokInboxUpload(env,user,body,key) {
 if(!/^[A-Za-z0-9_.:-]{4,80}$/.test(String(key||""))) return {status:422,body:{error:"Idempotency-Key header (4–80 chars) is required"}};
 const prior=await env.DB.prepare("SELECT details_json FROM audit_events WHERE owner_user_id=? AND event_type='tiktok_inbox_upload' AND entity_id=?").bind(user.id,key).first();
 if(prior) return {status:409,body:{error:"This Idempotency-Key was already uploaded; not sent again",previous:JSON.parse(prior.details_json||"{}")}};
 const bytes=new Uint8Array(body);
 const {results:accs=[]}=await env.DB.prepare(TIKTOK_ACCOUNT_SQL+" WHERE owner_user_id=? AND platform='tiktok' AND status='connected'").bind(user.id).all();
 if(accs.length>1) return {status:409,body:{error:"Several TikTok accounts are connected; keep only one"}};
 const account=accs[0];
 const head=String.fromCharCode(...bytes.subarray(4,8));
 const problems=tiktokInboxProblems(account,bytes.byteLength);
 if(head!=="ftyp") problems.push("file is not an MP4");
 if(problems.length) return {status:422,body:{error:"Not sent to TikTok",problems}};
 const token=await tiktokAccessToken(env,account);
 const init=await fetch(TIKTOK_API+"/post/publish/inbox/video/init/",{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json; charset=UTF-8"},body:JSON.stringify({source_info:{source:"FILE_UPLOAD",video_size:bytes.byteLength,chunk_size:bytes.byteLength,total_chunk_count:1}})});
 const ij=await init.json().catch(()=>({}));
 if(!init.ok||(ij.error&&ij.error.code!=="ok")||!ij.data?.upload_url) {
  const m=safeText(ij.error?.message||ij.error?.code||init.statusText||"init failed",240);
  await audit(env,user.id,"tiktok_inbox_upload_failed","tiktok",key,user.email,{stage:"init",error:m});
  return {status:502,body:{error:"TikTok init failed: "+m}};
 }
 // Record the attempt before the transfer so a retry with the same key can never send a second draft.
 await audit(env,user.id,"tiktok_inbox_upload","tiktok",key,user.email,{publish_id:ij.data.publish_id,bytes:bytes.byteLength,account:account.account_name});
 const put=await fetch(ij.data.upload_url,{method:"PUT",headers:{"Content-Type":"video/mp4","Content-Length":String(bytes.byteLength),"Content-Range":"bytes 0-"+(bytes.byteLength-1)+"/"+bytes.byteLength},body:bytes});
 if(!(put.status===201||put.ok)) {
  await audit(env,user.id,"tiktok_inbox_upload_failed","tiktok",key,user.email,{stage:"upload",http:put.status,publish_id:ij.data.publish_id});
  return {status:502,body:{error:"TikTok upload failed with HTTP "+put.status,publish_id:ij.data.publish_id}};
 }
 const st=await tiktokPublishStatus(env,account,ij.data.publish_id).catch(e=>({error:safeText(e?.message,200)}));
 return {status:200,body:{sent:true,mode:"inbox_draft",account:account.account_name,publish_id:ij.data.publish_id,status:st}};
}
async function tiktokPublishStatus(env,account,publishId) {
 const token=await tiktokAccessToken(env,account);
 const r=await fetch(TIKTOK_API+"/post/publish/status/fetch/",{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json; charset=UTF-8"},body:JSON.stringify({publish_id:publishId})});
 const j=await r.json().catch(()=>({}));
 if(!r.ok||(j.error&&j.error.code!=="ok")) throw new Error("TikTok status failed: "+safeText(j.error?.message||j.error?.code||r.statusText,200));
 return j.data||{};
}
async function verifyTikTokAccount(env,user,accountId) {
 const account=await env.DB.prepare(TIKTOK_ACCOUNT_SQL+" WHERE id=? AND owner_user_id=? AND platform='tiktok'").bind(accountId,user.id).first();
 if(!account) return {status:404,body:{error:"TikTok account not found"}};
 try {
  const profile=await tiktokUserInfo(await tiktokAccessToken(env,account));
  if(String(profile.open_id)!==String(account.external_account_id)) throw new Error("TikTok returned a different account");
  const stamp=now(),meta={...JSON.parse(account.page_tasks_json||"{}"),verified_at:stamp};
  await env.DB.prepare("UPDATE social_accounts SET account_name=?,profile_picture_url=?,page_tasks_json=?,updated_at=? WHERE id=?").bind(safeText(profile.display_name||account.account_name,160),profile.avatar_url||null,JSON.stringify(meta),stamp,account.id).run();
  await audit(env,user.id,"tiktok_account_verified","account",account.id,user.email,{open_id:account.external_account_id});
  return {status:200,body:{id:account.id,platform:"tiktok",connected:true,account_name:profile.display_name||account.account_name,open_id:account.external_account_id,verified_at:stamp}};
 } catch(e) {
  const message=safeText(e?.message||"TikTok check failed",240);
  await audit(env,user.id,"tiktok_account_verify_failed","account",account.id,user.email,{error:message});
  return {status:502,body:{id:account.id,connected:false,error:message}};
 }
}
async function revokeTikTokToken(env,account) {
 if(!tiktokConfigured(env)||!account.encrypted_access_token) return false;
 try {
  const response=await fetch(TIKTOK_API+"/oauth/revoke/",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_key:String(env.TIKTOK_CLIENT_KEY).trim(),client_secret:String(env.TIKTOK_CLIENT_SECRET).trim(),token:await decrypt(account.encrypted_access_token,env)})});
  return response.ok;
 } catch { return false; }
}
// ---- Shopee Affiliate Open API (Thailand): account connection check only. ----
// Docs: affiliate.shopee.co.th/open_api/document (Authentication; Request and Response).
// Read-only: one signed shopeeOfferV2 query. No short links, orders, listings or other transactions here.
// AppID/Secret are issued by Shopee after Affiliate Open API approval and live only as Worker secrets.
const SHOPEE_AFFILIATE_DEFAULT_ENDPOINT="https://open-api.affiliate.shopee.co.th/graphql";
export const SHOPEE_AFFILIATE_VERIFY_QUERY="{shopeeOfferV2(page:1,limit:1){nodes{offerName}pageInfo{page limit hasNextPage}}}";
export const shopeeAffiliateEndpoint=(env)=>{
 const value=String(env.SHOPEE_AFFILIATE_ENDPOINT||"").trim();
 return /^https:\/\/open-api\.affiliate\.shopee\.[a-z.]{2,12}\/graphql$/.test(value)?value:SHOPEE_AFFILIATE_DEFAULT_ENDPOINT;
};
export const shopeeAffiliateConfigured=(env)=>!!(String(env.SHOPEE_AFFILIATE_APP_ID||"").trim()&&String(env.SHOPEE_AFFILIATE_SECRET||"").trim());
const sha256Hex=async(text)=>[...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text)))].map(b=>b.toString(16).padStart(2,"0")).join("");
// Authorization: SHA256 Credential={AppId}, Timestamp={ts}, Signature=sha256(AppId+Timestamp+Payload+Secret)
export async function shopeeAffiliateAuthorization(appId,secret,timestamp,payload) {
 const signature=await sha256Hex(String(appId)+String(timestamp)+String(payload)+String(secret));
 return "SHA256 Credential="+appId+", Timestamp="+timestamp+", Signature="+signature;
}
export async function shopeeAffiliateCheck(env) {
 if(!shopeeAffiliateConfigured(env)) throw new Error("Shopee Affiliate Open API is not configured");
 const appId=String(env.SHOPEE_AFFILIATE_APP_ID).trim(),secret=String(env.SHOPEE_AFFILIATE_SECRET).trim();
 const payload=JSON.stringify({query:SHOPEE_AFFILIATE_VERIFY_QUERY}),timestamp=Math.floor(Date.now()/1000);
 const response=await fetch(shopeeAffiliateEndpoint(env),{method:"POST",headers:{"Content-Type":"application/json",Authorization:await shopeeAffiliateAuthorization(appId,secret,timestamp,payload)},body:payload});
 const data=await response.json().catch(()=>({}));
 const error=Array.isArray(data.errors)?data.errors[0]:null;
 if(error) {
  const code=error.extensions?.code;
  const hint=code===10020?" (AppID/Secret ไม่ถูกต้องหรือหมดอายุ)":code===10030?" (เกินโควตาการเรียก API)":"";
  throw new Error("Shopee Affiliate API error"+(code?" "+code:"")+": "+safeText(error.extensions?.message||error.message||"unknown",160)+hint);
 }
 if(!response.ok||!data.data?.shopeeOfferV2) throw new Error("Shopee Affiliate API request failed (HTTP "+response.status+")");
 return {app_id:appId,sample_offers:(data.data.shopeeOfferV2.nodes||[]).length};
}
const maskedAppId=(id)=>{ const s=String(id||""); return "••••"+s.slice(-4); };
async function connectShopeeAffiliate(env,user) {
 if(!shopeeAffiliateConfigured(env)) return {status:503,body:{error:"Shopee Affiliate Open API is not configured on the Cloudflare Worker (SHOPEE_AFFILIATE_APP_ID / SHOPEE_AFFILIATE_SECRET)"}};
 try {
  const check=await shopeeAffiliateCheck(env);
  const stamp=now(),name="Shopee Affiliate TH · AppID "+maskedAppId(check.app_id);
  const meta=JSON.stringify({verified_at:stamp,mode:"read_only",endpoint:shopeeAffiliateEndpoint(env)});
  await env.DB.prepare("INSERT INTO social_accounts(id,owner_user_id,platform,external_account_id,account_name,status,scopes_json,page_tasks_json,created_at,updated_at) VALUES(?,?,'shopee_affiliate',?,?,'connected',?,?,?,?) ON CONFLICT(owner_user_id,platform,external_account_id) DO UPDATE SET account_name=excluded.account_name,status='connected',scopes_json=excluded.scopes_json,page_tasks_json=excluded.page_tasks_json,updated_at=excluded.updated_at")
   .bind(random(16),user.id,check.app_id,name,JSON.stringify(["offer.read"]),meta,stamp,stamp).run();
  const row=await env.DB.prepare("SELECT id FROM social_accounts WHERE owner_user_id=? AND platform='shopee_affiliate' AND external_account_id=?").bind(user.id,check.app_id).first();
  await audit(env,user.id,"shopee_affiliate_connected","account",row?.id||null,user.email,{app_id:maskedAppId(check.app_id),mode:"read_only"});
  return {status:200,body:{id:row?.id||null,platform:"shopee_affiliate",connected:true,account_name:name,verified_at:stamp}};
 } catch(e) {
  const message=safeText(e?.message||"Shopee Affiliate check failed",240);
  await audit(env,user.id,"shopee_affiliate_connect_failed","integration","shopee_affiliate",user.email,{error:message});
  return {status:502,body:{connected:false,error:message}};
 }
}
async function verifyShopeeAffiliateAccount(env,user,account) {
 try {
  if(account.status!=="connected") throw new Error("Shopee Affiliate account is not connected");
  const check=await shopeeAffiliateCheck(env);
  if(check.app_id!==String(account.external_account_id)) throw new Error("Worker AppID changed; connect Shopee Affiliate again");
  const stamp=now(),meta={...JSON.parse(account.page_tasks_json||"{}"),verified_at:stamp};
  await env.DB.prepare("UPDATE social_accounts SET page_tasks_json=?,updated_at=? WHERE id=?").bind(JSON.stringify(meta),stamp,account.id).run();
  await audit(env,user.id,"shopee_affiliate_verified","account",account.id,user.email,{app_id:maskedAppId(check.app_id)});
  return {status:200,body:{id:account.id,platform:"shopee_affiliate",connected:true,account_name:account.account_name,verified_at:stamp}};
 } catch(e) {
  const message=safeText(e?.message||"Shopee Affiliate check failed",240);
  // Only credential problems mark the account; transient Shopee errors (system/rate limit) keep it connected.
  if(account.status==="connected"&&/ 10020:|AppID changed|not configured/.test(message)) await env.DB.prepare("UPDATE social_accounts SET status='error',updated_at=? WHERE id=?").bind(now(),account.id).run();
  await audit(env,user.id,"shopee_affiliate_verify_failed","account",account.id,user.email,{error:message});
  return {status:502,body:{id:account.id,connected:false,error:message}};
 }
}
async function verifyAccount(env,user,accountId) {
 const account=await env.DB.prepare("SELECT id,platform,external_account_id,account_name,status,page_tasks_json FROM social_accounts WHERE id=? AND owner_user_id=?").bind(accountId,user.id).first();
 if(account?.platform==="shopee_affiliate") return verifyShopeeAffiliateAccount(env,user,account);
 return verifyTikTokAccount(env,user,accountId);
}
export function accountReadiness(account,scopes,pageTasks) {
 if(account.platform==="facebook") return facebookPublishReadiness(scopes,pageTasks);
 if(account.platform==="tiktok") return {ready:false,missing:["TikTok publishing is not enabled (connection only)"]};
 if(account.platform==="shopee_affiliate") return {ready:false,missing:["Shopee Affiliate is connected read-only (no posting or transactions)"]};
 return {ready:false,missing:["adapter not enabled"]};
}
// ---- "เลขาส่วนตัว" (Personal Secretary): one Facebook Private Reply to people who comment the CTA keyword. ----
// Docs: developers.facebook.com/docs/messenger-platform/discovery/private-replies
//  POST /{page-id}/messages {recipient:{comment_id}, message:{text}} · needs pages_messaging + Page task MESSAGING
//  · only one private reply per comment · only within 7 days of the comment.
// Safety: COMMENT_DM_MODE is "off" unless set; "dry_run" records leads without sending; "live" sends.
// COMMENT_DM_ALLOW_IDS (comma-separated commenter IDs or comment IDs) limits live sends to those people/comments, e.g. for a test.
// Only comments under posts published by the creative workflow in the last 7 days are read.
// A lead row is unique per comment and claimed before sending, so a comment is never messaged twice.
const DM_WINDOW_MS=7*86400000, DM_SAFETY_MS=3600000, DM_MAX_SENDS_PER_RUN=10, DM_MAX_POSTS=30;
export const commentDmMode=(env)=>{ const m=String(env.COMMENT_DM_MODE||"off").trim().toLowerCase(); return ["dry_run","live"].includes(m)?m:"off"; };
export const commentDmKeyword=(env)=>String(env.COMMENT_DM_KEYWORD||"สนใจ").trim()||"สนใจ";
const commentDmAllowIds=(env)=>String(env.COMMENT_DM_ALLOW_IDS||"").split(/[\s,]+/).map(s=>s.trim()).filter(Boolean);
const POLITE=/(ครับ|คับ|ค่ะ|คะ|ค่า|จ้า|จ้ะ|นะ|ค่ะ)+$/;
// True when the comment is the keyword itself, optionally with spaces, punctuation, emoji or a polite particle.
export function isKeywordComment(text,keyword="สนใจ") {
 const cleaned=String(text||"").normalize("NFC").replace(/[\s\p{P}\p{S}​-‍️]/gu,"");
 if(!cleaned) return false;
 return cleaned===keyword||(cleaned.startsWith(keyword)&&POLITE.test(cleaned.slice(keyword.length))&&cleaned.slice(keyword.length).replace(POLITE,"")==="");
}
export function commentDmReadiness(env,scopes=[],tasks=[]) {
 const granted=new Set(scopes),assigned=new Set(tasks),missing=[];
 if(!granted.has("pages_read_user_content")) missing.push("pages_read_user_content");
 if(!granted.has("pages_messaging")) missing.push("pages_messaging");
 if(!(assigned.has("MESSAGING")||assigned.has("MANAGE"))) missing.push("Page task MESSAGING");
 if(!String(env.COMMENT_DM_TEXT||"").trim()) missing.push("COMMENT_DM_TEXT (approved message)");
 return {ready:missing.length===0,missing};
}
const isMissingTable=(e)=>/no such table/i.test(String(e?.message||e));
async function sendPrivateReply(env,pageId,commentId,text,token) {
 const body=new FormData();
 body.set("access_token",token);
 const proof=await appSecretProof(env,token); if(proof) body.set("appsecret_proof",proof);
 body.set("recipient",JSON.stringify({comment_id:commentId}));
 body.set("message",JSON.stringify({text}));
 const res=await fetch("https://graph.facebook.com/"+graphVersion(env)+"/"+encodeURIComponent(pageId)+"/messages",{method:"POST",body,headers:{Accept:"application/json"}});
 const data=await res.json().catch(()=>({}));
 if(!res.ok||data.error||!data.message_id) return {ok:false,error:safeText(data.error?.message||"Facebook did not confirm the message",300)};
 return {ok:true,message_id:String(data.message_id)};
}
export async function runCommentSecretaryForAccount(env,account,actor) {
 const mode=commentDmMode(env),keyword=commentDmKeyword(env),allow=commentDmAllowIds(env);
 const summary={account_id:account.id,mode,scanned_posts:0,new_leads:0,sent:0,failed:0,unknown:0,skipped:0};
 if(mode==="off") return {...summary,error:"COMMENT_DM_MODE is off"};
 if(account.status!=="connected"||!account.encrypted_access_token) return {...summary,error:"Page not connected"};
 const scopes=JSON.parse(account.scopes_json||"[]"),tasks=JSON.parse(account.page_tasks_json||"[]");
 if(!new Set(scopes).has("pages_read_user_content")) return {...summary,error:"Missing pages_read_user_content"};
 const token=await decrypt(account.encrypted_access_token,env),pageId=String(account.external_account_id);
 const since=new Date(Date.now()-DM_WINDOW_MS).toISOString();
 const {results:posts=[]}=await env.DB.prepare("SELECT DISTINCT p.external_post_id post_id FROM publish_records p JOIN workflow_runs r ON r.content_id=p.content_id WHERE p.account_id=? AND p.status='published' AND p.external_post_id IS NOT NULL AND p.updated_at>=? ORDER BY p.updated_at DESC LIMIT ?").bind(account.id,since,DM_MAX_POSTS).all();
 for(const {post_id} of posts) {
  let comments=[];
  try { comments=(await graphGet(env,post_id+"/comments",{fields:"id,message,from{id,name},created_time",filter:"stream",order:"reverse_chronological",limit:100,access_token:token})).data||[]; }
  catch(e) { summary.error=safeText(e?.message||"Could not read comments",300); continue; }
  summary.scanned_posts++;
  for(const c of comments) {
   if(!c?.id||!isKeywordComment(c.message,keyword)) continue;
   if(c.from?.id&&String(c.from.id)===pageId) continue;
   const r=await env.DB.prepare("INSERT OR IGNORE INTO comment_leads(id,owner_user_id,account_id,page_id,post_id,comment_id,commenter_id,commenter_name,comment_text,comment_created_at,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'pending',?,?)")
    .bind(random(12),account.owner_user_id,account.id,pageId,String(post_id),String(c.id),c.from?.id?String(c.from.id):null,c.from?.name?safeText(c.from.name,120):null,safeText(c.message,300),c.created_time||null,now(),now()).run();
   if((r.meta?.changes||0)===1) summary.new_leads++;
  }
 }
 if(mode!=="live") return summary;
 const readiness=commentDmReadiness(env,scopes,tasks);
 if(!readiness.ready) return {...summary,error:"Not ready to send: "+readiness.missing.join(", ")};
 const text=safeText(String(env.COMMENT_DM_TEXT).trim(),1900);
 const {results:pending=[]}=await env.DB.prepare("SELECT id,post_id,comment_id,commenter_id,comment_created_at FROM comment_leads WHERE account_id=? AND status='pending' ORDER BY created_at LIMIT ?").bind(account.id,DM_MAX_SENDS_PER_RUN).all();
 for(const lead of pending) {
  const age=Date.now()-Date.parse(lead.comment_created_at||0);
  const already=lead.commenter_id?await env.DB.prepare("SELECT id FROM comment_leads WHERE account_id=? AND post_id=? AND commenter_id=? AND id<>? AND status IN ('sending','sent','unknown','failed')").bind(account.id,lead.post_id,lead.commenter_id,lead.id).first():null;
  const skip=!(age>=0&&age<DM_WINDOW_MS-DM_SAFETY_MS)?"Comment is older than Facebook's 7-day private-reply window"
   :(allow.length&&!allow.includes(String(lead.commenter_id||""))&&!allow.includes(String(lead.comment_id)))?"Commenter/comment is not on COMMENT_DM_ALLOW_IDS (test allowlist)"
   :already?"This person was already messaged (or attempted) for this post":null;
  if(skip) { await env.DB.prepare("UPDATE comment_leads SET status='skipped',reason=?,updated_at=? WHERE id=? AND status='pending'").bind(skip,now(),lead.id).run(); summary.skipped++; continue; }
  const claim=await env.DB.prepare("UPDATE comment_leads SET status='sending',updated_at=? WHERE id=? AND status='pending'").bind(now(),lead.id).run();
  if((claim.meta?.changes||0)!==1) continue;
  let result;
  try { result=await sendPrivateReply(env,pageId,lead.comment_id,text,token); }
  catch {
   await env.DB.prepare("UPDATE comment_leads SET status='unknown',reason=?,updated_at=? WHERE id=?").bind("Network error after the send request; not retried",now(),lead.id).run();
   await audit(env,account.owner_user_id,"comment_dm_unknown","comment",lead.comment_id,actor,{account_id:account.id});
   summary.unknown++; continue;
  }
  if(result.ok) {
   await env.DB.prepare("UPDATE comment_leads SET status='sent',message_id=?,reason=NULL,sent_at=?,updated_at=? WHERE id=?").bind(result.message_id,now(),now(),lead.id).run();
   await audit(env,account.owner_user_id,"comment_dm_sent","comment",lead.comment_id,actor,{account_id:account.id,message_id:result.message_id});
   summary.sent++;
  } else {
   await env.DB.prepare("UPDATE comment_leads SET status='failed',reason=?,updated_at=? WHERE id=?").bind(result.error,now(),lead.id).run();
   await audit(env,account.owner_user_id,"comment_dm_failed","comment",lead.comment_id,actor,{account_id:account.id,error:result.error});
   summary.failed++;
  }
 }
 return summary;
}
export async function runCommentSecretary(env,ownerId=null,actor="comment_dm_cron") {
 if(commentDmMode(env)==="off") return [];
 const {results=[]}=await env.DB.prepare("SELECT id,owner_user_id,external_account_id,account_name,status,scopes_json,page_tasks_json,encrypted_access_token FROM social_accounts WHERE platform='facebook' AND status='connected'"+(ownerId?" AND owner_user_id=?":"")).bind(...(ownerId?[ownerId]:[])).all();
 const out=[];
 for(const a of results) {
  try { out.push(await runCommentSecretaryForAccount(env,a,actor)); }
  catch(e) { out.push({account_id:a.id,error:isMissingTable(e)?"Database migration 0010_comment_leads is not applied":safeText(e?.message||"failed",300)}); }
 }
 return out;
}
async function commentSecretaryView(env,user) {
 const {results:accounts=[]}=await env.DB.prepare("SELECT id,account_name,scopes_json,page_tasks_json FROM social_accounts WHERE owner_user_id=? AND platform='facebook' AND status='connected'").bind(user.id).all();
 const view={mode:commentDmMode(env),keyword:commentDmKeyword(env),message_configured:!!String(env.COMMENT_DM_TEXT||"").trim(),test_allowlist:commentDmAllowIds(env).length>0,
  pages:accounts.map(a=>({id:a.id,name:a.account_name,...commentDmReadiness(env,JSON.parse(a.scopes_json||"[]"),JSON.parse(a.page_tasks_json||"[]"))})),schema_ready:true,leads:[]};
 try { view.leads=(await env.DB.prepare("SELECT id,post_id,comment_id,commenter_name,comment_text,comment_created_at,status,reason,sent_at,created_at FROM comment_leads WHERE owner_user_id=? ORDER BY created_at DESC LIMIT 100").bind(user.id).all()).results||[]; }
 catch(e) { if(!isMissingTable(e)) throw e; view.schema_ready=false; }
 return view;
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
// ---- Cloud creative workflow: Master Bot -> Creative Bot -> Graphic Design -> แอดมินโซเชียล ----
// Each advance call runs exactly one stage under a row lock, so the browser (or the cron fallback)
// can drive the run step by step while the activity feed polls the timestamped events.
const WF_TEXT_MODEL="@cf/aisingapore/gemma-sea-lion-v4-27b-it";
const WF_IMAGE_SQUARE_MODEL="@cf/black-forest-labs/flux-1-schnell";
const WF_IMAGE_WIDE_MODEL="@cf/leonardo/lucid-origin";
// WF_ECONOMY_IMAGES="on": use FLUX schnell (~250 neurons/image) instead of Lucid Origin (~3,300–7,000 neurons/image)
// so several daily posts fit Workers AI's free 10,000 neurons per rolling 24 h. FLUX schnell renders square images.
export const wfEconomyImages=(env)=>String(env?.WF_ECONOMY_IMAGES||"").trim().toLowerCase()==="on";
export const wfWideModel=(env)=>wfEconomyImages(env)?WF_IMAGE_SQUARE_MODEL:WF_IMAGE_WIDE_MODEL;
const WF_LOCK_MS=180000;
const WF_ASSETS=[
 {kind:"cover",from:"creative_done",to:"graphic_cover",label:"ภาพปก",model:WF_IMAGE_SQUARE_MODEL,width:1024,height:1024,promptKey:"cover_prompt"},
 {kind:"illustration",from:"graphic_cover",to:"graphic_illustration",label:"ภาพประกอบ",model:WF_IMAGE_SQUARE_MODEL,width:1024,height:1024,promptKey:"illustration_prompt"},
 {kind:"banner",from:"graphic_illustration",to:"graphic_banner",label:"แบนเนอร์",model:WF_IMAGE_WIDE_MODEL,width:1536,height:640,promptKey:"banner_prompt"}
];
const WF_STAGE_AGENT={created:"master",planned:"creative",creative_done:"graphic",graphic_cover:"graphic",graphic_illustration:"graphic",graphic_banner:"social"};
export function extractJsonObject(text) {
 const s=String(text||"");
 const fenced=s.match(/```(?:json)?\s*([\s\S]*?)```/i);
 for(const c of [fenced?fenced[1]:null,s]) {
  if(!c) continue;
  const start=c.indexOf("{"),end=c.lastIndexOf("}");
  if(start<0||end<=start) continue;
  try { return JSON.parse(c.slice(start,end+1)); } catch {}
 }
 return null;
}
async function wfLlmJson(env,system,user,validate) {
 let last="";
 for(let attempt=0;attempt<2;attempt++) {
  const r=await env.AI.run(WF_TEXT_MODEL,{messages:[{role:"system",content:system},{role:"user",content:attempt?user+"\n\nตอบเป็น JSON object เดียวที่ถูกต้องเท่านั้น ห้ามมีข้อความอื่น":user}],max_tokens:1600,response_format:{type:"json_object"}});
  const content=r?.choices?.[0]?.message?.content??r?.response??"";
  const obj=content&&typeof content==="object"?content:extractJsonObject(content);
  last=typeof content==="string"?content:JSON.stringify(content);
  if(obj&&validate(obj)) return obj;
 }
 throw new Error("AI output was not valid JSON: "+safeText(last,160));
}
async function wfImageBase64(result) {
 if(result&&typeof result.image==="string") return result.image;
 if(result instanceof ReadableStream||result instanceof ArrayBuffer||result instanceof Uint8Array) {
  const bytes=new Uint8Array(result instanceof ReadableStream?await new Response(result).arrayBuffer():result);
  let bin=""; for(let i=0;i<bytes.length;i+=0x8000) bin+=String.fromCharCode(...bytes.subarray(i,i+0x8000));
  return btoa(bin);
 }
 throw new Error("Image model returned no image");
}
async function appSecretProof(env,token) {
 if(!env.META_APP_SECRET) return null;
 const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(env.META_APP_SECRET),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
 const proof=await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(token));
 return Array.from(new Uint8Array(proof),b=>b.toString(16).padStart(2,"0")).join("");
}
async function wfEvent(env,runId,from,to,status,message,detail=null) {
 const row=await env.DB.prepare("SELECT COALESCE(MAX(seq),0)+1 n FROM workflow_events WHERE run_id=?").bind(runId).first();
 await env.DB.prepare("INSERT INTO workflow_events(id,run_id,seq,from_agent,to_agent,status,message,detail_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
  .bind(random(12),runId,row?.n||1,from,to,status,safeText(message,700),detail?JSON.stringify(detail).slice(0,6000):null,now()).run();
}
const wfImagePrompt=(p)=>safeText(p,900)+", professional social media visual, clean composition, high quality, no text, no letters, no words, no logos, no watermark";
// ---- Video Editor mode (short vertical clip) ----
// A command that contains [VIDEO] or "Video Editor" runs: Master Bot → Creative Bot → Graphic Design (one 9:16 keyframe)
// → Video Editor (render node) → แอดมินโซเชียล (ONE Facebook Page video post).
// Rendering (ffmpeg, Thai TTS, subtitles, character compositing) cannot run inside a Worker, so the run waits at
// "video_awaiting_render" until the render node (scripts/video_editor/render_node.py, authenticated with VIDEO_RENDER_TOKEN)
// renders, checks the file and hands it over. The MP4 is streamed to Facebook and not stored in D1.
// Exact wording: TEXT:"..." (on-screen hook) and VO:"..." (voice-over) in the command are used verbatim.
export const WF_VIDEO_SPEC={width:1080,height:1920,duration:6,fps:30};
// VIDEO_MAX_SECONDS (default 6.6, capped at 20): longer two-part clips such as the ~12 s Clip 2 format need e.g. "15".
export const wfVideoMaxSeconds=(env)=>{ const v=Number(env?.VIDEO_MAX_SECONDS); return Number.isFinite(v)&&v>=6.6?Math.min(v,20):6.6; };
export const wfIsVideo=(command)=>/\[VIDEO\]|video\s*editor/i.test(String(command||""));
export function wfVideoDirectives(command) {
 const text=String(command||"");
 const pick=(key,max)=>{ const m=text.match(new RegExp(key+'\\s*[:：]\\s*["“]([^"“”\\n]{1,'+max+'})["”]',"i")); return m?m[1].trim():null; };
 return {text:pick("TEXT",120),vo:pick("VO",240)};
}
// Two subtitle lines, split at the space or Thai connective nearest the middle (Thai has no spaces between words).
export function wfSubtitleLines(vo) {
 const s=String(vo||"").trim();
 if(s.length<=20) return [s];
 const mid=s.length/2;
 const cuts=[];
 for(const w of [" ","…","แล้ว","ว่า","คือ","แต่","จะ","ไม่"]) { let i=s.indexOf(w,4); while(i>0&&i<s.length-4) { cuts.push(w===" "||w==="…"?i+1:i); i=s.indexOf(w,i+1); } }
 if(!cuts.length) return [s];
 const cut=cuts.sort((a,b)=>Math.abs(a-mid)-Math.abs(b-mid))[0];
 return [s.slice(0,cut).trim(),s.slice(cut).trim()].filter(Boolean);
}
const wfVideoKeyframePrompt=(p)=>safeText(p,700)+", vertical 9:16 composition, cinematic dark modern corporate office at night, neon cyan and magenta accent lights, glowing floating resume documents in the air, open empty space in the lower center for a person to be composited, no people, no person, no human, no text, no letters, no words, no logos, no watermark, high detail";
export function wfVideoQcProblems(qc,size,head,maxSeconds=6.6) {
 const p=[];
 if(!(size>=50*1024&&size<=25*1024*1024)) p.push("file size "+size+" bytes is outside 50 KB–25 MB");
 if(!head||String.fromCharCode(...head.slice(4,8))!=="ftyp") p.push("file is not an MP4 (no ftyp box)");
 const q=qc&&typeof qc==="object"?qc:{};
 if(q.width!==WF_VIDEO_SPEC.width||q.height!==WF_VIDEO_SPEC.height) p.push("resolution must be 1080x1920 (9:16), got "+q.width+"x"+q.height);
 if(!(Number(q.duration)>=5.5&&Number(q.duration)<=maxSeconds)) p.push("duration must be 5.5–"+maxSeconds+" s, got "+q.duration);
 if(q.video_codec!=="h264") p.push("video codec must be h264");
 if(q.audio_codec!=="aac"||!q.has_audio) p.push("an AAC audio track (voice-over) is required");
 if(!q.subtitles_burned_in) p.push("Thai subtitles must be burned in");
 if(!q.character_reference) p.push("the main character reference must be used");
 return p;
}
// Content guard for scheduled/routine commands (no schema change):
//  [CID:<id>]  content ID — the same ID cannot start a new run while one is running or after one was published in the last 30 days.
//  CTA "<word>" — the published caption must contain the word; when the AI leaves it out, a CTA line is appended.
const WF_DUPLICATE_WINDOW_DAYS=30;
export function wfDirectives(command) {
 const text=String(command||"");
 const cid=text.match(/\[CID:([A-Za-z0-9_-]{2,40})\]/);
 const cta=text.match(/CTA\s*[:：]?\s*["“”'‘’]([^"“”'‘’\n]{1,40})["“”'‘’]/i);
 return {cid:cid?cid[1]:null,cta:cta?cta[1].trim():null};
}
export function wfEnsureCta(caption,cta) {
 const text=String(caption||"").trim();
 if(!cta||text.includes(cta)) return {caption:text,added:false};
 return {caption:text+"\n\n👉 คอมเมนต์ \""+cta+"\" ใต้โพสต์นี้",added:true};
}
async function wfDuplicateReason(env,userId,text,cid) {
 const since=new Date(Date.now()-WF_DUPLICATE_WINDOW_DAYS*86400000).toISOString();
 const {results=[]}=await env.DB.prepare("SELECT id,command,status,created_at FROM workflow_runs WHERE owner_user_id=? AND created_at>=? AND status IN ('running','completed')").bind(userId,since).all();
 const hit=results.find(r=>(cid&&wfDirectives(r.command).cid===cid)||r.command===text);
 if(!hit) return null;
 return (cid?"Content ID "+cid:"คำสั่งเดียวกันนี้")+" ถูกใช้แล้วใน Run "+hit.id+" ("+hit.status+", "+hit.created_at+") · ไม่สร้างโพสต์ซ้ำภายใน "+WF_DUPLICATE_WINDOW_DAYS+" วัน";
}
export async function wfCreateRun(env,user,command) {
 const text=safeText(String(command||"").trim(),1000);
 if(text.length<4) return {error:"Command is too short",status:422};
 const {results:fb=[]}=await env.DB.prepare("SELECT id,account_name,external_account_id,scopes_json,page_tasks_json FROM social_accounts WHERE owner_user_id=? AND platform='facebook' AND status='connected' AND encrypted_access_token IS NOT NULL").bind(user.id).all();
 const ready=fb.filter(a=>facebookPublishReadiness(JSON.parse(a.scopes_json||"[]"),JSON.parse(a.page_tasks_json||"[]")).ready);
 const named=ready.filter(a=>text.toLowerCase().includes(String(a.account_name).toLowerCase()));
 const target=named.length===1?named[0]:ready.length===1?ready[0]:null;
 const id=random(12),stamp=now();
 const duplicate=await wfDuplicateReason(env,user.id,text,wfDirectives(text).cid);
 const blocked=duplicate?duplicate:!target?(ready.length?"พบ Facebook Page ที่พร้อมโพสต์หลายเพจ กรุณาระบุชื่อเพจในคำสั่ง: "+ready.map(a=>a.account_name).join(", "):"ยังไม่มี Facebook Page ที่เชื่อมต่อและพร้อมโพสต์"):null;
 await env.DB.prepare("INSERT INTO workflow_runs(id,owner_user_id,command,status,stage,target_account_id,error_message,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
  .bind(id,user.id,text,target&&!duplicate?"running":"blocked","created",target?target.id:null,blocked,stamp,stamp).run();
 await wfEvent(env,id,"user","master","RECEIVED","รับคำสั่งจากแชท: "+text);
 if(target&&!duplicate) await wfEvent(env,id,"master","master","TARGET","เพจปลายทาง: "+target.account_name+" (Page ID "+target.external_account_id+")",{page_id:target.external_account_id});
 else await wfEvent(env,id,"master","user","BLOCKED",blocked);
 await audit(env,user.id,"workflow_started","workflow",id,user.email,{command:text,target_account_id:target?.id||null,blocked:!!blocked,duplicate:!!duplicate});
 return {id};
}
async function wfStep(env,run,actor) {
 const plan=run.plan_json?JSON.parse(run.plan_json):null,creative=run.creative_json?JSON.parse(run.creative_json):null;
 const account=await env.DB.prepare("SELECT id,owner_user_id,external_account_id,account_name,status,scopes_json,page_tasks_json,encrypted_access_token FROM social_accounts WHERE id=? AND owner_user_id=? AND platform='facebook'").bind(run.target_account_id,run.owner_user_id).first();
 if(!account) throw new Error("Target Facebook Page is no longer connected");
 if(wfIsVideo(run.command)) return wfVideoStep(env,run,account,plan);
 if(run.stage==="created") {
  await wfEvent(env,run.id,"master","master","WORKING","Master Bot กำลังวิเคราะห์คำสั่งและวางแผนมอบหมายงาน ("+WF_TEXT_MODEL+")");
  const p=await wfLlmJson(env,
   'คุณคือ Master Bot ผู้ประสานงานทีม AI ของเพจ Facebook "'+account.account_name+'" วิเคราะห์คำสั่งผู้ใช้แล้ววางแผนให้ Creative Bot (คิดคอนเซปต์ สคริปต์ และ prompt ภาพ), Graphic Design (สร้างภาพปก ภาพประกอบ และแบนเนอร์) และแอดมินโซเชียล (โพสต์ลงเพจ) ตอบเป็น JSON เท่านั้น: {"summary":"สรุปแผนภาษาไทย 1 ประโยค","topic":"หัวข้อโพสต์","audience":"กลุ่มเป้าหมาย","tone":"โทนการสื่อสาร","creative_brief":"คำสั่งถึง Creative Bot","graphic_brief":"แนวทางภาพถึง Graphic Design","social_brief":"แนวทางการโพสต์ถึงแอดมินโซเชียล"}',
   "คำสั่งผู้ใช้: "+run.command,
   o=>typeof o.creative_brief==="string"&&o.creative_brief.trim()&&typeof o.topic==="string");
  await env.DB.prepare("UPDATE workflow_runs SET plan_json=?,stage='planned',updated_at=? WHERE id=?").bind(JSON.stringify(p),now(),run.id).run();
  await wfEvent(env,run.id,"master","creative","HANDOFF","Master Bot มอบหมาย Creative Bot: "+safeText(p.creative_brief,400),{summary:p.summary,topic:p.topic,audience:p.audience,tone:p.tone});
  return;
 }
 if(run.stage==="planned") {
  await wfEvent(env,run.id,"creative","creative","WORKING","Creative Bot กำลังคิดคอนเซปต์ สคริปต์ แคปชัน และ prompt ภาพ 3 ชิ้น");
  const c=await wfLlmJson(env,
   'คุณคือ Creative Bot ของเพจ Facebook "'+account.account_name+'" (ชุมชนสายงาน HR สรรหาว่าจ้าง) สร้างคอนเทนต์ตาม brief ตอบเป็น JSON เท่านั้น: {"concept":"คอนเซปต์ภาษาไทย 1-2 ประโยค","script":"สคริปต์/โครงเรื่องโพสต์ภาษาไทย 3-5 ข้อ","caption":"แคปชันโพสต์ Facebook ภาษาไทย 4-8 บรรทัด อ่านง่าย ใช้อีโมจิพอประมาณ ปิดท้ายด้วยแฮชแท็ก 3-5 อัน","cover_prompt":"English prompt for a square cover image","illustration_prompt":"English prompt for a square supporting illustration","banner_prompt":"English prompt for a wide web banner"} กติกา: prompt ภาพต้องเป็นภาษาอังกฤษ บรรยายเฉพาะภาพ ห้ามมีตัวอักษรในภาพ; แคปชันห้ามแต่งตัวเลขสถิติ ห้ามอ้างชื่อบริษัทหรือบุคคลจริง และห้ามใส่ข้อมูลส่วนบุคคล',
   "คำสั่งผู้ใช้: "+run.command+"\nแผนจาก Master Bot: "+JSON.stringify(plan),
   o=>["concept","caption","cover_prompt","illustration_prompt","banner_prompt"].every(k=>typeof o[k]==="string"&&o[k].trim())&&o.caption.length>=20);
  c.caption=safeText(String(c.caption).replace(/```/g,"").trim(),2200);
  const cta=wfDirectives(run.command).cta;
  const ensured=wfEnsureCta(c.caption,cta);
  c.caption=safeText(ensured.caption,2200);
  if(cta) c.cta={word:cta,added_by_guard:ensured.added};
  if(Array.isArray(c.script)) c.script=c.script.join("\n");
  await env.DB.prepare("UPDATE workflow_runs SET creative_json=?,stage='creative_done',updated_at=? WHERE id=?").bind(JSON.stringify(c),now(),run.id).run();
  await wfEvent(env,run.id,"creative","graphic","HANDOFF","Creative Bot ส่ง brief + prompt ภาพ 3 ชิ้นให้ Graphic Design · คอนเซปต์: "+safeText(c.concept,300),{concept:c.concept,script:safeText(c.script||"",1200),cover_prompt:c.cover_prompt,illustration_prompt:c.illustration_prompt,banner_prompt:c.banner_prompt});
  return;
 }
 const assetStep=WF_ASSETS.find(a=>a.from===run.stage);
 if(assetStep) {
  const prompt=wfImagePrompt(creative[assetStep.promptKey]);
  await wfEvent(env,run.id,"graphic","graphic","WORKING","Graphic Design กำลังสร้าง"+assetStep.label+" "+assetStep.width+"x"+assetStep.height+" ("+assetStep.model+")");
  const model=assetStep.model===WF_IMAGE_WIDE_MODEL?wfWideModel(env):assetStep.model;
  const input=model===WF_IMAGE_WIDE_MODEL?{prompt,width:assetStep.width,height:assetStep.height,num_steps:20}:{prompt,steps:6};
  const b64=await wfImageBase64(await env.AI.run(model,input));
  const bytes=Math.floor(b64.length*3/4);
  await env.DB.prepare("INSERT OR IGNORE INTO workflow_assets(id,run_id,kind,prompt,model,mime,width,height,bytes,data_b64,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
   .bind(random(12),run.id,assetStep.kind,prompt,assetStep.model,"image/jpeg",assetStep.width,assetStep.height,bytes,b64,now()).run();
  await env.DB.prepare("UPDATE workflow_runs SET stage=?,updated_at=? WHERE id=?").bind(assetStep.to,now(),run.id).run();
  await wfEvent(env,run.id,"graphic","graphic","DONE","สร้าง"+assetStep.label+"เสร็จ ("+assetStep.width+"x"+assetStep.height+", "+Math.round(bytes/1024)+" KB)",{kind:assetStep.kind});
  if(assetStep.kind==="banner") await wfEvent(env,run.id,"graphic","social","HANDOFF","Graphic Design ส่งภาพปก ภาพประกอบ แบนเนอร์ และแคปชันให้แอดมินโซเชียล");
  return;
 }
 if(run.stage==="graphic_banner") {
  await wfEvent(env,run.id,"social","social","WORKING","แอดมินโซเชียลกำลังโพสต์ภาพ 3 ชิ้น + แคปชันลงเพจ "+account.account_name);
  const readiness=facebookPublishReadiness(JSON.parse(account.scopes_json||"[]"),JSON.parse(account.page_tasks_json||"[]"));
  if(account.status!=="connected"||!account.encrypted_access_token||!readiness.ready) throw new Error("Facebook Page is not authorized to publish: "+readiness.missing.join(", "));
  let contentId=run.content_id;
  if(!contentId) {
   contentId=random(16);
   const stamp=now();
   await env.DB.prepare("INSERT INTO content_items(id,owner_user_id,title,body,affiliate_url,disclosure,platforms_json,account_ids_json,status,created_at,updated_at,approved_at,approved_by) VALUES(?,?,?,?,?,?,?,?,'approved',?,?,?,?)")
    .bind(contentId,run.owner_user_id,safeText("Workflow: "+(creative.concept||plan?.topic||"Creative post"),240),creative.caption,null,"",JSON.stringify(["facebook"]),JSON.stringify([account.id]),stamp,stamp,stamp,safeText(actor,120)+" (user-authorized workflow)").run();
   await env.DB.prepare("UPDATE workflow_runs SET content_id=?,updated_at=? WHERE id=?").bind(contentId,now(),run.id).run();
   await audit(env,run.owner_user_id,"content_approve","content",contentId,actor,{reason:"User instructed this workflow to publish directly",workflow_run:run.id});
  }
  const existing=await env.DB.prepare("SELECT status,external_post_id,permalink FROM publish_records WHERE content_id=? AND account_id=?").bind(contentId,account.id).first();
  if(existing) {
   if(existing.status==="published") { await env.DB.prepare("UPDATE workflow_runs SET status='completed',stage='published',post_id=?,permalink=?,completed_at=?,updated_at=? WHERE id=?").bind(existing.external_post_id,existing.permalink,now(),now(),run.id).run(); return; }
   throw new Error("A previous publish attempt is "+existing.status+"; not retried to avoid duplicate posts");
  }
  const recordId=random(16);
  await env.DB.prepare("INSERT INTO publish_records(id,owner_user_id,content_id,account_id,platform,idempotency_key,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'publishing',?,?)")
   .bind(recordId,run.owner_user_id,contentId,account.id,"facebook","wf_"+run.id,now(),now()).run();
  const failRecord=async(status,message)=>{ await env.DB.prepare("UPDATE publish_records SET status=?,error_message=?,updated_at=? WHERE id=?").bind(status,safeText(message,300),now(),recordId).run(); };
  const token=await decrypt(account.encrypted_access_token,env),proof=await appSecretProof(env,token);
  const page=encodeURIComponent(account.external_account_id),base="https://graph.facebook.com/"+graphVersion(env)+"/";
  const {results:assets=[]}=await env.DB.prepare("SELECT id,kind,data_b64,fb_photo_id FROM workflow_assets WHERE run_id=? ORDER BY CASE kind WHEN 'cover' THEN 1 WHEN 'illustration' THEN 2 ELSE 3 END").bind(run.id).all();
  if(assets.length!==3) { await failRecord("failed","Expected 3 generated images"); throw new Error("Expected 3 generated images, found "+assets.length); }
  const mediaIds=[];
  for(const asset of assets) {
   let photoId=asset.fb_photo_id;
   if(!photoId) {
    const form=new FormData();
    form.set("access_token",token); if(proof) form.set("appsecret_proof",proof);
    form.set("published","false");
    form.set("source",new Blob([Uint8Array.from(atob(asset.data_b64),c=>c.charCodeAt(0))],{type:"image/jpeg"}),asset.kind+".jpg");
    let res,meta;
    try { res=await fetch(base+page+"/photos",{method:"POST",body:form,headers:{Accept:"application/json"}}); meta=await res.json().catch(()=>({})); }
    catch { await failRecord("failed","Network error while uploading "+asset.kind); throw new Error("Network error while uploading the "+asset.kind+" image; nothing was posted"); }
    if(!res.ok||meta.error||!meta.id) { const m=safeText(meta.error?.message||"Photo upload failed",300); await failRecord("failed",m); throw new Error("Facebook rejected the "+asset.kind+" upload: "+m); }
    photoId=String(meta.id);
    await env.DB.prepare("UPDATE workflow_assets SET fb_photo_id=? WHERE id=?").bind(photoId,asset.id).run();
   }
   mediaIds.push(photoId);
  }
  await wfEvent(env,run.id,"social","social","UPLOADED","อัปโหลดภาพ 3 ชิ้นแบบยังไม่เผยแพร่แล้ว กำลังสร้างโพสต์",{media_fbids:mediaIds});
  const feed=new FormData();
  feed.set("access_token",token); if(proof) feed.set("appsecret_proof",proof);
  feed.set("message",creative.caption); feed.set("published","true");
  mediaIds.forEach((id,i)=>feed.set("attached_media["+i+"]",JSON.stringify({media_fbid:id})));
  let res,meta;
  try { res=await fetch(base+page+"/feed",{method:"POST",body:feed,headers:{Accept:"application/json"}}); meta=await res.json().catch(()=>({})); }
  catch {
   await failRecord("unknown","Network error after the post request; check the Page before retrying");
   await audit(env,run.owner_user_id,"facebook_publish_unknown","content",contentId,actor,{account_id:account.id,workflow_run:run.id});
   throw new Error("The connection ended before Facebook confirmed the post; it may exist. Not retried.");
  }
  if(!res.ok||meta.error||!meta.id) {
   const m=safeText(meta.error?.message||"Facebook did not return a post ID",300);
   await failRecord("failed",m);
   await audit(env,run.owner_user_id,"facebook_publish_failed","content",contentId,actor,{account_id:account.id,workflow_run:run.id,error:m});
   throw new Error("Facebook rejected the post: "+m);
  }
  const postId=String(meta.id);
  let permalink=null;
  try { permalink=(await graphGet(env,postId,{fields:"permalink_url",access_token:token})).permalink_url||null; } catch {}
  const done=now();
  await env.DB.prepare("UPDATE publish_records SET status='published',external_post_id=?,permalink=?,updated_at=? WHERE id=?").bind(postId,permalink,done,recordId).run();
  await env.DB.prepare("UPDATE content_items SET status='published',updated_at=? WHERE id=?").bind(done,contentId).run();
  await env.DB.prepare("UPDATE workflow_runs SET status='completed',stage='published',post_id=?,permalink=?,completed_at=?,updated_at=? WHERE id=?").bind(postId,permalink,done,done,run.id).run();
  await audit(env,run.owner_user_id,"facebook_post_published","content",contentId,actor,{account_id:account.id,post_id:postId,permalink,post_kind:"multi_photo",workflow_run:run.id});
  await wfEvent(env,run.id,"social","master","DONE","แอดมินโซเชียลโพสต์สำเร็จ · Post ID "+postId,{post_id:postId,permalink});
  await wfEvent(env,run.id,"master","user","COMPLETED","Workflow เสร็จสมบูรณ์ · Facebook ยืนยันโพสต์แล้ว"+(permalink?" · "+permalink:""),{post_id:postId,permalink});
  return;
 }
 throw new Error("Unknown workflow stage "+run.stage);
}
async function wfVideoStep(env,run,account,plan) {
 if(run.stage==="created") {
  await wfEvent(env,run.id,"master","master","WORKING","Master Bot กำลังวางแผนคลิปวิดีโอสั้นแนวตั้ง ("+WF_TEXT_MODEL+")");
  const p=await wfLlmJson(env,
   'คุณคือ Master Bot ผู้ประสานงานทีม AI ของเพจ Facebook "'+account.account_name+'" วางแผนคลิปวิดีโอสั้นแนวตั้ง 9:16 ยาว 6 วินาที 1 ซีน ให้ Creative Bot (คอนเซปต์ แคปชัน prompt ฉาก), Graphic Design (ภาพฉากหลังแนวตั้ง 1 ภาพ), Video Editor (ตัดต่อ ซับไทย เสียงบรรยาย เสียง impact) และแอดมินโซเชียล (โพสต์วิดีโอลงเพจ 1 ครั้ง) ตอบเป็น JSON เท่านั้น: {"summary":"สรุปแผนภาษาไทย 1 ประโยค","topic":"หัวข้อคลิป","audience":"กลุ่มเป้าหมาย","tone":"โทน","creative_brief":"คำสั่งถึง Creative Bot","graphic_brief":"แนวทางภาพฉากหลังถึง Graphic Design","video_brief":"แนวทางตัดต่อถึง Video Editor","social_brief":"แนวทางการโพสต์ถึงแอดมินโซเชียล"}',
   "คำสั่งผู้ใช้: "+run.command,
   o=>typeof o.creative_brief==="string"&&o.creative_brief.trim()&&typeof o.topic==="string");
  await env.DB.prepare("UPDATE workflow_runs SET plan_json=?,stage='planned',updated_at=? WHERE id=?").bind(JSON.stringify({...p,mode:"video"}),now(),run.id).run();
  await wfEvent(env,run.id,"master","creative","HANDOFF","Master Bot มอบหมาย Creative Bot (คลิปวิดีโอ 9:16 · 6 วินาที): "+safeText(p.creative_brief,400),{summary:p.summary,topic:p.topic,video_brief:p.video_brief});
  return;
 }
 if(run.stage==="planned") {
  const d=wfVideoDirectives(run.command);
  await wfEvent(env,run.id,"creative","creative","WORKING","Creative Bot กำลังเขียนคอนเซปต์ แคปชัน และ prompt ฉากหลังของคลิป");
  const c=await wfLlmJson(env,
   'คุณคือ Creative Bot ของเพจ Facebook "'+account.account_name+'" (ชุมชนสายงาน HR สรรหาว่าจ้าง) สร้างคลิปสั้นแนวตั้ง 6 วินาที ตอบเป็น JSON เท่านั้น: {"concept":"คอนเซปต์ภาษาไทย 1-2 ประโยค","hook_text":"ข้อความบนจอภาษาไทยสั้น ๆ","voiceover":"เสียงบรรยายภาษาไทย 1 ประโยค อ่านจบใน 4 วินาที จบด้วยคำถามกระตุกความคิด","caption":"แคปชันโพสต์ Facebook ภาษาไทย 3-6 บรรทัด ปิดท้ายด้วยคำถามชวนคอมเมนต์และแฮชแท็ก 3-5 อัน","keyframe_prompt":"English prompt describing ONLY the background scene (no people)"} กติกา: ถ้าผู้ใช้กำหนด TEXT หรือ VO มา ให้ใช้ข้อความนั้นตรงตัว; prompt ภาพเป็นภาษาอังกฤษ ไม่มีคนและไม่มีตัวอักษร; แคปชันห้ามแต่งตัวเลขสถิติ ห้ามอ้างชื่อบริษัทหรือบุคคลจริง',
   "คำสั่งผู้ใช้: "+run.command+"\nแผนจาก Master Bot: "+JSON.stringify(plan),
   o=>["concept","caption","keyframe_prompt"].every(k=>typeof o[k]==="string"&&o[k].trim())&&o.caption.length>=20);
  const hook=safeText(d.text||c.hook_text||"",120),vo=safeText(d.vo||c.voiceover||"",240);
  if(!hook||!vo) throw new Error("Creative Bot did not produce on-screen text and voice-over");
  const cta=wfDirectives(run.command).cta;
  const ensured=wfEnsureCta(safeText(String(c.caption).replace(/```/g,"").trim(),2200),cta);
  const creative={mode:"video",concept:safeText(c.concept,600),hook_text:hook,voiceover:vo,subtitle_lines:wfSubtitleLines(vo),caption:safeText(ensured.caption,2200),keyframe_prompt:safeText(c.keyframe_prompt,700),spec:WF_VIDEO_SPEC,text_source:d.text?"user":"ai",vo_source:d.vo?"user":"ai"};
  if(cta) creative.cta={word:cta,added_by_guard:ensured.added};
  await env.DB.prepare("UPDATE workflow_runs SET creative_json=?,stage='creative_done',updated_at=? WHERE id=?").bind(JSON.stringify(creative),now(),run.id).run();
  await wfEvent(env,run.id,"creative","graphic","HANDOFF","Creative Bot ส่ง brief ฉากหลังให้ Graphic Design · ข้อความบนจอ \""+hook+"\" · VO \""+vo+"\"",{concept:creative.concept,hook_text:hook,voiceover:vo,subtitle_lines:creative.subtitle_lines,keyframe_prompt:creative.keyframe_prompt});
  return;
 }
 if(run.stage==="creative_done") {
  const creative=JSON.parse(run.creative_json||"{}"),prompt=wfVideoKeyframePrompt(creative.keyframe_prompt);
  await wfEvent(env,run.id,"graphic","graphic","WORKING","Graphic Design กำลังสร้างฉากหลังแนวตั้ง 1080x1920 ("+WF_IMAGE_WIDE_MODEL+")");
  const vm=wfWideModel(env);
  const b64=await wfImageBase64(await env.AI.run(vm,vm===WF_IMAGE_WIDE_MODEL?{prompt,width:WF_VIDEO_SPEC.width,height:WF_VIDEO_SPEC.height,num_steps:20}:{prompt,steps:6}));
  const bytes=Math.floor(b64.length*3/4);
  await env.DB.prepare("INSERT OR IGNORE INTO workflow_assets(id,run_id,kind,prompt,model,mime,width,height,bytes,data_b64,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
   .bind(random(12),run.id,"cover",prompt,vm,"image/jpeg",WF_VIDEO_SPEC.width,WF_VIDEO_SPEC.height,bytes,b64,now()).run();
  await env.DB.prepare("UPDATE workflow_runs SET stage='video_awaiting_render',updated_at=? WHERE id=?").bind(now(),run.id).run();
  await wfEvent(env,run.id,"graphic","graphic","DONE","สร้างฉากหลังคลิปเสร็จ (1080x1920, "+Math.round(bytes/1024)+" KB)",{kind:"cover",role:"video_keyframe"});
  await wfEvent(env,run.id,"graphic","video","HANDOFF","Graphic Design ส่งฉากหลัง + ข้อความบนจอ + VO + ซับให้ Video Editor · รอ render node ตัดต่อและตรวจไฟล์");
  return;
 }
 throw new Error("Unknown video workflow stage "+run.stage);
}
// ---- Render node API (machine-to-machine, header X-Render-Token = VIDEO_RENDER_TOKEN) ----
export async function renderTokenOk(request,env) {
 const expected=String(env.VIDEO_RENDER_TOKEN||"");
 const got=request.headers.get("X-Render-Token")||"";
 if(expected.length<32||!got) return false;
 return (await sha(got))===(await sha(expected));
}
const WF_VIDEO_JOB_SQL="SELECT r.id,r.owner_user_id,r.command,r.status,r.stage,r.plan_json,r.creative_json,r.target_account_id,r.created_at,a.account_name,a.external_account_id page_id FROM workflow_runs r LEFT JOIN social_accounts a ON a.id=r.target_account_id";
const wfVideoJobView=(r)=>({id:r.id,command:r.command,status:r.status,stage:r.stage,page:r.account_name,page_id:r.page_id,created_at:r.created_at,creative:r.creative_json?JSON.parse(r.creative_json):null});
async function wfVideoJob(env,id) {
 const r=await env.DB.prepare(WF_VIDEO_JOB_SQL+" WHERE r.id=?").bind(id).first();
 return r&&wfIsVideo(r.command)?r:null;
}
export async function wfVideoPublish(env,runId,fileBytes,qc,actor="video_render_node") {
 const run=await wfVideoJob(env,runId);
 if(!run) return {status:404,body:{error:"Video job not found"}};
 if(run.status!=="running"||run.stage!=="video_awaiting_render") return {status:409,body:{error:"Video job is not waiting for a render (status "+run.status+", stage "+run.stage+")"}};
 const problems=wfVideoQcProblems(qc,fileBytes.byteLength,fileBytes.subarray(0,12),wfVideoMaxSeconds(env));
 if(problems.length) {
  await wfEvent(env,run.id,"video","video","QC_REJECTED","Worker ตรวจไฟล์ไม่ผ่าน ไม่ได้โพสต์: "+problems.join("; "),{qc});
  return {status:422,body:{error:"Video QC failed",problems}};
 }
 const stamp=now();
 const claim=await env.DB.prepare("UPDATE workflow_runs SET stage='video_publishing',lock_until=?,updated_at=? WHERE id=? AND status='running' AND stage='video_awaiting_render'").bind(new Date(Date.now()+WF_LOCK_MS).toISOString(),stamp,run.id).run();
 if((claim.meta?.changes||0)!==1) return {status:409,body:{error:"Another upload is already publishing this job"}};
 const creative=JSON.parse(run.creative_json||"{}"),digest=[...new Uint8Array(await crypto.subtle.digest("SHA-256",fileBytes))].map(b=>b.toString(16).padStart(2,"0")).join("");
 const fail=async(message)=>{
  await env.DB.prepare("UPDATE workflow_runs SET status='failed',error_message=?,lock_until=NULL,completed_at=?,updated_at=? WHERE id=?").bind(safeText(message,300),now(),now(),run.id).run();
  await wfEvent(env,run.id,"social","master","FAILED",message);
  await audit(env,run.owner_user_id,"workflow_failed","workflow",run.id,actor,{stage:"video_publishing",error:safeText(message,300)});
  return {status:502,body:{error:message}};
 };
 await wfEvent(env,run.id,"video","video","DONE","Video Editor ตัดต่อเสร็จและตรวจไฟล์ผ่าน · "+qc.width+"x"+qc.height+" · "+Number(qc.duration).toFixed(2)+" วินาที · "+qc.video_codec+"/"+qc.audio_codec+" · "+Math.round(fileBytes.byteLength/1024)+" KB",{qc,sha256:digest,bytes:fileBytes.byteLength});
 await wfEvent(env,run.id,"video","social","HANDOFF","Video Editor ส่งไฟล์ MP4 ที่ตรวจแล้วให้แอดมินโซเชียล (sha256 "+digest.slice(0,12)+"…)");
 const account=await env.DB.prepare("SELECT id,external_account_id,account_name,status,scopes_json,page_tasks_json,encrypted_access_token FROM social_accounts WHERE id=? AND owner_user_id=? AND platform='facebook'").bind(run.target_account_id,run.owner_user_id).first();
 const readiness=account?facebookPublishReadiness(JSON.parse(account.scopes_json||"[]"),JSON.parse(account.page_tasks_json||"[]")):{ready:false,missing:["page not connected"]};
 if(!account||account.status!=="connected"||!account.encrypted_access_token||!readiness.ready) return fail("Facebook Page is not authorized to publish: "+readiness.missing.join(", "));
 await wfEvent(env,run.id,"social","social","WORKING","แอดมินโซเชียลกำลังอัปโหลดวิดีโอ 1 คลิป + แคปชันลงเพจ "+account.account_name);
 const contentId=random(16),recordId=random(16),t0=now();
 await env.DB.prepare("INSERT INTO content_items(id,owner_user_id,title,body,affiliate_url,disclosure,platforms_json,account_ids_json,status,created_at,updated_at,approved_at,approved_by) VALUES(?,?,?,?,?,?,?,?,'approved',?,?,?,?)")
  .bind(contentId,run.owner_user_id,safeText("Video: "+(creative.hook_text||"clip"),240),creative.caption,null,"",JSON.stringify(["facebook"]),JSON.stringify([account.id]),t0,t0,t0,"video workflow (user-authorized single test post)").run();
 await env.DB.prepare("UPDATE workflow_runs SET content_id=?,updated_at=? WHERE id=?").bind(contentId,now(),run.id).run();
 await env.DB.prepare("INSERT INTO publish_records(id,owner_user_id,content_id,account_id,platform,idempotency_key,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'publishing',?,?)")
  .bind(recordId,run.owner_user_id,contentId,account.id,"facebook","wfv_"+run.id,now(),now()).run();
 const mark=async(status,message)=>env.DB.prepare("UPDATE publish_records SET status=?,error_message=?,updated_at=? WHERE id=?").bind(status,safeText(message,300),now(),recordId).run();
 const token=await decrypt(account.encrypted_access_token,env),proof=await appSecretProof(env,token);
 const form=new FormData();
 form.set("access_token",token); if(proof) form.set("appsecret_proof",proof);
 form.set("description",creative.caption); form.set("title",safeText(creative.hook_text||"",120)); form.set("published","true");
 form.set("source",new Blob([fileBytes],{type:"video/mp4"}),"clip.mp4");
 let res,meta;
 try { res=await fetch("https://graph-video.facebook.com/"+graphVersion(env)+"/"+encodeURIComponent(account.external_account_id)+"/videos",{method:"POST",body:form,headers:{Accept:"application/json"}}); meta=await res.json().catch(()=>({})); }
 catch { await mark("unknown","Network error after the video upload request; check the Page before retrying"); return fail("The connection ended before Facebook confirmed the video; it may exist. Not retried."); }
 if(!res.ok||meta.error||!meta.id) { const m=safeText(meta.error?.message||"Facebook did not return a video ID",300); await mark("failed",m); return fail("Facebook rejected the video: "+m); }
 const videoId=String(meta.id);
 let permalink=null;
 try { const v=await graphGet(env,videoId,{fields:"permalink_url",access_token:token}); permalink=v.permalink_url?(String(v.permalink_url).startsWith("http")?v.permalink_url:"https://www.facebook.com"+v.permalink_url):null; } catch {}
 const done=now();
 await env.DB.prepare("UPDATE publish_records SET status='published',external_post_id=?,permalink=?,updated_at=? WHERE id=?").bind(videoId,permalink,done,recordId).run();
 await env.DB.prepare("UPDATE content_items SET status='published',updated_at=? WHERE id=?").bind(done,contentId).run();
 await env.DB.prepare("UPDATE workflow_runs SET status='completed',stage='published',post_id=?,permalink=?,lock_until=NULL,completed_at=?,updated_at=? WHERE id=?").bind(videoId,permalink,done,done,run.id).run();
 await audit(env,run.owner_user_id,"facebook_post_published","content",contentId,actor,{account_id:account.id,post_id:videoId,permalink,post_kind:"video",workflow_run:run.id,sha256:digest});
 await wfEvent(env,run.id,"social","master","DONE","แอดมินโซเชียลโพสต์วิดีโอสำเร็จ · Video ID "+videoId,{post_id:videoId,permalink});
 await wfEvent(env,run.id,"master","user","COMPLETED","Workflow คลิปวิดีโอเสร็จสมบูรณ์ · Facebook ยืนยันวิดีโอแล้ว"+(permalink?" · "+permalink:""),{post_id:videoId,permalink});
 return {status:200,body:{published:true,video_id:videoId,permalink,sha256:digest}};
}
async function handleRenderNode(request,env,path,method) {
 if(!await renderTokenOk(request,env)) return json({error:"Render token required"},401);
 if(method==="GET"&&path==="/video-jobs") {
  const {results=[]}=await env.DB.prepare(WF_VIDEO_JOB_SQL+" WHERE r.status='running' AND r.stage='video_awaiting_render' ORDER BY r.created_at LIMIT 5").all();
  return json({jobs:results.filter(r=>wfIsVideo(r.command)).map(wfVideoJobView)});
 }
 const m=path.match(/^\/video-jobs\/([a-zA-Z0-9_-]+)(?:\/(keyframe|events|publish|fail))?$/);
 if(!m) return json({error:"Not found"},404);
 const job=await wfVideoJob(env,m[1]);
 if(!job) return json({error:"Video job not found"},404);
 if(method==="GET"&&!m[2]) return json({job:wfVideoJobView(job)});
 if(method==="GET"&&m[2]==="keyframe") {
  const a=await env.DB.prepare("SELECT data_b64,mime FROM workflow_assets WHERE run_id=? AND kind='cover'").bind(job.id).first();
  if(!a) return json({error:"Keyframe not found"},404);
  return new Response(Uint8Array.from(atob(a.data_b64),c=>c.charCodeAt(0)),{headers:{"Content-Type":a.mime,"Cache-Control":"no-store"}});
 }
 if(method==="POST"&&(m[2]==="events"||m[2]==="fail")) {
  if(job.status!=="running"||job.stage!=="video_awaiting_render") return json({error:"Video job is not waiting for a render"},409);
  const b=await request.json().catch(()=>({}));
  const message=safeText(String(b.message||"").trim(),600);
  if(!message) return json({error:"message is required"},422);
  if(m[2]==="fail") {
   await env.DB.prepare("UPDATE workflow_runs SET status='failed',error_message=?,completed_at=?,updated_at=? WHERE id=?").bind(safeText("Video Editor: "+message,300),now(),now(),job.id).run();
   await wfEvent(env,job.id,"video","master","FAILED","Video Editor หยุดงาน ไม่ได้โพสต์: "+message);
   await audit(env,job.owner_user_id,"workflow_failed","workflow",job.id,"video_render_node",{stage:job.stage,error:message});
   return json({failed:true});
  }
  const status=["WORKING","QC"].includes(b.status)?b.status:"WORKING";
  await wfEvent(env,job.id,"video","video",status,message,b.detail&&typeof b.detail==="object"?b.detail:null);
  return json({logged:true});
 }
 if(method==="POST"&&m[2]==="publish") {
  const form=await request.formData().catch(()=>null);
  const file=form?.get("video");
  if(!file||typeof file==="string") return json({error:"multipart field 'video' (MP4) is required"},422);
  let qc=null; try { qc=JSON.parse(String(form.get("qc")||"")); } catch {}
  const r=await wfVideoPublish(env,job.id,new Uint8Array(await file.arrayBuffer()),qc);
  return json(r.body,r.status);
 }
 return json({error:"Not found"},404);
}
export async function wfAdvance(env,runId,ownerId,actor) {
 const stamp=now(),lock=new Date(Date.now()+WF_LOCK_MS).toISOString();
 // Video runs waiting for (or being published by) the render node are not advanced here.
 const claim=await env.DB.prepare("UPDATE workflow_runs SET lock_until=?,updated_at=? WHERE id=? AND owner_user_id=? AND status='running' AND stage NOT IN ('video_awaiting_render','video_publishing') AND (lock_until IS NULL OR lock_until<?)").bind(lock,stamp,runId,ownerId,stamp).run();
 if((claim.meta?.changes||0)!==1) return false;
 const run=await env.DB.prepare("SELECT * FROM workflow_runs WHERE id=?").bind(runId).first();
 try { await wfStep(env,run,actor); }
 catch(error) {
  const message=safeText(error?.message||"Workflow step failed",300);
  await env.DB.prepare("UPDATE workflow_runs SET status='failed',error_message=?,completed_at=?,updated_at=? WHERE id=?").bind(message,now(),now(),runId).run();
  await wfEvent(env,runId,WF_STAGE_AGENT[run.stage]||"master","master","FAILED",message);
  await audit(env,ownerId,"workflow_failed","workflow",runId,actor,{stage:run.stage,error:message});
 } finally {
  await env.DB.prepare("UPDATE workflow_runs SET lock_until=NULL,updated_at=? WHERE id=?").bind(now(),runId).run();
 }
 return true;
}
export async function wfView(env,runId,ownerId,after=0) {
 const run=await env.DB.prepare("SELECT r.id,r.command,r.status,r.stage,r.plan_json,r.creative_json,r.content_id,r.post_id,r.permalink,r.error_message,r.lock_until,r.created_at,r.updated_at,r.completed_at,a.account_name,a.external_account_id page_id FROM workflow_runs r LEFT JOIN social_accounts a ON a.id=r.target_account_id WHERE r.id=? AND r.owner_user_id=?").bind(runId,ownerId).first();
 if(!run) return null;
 const {results:events=[]}=await env.DB.prepare("SELECT seq,from_agent,to_agent,status,message,detail_json,created_at FROM workflow_events WHERE run_id=? AND seq>? ORDER BY seq").bind(runId,after).all();
 const {results:assets=[]}=await env.DB.prepare("SELECT kind,prompt,model,width,height,bytes,fb_photo_id,created_at FROM workflow_assets WHERE run_id=? ORDER BY created_at").bind(runId).all();
 const {plan_json,creative_json,...rest}=run;
 return {run:{...rest,plan:plan_json?JSON.parse(plan_json):null,creative:creative_json?JSON.parse(creative_json):null},events:events.map(e=>({...e,detail:e.detail_json?JSON.parse(e.detail_json):null,detail_json:undefined})),assets};
}
// ---- Always-on daily campaign (server-side; runs even when OpenBot and the browser are closed) ----
// Slots: 10:30 and 17:30 Asia/Bangkok (UTC+7, no DST) = 03:30 and 10:30 UTC. The 5-minute cron checks for a due slot.
// Each slot posts ONE creative-workflow run using the next content ID ([CID:...]) that has never been used; the existing
// workflow does Master → Creative → Graphic → Facebook publish, and Auto-Like likes the Page's own post. No comments, no DMs.
// Off unless CAMPAIGN_SCHEDULER="on". A slot is handled once: an audit "campaign_slot" claim, and any workflow run created
// since 30 minutes before the slot (e.g. by the OpenBot routine) counts as that slot's post, so nothing posts twice.
export const CAMPAIGN_SLOTS_UTC=[{label:"10:30",h:3,m:30},{label:"17:30",h:10,m:30}];
// CAMPAIGN_SLOTS="09:30,17:30" (Asia/Bangkok, UTC+7, no DST) overrides the default 10:30/17:30. Invalid entries are ignored.
export function campaignSlots(env) {
 const raw=String(env?.CAMPAIGN_SLOTS||"").trim();
 if(!raw) return CAMPAIGN_SLOTS_UTC;
 const out=[];
 for(const part of raw.split(/[\s,]+/)) {
  const m=part.match(/^([01]?\d|2[0-3]):([0-5]\d)$/); if(!m) continue;
  const mins=((Number(m[1])*60+Number(m[2])-7*60)%1440+1440)%1440;
  out.push({label:m[1].padStart(2,"0")+":"+m[2],h:Math.floor(mins/60),m:mins%60});
 }
 return out.length?out:CAMPAIGN_SLOTS_UTC;
}
const CAMPAIGN_WINDOW_MS=60*60000, CAMPAIGN_FILL_LOOKBACK_MS=30*60000;
export const campaignEnabled=(env)=>String(env.CAMPAIGN_SCHEDULER||"").trim().toLowerCase()==="on";
export function campaignDueSlot(now=new Date(),slots=CAMPAIGN_SLOTS_UTC) {
 for(const s of slots) {
  const start=Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate(),s.h,s.m);
  if(now.getTime()>=start&&now.getTime()<start+CAMPAIGN_WINDOW_MS) {
   const bkk=new Date(start+7*3600000).toISOString().slice(0,10);
   return {key:bkk+"@"+s.label,label:s.label,start:new Date(start).toISOString()};
  }
 }
 return null;
}
export function pickNextCampaignItem(bank,usedCids) {
 return [...(bank.week1||[]),...(bank.week2_3||[]),...(bank.reserves||[])].find(i=>i&&i.cid&&i.command&&!usedCids.has(i.cid))||null;
}
export async function runCampaignScheduler(env,now=new Date(),bank=CAMPAIGN_BANK) {
 if(!campaignEnabled(env)) return {skipped:"disabled"};
 const slot=campaignDueSlot(now,campaignSlots(env));
 if(!slot) return {skipped:"no slot due"};
 const claimed=await env.DB.prepare("SELECT id FROM audit_events WHERE event_type='campaign_slot' AND entity_id=?").bind(slot.key).first();
 if(claimed) return {slot:slot.key,skipped:"slot already handled"};
 const {results:fb=[]}=await env.DB.prepare("SELECT owner_user_id,scopes_json,page_tasks_json FROM social_accounts WHERE platform='facebook' AND status='connected' AND encrypted_access_token IS NOT NULL").all();
 const owners=[...new Set(fb.filter(a=>facebookPublishReadiness(JSON.parse(a.scopes_json||"[]"),JSON.parse(a.page_tasks_json||"[]")).ready).map(a=>a.owner_user_id))];
 const claim=async(ownerId,details)=>audit(env,ownerId,"campaign_slot","campaign",slot.key,"campaign_scheduler",details);
 if(owners.length!==1) { const e=owners.length?"several Dashboard users own publish-ready Pages":"no publish-ready Facebook Page"; console.error("campaign",{slot:slot.key,error:e}); return {slot:slot.key,error:e}; }
 const ownerId=owners[0];
 const since=new Date(Date.parse(slot.start)-CAMPAIGN_FILL_LOOKBACK_MS).toISOString();
 const existing=await env.DB.prepare("SELECT id,command FROM workflow_runs WHERE owner_user_id=? AND created_at>=? ORDER BY created_at LIMIT 1").bind(ownerId,since).first();
 if(existing) { await claim(ownerId,{filled_by:existing.id,cid:wfDirectives(existing.command).cid,source:"existing run"}); return {slot:slot.key,skipped:"slot already has a run",run:existing.id}; }
 const {results:runs=[]}=await env.DB.prepare("SELECT command FROM workflow_runs WHERE owner_user_id=? AND status IN ('running','completed')").bind(ownerId).all();
 const used=new Set(runs.map(r=>wfDirectives(r.command).cid).filter(Boolean));
 const item=pickNextCampaignItem(bank,used);
 if(!item) { await claim(ownerId,{error:"content bank exhausted"}); console.error("campaign",{slot:slot.key,error:"content bank exhausted"}); return {slot:slot.key,error:"content bank exhausted"}; }
 await claim(ownerId,{cid:item.cid,topic:item.topic});
 const user=await env.DB.prepare("SELECT id,email FROM app_users WHERE id=?").bind(ownerId).first();
 const created=await wfCreateRun(env,user,item.command);
 if(created.error) return {slot:slot.key,cid:item.cid,error:created.error};
 for(let i=0;i<8;i++) {
  if(!await wfAdvance(env,created.id,ownerId,"campaign_scheduler")) break;
  const s=await env.DB.prepare("SELECT status FROM workflow_runs WHERE id=?").bind(created.id).first();
  if(s?.status!=="running") break;
 }
 const run=await env.DB.prepare("SELECT status,post_id,error_message FROM workflow_runs WHERE id=?").bind(created.id).first();
 return {slot:slot.key,cid:item.cid,run:created.id,status:run?.status,post_id:run?.post_id||null,error:run?.error_message||null};
}
export async function runScheduledWorkflows(env) {
 const stamp=now(),stale=new Date(Date.now()-60000).toISOString();
 const {results=[]}=await env.DB.prepare("SELECT id,owner_user_id FROM workflow_runs WHERE status='running' AND stage NOT IN ('video_awaiting_render','video_publishing') AND (lock_until IS NULL OR lock_until<?) AND updated_at<? ORDER BY created_at LIMIT 3").bind(stamp,stale).all();
 for(const r of results) {
  for(let i=0;i<7;i++) {
   if(!await wfAdvance(env,r.id,r.owner_user_id,"workflow_cron")) break;
   const s=await env.DB.prepare("SELECT status FROM workflow_runs WHERE id=?").bind(r.id).first();
   if(s?.status!=="running") break;
  }
 }
 return results.length;
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
 if(method==="GET"&&path==="/oauth/tiktok/callback") return finishTikTokOAuth(request,env,url);
 if(method==="GET"&&path==="/oauth/shopee-seller/callback") return shopeeSeller.callback(env,url);
 if(method==="GET"&&(path==="/"||path==="/health")) {
  const setup=!!env.BOOTSTRAP_KEY&&!!env.TOKEN_ENCRYPTION_KEY;
  const users=await env.DB.prepare("SELECT COUNT(*) n FROM app_users").first();
  const {results:facebookAccounts=[]}=await env.DB.prepare("SELECT scopes_json,page_tasks_json FROM social_accounts WHERE platform='facebook' AND status='connected'").all();
  const publishReadyAccounts=facebookAccounts.filter(a=>facebookPublishReadiness(JSON.parse(a.scopes_json||"[]"),JSON.parse(a.page_tasks_json||"[]")).ready).length;
  return json({service:"Alpha Centauri Social Commerce Cloud API",status:"online",mode:"cloud",setup_ready:setup,admin_initialized:(users?.n||0)>0,publishing_enabled:publishReadyAccounts>0,publishing_adapter_enabled:true,publishing_adapter:"facebook_page_photo",publishing_formats:["text","photo"],publish_ready_accounts:publishReadyAccounts,meta_oauth_configured:metaAnyConfigured(env),meta_instagram_configured:metaConfigured(env,"instagram"),meta_facebook_configured:metaConfigured(env,"facebook"),meta_webhook_configured:webhookConfigured(env),meta_redirect_uri:env.META_REDIRECT_URI||null,tiktok_oauth_configured:tiktokConfigured(env),tiktok_redirect_uri:tiktokRedirectUri(env),tiktok_scopes:tiktokScopes(env),tiktok_publishing_enabled:false,shopee_affiliate_configured:shopeeAffiliateConfigured(env),shopee_affiliate_endpoint:shopeeAffiliateEndpoint(env),shopee_affiliate_mode:"read_only",shopee_seller:await shopeeSeller.status(env),platforms:Object.fromEntries(PLATFORMS.map(p=>[p,p==="instagram"?(metaConfigured(env,"instagram")?"oauth_ready":"oauth_not_configured"):p==="facebook"?(metaConfigured(env,"facebook")?"oauth_ready":"oauth_not_configured"):p==="tiktok"?(tiktokConfigured(env)?"oauth_ready":"oauth_not_configured"):p==="shopee_affiliate"?(shopeeAffiliateConfigured(env)?"api_ready":"awaiting_api_approval"):"oauth_not_configured"]))},200,cors(request));
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
 if(path==="/video-jobs"||path.startsWith("/video-jobs/")) return handleRenderNode(request,env,path,method);
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
 if(method==="POST"&&path==="/oauth/tiktok/start") {
  if(!tiktokConfigured(env)) return json({error:"TikTok Login Kit is not configured on the Cloudflare Worker (TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET)"},503,cors(request));
  const state=random(32),stamp=now(),expiry=new Date(Date.now()+10*60*1000).toISOString();
  await env.DB.prepare("DELETE FROM oauth_states WHERE expires_at<=?").bind(stamp).run();
  await env.DB.prepare("INSERT INTO oauth_states(state_hash,owner_user_id,platform,expires_at,created_at) VALUES(?,?,?,?,?)").bind(await sha(state),user.id,"tiktok",expiry,stamp).run();
  return json({authorization_url:buildTikTokAuthorizationUrl(env,state),expires_at:expiry,redirect_uri:tiktokRedirectUri(env),platform:"tiktok",scopes:tiktokScopes(env)},200,cors(request));
 }
 if(method==="POST"&&path==="/oauth/shopee-seller/start") { const r=await shopeeSeller.start(env,user); return json(r.body,r.status,cors(request)); }
 if(method==="GET"&&path==="/shopee-seller/shops") { const r=await shopeeSeller.list(env,user); return json(r.body,r.status,cors(request)); }
 const sellerShop=path.match(/^\/shopee-seller\/shops\/([a-zA-Z0-9_-]+)(\/verify)?$/);
 if(sellerShop&&method==="POST"&&sellerShop[2]) { const r=await shopeeSeller.verify(env,user,sellerShop[1]); return json(r.body,r.status,cors(request)); }
 if(sellerShop&&method==="DELETE"&&!sellerShop[2]) { const r=await shopeeSeller.disconnect(env,user,sellerShop[1]); return json(r.body,r.status,cors(request)); }
 if(method==="POST"&&path==="/affiliate/shopee/connect") { const r=await connectShopeeAffiliate(env,user); return json(r.body,r.status,cors(request)); }
 if(method==="POST"&&path==="/tiktok/inbox-upload") { const r=await tiktokInboxUpload(env,user,await request.arrayBuffer(),request.headers.get("Idempotency-Key")); return json(r.body,r.status,cors(request)); }
 if(method==="POST"&&path==="/tiktok/publish-status") {
  const b=await request.json().catch(()=>({}));
  const account=await env.DB.prepare(TIKTOK_ACCOUNT_SQL+" WHERE owner_user_id=? AND platform='tiktok' AND status='connected'").bind(user.id).first();
  if(!account||!b.publish_id) return json({error:"publish_id and a connected TikTok account are required"},422,cors(request));
  try { return json(await tiktokPublishStatus(env,account,String(b.publish_id)),200,cors(request)); } catch(e) { return json({error:safeText(e?.message,240)},502,cors(request)); }
 }
 const accountVerify=path.match(/^\/accounts\/([a-zA-Z0-9_-]+)\/verify$/);
 if(method==="POST"&&accountVerify) { const r=await verifyAccount(env,user,accountVerify[1]); return json(r.body,r.status,cors(request)); }
 if(method==="GET"&&path==="/accounts") {
  const {results=[]}=await env.DB.prepare("SELECT id,platform,external_account_id,account_name,profile_picture_url,status,scopes_json,page_tasks_json,token_expires_at,created_at,updated_at FROM social_accounts WHERE owner_user_id=? ORDER BY platform,account_name").bind(user.id).all();
  return json({accounts:results.map(a=>{const scopes=JSON.parse(a.scopes_json||"[]"),meta=JSON.parse(a.page_tasks_json||"[]"),page_tasks=Array.isArray(meta)?meta:[];const readiness=accountReadiness(a,scopes,page_tasks);const {page_tasks_json,...rest}=a;return {...rest,page_tasks_json:Array.isArray(meta)?page_tasks_json:"[]",scopes,page_tasks,connection:Array.isArray(meta)?null:{verified_at:meta.verified_at||null,refresh_expires_at:meta.refresh_expires_at||null},publish_ready:readiness.ready,publish_blockers:readiness.missing};})},200,cors(request));
 }
 if(method==="POST"&&path==="/accounts") {
  const b=await request.json();
  if(!PLATFORMS.includes(b.platform)||!b.external_account_id||!b.account_name) return json({error:"OAuth-created account identity is required"},422,cors(request));
  return json({error:"Manual account creation is disabled; connect through verified OAuth or an approved affiliate adapter."},409,cors(request));
 }
 if(method==="GET"&&path==="/secretary") return json(await commentSecretaryView(env,user),200,cors(request));
 if(method==="POST"&&path==="/secretary/scan") { const results=await runCommentSecretary(env,user.id,user.email); return json({results,view:await commentSecretaryView(env,user)},200,cors(request)); }
 const accountMatch=path.match(/^\/accounts\/([a-zA-Z0-9_-]+)$/);
 if(method==="DELETE"&&accountMatch) {
  const a=await env.DB.prepare("SELECT id,platform,encrypted_access_token FROM social_accounts WHERE id=? AND owner_user_id=?").bind(accountMatch[1],user.id).first();
  if(!a) return json({error:"Account not found"},404,cors(request));
  const revoked=a.platform==="tiktok"?await revokeTikTokToken(env,a):null;
  await env.DB.prepare("UPDATE social_accounts SET status='disconnected',encrypted_access_token=NULL,encrypted_refresh_token=NULL,updated_at=? WHERE id=? AND owner_user_id=?").bind(now(),a.id,user.id).run();
  await audit(env,user.id,"account_disconnected","account",a.id,user.email,{platform:a.platform,...(revoked===null?{}:{token_revoked:revoked})});
  return json({id:a.id,status:"disconnected"},200,cors(request));
 }
 if(method==="POST"&&path==="/workflows") {
  if(!env.AI) return json({error:"Workers AI binding is not configured"},503,cors(request));
  const b=await request.json().catch(()=>({}));
  const created=await wfCreateRun(env,user,b.command);
  if(created.error) return json({error:created.error},created.status,cors(request));
  return json(await wfView(env,created.id,user.id),201,cors(request));
 }
 if(method==="GET"&&path==="/workflows") {
  const {results=[]}=await env.DB.prepare("SELECT id,command,status,stage,post_id,permalink,error_message,created_at,completed_at FROM workflow_runs WHERE owner_user_id=? ORDER BY created_at DESC LIMIT 10").bind(user.id).all();
  return json({runs:results},200,cors(request));
 }
 const wfMatch=path.match(/^\/workflows\/([a-zA-Z0-9_-]+)(?:\/(advance|assets\/(cover|illustration|banner)))?$/);
 if(wfMatch&&method==="GET"&&!wfMatch[2]) {
  const view=await wfView(env,wfMatch[1],user.id,Math.max(0,parseInt(url.searchParams.get("after")||"0",10)||0));
  return view?json(view,200,cors(request)):json({error:"Workflow not found"},404,cors(request));
 }
 if(wfMatch&&method==="POST"&&wfMatch[2]==="advance") {
  const after=Math.max(0,parseInt(url.searchParams.get("after")||"0",10)||0);
  if(!await wfView(env,wfMatch[1],user.id,0)) return json({error:"Workflow not found"},404,cors(request));
  const advanced=await wfAdvance(env,wfMatch[1],user.id,user.email);
  return json({advanced,...await wfView(env,wfMatch[1],user.id,after)},200,cors(request));
 }
 if(wfMatch&&method==="GET"&&wfMatch[3]) {
  const asset=await env.DB.prepare("SELECT s.data_b64,s.mime FROM workflow_assets s JOIN workflow_runs r ON r.id=s.run_id WHERE s.run_id=? AND s.kind=? AND r.owner_user_id=?").bind(wfMatch[1],wfMatch[3],user.id).first();
  if(!asset) return json({error:"Asset not found"},404,cors(request));
  return new Response(Uint8Array.from(atob(asset.data_b64),c=>c.charCodeAt(0)),{status:200,headers:{"Content-Type":asset.mime,"Cache-Control":"private, max-age=3600","X-Content-Type-Options":"nosniff",...cors(request)}});
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
 // Resume creative workflows whose browser driver went away (stale, unlocked, still running).
 ctx.waitUntil(runCommentSecretary(env).then(r=>r.length&&console.log("comment-dm-cron",{results:r})).catch(e=>console.error("comment-dm-cron",{message:safeText(e?.message||"unknown",200)})));
 if(env.AI) ctx.waitUntil(runCampaignScheduler(env).then(r=>r&&!r.skipped&&console.log("campaign",r)).catch(e=>console.error("campaign",{message:safeText(e?.message||"unknown",200)})).then(()=>runScheduledWorkflows(env)).then(n=>n&&console.log("workflow-cron",{resumed:n})).catch(e=>console.error("workflow-cron",{message:safeText(e?.message||"unknown",200)})));
}};
