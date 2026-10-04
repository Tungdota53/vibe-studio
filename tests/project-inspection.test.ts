import {describe,it,expect,afterEach} from 'vitest';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {inspectProject} from '../src/project-inspection.js';import {Tools} from '../src/tools.js';import {SkillLibrary} from '../src/skills.js';
const roots:string[]=[];const root=()=>{const p=fs.mkdtempSync(path.join(os.tmpdir(),'vibe-assess-'));roots.push(p);return p;};afterEach(()=>roots.splice(0).forEach(p=>fs.rmSync(p,{recursive:true,force:true})));
describe('Local project assessment',()=>{
 it('reports inventory and candidates without executing hooks or claiming CVE coverage',()=>{
 const dir=root();fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({dependencies:{electron:'44.5.1',example:'git+https://example.invalid/a.git'},scripts:{postinstall:'node marker.cjs'}}));fs.writeFileSync(path.join(dir,'package-lock.json'),JSON.stringify({packages:{'node_modules/example':{version:'1.0.0',resolved:'https://registry.npmjs.org/example'}}}));fs.writeFileSync(path.join(dir,'main.cjs'),'const config={nodeIntegration:true,contextIsolation:false};');fs.writeFileSync(path.join(dir,'marker.cjs'),"require('fs').writeFileSync('executed.txt','bad')");
 const report=inspectProject(dir);expect(report.verdict).toBe('UNVERIFIED');expect(report.electron).toBe(true);expect(report.observations.map(f=>f.code)).toEqual(expect.arrayContaining(['dependency_source','lifecycle_script','missing_integrity','electron_node_integration','electron_context_isolation']));expect(report.files.every(f=>/^[a-f0-9]{64}$/.test(f.sha256))).toBe(true);expect(fs.existsSync(path.join(dir,'executed.txt'))).toBe(false);
 });
 it('does not inspect secrets, generated files, escaped symlinks or oversized source',()=>{
 const dir=root(),outside=root();fs.writeFileSync(path.join(dir,'package.json'),'{"dependencies":{"electron":"44.5.1"}}');fs.writeFileSync(path.join(dir,'.env'),'secret');fs.mkdirSync(path.join(dir,'node_modules'));fs.writeFileSync(path.join(dir,'node_modules','bad.js'),'nodeIntegration:true');fs.writeFileSync(path.join(outside,'outside.js'),'nodeIntegration:true');fs.symlinkSync(outside,path.join(dir,'escape'),process.platform==='win32'?'junction':'dir');fs.writeFileSync(path.join(dir,'huge.js'),'nodeIntegration:true'+'x'.repeat(512*1024));const report=inspectProject(dir);expect(report.observations).toEqual([]);expect(report.files.map(f=>f.path)).toEqual(['package.json']);
 });
 it('allows read-only reviewers to inspect and auto-routes relevant skills without adding unrelated ones',async()=>{
 const dir=root();const result=await new Tools(dir,undefined,'reviewer',undefined,undefined,true).run('inspect_project','{}');expect(result.ok).toBe(true);expect((result.inspection as any).verdict).toBe('UNVERIFIED');
 const library=new SkillLibrary(dir);expect(library.select('reviewer','electron preload ipc').map(s=>s.id)).toContain('builtin:electron-security-review');expect(library.select('planner','dependency audit').map(s=>s.id)).toContain('builtin:project-assessment');expect(library.select('coder','write a poem').map(s=>s.id)).not.toContain('builtin:electron-security-review');
 });
});
