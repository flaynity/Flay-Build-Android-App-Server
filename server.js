'use strict';

const express=require('express');
const AdmZip=require('adm-zip');
const fs=require('fs');
const fsp=fs.promises;
const os=require('os');
const path=require('path');
const crypto=require('crypto');
const {spawn}=require('child_process');

const app=express();
const PORT=Number(process.env.PORT||8080);
const MAX_ARCHIVE_BYTES=Number(process.env.MAX_ARCHIVE_BYTES||100*1024*1024);
const BUILD_TIMEOUT_MS=Number(process.env.BUILD_TIMEOUT_MS||20*60*1000);
const BUILD_TOKEN=String(process.env.BUILD_TOKEN||'');
const MAX_CONCURRENT_BUILDS=Math.max(1,Number(process.env.MAX_CONCURRENT_BUILDS||1));

app.use(express.json({limit:Math.ceil(MAX_ARCHIVE_BYTES/1024/1024)+'mb'}));
app.use((req,res,next)=>{
  res.setHeader('Access-Control-Allow-Origin',process.env.ALLOWED_ORIGINS||'*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization,X-Build-Token');
  if(req.method==='OPTIONS')return res.sendStatus(204); next();
});

let activeBuilds=0; const queue=[];
function queueBuild(fn){return new Promise((resolve,reject)=>{queue.push({fn,resolve,reject});pumpQueue();});}
function pumpQueue(){
  while(activeBuilds<MAX_CONCURRENT_BUILDS&&queue.length){
    const job=queue.shift(); activeBuilds++;
    Promise.resolve().then(job.fn).then(job.resolve,job.reject).finally(()=>{activeBuilds--;pumpQueue();});
  }
}
function authOk(req){
  if(!BUILD_TOKEN)return true;
  const token=req.get('X-Build-Token')||String(req.get('Authorization')||'').replace(/^Bearer\\s+/i,'');
  return token===BUILD_TOKEN;
}
function fail(res,status,error,extra={}){return res.status(status).json({ok:false,error:String(error||'Build failed'),...extra});}
function safeProjectName(name){return String(name||'flay-app').replace(/[^a-zA-Z0-9._-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,80)||'flay-app';}

function assertSafeZipEntries(zip){
  for(const e of zip.getEntries()){
    const n=String(e.entryName||'').replace(/\\/g,'/');
    if(!n||n.startsWith('/')||/^[A-Za-z]:/.test(n)||n.split('/').includes('..'))throw new Error('Unsafe archive path: '+n);
  }
}
async function extractArchive(base64,target){
  const raw=Buffer.from(String(base64||''),'base64');
  if(!raw.length)throw new Error('archiveBase64 is empty');
  if(raw.length>MAX_ARCHIVE_BYTES)throw new Error('Project archive is too large');
  const zip=new AdmZip(raw); assertSafeZipEntries(zip); zip.extractAllTo(target,true);
  return raw.length;
}
async function findGradleRoot(dir){
  const direct=['settings.gradle','settings.gradle.kts','build.gradle','build.gradle.kts'];
  if(direct.some(x=>fs.existsSync(path.join(dir,x))))return dir;
  let names=[]; try{names=await fsp.readdir(dir,{withFileTypes:true});}catch(_){return null;}
  for(const x of names){
    if(!x.isDirectory()||x.name==='__MACOSX')continue;
    const hit=await findGradleRoot(path.join(dir,x.name)); if(hit)return hit;
  }
  return null;
}
async function collectApks(root){
  const found=[];
  async function walk(dir){
    let entries; try{entries=await fsp.readdir(dir,{withFileTypes:true});}catch(_){return;}
    for(const e of entries){
      const p=path.join(dir,e.name);
      if(e.isDirectory()){if(e.name!=='.gradle'&&e.name!=='node_modules')await walk(p);}
      else if(/\.apk$/i.test(e.name)&&/build[\\/]outputs[\\/]apk/i.test(p))found.push(p);
    }
  }
  await walk(root); return found;
}
function runGradle(root){
  return new Promise((resolve,reject)=>{
    const wrapperPath=path.join(root,process.platform==='win32'?'gradlew.bat':'gradlew');
    const command=fs.existsSync(wrapperPath)?(process.platform==='win32'?'gradlew.bat':'./gradlew'):'gradle';
    const child=spawn(command,['--no-daemon','--stacktrace','assembleDebug'],{
      cwd:root,env:{...process.env,CI:'true',GRADLE_OPTS:process.env.GRADLE_OPTS||'-Dorg.gradle.daemon=false -Dorg.gradle.jvmargs=-Xmx2g'},
      stdio:['ignore','pipe','pipe']
    });
    let tail='';
    const append=chunk=>{tail=(tail+String(chunk)).slice(-30000);};
    child.stdout.on('data',append); child.stderr.on('data',append);
    const timer=setTimeout(()=>{child.kill('SIGTERM');setTimeout(()=>child.kill('SIGKILL'),5000).unref();reject(Object.assign(new Error('Gradle build timed out'),{code:'BUILD_TIMEOUT',log:tail}));},BUILD_TIMEOUT_MS);
    child.on('error',err=>{clearTimeout(timer);reject(Object.assign(err,{log:tail}));});
    child.on('close',code=>{clearTimeout(timer);if(code===0)resolve(tail);else reject(Object.assign(new Error('Gradle exited with code '+code),{code,log:tail}));});
  });
}
async function buildProject(payload){
  const jobId=crypto.randomUUID();
  const tempRoot=await fsp.mkdtemp(path.join(os.tmpdir(),'flay-build-'));
  const workDir=path.join(tempRoot,'project'); await fsp.mkdir(workDir,{recursive:true});
  try{
    const raw=Buffer.from(String(payload.archiveBase64||''),'base64');
    if(!raw.length)throw new Error('archiveBase64 is empty');
    if(raw.length>MAX_ARCHIVE_BYTES)throw new Error('Project archive is too large');
    const zip=new AdmZip(raw); assertSafeZipEntries(zip); zip.extractAllTo(workDir,true);
    const root=await findGradleRoot(workDir);
    if(!root)throw new Error('No Android Gradle project found in the uploaded archive');
    if(!fs.existsSync(path.join(root,'settings.gradle'))&&!fs.existsSync(path.join(root,'settings.gradle.kts')))
      throw new Error('Android project is missing settings.gradle/settings.gradle.kts');
    const log=await runGradle(root);
    const apks=await collectApks(root);
    if(!apks.length)throw Object.assign(new Error('Gradle completed but no APK was produced'),{log});
    const apk=apks.find(p=>/[\\/]debug[\\/][^\\/]+\.apk$/i.test(p))||apks[0];
    return{jobId,archiveSize:raw.length,apk:await fsp.readFile(apk),apkName:safeProjectName(payload.name)+'-debug.apk',technology:String(payload.technology||'unknown'),log:log.slice(-12000)};
  }finally{await fsp.rm(tempRoot,{recursive:true,force:true}).catch(()=>{});}
}

app.get('/health',(req,res)=>res.json({ok:true,service:'flay-ai-build-server',buildEngine:'Gradle + Android SDK',java:process.env.JAVA_HOME||null,activeBuilds,queuedBuilds:queue.length,maxConcurrentBuilds:MAX_CONCURRENT_BUILDS}));
app.get('/',(req,res)=>res.json({ok:true,service:'flay-ai-build-server',endpoint:'/build',methods:['POST'],message:'Real Android APK build server'}));

app.post('/build',async(req,res)=>{
  if(!authOk(req))return fail(res,401,'Invalid build server token');
  const {name,technology,archiveBase64}=req.body||{};
  if(!archiveBase64)return fail(res,400,'archiveBase64 is required');
  if(String(archiveBase64).length>Math.ceil(MAX_ARCHIVE_BYTES*1.37))return fail(res,413,'Project archive is too large');
  try{
    const result=await queueBuild(()=>buildProject({name:safeProjectName(name),technology,archiveBase64}));
    res.status(200).setHeader('Content-Type','application/vnd.android.package-archive');
    res.setHeader('Content-Disposition','attachment; filename="'+result.apkName.replace(/"/g,'')+'"');
    res.setHeader('X-Flay-Build-Id',result.jobId);
    res.setHeader('X-Flay-Technology',result.technology);
    return res.end(result.apk);
  }catch(e){
    return fail(res,e.code==='BUILD_TIMEOUT'?504:422,e.message,{buildId:e.jobId||null,log:String(e.log||'').slice(-12000)});
  }
});
app.listen(PORT,'0.0.0.0',()=>console.log('Flay AI Build Server listening on 0.0.0.0:'+PORT));
