const CORS={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"GET,POST,PUT,OPTIONS","Access-Control-Allow-Headers":"Content-Type,X-Build-Token"};
const out=(v,s=200)=>new Response(JSON.stringify(v),{status:s,headers:{"Content-Type":"application/json",...CORS}});
const name=v=>String(v||"flay-app").replace(/[^a-zA-Z0-9._-]+/g,"-").replace(/^-+|-+$/g,"").slice(0,80)||"flay-app";
async function gh(env,path,init={}){const headers={"Accept":"application/vnd.github+json","Authorization":"Bearer "+env.GITHUB_TOKEN,"X-GitHub-Api-Version":"2026-03-10","User-Agent":"Flay-Build-Android-App-Server","Content-Type":"application/json",...(init.headers||{})};const r=await fetch("https://api.github.com"+path,{...init,headers});const t=await r.text();let d;try{d=t?JSON.parse(t):null}catch(_){d=t}if(!r.ok)throw new Error("GitHub API "+r.status+": "+String(d?.message||t||"request failed"));return d}
async function jobGet(env,id){const o=await env.BUILD_BUCKET.get("jobs/"+id+".json");return o?o.json():null}
async function jobPut(env,j){await env.BUILD_BUCKET.put("jobs/"+j.id+".json",JSON.stringify(j),{httpMetadata:{contentType:"application/json"}})}
function auth(r,e){return !!e.INTERNAL_TOKEN&&r.headers.get("X-Build-Token")===e.INTERNAL_TOKEN}
function pickError(logs,steps){
 const t=String(logs||"");
 const pats=[/^.*\be: .*$/m,/^.*\berror: .*$/im,/^.*FAILURE:.*$/m,/^.*BUILD FAILED.*$/m];
 for(const p of pats){const m=t.match(p);if(m&&m[0].trim())return m[0].trim()}
 const f=(steps||[]).find(x=>x.conclusion==="failure");
 return f?"GitHub Actions step failed: "+f.name:"GitHub Actions Android build failed. Check the Actions log."
}
async function refresh(env,j){
 if(j.finished)return j;
 try{
  if(!j.run_id){
   const p="/repos/"+env.GITHUB_REPO+"/actions/workflows/"+encodeURIComponent(env.GITHUB_WORKFLOW)+"/runs?event=workflow_dispatch&branch=main&per_page=20";
   const d=await gh(env,p);const n="Flay APK Build - "+j.id;const r=(d.workflow_runs||[]).find(x=>x.display_title===n||x.name===n);if(r)j.run_id=r.id;
  }
  if(j.run_id){
   const r=await gh(env,"/repos/"+env.GITHUB_REPO+"/actions/runs/"+j.run_id);
   j.html_url=r.html_url||null;
   j.workflow={name:r.name||null,file:env.GITHUB_WORKFLOW,path:r.path||null,workflow_id:r.workflow_id||null};
   j.run={id:r.id,number:r.run_number,attempt:r.run_attempt,name:r.name,display_title:r.display_title,event:r.event,head_branch:r.head_branch,status:r.status,conclusion:r.conclusion,created_at:r.created_at,run_started_at:r.run_started_at,updated_at:r.updated_at};
   const jobs=await gh(env,"/repos/"+env.GITHUB_REPO+"/actions/runs/"+j.run_id+"/jobs?per_page=100");
   const list=(jobs.jobs||[]).slice();
   j.jobs=list.map(x=>({id:x.id,name:x.name,status:x.status,conclusion:x.conclusion,started_at:x.started_at,completed_at:x.completed_at,runner_name:x.runner_name,steps:(x.steps||[]).map(s=>({number:s.number,name:s.name,status:s.status,conclusion:s.conclusion}))}));
   const primary=list.find(x=>x.name==="build")||list[list.length-1];
   j.steps=primary?.steps||[];
   const logParts=[];
   for(const job of list){
    if(job.status==="queued"||job.status==="waiting")continue;
    try{
     const logs=await gh(env,"/repos/"+env.GITHUB_REPO+"/actions/jobs/"+job.id+"/logs",{headers:{"Accept":"text/plain"}});
     const txt=typeof logs==="string"?logs:"";
     if(txt)logParts.push("===== GitHub Actions Job: "+job.name+" =====\n"+txt);
    }catch(_){}
   }
   if(logParts.length)j.logs=logParts.join("\n\n");
   if(primary)j.job_id=primary.id;
   const done=r.status==="completed";
   j.status=done?(r.conclusion==="success"?"success":"failed"):"building";
   if(j.status==="success")j.apk_url=env.BUILD_SERVER_URL+"/build/download/"+j.id;
   if(j.status==="failed"){j.error=pickError(j.logs,(j.steps||[]));j.failed_step=((j.steps||[]).find(x=>x.conclusion==="failure")||{}).name||null}
   /* stop calling the GitHub API once the run is final and its logs were retrieved */
   if(done&&(j.logs||!list.length))j.finished=true;
   j.last_error=null;
  }
 }catch(e){j.last_error=String(e.message||e)}
 j.updated_at=Date.now();await jobPut(env,j);return j
}
async function build(r,e){let b;try{b=await r.json()}catch(_){return out({ok:false,error:"Invalid JSON"},400)}const a=String(b.archiveBase64||"");if(!a)return out({ok:false,error:"archiveBase64 is required"},400);if(a.length>105000000)return out({ok:false,error:"Project archive is too large"},413);if(!e.GITHUB_TOKEN||!e.INTERNAL_TOKEN)return out({ok:false,error:"Build gateway secrets are not configured"},503);const id=crypto.randomUUID();const j={id,name:name(b.name),package:String(b.package||""),technology:String(b.technology||"unknown"),status:"queued",created_at:Date.now(),updated_at:Date.now()};const bin=Uint8Array.from(atob(a),c=>c.charCodeAt(0));await e.BUILD_BUCKET.put("inputs/"+id+".zip",bin,{httpMetadata:{contentType:"application/zip"}});await jobPut(e,j);try{await gh(e,"/repos/"+e.GITHUB_REPO+"/actions/workflows/"+encodeURIComponent(e.GITHUB_WORKFLOW)+"/dispatches",{method:"POST",body:JSON.stringify({ref:"main",inputs:{build_id:id,app_name:j.name,technology:j.technology}})});}catch(x){j.status="failed";j.error=String(x.message||x);await jobPut(e,j);return out({ok:false,error:j.error},502)}return out({ok:true,jobId:id,status:"queued",statusUrl:e.BUILD_SERVER_URL+"/build/status/"+id},202)}
export default{async fetch(r,e){if(r.method==="OPTIONS")return new Response(null,{status:204,headers:CORS});const p=new URL(r.url).pathname.replace(/\/+$/,"")||"/";try{if(r.method==="GET"&&p==="/health")return out({ok:true,service:"flay-ai-free-build-gateway",buildEngine:"GitHub Actions"});if(r.method==="POST"&&p==="/build")return build(r,e);let m=p.match(/^\/build\/status\/([a-f0-9-]+)$/i);if(r.method==="GET"&&m){const j=await jobGet(e,m[1]);if(!j)return out({ok:false,error:"Build job not found"},404);const x=await refresh(e,j);return out({ok:true,jobId:x.id,status:x.status,error:x.error||null,htmlUrl:x.html_url||null,apkUrl:x.apk_url||null,logs:x.logs||"",steps:x.steps||[],jobIdGithub:x.job_id||null,workflow:x.workflow||null,run:x.run||null,jobs:x.jobs||[],failedStep:x.failed_step||null,gatewayError:x.last_error||null})}m=p.match(/^\/build\/download\/([a-f0-9-]+)$/i);if(r.method==="GET"&&m){const o=await e.BUILD_BUCKET.get("apks/"+m[1]+".apk");if(!o)return out({ok:false,error:"APK is not ready"},404);const j=await jobGet(e,m[1]);return new Response(o.body,{headers:{...CORS,"Content-Type":"application/vnd.android.package-archive","Content-Disposition":"attachment; filename=\""+name(j?.name||"flay-app")+"-debug.apk\"","Cache-Control":"no-store"}})}m=p.match(/^\/internal\/archive\/([a-f0-9-]+)$/i);if(r.method==="GET"&&m){if(!auth(r,e))return new Response("Unauthorized",{status:401});const o=await e.BUILD_BUCKET.get("inputs/"+m[1]+".zip");return o?new Response(o.body,{headers:{"Content-Type":"application/zip","Cache-Control":"no-store"}}):new Response("Not found",{status:404})}m=p.match(/^\/internal\/apk\/([a-f0-9-]+)$/i);if(r.method==="PUT"&&m){if(!auth(r,e))return new Response("Unauthorized",{status:401});const d=await r.arrayBuffer();await e.BUILD_BUCKET.put("apks/"+m[1]+".apk",d,{httpMetadata:{contentType:"application/vnd.android.package-archive"}});const j=await jobGet(e,m[1]);if(j){j.status="success";j.apk_url=e.BUILD_SERVER_URL+"/build/download/"+m[1];j.updated_at=Date.now();await jobPut(e,j)}await e.BUILD_BUCKET.delete("inputs/"+m[1]+".zip");return out({ok:true})}m=p.match(/^\/internal\/failed\/([a-f0-9-]+)$/i);if(r.method==="POST"&&m){if(!auth(r,e))return new Response("Unauthorized",{status:401});const j=await jobGet(e,m[1]);if(j){j.status="failed";j.error="GitHub Actions Android build failed. Check the Actions log.";j.updated_at=Date.now();await jobPut(e,j)}return out({ok:true})}return out({ok:false,error:"Not found"},404)}catch(x){return out({ok:false,error:String(x.message||x)},500)}}};
