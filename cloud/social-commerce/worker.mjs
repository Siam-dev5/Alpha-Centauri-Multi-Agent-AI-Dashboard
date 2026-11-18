const ORIGIN = "https://siam-dev5.github.io";
const PLATFORMS = ["facebook","instagram","youtube","tiktok","shopee_affiliate","lazada_affiliate"];
const now = () => new Date().toISOString();
const json = (data,status=200,headers={}) => new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store",...headers}});
const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const unb64 = (value) => Uint8Array.from(atob(value.replace(/-/g,"+").replace(/_/g,"/")),c=>c.charCodeAt(0));
const random = (n=32) => { const a=new Uint8Array(n); crypto.getRandomValues(a); return b64(a); };
const sha = async (v) => b64(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(v)));
const cors = (request) => {
 const origin=request.headers.get("Origin")||"";
 const headers={"Access-Control-Allow-Methods":"GET,POST,DELETE,OPTIONS","Access-Control-Allow-Headers":"Authorization,Content-Type","Vary":"Origin"};
 if(origin===ORIGIN) headers["Access-Control-Allow-Origin"]=origin;
 return headers;
};
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
async function passwordHash(password,salt) {
 const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(password),"PBKDF2",false,["deriveBits"]);
 return b64(await crypto.subtle.deriveBits({name:"PBKDF2",salt:unb64(salt),iterations:310000,hash:"SHA-256"},key,256));
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
async function handle(request,env) {
 const url=new URL(request.url), path=url.pathname.replace(/^\/api\/social-commerce/,"")||"/", method=request.method;
 if(method==="OPTIONS") return new Response(null,{status:204,headers:cors(request)});
 if(method==="GET" && path==="/health") {
  const setup=!!env.BOOTSTRAP_KEY && !!env.TOKEN_ENCRYPTION_KEY;
  const users=await env.DB.prepare("SELECT COUNT(*) n FROM app_users").first();
  return json({service:"Alpha Centauri Social Commerce Cloud API",status:"online",mode:"cloud",setup_ready:setup,admin_initialized:(users?.n||0)>0,publishing_enabled:false,platforms:Object.fromEntries(PLATFORMS.map(p=>[p,"oauth_not_configured"]))},200,cors(request));
 }
 if(method==="POST" && path==="/auth/bootstrap") {
  if(!env.BOOTSTRAP_KEY || request.headers.get("X-Bootstrap-Key")!==env.BOOTSTRAP_KEY) return json({error:"Invalid bootstrap key"},403,cors(request));
  const count=await env.DB.prepare("SELECT COUNT(*) n FROM app_users").first();
  if(count.n>0) return json({error:"Initial administrator already exists"},409,cors(request));
  const body=await request.json();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email||"") || (body.password||"").length<14) return json({error:"Valid email and password of at least 14 characters are required"},422,cors(request));
  const id=random(16),salt=random(16),hash=await passwordHash(body.password,salt);
  await env.DB.prepare("INSERT INTO app_users(id,email,password_hash,password_salt,created_at) VALUES(?,?,?,?,?)").bind(id,body.email.toLowerCase(),hash,salt,now()).run();
  await audit(env,id,"admin_bootstrapped","user",id,body.email);
  return json(await newSession(env,{id,email:body.email.toLowerCase()}),201,cors(request));
 }
 if(method==="POST" && path==="/auth/login") {
  const body=await request.json();
  const user=await env.DB.prepare("SELECT id,email,password_hash,password_salt FROM app_users WHERE email=?").bind((body.email||"").toLowerCase()).first();
  if(!user || await passwordHash(body.password||"",user.password_salt)!==user.password_hash) return json({error:"Invalid email or password"},401,cors(request));
  return json(await newSession(env,user),200,cors(request));
 }
 const user=await sessionUser(request,env);
 if(!user) return json({error:"Authentication required"},401,cors(request));
 if(method==="GET" && path==="/auth/me") return json({user},200,cors(request));
 if(method==="POST" && path==="/auth/logout") {
  const token=(request.headers.get("Authorization")||"").replace(/^Bearer\s+/i,"");
  await env.DB.prepare("DELETE FROM user_sessions WHERE token_hash=?").bind(await sha(token)).run();
  return json({ok:true},200,cors(request));
 }
 if(method==="GET" && path==="/accounts") {
  const {results=[]}=await env.DB.prepare("SELECT id,platform,external_account_id,account_name,profile_picture_url,status,scopes_json,token_expires_at,created_at,updated_at FROM social_accounts WHERE owner_user_id=? ORDER BY platform,account_name").bind(user.id).all();
  return json({accounts:results.map(a=>({...a,scopes:JSON.parse(a.scopes_json)}))},200,cors(request));
 }
 if(method==="POST" && path==="/accounts") {
  const b=await request.json();
  if(!PLATFORMS.includes(b.platform)||!b.external_account_id||!b.account_name) return json({error:"OAuth-created account identity is required"},422,cors(request));
  return json({error:"Manual account creation is disabled; connect through verified OAuth or an approved affiliate adapter."},409,cors(request));
 }
 const accountMatch=path.match(/^\/accounts\/([a-zA-Z0-9_-]+)$/);
 if(method==="DELETE" && accountMatch) {
  const a=await env.DB.prepare("SELECT id,platform FROM social_accounts WHERE id=? AND owner_user_id=?").bind(accountMatch[1],user.id).first();
  if(!a) return json({error:"Account not found"},404,cors(request));
  await env.DB.prepare("UPDATE social_accounts SET status='disconnected',encrypted_access_token=NULL,encrypted_refresh_token=NULL,updated_at=? WHERE id=? AND owner_user_id=?").bind(now(),a.id,user.id).run();
  await audit(env,user.id,"account_disconnected","account",a.id,user.email,{platform:a.platform});
  return json({id:a.id,status:"disconnected"},200,cors(request));
 }
 if(method==="GET" && path==="/content") {
  const status=url.searchParams.get("status");
  const q=status?env.DB.prepare("SELECT * FROM content_items WHERE owner_user_id=? AND status=? ORDER BY updated_at DESC").bind(user.id,status):env.DB.prepare("SELECT * FROM content_items WHERE owner_user_id=? ORDER BY updated_at DESC").bind(user.id);
  const {results=[]}=await q.all();
  return json({items:results.map(x=>({...x,platforms:JSON.parse(x.platforms_json),account_ids:JSON.parse(x.account_ids_json)}))},200,cors(request));
 }
 if(method==="POST" && path==="/content") {
  const b=await request.json();
  if(!b.title||!b.body||!Array.isArray(b.platforms)||!Array.isArray(b.account_ids)||!b.account_ids.length) return json({error:"Title, body, platforms and target accounts are required"},422,cors(request));
  if(b.platforms.some(p=>!PLATFORMS.includes(p))) return json({error:"Unsupported platform"},422,cors(request));
  if(b.platforms.some(p=>p.endsWith("_affiliate"))&&!String(b.disclosure||"").trim()) return json({error:"Affiliate disclosure is required"},422,cors(request));
  const marks=b.account_ids.map(()=>"?").join(",");
  const {results:accounts=[]}=await env.DB.prepare("SELECT id,platform FROM social_accounts WHERE owner_user_id=? AND id IN ("+marks+")").bind(user.id,...b.account_ids).all();
  if(accounts.length!==b.account_ids.length || accounts.some(a=>!b.platforms.includes(a.platform))) return json({error:"Invalid account destinations"},422,cors(request));
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
 catch(e) { console.error("social-commerce-api",e); return json({error:"Internal server error"},500,headers); }
}};
