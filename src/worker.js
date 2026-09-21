const JSON_HEADERS={"content-type":"application/json; charset=utf-8","cache-control":"no-store"};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:JSON_HEADERS});
const now=()=>Date.now();
const id=()=>crypto.randomUUID();
async function body(req){try{return await req.json()}catch{return {}}}
function token(req){return req.headers.get('authorization')?.replace(/^Bearer\s+/i,'')||''}
async function isAdmin(req,env){const expected=env.ADMIN_TOKEN||'';return expected && token(req)===expected}
async function blocked(env,device){if(!device)return false;return !!(await env.DB.prepare('SELECT 1 FROM blocked_devices WHERE device_id=?').bind(device).first())}
export default {async fetch(req,env){
  const u=new URL(req.url), p=u.pathname;
  if(p==='/admin') return env.ASSETS.fetch(new Request(new URL('/admin.html',u),req));
  if(!p.startsWith('/api/')) return env.ASSETS.fetch(req);
  try{
    if(p==='/api/health') return json({ok:true,service:'Vial Reynosa'});
    if(p==='/api/incidents' && req.method==='GET'){
      const t=now(); const {results}=await env.DB.prepare("SELECT * FROM incidents WHERE status='active' AND (expires_at IS NULL OR expires_at>?) ORDER BY created_at DESC LIMIT 500").bind(t).all(); return json(results);
    }
    if(p==='/api/incidents' && req.method==='POST'){
      const b=await body(req); if(await blocked(env,b.device_id))return json({error:'blocked'},403);
      if(!b.category||!Number.isFinite(+b.lat)||!Number.isFinite(+b.lng))return json({error:'invalid'},400);
      const c=await env.DB.prepare('SELECT ttl_minutes,enabled FROM categories WHERE id=?').bind(b.category).first(); if(!c||!c.enabled)return json({error:'category_disabled'},400);
      const t=now(), rid=id(), exp=t+(c.ttl_minutes*60000);
      await env.DB.prepare('INSERT INTO incidents(id,category,lat,lng,text,confirmations,status,device_id,created_at,updated_at,expires_at) VALUES(?,?,?,?,?,1,\'active\',?,?,?,?,?)')
        .bind(rid,b.category,+b.lat,+b.lng,String(b.text||'').slice(0,280),b.device_id||null,t,t,exp).run();
      return json({ok:true,id:rid},201);
    }
    let m=p.match(/^\/api\/incidents\/([^/]+)\/(confirm|gone)$/);
    if(m && req.method==='POST'){
      const b=await body(req); if(await blocked(env,b.device_id))return json({error:'blocked'},403); if(!b.device_id)return json({error:'device_required'},400);
      const vote=m[2]==='confirm'?'confirm':'gone'; const exists=await env.DB.prepare('SELECT vote FROM votes WHERE incident_id=? AND device_id=?').bind(m[1],b.device_id).first();
      if(exists)return json({ok:true,duplicate:true});
      await env.DB.batch([env.DB.prepare('INSERT INTO votes(incident_id,device_id,vote,created_at) VALUES(?,?,?,?)').bind(m[1],b.device_id,vote,now()),
        vote==='confirm'?env.DB.prepare('UPDATE incidents SET confirmations=confirmations+1,updated_at=? WHERE id=?').bind(now(),m[1]):env.DB.prepare("UPDATE incidents SET status='closed',updated_at=? WHERE id=?").bind(now(),m[1])]);
      return json({ok:true});
    }
    m=p.match(/^\/api\/incidents\/([^/]+)\/comments$/);
    if(m && req.method==='GET'){const {results}=await env.DB.prepare("SELECT id,text,created_at FROM comments WHERE incident_id=? AND status='active' ORDER BY created_at ASC LIMIT 100").bind(m[1]).all();return json(results)}
    if(m && req.method==='POST'){const b=await body(req);if(await blocked(env,b.device_id))return json({error:'blocked'},403);const txt=String(b.text||'').trim().slice(0,180);if(!txt)return json({error:'empty'},400);const cid=id();await env.DB.prepare('INSERT INTO comments(id,incident_id,text,device_id,status,created_at) VALUES(?,?,?,?,\'active\',?)').bind(cid,m[1],txt,b.device_id||null,now()).run();return json({ok:true,id:cid},201)}
    if(p==='/api/bootstrap' && req.method==='GET'){
      const [cats,alerts,ads,settings]=await Promise.all([env.DB.prepare('SELECT * FROM categories ORDER BY rowid').all(),env.DB.prepare('SELECT * FROM alerts WHERE active=1 ORDER BY created_at DESC LIMIT 20').all(),env.DB.prepare('SELECT * FROM ads WHERE active=1 AND (starts_at IS NULL OR starts_at<=?) AND (ends_at IS NULL OR ends_at>=?) ORDER BY created_at DESC').bind(now(),now()).all(),env.DB.prepare('SELECT key,value FROM settings').all()]);return json({categories:cats.results,alerts:alerts.results,ads:ads.results,settings:Object.fromEntries(settings.results.map(x=>[x.key,x.value]))});
    }
    if(p.startsWith('/api/admin/')){
      if(!(await isAdmin(req,env)))return json({error:'unauthorized'},401);
      if(p==='/api/admin/dashboard'){const [i,c]=await Promise.all([env.DB.prepare("SELECT COUNT(*) n FROM incidents WHERE status='active'").first(),env.DB.prepare("SELECT COUNT(*) n FROM comments WHERE status='active'").first()]);return json({active_incidents:i.n,active_comments:c.n})}
      if(p==='/api/admin/incidents'&&req.method==='GET'){const {results}=await env.DB.prepare('SELECT * FROM incidents ORDER BY created_at DESC LIMIT 1000').all();return json(results)}
      m=p.match(/^\/api\/admin\/incidents\/([^/]+)$/); if(m&&req.method==='DELETE'){await env.DB.prepare("UPDATE incidents SET status='deleted',updated_at=? WHERE id=?").bind(now(),m[1]).run();return json({ok:true})}
      if(p==='/api/admin/comments'&&req.method==='GET'){const {results}=await env.DB.prepare("SELECT comments.*,incidents.category FROM comments LEFT JOIN incidents ON incidents.id=comments.incident_id WHERE comments.status='active' ORDER BY comments.created_at DESC LIMIT 500").all();return json(results)}
      m=p.match(/^\/api\/admin\/comments\/([^/]+)$/); if(m&&req.method==='DELETE'){await env.DB.prepare("UPDATE comments SET status='deleted' WHERE id=?").bind(m[1]).run();return json({ok:true})}
      if(p==='/api/admin/categories'&&req.method==='GET'){const {results}=await env.DB.prepare('SELECT * FROM categories ORDER BY rowid').all();return json(results)}
      m=p.match(/^\/api\/admin\/categories\/([^/]+)$/); if(m&&req.method==='PATCH'){const b=await body(req);await env.DB.prepare('UPDATE categories SET enabled=COALESCE(?,enabled),ttl_minutes=COALESCE(?,ttl_minutes),name=COALESCE(?,name),icon=COALESCE(?,icon) WHERE id=?').bind(b.enabled==null?null:(b.enabled?1:0),b.ttl_minutes??null,b.name??null,b.icon??null,m[1]).run();return json({ok:true})}
      if(p==='/api/admin/alerts'&&req.method==='POST'){const b=await body(req);await env.DB.prepare('INSERT INTO alerts(id,title,body,active,created_at) VALUES(?,?,?,?,?)').bind(id(),String(b.title||'Aviso').slice(0,80),String(b.body||'').slice(0,300),1,now()).run();return json({ok:true},201)}
      if(p==='/api/admin/ads'&&req.method==='POST'){const b=await body(req);await env.DB.prepare('INSERT INTO ads(id,name,body,link,active,starts_at,ends_at,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(id(),String(b.name||'Patrocinador').slice(0,100),String(b.body||'').slice(0,240),b.link||null,1,b.starts_at||null,b.ends_at||null,now()).run();return json({ok:true},201)}
      if(p==='/api/admin/settings'&&req.method==='POST'){const b=await body(req);for(const [k,v] of Object.entries(b)){await env.DB.prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind(k,String(v),now()).run()}return json({ok:true})}
      if(p==='/api/admin/block'&&req.method==='POST'){const b=await body(req);if(!b.device_id)return json({error:'device_required'},400);await env.DB.prepare('INSERT OR REPLACE INTO blocked_devices(device_id,reason,created_at) VALUES(?,?,?)').bind(b.device_id,String(b.reason||'Moderación').slice(0,180),now()).run();return json({ok:true})}
    }
    return json({error:'not_found'},404);
  }catch(e){return json({error:'server_error',detail:String(e?.message||e)},500)}
}};
