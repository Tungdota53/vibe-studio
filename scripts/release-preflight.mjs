import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';

// This command produces and checks artifacts locally. Publishing is a separate action.
const startedAt=new Date().toISOString(),steps=[];
fs.mkdirSync('.vibe',{recursive:true});fs.mkdirSync('release',{recursive:true});
const sourceFiles=[...new Set(execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(file=>file&&fs.existsSync(file)))];
const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sourceHashes=Object.fromEntries(sourceFiles.map(file=>[file,digest(file)]));
const commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
async function run(command){
  console.log(`[Release preflight] ${command}`);const began=Date.now();
  const code=await new Promise((resolve,reject)=>{
    const child=process.platform==='win32'?spawn(process.env.ComSpec||'cmd.exe',['/d','/s','/c',command],{stdio:'inherit',windowsHide:true}):spawn('/bin/sh',['-c',command],{stdio:'inherit'});
    child.once('error',reject);child.once('exit',resolve);
  });steps.push({command,exitCode:code,durationMs:Date.now()-began});if(code!==0)throw new Error(`Release preflight failed: ${command} (exit ${code})`);
}
let result;
try{
  await run('npm run build');
  await run('npm test -- '+(process.platform==='win32'?'--maxWorkers=1 ':'')+'--reporter=json --outputFile=.vibe/release-test-results.json');
  const test=JSON.parse(fs.readFileSync('.vibe/release-test-results.json','utf8'));
  if(!test.success||test.numFailedTests||!test.numPassedTests)throw new Error('Test result does not prove a successful test suite');
  process.env.VIBE_SMOKE_WORKSPACE=path.resolve('.vibe/release-ui-'+crypto.randomUUID());
  await run('npx --no-install electron scripts/smoke-desktop.cjs');
  if(JSON.parse(fs.readFileSync('release/smoke-result.json','utf8')).ok!==true)throw new Error('Desktop smoke failed');
  await run('npm run desktop:pack');
  await run('node scripts/verify-exe.mjs');
  if(JSON.parse(fs.readFileSync('release/exe-result.json','utf8')).ok!==true)throw new Error('Packaged EXE verification failed');
  for(const [file,expected]of Object.entries(sourceHashes))if(!fs.existsSync(file)||digest(file)!==expected)throw new Error(`Source changed during preflight: ${file}`);
  const names=['Vibe-Studio-1.0.0-x64-Setup.exe','Vibe-Studio-1.0.0-x64-Portable.exe'];
  const artifacts=names.map(name=>{const file=path.join('release',name);if(!fs.statSync(file).size)throw new Error('Empty executable');return {name,size:fs.statSync(file).size,sha256:digest(file)};});
  fs.writeFileSync('release/SHA256SUMS-1.0.0.txt',artifacts.map(file=>`${file.sha256}  ${file.name}`).join('\n')+'\n');
  result={ok:true,startedAt,finishedAt:new Date().toISOString(),commit,sourceHashes,steps,tests:{passed:test.numPassedTests,failed:test.numFailedTests},artifacts};
}catch(error){result={ok:false,startedAt,finishedAt:new Date().toISOString(),commit,steps,error:String(error)};process.exitCode=1;}
fs.writeFileSync('release/preflight.json',JSON.stringify(result,null,2));
console.log(result.ok?'Release preflight passed. Setup, Portable and checksums are ready.':result.error);
