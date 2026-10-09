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

const base=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const port=Number(process.env.STUDIO_PORT||4174);
const origin=`http://127.0.0.1:${port}`;
const projectsRoot=path.resolve(process.env.STUDIO_DATA_DIR||path.join(base,'.studio','projects'));
const sessionToken=randomBytes(32).toString('hex');
const readTokens=new Map(),clients=new Set(),watchers=new Map(),knownHashes=new Map(),watchTimers=new Map();
const store=new ProjectStore({root:projectsRoot,sampleSourcePath:path.join(base,'model.js')});
await mkdir(projectsRoot,{recursive:true});
await store.init();
const bridge=new CodexBridge({workspaceRoot:projectsRoot});
let bridgeInfo={connected:false,status:'disconnected',models:[],error:null},active=null,creatingTask=false;
const approvals=new ApprovalInbox(emit);
const mutations=new MutationGate();
const hash=b=>createHash('sha256').update(b).digest('hex');
const safeId=s=>typeof s==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(s);
const publicError=e=>String(e?.message||e).slice(0,1500);
function tokenFor(id){if(!readTokens.has(id))readTokens.set(id,randomBytes(24).toString('hex'));return readTokens.get(id);}
function decorate(project){
  const access=tokenFor(project.id);
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
  const info=await bridge.connect();
  bridgeInfo={...info,status:info.connected?'connected':'disconnected'};
  emit({type:'bridge',bridge:bridgeInfo});return bridgeInfo;
}
async function sourceBytes(id){return readFile((await store.contextPaths(id)).modelPath);}
async function rememberSource(id){knownHashes.set(id,hash(await sourceBytes(id)));}
async function provision(id){
  const p=await store.contextPaths(id);
  const skillFolder=await store.workPath(id,'.agents','skills','model-studio');
  await mkdir(path.dirname(skillFolder),{recursive:true});
  await cp(path.join(base,'studio-skill','model-studio'),skillFolder,{recursive:true,force:false});
  await writeFile(await store.workPath(id,'AGENTS.md'),[
    '# 造物 Studio 工程',
    '建模任务请先读取 .agents/skills/model-studio/SKILL.md 和 task-context.json（如果存在）。',
    '本工程的模型入口是 model.js，导出 createModel()，返回 { root, animations? }。',
    '模型在独立浏览器预览中运行；不要向 model.js 添加文件系统、网络、进程或界面代码。',
    '平台负责预览、版本和 GLB 导出。仅在用户要求的范围内修改几何，保留稳定的对象名称。',
    '通常只需编辑 model.js；不要修改参考图片、技能文件和本工作约定。',
  ].join('\n')+'\n',{flag:'wx'}).catch(error=>{if(error.code!=='EEXIST')throw error;});
  await rememberSource(id);
  if(!watchers.has(id))watchers.set(id,watch(p.workDir,{persistent:false},(_event,filename)=>{
    if(filename&&String(filename)!=='model.js')return;
    clearTimeout(watchTimers.get(id));
    watchTimers.set(id,setTimeout(()=>detectExternalEdit(id).catch(e=>emit({type:'notice',message:publicError(e)})),900));
  }));
}
async function detectExternalEdit(id){
  if(active?.projectId===id)return;
  let source;try{source=await sourceBytes(id);}catch{return;}
  const digest=hash(source);if(digest===knownHashes.get(id))return;
  const project=await store.get(id);
  if(project.pendingRevisionId)return;
  await store.snapshot(id,{label:'本地 Agent 修改',status:'pending'});
  knownHashes.set(id,digest);await publishProject(id,'model');
}
function ensureIdle(id){
  if(mutations.busy)throw Object.assign(new Error('项目正在保存，请稍后重试。'),{status:409});
  if(active||creatingTask)throw Object.assign(new Error('当前任务尚未结束，请等待完成或先停止任务。'),{status:409});
  if(bridge.busy)throw Object.assign(new Error('Codex 仍在结束上一项任务，请稍后重试。'),{status:409});
}
function mutateIdle(operation){ensureIdle();return mutations.run(operation);}
function mutateEditable(id,operation){
  return mutateIdle(async()=>{
    const project=await store.get(id);
    if(project.pendingRevisionId)throw Object.assign(new Error('新版本正在等待预览校验，请先打开模型。'),{status:409});
    return operation();
  });
}
async function finishTask(event,taskId=active?.task.id){
  const run=active;if(!run||run.task.id!==taskId||run.finishing)return;run.finishing=true;
  approvals.clear(run.projectId);
  bridgeInfo={...bridgeInfo,connected:bridge.connected,status:bridge.connected?'connected':'disconnected'};
  emit({type:'bridge',bridge:bridgeInfo});
  try{
    const text=[...run.items.values()].join('\n\n').trim();
    if(text)await store.appendMessage(run.projectId,{id:randomUUID(),role:'assistant',text,createdAt:new Date().toISOString()});
    const changed=hash(await sourceBytes(run.projectId))!==run.beforeHash;
    if(changed){
      const pending=await store.snapshot(run.projectId,{label:run.task.prompt.slice(0,44),status:'pending',resetOverrides:run.task.intent==='generate'});
      run.task={...run.task,modelRevisionId:pending.pendingRevisionId};
      await rememberSource(run.projectId);
    }
    run.task=completeTask(run.task,event,{changed,output:text});
    await store.updateTask(run.projectId,run.task);
    await publishProject(run.projectId,changed?'model':'project');
    emit({type:'task',projectId:run.projectId,task:run.task});
    if(active===run)active=null;
  }catch(e){
    if(active===run)active=null;
    run.task={...run.task,status:'failed',completedAt:new Date().toISOString(),error:publicError(e)};
    const current=await store.get(run.projectId).catch(()=>null);
    if(current?.task?.id===run.task.id){
      await store.updateTask(run.projectId,run.task).catch(()=>{});
      emit({type:'task',projectId:run.projectId,task:run.task});
    }
  }
}
bridge.on('event',event=>{
  if(event.type==='status'){
    bridgeInfo=updateBridgeStatus(bridgeInfo,event);
    emit({type:'bridge',bridge:bridgeInfo});
  }
  const run=active;
  if(!run)return;
  emit({type:'agent',projectId:run.projectId,event});
  if(event.type==='text'){
    const id=event.itemId||'message';
    run.items.set(id,event.delta?(run.items.get(id)||'')+event.text:event.text);
  }
  if(event.type==='approval')approvals.set(run.projectId,event);
  if(event.type==='complete')void finishTask(event);
});

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
  ensureIdle(projectId);creatingTask=true;
  emit({type:'taskCreating',taskCreating:true,projectId});
  try{return await beginTask(projectId,data);}
  catch(error){
    if(active?.projectId===projectId&&!active.finishing)await finishTask({status:'failed',message:publicError(error)},active.task.id);
    throw error;
  }finally{creatingTask=false;emit({type:'taskCreating',taskCreating:false,projectId});}
}
async function beginTask(projectId,data){
  const project=await store.get(projectId);
  if(project.pendingRevisionId)throw Object.assign(new Error('新版本正在等待预览校验，请先打开模型。'),{status:409});
  const request=prepareTaskRequest(project,data);
  if(!bridge.connected)await connectBridge();
  if(!bridgeInfo.connected)throw new Error(bridgeInfo.error||'尚未连接本地 Codex。');
  if(bridgeInfo.requiresOpenaiAuth&&!bridgeInfo.account)throw new Error('请先在本机终端运行 codex login，再重新连接。');
  if(data.model&&!bridgeInfo.models.some(m=>m.id===data.model||m.model===data.model))throw new Error('请选择当前账户可用的模型。');
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
  const beforeHash=hash(await sourceBytes(projectId));
  const imageContext=buildTaskImageContext(request,pathsByReferenceId,screenshotPath),images=imageContext.images;
  const task={id:randomUUID(),intent:request.intent,status:'starting',prompt:request.prompt,userPrompt:request.userPrompt,referenceIds:request.referenceIds,imageGroups:request.imageGroups,attachmentReferenceIds:request.allReferenceIds,startedAt:new Date().toISOString(),output:'',error:null};
  const context={project:{id:projectId,name:project.name},intent:request.intent,prompt:request.userPrompt,effectivePrompt:request.prompt,recentConversation:recentConversationContext(project,request.intent),selectedPart:request.selectedPart,camera:request.camera,overrides:request.overrides,...imageContext,modelContract:{entry:'model.js',export:'createModel',returns:'{ root: THREE.Object3D, animations?: THREE.AnimationClip[] }'}};
  await writeFile(p.contextPath,JSON.stringify(context,null,2));
  await store.appendMessage(projectId,{id:randomUUID(),role:'user',text:task.prompt,createdAt:task.startedAt,referenceIds:request.referenceIds,imageGroups:request.imageGroups,attachments:request.allReferenceIds.map(referenceId=>({referenceId}))});
  await store.updateTask(projectId,task);
  active={projectId,task,items:new Map(),beforeHash,finishing:false};
  emit({type:'task',projectId,task});await publishProject(projectId);
  const prompt=buildAgentPrompt(request);
  bridge.run({cwd:p.workDir,prompt,images,threadId:request.intent==='generate'?undefined:project.threadId||undefined,model:data.model||undefined}).then(async result=>{
    const run=active;
    if(run?.task.id===task.id&&!run.finishing){
      run.task=acknowledgeTaskStart(run.task,result);
      await store.updateTask(projectId,run.task).catch(error=>emit({type:'notice',message:publicError(error)}));
      if(active===run&&!run.finishing)emit({type:'task',projectId,task:run.task});
    }
    await store.setThread(projectId,result.threadId).catch(error=>emit({type:'notice',message:publicError(error)}));
  },error=>finishTask({status:'failed',message:publicError(error)},task.id)).catch(error=>emit({type:'notice',message:publicError(error)}));
  return {task};
}

const server=http.createServer(async(req,res)=>{
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
    if(pathname==='/api/events'&&req.method==='GET'){
      res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});
      res.write(`event: studio\ndata: ${JSON.stringify({type:'hello',bridge:bridgeInfo,approvals:approvals.snapshot(),taskCreating:creatingTask})}\n\n`);clients.add(res);
      const timer=setInterval(()=>{if(!res.destroyed)res.write(': heartbeat\n\n');},20000);
      req.on('close',()=>{clearInterval(timer);clients.delete(res);});return;
    }
    if(pathname==='/api/bootstrap'&&req.method==='GET'){
      const projects=(await store.list()).map(decorate);json(res,{projects,activeProjectId:projects.find(p=>p.id==='airliner')?.id||projects[0]?.id,bridge:bridgeInfo,approvals:approvals.snapshot(),taskCreating:creatingTask,skill:{url:'/downloads/model-studio-skill.zip'},workspaceRoot:projectsRoot,capabilities:{revisionPreview:true,imageGroups:true,imageLimits:IMAGE_LIMITS}});return;
    }
    if(pathname==='/api/connect'&&req.method==='POST'){
      json(res,await mutateIdle(async()=>{await bridge.close();return connectBridge();}));return;
    }
    if(pathname==='/api/tasks/stop'&&req.method==='POST'){
      const data=await readJson(req),run=active;assertStopTarget(data,run);
      if(!run||run.finishing){json(res,{ok:true,interrupted:false});return;}
      if(run.task.status==='starting'||!run.task.turnId)throw Object.assign(new Error('任务仍在启动，启动完成后即可停止。'),{status:409});
      const result=await bridge.interrupt();
      if(result.interrupted)approvals.clear(run.projectId);
      if(result.interrupted&&active===run&&!run.finishing){
        run.task={...run.task,status:'stopping',stopRequestedAt:new Date().toISOString()};
        await store.updateTask(run.projectId,run.task);emit({type:'task',projectId:run.projectId,task:run.task});
      }
      json(res,{ok:true,...result});return;
    }
    const approvalMatch=/^\/api\/approvals\/([^/]+)$/.exec(pathname);
    if(approvalMatch&&req.method==='POST'){
      const data=await readJson(req),id=approvalMatch[1];
      if(!approvals.has(id))throw new Error('这项审批已经结束。');
      if(!['accept','decline','cancel'].includes(data.decision))throw new Error('审批选项无效。');
      const result=await bridge.respondApproval(id,data.decision);approvals.delete(id);json(res,result);return;
    }
    if(pathname==='/api/projects'&&req.method==='POST'){
      const data=await readJson(req);const project=await mutateIdle(async()=>{const created=await store.create(data);await provision(created.id);return created;});json(res,decorate(project),201);return;
    }
    const match=/^\/api\/projects\/([A-Za-z0-9_-]+)(?:\/(.*))?$/.exec(pathname);
    if(!match)throw Object.assign(new Error('接口不存在。'),{status:404});
    const id=match[1],action=match[2]||'';
    if(!action&&req.method==='GET'){json(res,decorate(await store.get(id)));return;}
    if(!action&&req.method==='PATCH'){const data=await readJson(req);json(res,decorate(await mutateEditable(id,()=>store.rename(id,data.name))));return;}
    if(action==='references'&&req.method==='POST'){const data=await readJson(req);json(res,decorate(await mutateEditable(id,()=>store.addReference(id,data))));return;}
    const refMatch=/^references\/([A-Za-z0-9_-]+)$/.exec(action);
    if(refMatch&&req.method==='DELETE'){json(res,decorate(await mutateEditable(id,()=>store.removeReference(id,refMatch[1]))));return;}
    if(action==='tasks'&&req.method==='POST'){json(res,await startTask(id,await readJson(req)),202);return;}
    if(action==='exports'&&req.method==='POST'){
      let length=0;const chunks=[];
      for await(const chunk of req){length+=chunk.length;if(length>64*1024*1024)throw Object.assign(new Error('导出模型超过 64 MB。'),{status:413});chunks.push(chunk);}
      const binary=Buffer.concat(chunks);
      const saved=await store.writeExport(id,binary);
      json(res,{url:`/artifacts/${id}/exports/${saved.file}?access=${tokenFor(id)}`,savedPath:saved.savedPath,bytes:saved.bytes},201);return;
    }
    if(action==='overrides'&&req.method==='POST'){
      const data=await readJson(req);const project=await mutateEditable(id,async()=>{const updated=await store.setOverrides(id,data);await rememberSource(id);return updated;});json(res,decorate(project));return;
    }
    const revisionMatch=/^versions\/([A-Za-z0-9_-]+)$/.exec(action);
    if(revisionMatch&&req.method==='GET'){
      const revision=await store.getRevision(id,revisionMatch[1]);
      json(res,{...revision,modelUrl:`/artifacts/${id}/model.js?version=${revision.id}&access=${tokenFor(id)}`});return;
    }
    const restoreMatch=/^versions\/([A-Za-z0-9_-]+)\/restore$/.exec(action);
    if(restoreMatch&&req.method==='POST'){
      const project=await mutateEditable(id,async()=>{await store.restore(id,restoreMatch[1]);await rememberSource(id);return publishProject(id,'model');});json(res,project);return;
    }
    if(action==='validate'&&req.method==='POST'){
      const data=await readJson(req);if(typeof data.valid!=='boolean')throw new Error('校验结果无效。');
      const before=await store.get(id);const candidateBytes=await store.readRevisionSource(id,data.revisionId);
      const after=await store.validate(id,data.revisionId,{valid:data.valid,error:String(data.error||'').slice(0,1000)});
      if(before.pendingRevisionId===data.revisionId){
        knownHashes.set(id,hash(data.valid?candidateBytes:await store.readRevisionSource(id,after.headId)));
        if(before.task?.status==='validating')await store.updateTask(id,validateTask(before.task,{valid:data.valid,error:data.error}));
        await detectExternalEdit(id);
      }
      json(res,await publishProject(id,data.valid?'project':'model'));return;
    }
    throw Object.assign(new Error('接口不存在。'),{status:404});
  }catch(error){if(!res.headersSent)json(res,{error:publicError(error)},error.status||error.statusCode||(error.code==='ENOENT'?404:400));else res.end();}
});
for(const project of await store.list()){
  await provision(project.id);
  let recovered=project;
  if(['starting','running','stopping'].includes(project.task?.status)&&!project.pendingRevisionId){
    const changed=hash(await sourceBytes(project.id))!==hash(await store.readRevisionSource(project.id,project.headId));
    if(changed)recovered=await store.snapshot(project.id,{label:'连接中断前保存的模型',status:'pending',resetOverrides:project.task.intent==='generate'});
  }
  const task=recoverTaskAfterRestart(recovered);
  if(task!==recovered.task)await store.updateTask(project.id,task);
}
server.listen(port,'127.0.0.1',()=>{
  console.log(`造物 Studio: ${origin}`);
  connectBridge().catch(error=>{bridgeInfo={connected:false,status:'disconnected',models:[],error:publicError(error)};emit({type:'bridge',bridge:bridgeInfo});});
});
async function shutdown(){for(const client of clients)client.end();for(const w of watchers.values())w.close();for(const timer of watchTimers.values())clearTimeout(timer);await bridge.close();server.close(()=>process.exit(0));}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
