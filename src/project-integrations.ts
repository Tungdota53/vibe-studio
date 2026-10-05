import { templateCatalog } from './template-catalog.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execaCommand } from 'execa';
import { SkillLibrary } from './skills.js';
import { recommendationScore, skillRoutes } from './skill-routing.js';
import { safePath, isSensitivePath } from './security.js';
import { durableJson } from './checkpoints.js';
import { McpRegistry } from './mcp.js';
import type { Config } from './config.js';
import type { Role } from './types.js';
import { roleProfile } from './roles.js';

async function download(url:string,signal?:AbortSignal) {
  const parsed=new URL(url);if(!['raw.githubusercontent.com','registry.npmjs.org'].includes(parsed.hostname)||parsed.protocol!=='https:')throw new Error('Unsupported integration source');
  const response=await fetch(url,{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000),redirect:'error'});
  if(!response.ok)throw new Error(`Source HTTP ${response.status}`);
  const reader=response.body!.getReader(),chunks:Uint8Array[]=[];let bytes=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>1024*1024)throw new Error('Source exceeds 1 MiB');chunks.push(value)}}finally{await reader.cancel()}
  return Buffer.concat(chunks);
}
export function projectSignals(workspace:string) {
  const files:string[]=[],dependencies:string[]=[];
  for(const name of ['package.json','pyproject.toml','requirements.txt','Cargo.toml','go.mod','index.html','angular.json','next.config.js','next.config.ts','vite.config.ts','vite.config.js'])try{
    const file=safePath(workspace,name);if(fs.statSync(file).size>128000)continue;files.push(name);
    if(name==='package.json'){const data=JSON.parse(fs.readFileSync(file,'utf8'));dependencies.push(...Object.keys({...data.dependencies,...data.devDependencies}).slice(0,200));}
    else if(name!=='index.html')dependencies.push(...(fs.readFileSync(file,'utf8').match(/\b(django|flask|fastapi|pytest|sqlalchemy|playwright|react|vue|next|vite|tailwind)\b/gi)||[]));
  }catch{}
  const web=files.includes('index.html')||dependencies.some(x=>/react|vue|next|vite|angular|svelte|playwright|electron/.test(x));
  return {files,dependencies:[...new Set(dependencies)],web,summary:[...files,...dependencies].join(' ').slice(0,12000)};
}
export class ProjectIntegrations {
  private running?:Promise<any>;
  constructor(private workspace:string,private get=download){}
  scan(task='') {
    const project=projectSignals(this.workspace),library=new SkillLibrary(this.workspace);
    const query=project.summary+' '+task+' testing security'+(project.web?' frontend ui design webapp':'');
    const candidates=library.list().filter(s=>s.source==='github'&&s.provenance?.integrity&&!s.provenance.adaptation).map(skill=>{
      const roles=skillRoutes[skill.id]?.roles || ['coder'] as Role[];
      const score=Math.max(...roles.map(role=>recommendationScore(skill.id,role,query)));
      return {id:skill.id,name:skill.name,roles,score,repository:skill.provenance!.repository,url:skill.provenance!.url,commit:skill.provenance!.commit,license:skill.provenance!.license};
    }).filter(x=>x.score>0).sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id)).slice(0,6);
    const webTask=/(website|frontend|giao diện|trang web|landing page|\bhtml\b|\bcss\b)/i.test(task);
    return {project,templates:{summary:templateCatalog.summary(),recommendations:templateCatalog.search(project.summary+' '+task,'skills',0,6).items},skills:candidates,mcp:[...(project.web||webTask?[{id:'auto-playwright',name:'Playwright',source:'https://github.com/microsoft/playwright-mcp',reason:project.web?'Dự án web: kiểm tra giao diện bằng trình duyệt':'Yêu cầu tạo web: chuẩn bị kiểm tra giao diện',package:'@playwright/mcp'}]:[]),...(project.dependencies.length?[{id:'auto-context7',name:'Context7',source:'https://github.com/upstash/context7',reason:'Tra cứu tài liệu thư viện phát hiện trong dự án',url:'https://mcp.context7.com/mcp'}]:[])]};
  }
  sync(c:Config,task:string,notify:(message:string)=>void=()=>{},signal?:AbortSignal) {
    if(this.running)return this.running;
    this.running=this.execute(c,task,notify,signal).finally(()=>{this.running=undefined});return this.running;
  }
  private async execute(c:Config,task:string,notify:(message:string)=>void,signal?:AbortSignal){
    const plan=this.scan(task),results:{id:string;status:string;message:string}[]=[],file=safePath(this.workspace,'.vibe/config.json',true);
    let saved:any={};try{saved=JSON.parse(fs.readFileSync(file,'utf8'))}catch{}
    const profiles={...(c.agentProfiles || {}),...saved.agentProfiles},servers={...(c.mcpServers || {})};
    for(const candidate of plan.skills.slice(0,3)) {
      signal?.throwIfAborted();
      try{
        const source=new SkillLibrary(this.workspace).resolve(candidate.id),manifest=JSON.parse(fs.readFileSync(path.join(path.dirname(source.file),'.provenance.json'),'utf8'));
        const destination=safePath(this.workspace,'.vibe/skills/auto/'+candidate.id.slice(7),true),targetManifest=path.join(destination,'.provenance.json');
        let verified=false;try{const installed=JSON.parse(fs.readFileSync(targetManifest,'utf8'));verified=installed.commit===manifest.commit&&Object.entries(manifest.files as Record<string,string>).every(([name,hash])=>crypto.createHash('sha256').update(fs.readFileSync(safePath(destination,name))).digest('hex')===hash)}catch{}
        if(!verified){
          notify(`Đang tải skill ${candidate.name} từ ${candidate.repository}.`);
          const entries=Object.entries(manifest.files as Record<string,string>);if(entries.length>100)throw new Error('Skill bundle too large');
          const buffers=new Map<string,Buffer>();let total=0;
          for(const [name,hash]of entries){if(path.isAbsolute(name)||name.split(/[\\/]/).includes('..')||isSensitivePath(name))throw new Error('Unsafe skill resource');const remotes=name==='LICENSE.txt'?[`${manifest.path}/${name}`,'LICENSE','LICENSE.txt']:[`${manifest.path}/${name}`];let bytes:Buffer|undefined;for(const remote of remotes){try{const fetched=await this.get(`https://raw.githubusercontent.com/${manifest.repository}/${manifest.commit}/${remote}`,signal);if(crypto.createHash('sha256').update(fetched).digest('hex')===hash){bytes=fetched;break;}}catch{signal?.throwIfAborted()}}if(!bytes)throw new Error('Source checksum mismatch or resource unavailable: '+name);total+=bytes.length;if(total>4*1024*1024)throw new Error('Skill bundle exceeds 4 MiB');buffers.set(name,bytes);}
          fs.mkdirSync(destination,{recursive:true});for(const [name,bytes]of buffers){const target=safePath(destination,name,true);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);}durableJson(targetManifest,manifest);
        }
        const skillId='workspace:auto/'+candidate.id.slice(7);
        const assigned:Role[]=[];
        for(const role of candidate.roles){const existing=profiles[role] || {},skills=[...(existing.skills || roleProfile(role,c).skills)];if(!skills.includes(skillId)&&skills.length>=8){notify(`Vai ${role} đã có 8 skill; giữ lựa chọn hiện tại.`);continue;}profiles[role]={...existing,skills:[...new Set([...skills,skillId])]};assigned.push(role);}
        results.push({id:skillId,status:verified?'cached':'installed',message:assigned.length?`Đã gán ${candidate.name} cho ${assigned.join(', ')}.`:`Đã tải ${candidate.name}; vai đã đủ skill, chọn thủ công nếu cần.`});
      }catch(error){results.push({id:candidate.id,status:'error',message:error instanceof Error?error.message:String(error)});}
    }
    for(const candidate of plan.mcp){
      signal?.throwIfAborted();if(servers[candidate.id]){results.push({id:candidate.id,status:'configured',message:'Giữ cấu hình hiện tại.'});continue;}
      try{
        notify(`Đang thiết lập MCP ${candidate.name}.`);
        if('url'in candidate)servers[candidate.id]={transport:'http',url:candidate.url!,enabled:true,timeoutMs:20000};
        else{
          const metadata=JSON.parse((await this.get(`https://registry.npmjs.org/${encodeURIComponent(candidate.package!)}/latest`,signal)).toString());
          if(metadata.name!==candidate.package||!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(metadata.version)||!metadata.dist?.integrity)throw new Error('Invalid npm metadata');
          const root=safePath(this.workspace,'.vibe/integrations/'+candidate.id,true);fs.mkdirSync(root,{recursive:true});
          if(!fs.existsSync(path.join(root,'package.json')))durableJson(path.join(root,'package.json'),{name:candidate.id,version:'1.0.0',private:true});
          const installed=await execaCommand(`npm install --workspaces=false --ignore-scripts --no-audit --no-fund --save-exact --registry=https://registry.npmjs.org ${candidate.package}@${metadata.version}`,{cwd:root,shell:true,windowsHide:true,timeout:180000,cancelSignal:signal,reject:false});
          if(installed.exitCode!==0)throw new Error('Không cài được MCP; cần npm trên máy. Xem cài đặt MCP để cấu hình thủ công.');
          const packageRoot=safePath(root,'node_modules/'+candidate.package),pkg=JSON.parse(fs.readFileSync(path.join(packageRoot,'package.json'),'utf8'));
          const bin=typeof pkg.bin==='string'?pkg.bin:Object.values(pkg.bin || {})[0];if(typeof bin!=='string')throw new Error('MCP entry point missing');
          const entry=safePath(packageRoot,bin);servers[candidate.id]={transport:'stdio',command:process.execPath,args:[entry,'--headless'],enabled:true,timeoutMs:30000};
          durableJson(path.join(root,'source.json'),{package:metadata.name,version:metadata.version,integrity:metadata.dist.integrity,repository:candidate.source});
        }
        results.push({id:candidate.id,status:'configured',message:`Đã cấu hình ${candidate.name}.`});
      }catch(error){results.push({id:candidate.id,status:'error',message:error instanceof Error?error.message:String(error)});}
    }
    // Reread to preserve unrelated settings edited while a download was in flight.
    try{saved=JSON.parse(fs.readFileSync(file,'utf8'))}catch{}
    durableJson(file,{...saved,agentProfiles:profiles,mcpServers:servers});
    const next={...c,agentProfiles:profiles,mcpServers:servers};
    const connections=await McpRegistry.forWorkspace(this.workspace,servers).discover(signal);
    const report={...plan,results,connections,updatedAt:new Date().toISOString()};durableJson(safePath(this.workspace,'.vibe/integrations/report.json',true),report);return {config:next,report};
  }
}
