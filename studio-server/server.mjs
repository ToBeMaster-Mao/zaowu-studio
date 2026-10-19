import http from 'node:http';
import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { watch } from 'node:fs';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexBridge } from './codex-bridge.mjs';
import { ProjectStore } from './project-store.mjs';
import { prepareTaskRequest, buildTaskImageContext, buildAgentPrompt, completeTask, validateTask, assertStopTarget, recentConversationContext, IMAGE_LIMITS } from './task-contract.mjs';
import { ApprovalInbox, acknowledgeTaskStart, updateBridgeStatus, recoverTaskAfterRestart } from './task-runtime.mjs';
import { resolvePublicFile, tokenMatches, MutationGate } from './server-security.mjs';
import { SettingsStore } from './settings-store.mjs';
import { ApiModelRunner, listProviderModels, testProviderConnection } from './api-provider.mjs';
import { TaskScheduler } from './task-scheduler.mjs';
import { ProjectTransactions } from './project-transactions.mjs';

const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const port=Number(process.env.STUDIO_PORT||4174);
const origin=`http://127.0.0.1:${port}`;
const defaultWorkspaceRoot=path.resolve(process.env.STUDIO_DATA_DIR||path.join(base,'.studio','projects'));
const settings=new SettingsStore({file:process.env.STUDIO_SETTINGS_PATH||(process.env.STUDIO_DATA_DIR?`${defaultWorkspaceRoot}.settings.json`:path.join(base,'.studio','settings.json')),defaultWorkspaceRoot});
await settings.init();
let projectsRoot=settings.publicSettings().workspaceRoot;
const sessionToken=randomBytes(32).toString('hex');
const readTokens=new Map(),clients=new Set(),watchers=new Map(),knownHashes=new Map(),watchTimers=new Map();
let store=new ProjectStore({root:projectsRoot,sampleSourcePath:path.join(base,'model.js')});
await mkdir(projectsRoot,{recursive:true});
await store.init();
let bridgeInfo={connected:false,status:'disconnected',models:[],error:null};
let bridge=createMetadataBridge();
const creatingProjects=new Set(),projectMutations=new Map(),approvalTargets=new Map();
const approvals=new ApprovalInbox(emit);
const mutations=new MutationGate();
let closing=false;
let workspaceEpoch=0;
const scheduler=new TaskScheduler({limits:{codex:settings.publicSettings().codexConcurrency,api:settings.publicSettings().apiConcurrency},execute:executeTask,onChange:snapshot=>emit({type:'scheduler',scheduler:snapshot}),onError:(error,run)=>emit({type:'notice',projectId:run.projectId,message:publicError(error)})});
const hash=b=>createHash('sha256').update(b).digest('hex');
const safeId=s=>typeof s==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(s);
const publicError=e=>{
  let message=String(e?.message||e);
  const keys=['openai','deepseek','gemini','grok'].map(id=>settings.getProvider(id).apiKey);
  for(const run of [...scheduler.active.values(),...scheduler.queued])keys.push(run.providerConfig?.apiKey);
  for(const key of keys)if(key)message=message.replaceAll(key,'[redacted]');
  return message.replace(/Bearer\s+\S+/gi,'Bearer [redacted]').replace(/\bsk-[A-Za-z0-9_-]{12,}/g,'[redacted]').slice(0,1500);
};
function tokenFor(id){if(!readTokens.has(id))readTokens.set(id,randomBytes(24).toString('hex'));return readTokens.get(id);}
function decorate(project){
  const access=tokenFor(project.id);
  const position=scheduler.queued.findIndex(run=>run.projectId===project.id);
  if(project.task?.status==='queued'&&position>=0)project={...project,task:{...project.task,queuePosition:position+1}};
  return {...project,modelUrl:`${project.modelUrl}&access=${access}`,references:project.references.map(ref=>({...ref,url:`${ref.url}?access=${access}`})),messages:project.messages.map(message=>({...message,...(message.attachments?{attachments:message.attachments.map(attachment=>({...attachment,url:`${attachment.url}?access=${access}`}))}:{})}))};
}
function emit(data){
  const frame=`event: studio\ndata: ${JSON.stringify(data)}\n\n`;
  for(const client of clients){if(client.destroyed)clients.delete(client);else client.write(frame);}
}
async function publishProject(id,type='project'){
  const project=decorate(await store.get(id));emit({type,projectId:id,project});return project;
}
async function connectBridge(){
  const target=bridge,info=await target.connect();
  if(target!==bridge)return bridgeInfo;
  bridgeInfo={...info,status:info.connected?'connected':'disconnected'};
  emit({type:'bridge',bridge:bridgeInfo});return bridgeInfo;
}
function createMetadataBridge(){
  const connection=new CodexBridge({workspaceRoot:projectsRoot});
  connection.on('event',event=>{
    if(connection!==bridge||event.type!=='status')return;
    bridgeInfo=updateBridgeStatus(bridgeInfo,event);emit({type:'bridge',bridge:bridgeInfo});
  });
  return connection;
}
async function sourceBytes(id){return readFile((await store.contextPaths(id)).modelPath);}
async function rememberSource(id){knownHashes.set(id,hash(await sourceBytes(id)));}
function transactionsFor(id){
  if(!projectMutations.has(id))projectMutations.set(id,new ProjectTransactions());
  return projectMutations.get(id);
}
async function provision(id,targetStore=store,installWatch=true){
  const p=await targetStore.contextPaths(id);
  const skillFolder=await targetStore.workPath(id,'.agents','skills','model-studio');
  await mkdir(path.dirname(skillFolder),{recursive:true});
  await cp(path.join(base,'studio-skill','model-studio'),skillFolder,{recursive:true,force:false});
  await writeFile(await targetStore.workPath(id,'AGENTS.md'),[
    '# 造物 Studio 工程',
    '建模任务请先读取 .agents/skills/model-studio/SKILL.md 和 task-context.json（如果存在）。',
    '本工程的模型入口是 model.js，导出 createModel()，返回 { root, animations? }。',
    '模型在独立浏览器预览中运行；不要向 model.js 添加文件系统、网络、进程或界面代码。',
    '平台负责预览、版本和 GLB 导出。仅在用户要求的范围内修改几何，保留稳定的对象名称。',
    '通常只需编辑 model.js；不要修改参考图片、技能文件和本工作约定。',
  ].join('\n')+'\n',{flag:'wx'}).catch(error=>{if(error.code!=='EEXIST')throw error;});
  if(!installWatch)return;
  await rememberSource(id);
  if(!watchers.has(id))watchers.set(id,watch(p.workDir,{persistent:false},(_event,filename)=>{
    if(filename&&String(filename)!=='model.js')return;
    clearTimeout(watchTimers.get(id));
    watchTimers.set(id,setTimeout(()=>detectExternalEdit(id).catch(e=>emit({type:'notice',message:publicError(e)})),900));
  }));
}
async function detectExternalEdit(id){
  if(mutations.busy||projectMutations.get(id)?.busy||scheduler.find(id)||creatingProjects.has(id))return;
  return transactionsFor(id).run(async()=>{
  let source;try{source=await sourceBytes(id);}catch{return;}
  const digest=hash(source);if(digest===knownHashes.get(id))return;
  const project=await store.get(id);
  if(project.pendingRevisionId)return;
  await store.snapshot(id,{label:'本地 Agent 修改',status:'pending'});
  knownHashes.set(id,digest);await publishProject(id,'model');
  });
}
function ensureIdle(id){
  if(mutations.busy)throw Object.assign(new Error('项目正在保存，请稍后重试。'),{status:409});
  if(id&&(scheduler.find(id)||creatingProjects.has(id)||projectMutations.get(id)?.busy))throw Object.assign(new Error('此项目已有运行或排队中的任务，请等待完成或先停止任务。'),{status:409});
}
async function ensureWorkspaceIdle(locked=false){
  if(!locked)ensureIdle();
  if(scheduler.busy||creatingProjects.size||[...projectMutations.values()].some(gate=>gate.busy))throw Object.assign(new Error('请先完成或停止所有运行、排队中的任务，再切换工作空间或重新连接。'),{status:409});
  if((await store.list()).some(project=>project.pendingRevisionId))throw Object.assign(new Error('还有模型等待预览校验，请先打开相应项目完成校验。'),{status:409});
}
async function updateSettings(data){
  ensureIdle();
  return mutations.run(async()=>{
    const candidate=await settings.preview(data);
    const switching=path.relative(projectsRoot,candidate.workspaceRoot)!=='';
    let nextStore;
    if(switching){
      await ensureWorkspaceIdle(true);
      nextStore=new ProjectStore({root:candidate.workspaceRoot,sampleSourcePath:path.join(base,'model.js')});
      await nextStore.init();
      await recoverWorkspace(nextStore,false);
    }
    const saved=await settings.update(data);
    if(switching){
      for(const w of watchers.values())w.close();watchers.clear();
      for(const timer of watchTimers.values())clearTimeout(timer);watchTimers.clear();
      await bridge.close();
      knownHashes.clear();readTokens.clear();projectMutations.clear();
      store=nextStore;projectsRoot=nextStore.root;workspaceEpoch++;
      bridgeInfo={connected:false,status:'disconnected',models:[],error:null};bridge=createMetadataBridge();
      await recoverWorkspace();
      void connectBridge().catch(error=>emit({type:'notice',message:publicError(error)}));
    }
    scheduler.setLimits({codex:saved.codexConcurrency,api:saved.apiConcurrency});
    emit({type:'settings',settings:saved});return saved;
  });
}
function mutateEditable(id,operation){
  ensureIdle(id);
  return transactionsFor(id).run(async()=>{
    const project=await store.get(id);
    if(project.pendingRevisionId)throw Object.assign(new Error('新版本正在等待预览校验，请先打开模型。'),{status:409});
    return operation();
  });
}
function mutateProjectState(id,operation){
  if(mutations.busy)throw Object.assign(new Error('工作空间正在切换，请稍后重试。'),{status:409});
  return transactionsFor(id).run(operation);
}
async function finishTask(run,event){
  if(run.finishing)return;run.finishing=true;
  return transactionsFor(run.projectId).run(async()=>{
  approvals.clear(run.projectId);
  for(const [id,target] of approvalTargets)if(target.run===run)approvalTargets.delete(id);
  try{
    const text=[...run.items.values()].join('\n\n').trim();
    if(text)await store.appendMessage(run.projectId,{id:randomUUID(),role:'assistant',text,createdAt:new Date().toISOString()});
    const changed=Boolean(run.beforeHash)&&hash(await sourceBytes(run.projectId))!==run.beforeHash;
    if(changed){
      const pending=await store.snapshot(run.projectId,{label:run.task.prompt.slice(0,44),status:'pending',resetOverrides:run.task.intent==='generate'});
      run.task={...run.task,modelRevisionId:pending.pendingRevisionId};
      await rememberSource(run.projectId);
    }
    run.task=completeTask(run.task,event,{changed,output:text});
    await store.updateTask(run.projectId,run.task);
    await publishProject(run.projectId,changed?'model':'project');
    emit({type:'task',projectId:run.projectId,task:run.task});
  }catch(e){
    run.task={...run.task,status:'failed',completedAt:new Date().toISOString(),error:publicError(e)};
    const current=await store.get(run.projectId).catch(()=>null);
    if(current?.task?.id===run.task.id){
      await store.updateTask(run.projectId,run.task).catch(()=>{});
      emit({type:'task',projectId:run.projectId,task:run.task});
    }
  }finally{run.resolveDone?.();scheduler.changed();}
  });
}
function handleRunEvent(run,event){
  if(run.finishing||run.shuttingDown)return;
  if(event.type==='approval'){
    const requestId=`${run.task.id}:${event.requestId}`;
    approvalTargets.set(requestId,{run,originalId:event.requestId});
    event={...event,requestId};approvals.set(run.projectId,event);
  }
  emit({type:'agent',projectId:run.projectId,event});
  if(event.type==='text'){
    const id=event.itemId||'message';
    run.items.set(id,event.delta?(run.items.get(id)||'')+event.text:event.text);
  }
  if(event.type==='complete')void finishTask(run,event);
}

async function readJson(req){
  let total=0;const chunks=[];
  for await(const chunk of req){total+=chunk.length;if(total>19*1024*1024)throw Object.assign(new Error('上传内容过大。'),{status:413});chunks.push(chunk);}
  try{return chunks.length?JSON.parse(Buffer.concat(chunks).toString('utf8')):{};}catch{throw Object.assign(new Error('请求格式无效。'),{status:400});}
}
function json(res,data,status=200){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
async function staticFile(res,file,extra={}){
  const content=await readFile(file);
  const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.jpeg':'image/jpeg','.jpg':'image/jpeg','.webp':'image/webp','.zip':'application/zip','.svg':'image/svg+xml'};
  res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-cache',...extra});res.end(content);
}
async function startTask(projectId,data){
  ensureIdle(projectId);creatingProjects.add(projectId);
  emit({type:'taskCreating',taskCreating:true,projectId});
  try{return await beginTask(projectId,data);}
  finally{creatingProjects.delete(projectId);emit({type:'taskCreating',taskCreating:false,projectId});}
}
async function beginTask(projectId,data){
  const project=await store.get(projectId);
  if(project.pendingRevisionId)throw Object.assign(new Error('新版本正在等待预览校验，请先打开模型。'),{status:409});
  const request=prepareTaskRequest(project,data);
  const provider=data.provider??settings.publicSettings().defaultProvider;
  const providerConfig=settings.getProvider(provider);
  const model=data.model??providerConfig.model??'';
  if(typeof model!=='string'||model.length>200||/[\u0000-\u001f]/.test(model))throw new Error('模型名称无效。');
  if(provider!=='codex'){
    if(!providerConfig.apiKey)throw new Error('请先在设置中配置该服务的 API Key。');
    if(!model.trim())throw new Error('请选择或填写要使用的 API 模型。');
    if(!providerConfig.supportsImages&&(request.references.length||request.screenshotDataUrl))throw new Error('当前模型配置为仅文字，请移除本轮图片和视口截图，或启用支持图片的模型。');
  }
  const p=await store.contextPaths(projectId),pathsByReferenceId=new Map();
  for(const ref of request.references){
    const info=await store.readReference(projectId,ref.id);
    const extension=info.type==='image/jpeg'?'.jpg':info.type==='image/webp'?'.webp':'.png';
    const refPath=await store.workPath(projectId,'references',`task-reference-${ref.id}${extension}`);
    await writeFile(refPath,info.buffer);pathsByReferenceId.set(ref.id,refPath);
  }
  let screenshotPath=null;
  if(request.screenshotDataUrl){
    const match=/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(request.screenshotDataUrl);
    if(match){screenshotPath=await store.workPath(projectId,'references','current-view.'+(match[1]==='jpeg'?'jpg':'png'));await writeFile(screenshotPath,Buffer.from(match[2],'base64'));}
  }
  const imageContext=buildTaskImageContext(request,pathsByReferenceId,screenshotPath),images=imageContext.images;
  const task={id:randomUUID(),intent:request.intent,status:'queued',provider,model:model.trim(),prompt:request.prompt,userPrompt:request.userPrompt,referenceIds:request.referenceIds,imageGroups:request.imageGroups,attachmentReferenceIds:request.allReferenceIds,queuedAt:new Date().toISOString(),startedAt:null,output:'',error:null};
  const context={project:{id:projectId,name:project.name},intent:request.intent,prompt:request.userPrompt,effectivePrompt:request.prompt,recentConversation:recentConversationContext(provider==='codex'?project:{...project,threadId:null},request.intent),selectedPart:request.selectedPart,camera:request.camera,overrides:request.overrides,...imageContext,modelContract:{entry:'model.js',export:'createModel',returns:'{ root: THREE.Object3D, animations?: THREE.AnimationClip[] }'}};
  await writeFile(p.contextPath,JSON.stringify(context,null,2));
  await store.appendMessage(projectId,{id:randomUUID(),role:'user',text:task.prompt,createdAt:task.queuedAt,referenceIds:request.referenceIds,imageGroups:request.imageGroups,attachments:request.allReferenceIds.map(referenceId=>({referenceId}))});
  await store.updateTask(projectId,task);
  const run={projectId,task,providerConfig,items:new Map(),finishing:false,context,images,cwd:p.workDir,prompt:buildAgentPrompt(request),threadId:request.intent==='generate'?undefined:project.threadId||undefined};
  scheduler.enqueue(run);
  emit({type:'task',projectId,task});await publishProject(projectId);
  return {task:run.task};
}

async function executeTask(run){
  const {projectId}=run;
  run.done=new Promise(resolve=>{run.resolveDone=resolve;});
  const listener=event=>handleRunEvent(run,event);
  try{
    if(closing)throw new Error('服务正在关闭。');
    run.task={...run.task,status:'starting',startedAt:new Date().toISOString(),queuePosition:null};
    await store.updateTask(projectId,run.task);emit({type:'task',projectId,task:run.task});scheduler.changed();
    run.beforeHash=hash(await sourceBytes(projectId));
    if(closing)throw new Error('服务正在关闭。');
    run.runner=run.task.provider==='codex'?new CodexBridge({workspaceRoot:projectsRoot}):new ApiModelRunner({provider:run.providerConfig});
    run.runner.on('event',listener);
    if(run.task.provider==='codex'){
      const info=await run.runner.connect();
      if(!info.connected)throw new Error(info.error||'尚未连接本地 Codex。');
      if(info.requiresOpenaiAuth&&!info.account)throw new Error('请先在本机终端运行 codex login，再重新连接。');
      if(run.task.model&&!info.models.some(model=>model.id===run.task.model||model.model===run.task.model))throw new Error('请选择当前账户可用的 Codex 模型。');
    }else await store.setThread(projectId,null);
    if(closing)throw new Error('服务正在关闭。');
    const result=await run.runner.run({cwd:run.cwd,prompt:run.prompt,images:run.images,context:run.context,threadId:run.threadId,model:run.task.model||undefined});
    if(!run.finishing){
      run.task=acknowledgeTaskStart(run.task,result);
      await store.updateTask(projectId,run.task);
      if(!run.finishing)emit({type:'task',projectId,task:run.task});
      scheduler.changed();
    }
    if(result.threadId)await store.setThread(projectId,result.threadId);
    await run.done;
  }catch(error){await finishTask(run,{status:'failed',message:publicError(error)});}
  finally{
    run.runner?.off('event',listener);
    await run.runner?.close().catch(error=>emit({type:'notice',message:publicError(error)}));
    delete run.providerConfig;delete run.context;
  }
}

async function stopTask(data){
  if(typeof data.projectId!=='string'||!safeId(data.projectId))throw new Error('请指定要停止的项目。');
  const run=scheduler.find(data.projectId);
  assertStopTarget(data,run);
  if(!run||run.finishing)return {ok:true,interrupted:false};
  const queued=scheduler.cancelQueued(data.projectId,data.taskId);
  if(queued){
    queued.task={...queued.task,status:'interrupted',completedAt:new Date().toISOString(),error:null,queuePosition:null};
    await store.updateTask(queued.projectId,queued.task);await publishProject(queued.projectId);
    emit({type:'task',projectId:queued.projectId,task:queued.task});return {ok:true,interrupted:true};
  }
  if(run.task.status==='starting'||!run.task.turnId)throw Object.assign(new Error('任务仍在启动，启动完成后即可停止。'),{status:409});
  const result=await run.runner.interrupt();
  if(result.interrupted){
    approvals.clear(run.projectId);
    if(!run.finishing){run.task={...run.task,status:'stopping',stopRequestedAt:new Date().toISOString()};await store.updateTask(run.projectId,run.task);emit({type:'task',projectId:run.projectId,task:run.task});}
  }
  return {ok:true,...result};
}

const server=http.createServer(async(req,res)=>{
  const requestEpoch=workspaceEpoch;
  const assertWorkspaceCurrent=()=>{if(requestEpoch!==workspaceEpoch)throw Object.assign(new Error('工作空间已切换，请在当前工作空间重新操作。'),{status:409});};
  const requestJson=async()=>{const data=await readJson(req);assertWorkspaceCurrent();return data;};
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  const host=req.headers.host;
  if(host!==`127.0.0.1:${port}`&&host!==`localhost:${port}`){json(res,{error:'主机地址无效。'},403);return;}
  if(host===`localhost:${port}`){res.writeHead(308,{Location:origin+req.url});res.end();return;}
  try{
    const url=new URL(req.url,origin),pathname=decodeURIComponent(url.pathname);
    if(pathname==='/api/health'){json(res,{ok:true,product:'model-studio',version:'0.1.0'});return;}
    if(pathname==='/'||pathname==='/index.html'){
      const html=(await readFile(path.join(base,'studio-web','index.html'),'utf8')).replaceAll('__SESSION_TOKEN__',sessionToken);
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"});res.end(html);return;
    }
    if(pathname==='/downloads/model-studio-skill.zip'){
      await staticFile(res,path.join(base,'public-downloads','model-studio-skill.zip'),{'Content-Disposition':'attachment; filename="model-studio-skill.zip"'});return;
    }
    if(pathname.startsWith('/artifacts/')){
      const parts=pathname.split('/').filter(Boolean),id=parts[1];
      if(!safeId(id)||!tokenMatches(url.searchParams.get('access'),tokenFor(id)))throw Object.assign(new Error('预览链接已过期，请重新打开项目。'),{status:403});
      res.setHeader('Access-Control-Allow-Origin','*');
      if(parts[2]==='model.js'&&parts.length===3){
        const version=url.searchParams.get('version');if(!safeId(version))throw new Error('模型版本无效。');
        const data=await store.readRevisionSource(id,version);
        res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-store'});res.end(data);return;
      }
      if(parts[2]==='references'&&parts.length===4){
        const ref=await store.readReference(id,parts[3]);res.writeHead(200,{'Content-Type':ref.type,'Cache-Control':'private, max-age=120'});res.end(ref.buffer);return;
      }
      if(parts[2]==='messages'&&parts[4]==='attachments'&&parts.length===6){
        const attachment=await store.readMessageAttachment(id,parts[3],parts[5]);res.writeHead(200,{'Content-Type':attachment.type,'Cache-Control':'private, max-age=120'});res.end(attachment.buffer);return;
      }
      if(parts[2]==='exports'&&parts.length===4&&/^[a-f0-9-]{36}\.glb$/.test(parts[3])){
        const binary=await store.readExport(id,parts[3]);res.writeHead(200,{'Content-Type':'model/gltf-binary','Content-Disposition':'attachment; filename="model.glb"','Cache-Control':'no-store'});res.end(binary);return;
      }
      throw Object.assign(new Error('文件不存在。'),{status:404});
    }
    if(pathname.startsWith('/studio-web/')||pathname.startsWith('/studio-viewer/')||pathname.startsWith('/node_modules/three/')){
      const file=await resolvePublicFile(base,pathname);
      const headers={'Access-Control-Allow-Origin':'*'};
      if(pathname==='/studio-viewer/preview.html')headers['Content-Security-Policy']=`default-src 'none'; script-src 'unsafe-inline' ${origin}; style-src 'unsafe-inline'; img-src data: blob: ${origin}; connect-src ${origin}; worker-src blob:; object-src 'none'; base-uri 'none'`;
      await staticFile(res,file,headers);return;
    }
    if(!pathname.startsWith('/api/'))throw Object.assign(new Error('页面不存在。'),{status:404});
    const requestOrigin=req.headers.origin;
    if(requestOrigin&&requestOrigin!==origin&&requestOrigin!==`http://localhost:${port}`)throw Object.assign(new Error('来源校验失败。'),{status:403});
    if(!tokenMatches(req.headers['x-studio-token'],sessionToken))throw Object.assign(new Error('连接已过期，请刷新页面。'),{status:401});
    if(req.headers['x-studio-workspace']&&decodeURIComponent(req.headers['x-studio-workspace'])!==projectsRoot)throw Object.assign(new Error('工作空间已切换，请刷新当前项目后重试。'),{status:409});
    if(pathname==='/api/settings'&&req.method==='GET'){json(res,settings.publicSettings());return;}
    if(pathname==='/api/settings'&&req.method==='PUT'){json(res,await updateSettings(await requestJson()));return;}
    const providerMatch=/^\/api\/providers\/(openai|deepseek|gemini|grok)\/(models|test)$/.exec(pathname);
    if(providerMatch&&req.method==='POST'){
      const provider=settings.getProvider(providerMatch[1],await requestJson());
      const controller=new AbortController();res.on('close',()=>controller.abort());
      const result=providerMatch[2]==='models'?{models:await listProviderModels(provider,{signal:controller.signal})}:await testProviderConnection(provider,{signal:controller.signal});
      json(res,result);return;
    }
    if(pathname==='/api/events'&&req.method==='GET'){
      res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});
      res.write(`event: studio\ndata: ${JSON.stringify({type:'hello',bridge:bridgeInfo,approvals:approvals.snapshot(),taskCreating:creatingProjects.size>0,scheduler:scheduler.snapshot(),settings:settings.publicSettings()})}\n\n`);clients.add(res);
      const timer=setInterval(()=>{if(!res.destroyed)res.write(': heartbeat\n\n');},20000);
      req.on('close',()=>{clearInterval(timer);clients.delete(res);});return;
    }
    if(pathname==='/api/bootstrap'&&req.method==='GET'){
      const projects=(await store.list()).map(decorate);assertWorkspaceCurrent();json(res,{projects,activeProjectId:projects.find(p=>p.id==='airliner')?.id||projects[0]?.id,bridge:bridgeInfo,approvals:approvals.snapshot(),taskCreating:creatingProjects.size>0,settings:settings.publicSettings(),scheduler:scheduler.snapshot(),skill:{url:'/downloads/model-studio-skill.zip'},workspaceRoot:projectsRoot,capabilities:{revisionPreview:true,imageGroups:true,imageLimits:IMAGE_LIMITS,multiProvider:true,settings:true}});return;
    }
    if(pathname==='/api/connect'&&req.method==='POST'){
      ensureIdle();json(res,await mutations.run(async()=>{await ensureWorkspaceIdle(true);await bridge.close();return connectBridge();}));return;
    }
    if(pathname==='/api/tasks/stop'&&req.method==='POST'){
      const data=await requestJson();json(res,await mutateProjectState(data.projectId,()=>stopTask(data)));return;
    }
    const approvalMatch=/^\/api\/approvals\/([^/]+)$/.exec(pathname);
    if(approvalMatch&&req.method==='POST'){
      const data=await requestJson(),id=approvalMatch[1];
      const target=approvalTargets.get(id);
      if(!approvals.has(id)||!target)throw new Error('这项审批已经结束。');
      if(!['accept','decline','cancel'].includes(data.decision))throw new Error('审批选项无效。');
      const result=await target.run.runner.respondApproval(target.originalId,data.decision);approvals.delete(id);approvalTargets.delete(id);json(res,result);return;
    }
    if(pathname==='/api/projects'&&req.method==='POST'){
      const data=await requestJson();ensureIdle();const project=await mutations.run(async()=>{const created=await store.create(data);await provision(created.id);return created;});json(res,decorate(project),201);return;
    }
    const match=/^\/api\/projects\/([A-Za-z0-9_-]+)(?:\/(.*))?$/.exec(pathname);
    if(!match)throw Object.assign(new Error('接口不存在。'),{status:404});
    const id=match[1],action=match[2]||'';
    if(!action&&req.method==='GET'){const project=await store.get(id);assertWorkspaceCurrent();json(res,decorate(project));return;}
    if(!action&&req.method==='PATCH'){const data=await requestJson();json(res,decorate(await mutateEditable(id,()=>store.rename(id,data.name))));return;}
    if(action==='references'&&req.method==='POST'){const data=await requestJson();json(res,decorate(await mutateEditable(id,()=>store.addReference(id,data))));return;}
    const refMatch=/^references\/([A-Za-z0-9_-]+)$/.exec(action);
    if(refMatch&&req.method==='DELETE'){json(res,decorate(await mutateEditable(id,()=>store.removeReference(id,refMatch[1]))));return;}
    if(action==='tasks'&&req.method==='POST'){json(res,await startTask(id,await requestJson()),202);return;}
    if(action==='exports'&&req.method==='POST'){
      let length=0;const chunks=[];
      for await(const chunk of req){length+=chunk.length;if(length>64*1024*1024)throw Object.assign(new Error('导出模型超过 64 MB。'),{status:413});chunks.push(chunk);}
      const binary=Buffer.concat(chunks);
      assertWorkspaceCurrent();
      const saved=await mutateProjectState(id,()=>store.writeExport(id,binary));
      json(res,{url:`/artifacts/${id}/exports/${saved.file}?access=${tokenFor(id)}`,savedPath:saved.savedPath,bytes:saved.bytes},201);return;
    }
    if(action==='overrides'&&req.method==='POST'){
      const data=await requestJson();const project=await mutateEditable(id,async()=>{const updated=await store.setOverrides(id,data);await rememberSource(id);return updated;});json(res,decorate(project));return;
    }
    const revisionMatch=/^versions\/([A-Za-z0-9_-]+)$/.exec(action);
    if(revisionMatch&&req.method==='GET'){
      const revision=await store.getRevision(id,revisionMatch[1]);
      assertWorkspaceCurrent();
      json(res,{...revision,modelUrl:`/artifacts/${id}/model.js?version=${revision.id}&access=${tokenFor(id)}`});return;
    }
    const restoreMatch=/^versions\/([A-Za-z0-9_-]+)\/restore$/.exec(action);
    if(restoreMatch&&req.method==='POST'){
      const project=await mutateEditable(id,async()=>{await store.restore(id,restoreMatch[1]);await rememberSource(id);return publishProject(id,'model');});json(res,project);return;
    }
    if(action==='validate'&&req.method==='POST'){
      const data=await requestJson();if(typeof data.valid!=='boolean')throw new Error('校验结果无效。');
      await mutateProjectState(id,async()=>{
      const before=await store.get(id);const candidateBytes=await store.readRevisionSource(id,data.revisionId);
      const after=await store.validate(id,data.revisionId,{valid:data.valid,error:String(data.error||'').slice(0,1000)});
      if(before.pendingRevisionId===data.revisionId){
        knownHashes.set(id,hash(data.valid?candidateBytes:await store.readRevisionSource(id,after.headId)));
        if(before.task?.status==='validating')await store.updateTask(id,validateTask(before.task,{valid:data.valid,error:data.error}));
      }
      });
      assertWorkspaceCurrent();await detectExternalEdit(id);
      json(res,await publishProject(id,data.valid?'project':'model'));return;
    }
    throw Object.assign(new Error('接口不存在。'),{status:404});
  }catch(error){if(!res.headersSent)json(res,{error:publicError(error)},error.status||error.statusCode||(error.code==='ENOENT'?404:400));else res.end();}
});
async function recoverWorkspace(targetStore=store,installWatch=true){for(const project of await targetStore.list()){
  await provision(project.id,targetStore,installWatch);
  const modelBytes=await readFile((await targetStore.contextPaths(project.id)).modelPath);
  let recovered=project;
  if(['queued','starting','running','stopping'].includes(project.task?.status)&&!project.pendingRevisionId){
    const changed=hash(modelBytes)!==hash(await targetStore.readRevisionSource(project.id,project.headId));
    if(changed)recovered=await targetStore.snapshot(project.id,{label:'连接中断前保存的模型',status:'pending',resetOverrides:project.task.intent==='generate'});
  }
  const task=recoverTaskAfterRestart(recovered);
  if(task!==recovered.task)await targetStore.updateTask(project.id,task);
}}
await recoverWorkspace();
server.listen(port,'127.0.0.1',()=>{
  console.log(`造物 Studio: ${origin}`);
  connectBridge().catch(error=>{bridgeInfo={connected:false,status:'disconnected',models:[],error:publicError(error)};emit({type:'bridge',bridge:bridgeInfo});});
});
async function shutdown(){
  if(closing)return;closing=true;scheduler.paused=true;
  for(const client of clients)client.end();
  for(const w of watchers.values())w.close();for(const timer of watchTimers.values())clearTimeout(timer);
  for(const run of [...scheduler.queued])await stopTask({projectId:run.projectId,taskId:run.task.id});
  const running=[...scheduler.active.values()];
  await Promise.all(running.map(async run=>{
    run.shuttingDown=true;await run.runner?.close();
    await finishTask(run,{status:'interrupted',message:'服务已关闭，可重新提交任务。'});
  }));
  await Promise.all(running.map(run=>run.execution));
  await bridge.close();server.close(()=>process.exit(0));
}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
