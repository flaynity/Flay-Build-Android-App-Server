const CORS={
  "Access-Control-Allow-Origin":"*",
  "Access-Control-Allow-Methods":"GET,POST,PUT,OPTIONS",
  "Access-Control-Allow-Headers":"Content-Type,X-Build-Token"
};

const out=(v,s=200)=>new Response(JSON.stringify(v),{
  status:s,
  headers:{"Content-Type":"application/json",...CORS}
});

const name=v=>String(v||"flay-app")
  .replace(/[^a-zA-Z0-9._-]+/g,"-")
  .replace(/^-+|-+$/g,"")
  .slice(0,80)||"flay-app";

async function gh(env,path,init={},timeoutMs=12000){
  const ac=new AbortController();
  const timer=setTimeout(()=>ac.abort(),timeoutMs);
  try{
    const headers={
      "Accept":"application/vnd.github+json",
      "Authorization":"Bearer "+env.GITHUB_TOKEN,
      "X-GitHub-Api-Version":"2026-03-10",
      "User-Agent":"Flay-Build-Android-App-Server"
    };
    const r=await fetch("https://api.github.com"+path,{
      ...init,
      headers:{...headers,...(init.headers||{})},
      signal:ac.signal
    });
    const t=await r.text();
    let d;
    try{d=t?JSON.parse(t):null}catch(_){d=t}
    if(!r.ok)throw new Error("GitHub API "+r.status+": "+String(d?.message||t||"request failed"));
    return d;
  }finally{
    clearTimeout(timer);
  }
}

async function jobGet(env,id){
  const o=await env.BUILD_BUCKET.get("jobs/"+id+".json");
  return o?o.json():null;
}

async function jobPut(env,j){
  await env.BUILD_BUCKET.put(
    "jobs/"+j.id+".json",
    JSON.stringify(j),
    {httpMetadata:{contentType:"application/json"}}
  );
}

function auth(r,e){
  return !!e.INTERNAL_TOKEN&&r.headers.get("X-Build-Token")===e.INTERNAL_TOKEN;
}

async function findRun(env,j){
  if(j.run_id)return j.run_id;
  const p="/repos/"+env.GITHUB_REPO+
    "/actions/workflows/"+encodeURIComponent(env.GITHUB_WORKFLOW)+
    "/runs?event=workflow_dispatch&branch=main&per_page=20";
  const d=await gh(env,p,{},10000);
  const expected="Flay APK Build - "+j.id;
  const r=(d.workflow_runs||[]).find(x=>x.name===expected);
  if(r)j.run_id=r.id;
  return j.run_id||null;
}

async function refreshStatus(env,j){
  try{
    const runId=await findRun(env,j);
    if(!runId){
      j.status="queued";
      j.updated_at=Date.now();
      await jobPut(env,j);
      return j;
    }

    const r=await gh(env,"/repos/"+env.GITHUB_REPO+"/actions/runs/"+runId,{},10000);
    j.run_id=runId;
    j.html_url=r.html_url||null;

    try{
      const jobs=await gh(
        env,
        "/repos/"+env.GITHUB_REPO+"/actions/runs/"+runId+"/jobs?per_page=20",
        {},
        10000
      );
      const list=jobs.jobs||[];
      const job=list.slice().reverse().find(x=>x.name==="build")||list.slice(-1)[0];
      if(job){
        j.job_id=job.id;
        j.steps=job.steps||[];
        j.job_status=job.status||null;
        j.job_conclusion=job.conclusion||null;
      }
    }catch(e){
      j.last_jobs_error=String(e.message||e);
    }

    j.status=r.status==="completed"
      ?(r.conclusion==="success"?"success":"failed")
      :"building";

    if(j.status==="success"){
      j.apk_url=env.BUILD_SERVER_URL+"/build/download/"+j.id;
    }
    if(j.status==="failed"){
      j.error="Android build failed. See the terminal build log for the exact error.";
    }

    j.updated_at=Date.now();
    await jobPut(env,j);
    return j;
  }catch(e){
    j.last_error=String(e.message||e);
    j.updated_at=Date.now();
    await jobPut(env,j);
    return j;
  }
}

async function refreshLogs(env,id){
  const j=await jobGet(env,id);
  if(!j||!j.job_id)return j;

  const now=Date.now();
  if(j.logs_fetching)return j;
  if(j.logs_updated_at&&now-j.logs_updated_at<3500)return j;

  j.logs_fetching=true;
  j.logs_updated_at=now;
  await jobPut(env,j);

  try{
    const logs=await gh(
      env,
      "/repos/"+env.GITHUB_REPO+"/actions/jobs/"+j.job_id+"/logs",
      {headers:{"Accept":"text/plain"}},
      15000
    );
    const text=String(logs||"");
    j.logs=text.slice(-120000);
    j.logs_available_at=Date.now();
    j.logs_error="";
  }catch(e){
    j.logs_error=String(e.message||e);
  }finally{
    j.logs_fetching=false;
    j.updated_at=Date.now();
    await jobPut(env,j);
  }
  return j;
}

async function build(r,e){
  let b;
  try{b=await r.json()}catch(_){return out({ok:false,error:"Invalid JSON"},400)}
  const a=String(b.archiveBase64||"");
  if(!a)return out({ok:false,error:"archiveBase64 is required"},400);
  if(a.length>105000000)return out({ok:false,error:"Project archive is too large"},413);
  if(!e.GITHUB_TOKEN||!e.INTERNAL_TOKEN){
    return out({ok:false,error:"Build gateway secrets are not configured"},503);
  }

  const id=crypto.randomUUID();
  const j={
    id,
    name:name(b.name),
    package:String(b.package||""),
    technology:String(b.technology||"unknown"),
    status:"queued",
    logs:"",
    steps:[],
    created_at:Date.now(),
    updated_at:Date.now()
  };

  const bin=Uint8Array.from(atob(a),c=>c.charCodeAt(0));
  await e.BUILD_BUCKET.put(
    "inputs/"+id+".zip",
    bin,
    {httpMetadata:{contentType:"application/zip"}}
  );
  await jobPut(e,j);

  try{
    await gh(
      e,
      "/repos/"+e.GITHUB_REPO+"/actions/workflows/"+encodeURIComponent(e.GITHUB_WORKFLOW)+"/dispatches",
      {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          ref:"main",
          inputs:{build_id:id,app_name:j.name,technology:j.technology}
        })
      },
      15000
    );
  }catch(x){
    j.status="failed";
    j.error=String(x.message||x);
    await jobPut(e,j);
    return out({ok:false,error:j.error},502);
  }

  return out({
    ok:true,
    jobId:id,
    status:"queued",
    statusUrl:e.BUILD_SERVER_URL+"/build/status/"+id
  },202);
}

export default{
  async fetch(r,e,ctx){
    if(r.method==="OPTIONS"){
      return new Response(null,{status:204,headers:CORS});
    }

    const p=new URL(r.url).pathname.replace(/\/+$/,"")||"/";

    try{
      if(r.method==="GET"&&p==="/health"){
        return out({
          ok:true,
          service:"flay-ai-free-build-gateway",
          buildEngine:"Android build environment"
        });
      }

      if(r.method==="POST"&&p==="/build")return build(r,e);

      let m=p.match(/^\/build\/status\/([a-f0-9-]+)$/i);
      if(r.method==="GET"&&m){
        const j=await jobGet(e,m[1]);
        if(!j)return out({ok:false,error:"Build job not found"},404);

        const x=await refreshStatus(e,j);

        // Log retrieval is deliberately background work. The status request
        // must stay fast so the terminal never times out while GitHub is
        // generating/downloading the job log archive.
        if(x.job_id&&ctx)ctx.waitUntil(refreshLogs(e,x.id));

        return out({
          ok:true,
          jobId:x.id,
          status:x.status,
          error:x.error||null,
          htmlUrl:null,
          apkUrl:x.apk_url||null,
          logs:x.logs||"",
          steps:x.steps||[],
          jobIdGithub:x.job_id||null
        });
      }

      m=p.match(/^\/build\/logs\/([a-f0-9-]+)$/i);
      if(r.method==="GET"&&m){
        const j=await jobGet(e,m[1]);
        if(!j)return out({ok:false,error:"Build job not found"},404);
        const x=await refreshLogs(e,m[1]);
        return out({
          ok:true,
          jobId:x?.id||m[1],
          logs:x?.logs||"",
          jobIdGithub:x?.job_id||null
        });
      }

      m=p.match(/^\/build\/download\/([a-f0-9-]+)$/i);
      if(r.method==="GET"&&m){
        const o=await e.BUILD_BUCKET.get("apks/"+m[1]+".apk");
        if(!o)return out({ok:false,error:"APK is not ready"},404);
        const j=await jobGet(e,m[1]);
        return new Response(o.body,{
          headers:{
            ...CORS,
            "Content-Type":"application/vnd.android.package-archive",
            "Content-Disposition":"attachment; filename=\""+name(j?.name||"flay-app")+"-debug.apk\"",
            "Cache-Control":"no-store"
          }
        });
      }

      m=p.match(/^\/internal\/archive\/([a-f0-9-]+)$/i);
      if(r.method==="GET"&&m){
        if(!auth(r,e))return new Response("Unauthorized",{status:401});
        const o=await e.BUILD_BUCKET.get("inputs/"+m[1]+".zip");
        return o
          ?new Response(o.body,{headers:{"Content-Type":"application/zip","Cache-Control":"no-store"}})
          :new Response("Not found",{status:404});
      }

      m=p.match(/^\/internal\/apk\/([a-f0-9-]+)$/i);
      if(r.method==="PUT"&&m){
        if(!auth(r,e))return new Response("Unauthorized",{status:401});
        const d=await r.arrayBuffer();
        await e.BUILD_BUCKET.put(
          "apks/"+m[1]+".apk",
          d,
          {httpMetadata:{contentType:"application/vnd.android.package-archive"}}
        );
        const j=await jobGet(e,m[1]);
        if(j){
          j.status="success";
          j.apk_url=e.BUILD_SERVER_URL+"/build/download/"+m[1];
          j.updated_at=Date.now();
          await jobPut(e,j);
        }
        await e.BUILD_BUCKET.delete("inputs/"+m[1]+".zip");
        return out({ok:true});
      }

      m=p.match(/^\/internal\/failed\/([a-f0-9-]+)$/i);
      if(r.method==="POST"&&m){
        if(!auth(r,e))return new Response("Unauthorized",{status:401});
        const j=await jobGet(e,m[1]);
        if(j){
          j.status="failed";
          j.error="Android build failed. The terminal will show the available build log.";
          j.updated_at=Date.now();
          await jobPut(e,j);
        }
        return out({ok:true});
      }

      return out({ok:false,error:"Not found"},404);
    }catch(x){
      return out({ok:false,error:String(x.message||x)},500);
    }
  }
};
