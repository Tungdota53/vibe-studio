import {describe,it,expect,vi,afterEach} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {ProjectIntegrations,projectSignals} from '../src/project-integrations.js';
import {SkillLibrary} from '../src/skills.js';import {loadConfig} from '../src/config.js';import {McpRegistry} from '../src/mcp.js';
import {execaCommand} from 'execa';
vi.mock('execa',()=>({execaCommand:vi.fn()}));
const roots:string[]=[];afterEach(()=>{vi.restoreAllMocks();for(const root of roots.splice(0)){try{fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}catch{}}});
function project(web=false){const root=fs.mkdtempSync(path.join(os.tmpdir(),'vibe-auto-'));roots.push(root);if(web)fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({dependencies:{react:'1',vite:'1'}}));return root;}
function fixture(root:string){const library=new SkillLibrary(root);const sources=library.list().filter(s=>s.source==='github');return vi.fn(async(url:string)=>{const parsed=new URL(url),relative=decodeURIComponent(parsed.pathname.slice(1));for(const skill of sources){const m=JSON.parse(fs.readFileSync(path.join(path.dirname(skill.file),'.provenance.json'),'utf8')),prefix=`${m.repository}/${m.commit}/`;if(!relative.startsWith(prefix))continue;const file=relative.slice(prefix.length);const name=file.startsWith(m.path+'/')?file.slice(m.path.length+1):file==='LICENSE'||file==='LICENSE.txt'?'LICENSE.txt':'';if(name&&m.files[name])return fs.readFileSync(path.join(path.dirname(skill.file),name));}throw new Error('Unknown source')});}
describe('Automatic project integrations',()=>{
  it('prepares a browser MCP for a new website request even before project files exist',()=>{
    const service=new ProjectIntegrations(project());expect(service.scan('Tạo trang web quảng cáo').mcp.some(x=>x.id==='auto-playwright')).toBe(true);expect(service.scan('Rà soát bảo mật').mcp).toEqual([]);
  });
  it('installs MCP into a private package with fixed version, no lifecycle scripts and no project dependency edits',async()=>{
    const root=project(true),original=fs.readFileSync(path.join(root,'package.json'),'utf8'),sources=fixture(root);
    vi.spyOn(McpRegistry.prototype,'discover').mockResolvedValue([]);
    vi.mocked(execaCommand).mockImplementation(async(command,options:any)=>{
      expect(command).toContain('@playwright/mcp@1.2.3');expect(command).toContain('--ignore-scripts');expect(command).toContain('--save-exact');expect(options.cwd).toBe(path.join(root,'.vibe','integrations','auto-playwright'));
      expect(JSON.parse(fs.readFileSync(path.join(options.cwd,'package.json'),'utf8')).private).toBe(true);
      const target=path.join(options.cwd,'node_modules','@playwright','mcp');fs.mkdirSync(target,{recursive:true});fs.writeFileSync(path.join(target,'package.json'),JSON.stringify({bin:{mcp:'cli.js'}}));fs.writeFileSync(path.join(target,'cli.js'),'');return {exitCode:0} as any;
    });
    const get=async(url:string)=>url.startsWith('https://registry.npmjs.org/')?Buffer.from(JSON.stringify({name:'@playwright/mcp',version:'1.2.3',dist:{integrity:'sha512-fixture'}})):sources(url);
    const result=await new ProjectIntegrations(root,get).sync(loadConfig(root),'frontend website');expect(result.config.mcpServers?.['auto-playwright'].transport).toBe('stdio');expect(fs.readFileSync(path.join(root,'package.json'),'utf8')).toBe(original);expect(execaCommand).toHaveBeenCalledTimes(1);
  });
  it('rejects unsafe registry versions before invoking the package manager',async()=>{
    const root=project(true),sources=fixture(root);vi.spyOn(McpRegistry.prototype,'discover').mockResolvedValue([]);vi.mocked(execaCommand).mockClear();
    const get=async(url:string)=>url.startsWith('https://registry.npmjs.org/')?Buffer.from(JSON.stringify({name:'@playwright/mcp',version:'1.2.3 & echo injected',dist:{integrity:'x'}})):sources(url);
    const result=await new ProjectIntegrations(root,get).sync(loadConfig(root),'frontend');expect(execaCommand).not.toHaveBeenCalled();expect(result.report.results.find(x=>x.id==='auto-playwright')?.status).toBe('error');expect(result.config.mcpServers?.['auto-context7']).toBeDefined();
  });
  it('detects web dependencies locally without reading env secrets and picks role-specific sources',()=>{
    const root=project(true);fs.writeFileSync(path.join(root,'.env'),'SECRET=private');const plan=new ProjectIntegrations(root).scan('build frontend website');expect(plan.project.web).toBe(true);expect(plan.project.dependencies).toEqual(['react','vite']);expect(JSON.stringify(plan)).not.toContain('private');expect(plan.mcp.map(x=>x.id)).toEqual(['auto-playwright','auto-context7']);expect(plan.skills.some(s=>s.roles.includes('tester'))).toBe(true);expect(plan.skills.every(s=>/^[a-f0-9]{40}$/.test(s.commit))).toBe(true);
  });
  it('downloads actual pinned resources, verifies hashes, assigns roles and reuses verified cache',async()=>{
    const root=project(),get=fixture(root);vi.spyOn(McpRegistry.prototype,'discover').mockResolvedValue([]);const service=new ProjectIntegrations(root,get),result=await service.sync(loadConfig(root),'security audit');expect(result.report.results.some(x=>x.status==='installed')).toBe(true);expect(get).toHaveBeenCalled();const list=new SkillLibrary(root).list().filter(x=>x.source==='workspace');expect(list.length).toBeGreaterThan(0);expect(list.every(s=>s.provenance?.integrity)).toBe(true);expect(result.config.agentProfiles?.reviewer?.skills?.some(x=>x.startsWith('workspace:auto/'))).toBe(true);
    expect(result.config.agentProfiles?.reviewer?.skills).toContain('builtin:code-review');
    const count=get.mock.calls.length;const next=await service.sync(result.config,'security audit');expect(get.mock.calls.length).toBe(count);expect(next.report.results.every(x=>x.status==='cached')).toBe(true);
    const skill=list[0];fs.appendFileSync(skill.file,'\nTampered');expect(()=>new SkillLibrary(root).load(skill.id)).toThrow('checksum');
  },15000);
  it('rejects checksum failures without installing or assigning corrupt content',async()=>{
    const root=project();vi.spyOn(McpRegistry.prototype,'discover').mockResolvedValue([]);const result=await new ProjectIntegrations(root,async()=>Buffer.from('corrupt')).sync(loadConfig(root),'security');expect(result.report.results.every(x=>x.status==='error')).toBe(true);expect(new SkillLibrary(root).list().filter(s=>s.source==='workspace')).toHaveLength(0);expect(result.config.agentProfiles).toEqual({});
  });
  it('ignores manifest symlinks escaping the workspace during detection',()=>{
    const root=project(),outside=project();fs.writeFileSync(path.join(outside,'package.json'),JSON.stringify({dependencies:{react:'1'}}));try{fs.symlinkSync(path.join(outside,'package.json'),path.join(root,'package.json'))}catch{return;}expect(projectSignals(root).dependencies).toEqual([]);
  });
  it('cancels before writes and preserves existing MCP and custom role configuration',async()=>{
    const root=project();fs.mkdirSync(path.join(root,'.vibe'));fs.writeFileSync(path.join(root,'.vibe','config.json'),JSON.stringify({agentProfiles:{reviewer:{instructions:'Custom'}},mcpServers:{own:{transport:'http',url:'https://example.com/mcp',enabled:false}}}));vi.spyOn(McpRegistry.prototype,'discover').mockResolvedValue([]);const service=new ProjectIntegrations(root,fixture(root)),controller=new AbortController();controller.abort();await expect(service.sync(loadConfig(root),'security',undefined,controller.signal)).rejects.toThrow();const result=await service.sync(loadConfig(root),'security');expect(result.config.agentProfiles?.reviewer?.instructions).toBe('Custom');expect(result.config.mcpServers?.own.enabled).toBe(false);
  });
});
