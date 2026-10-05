import { execa, execaCommand } from 'execa';
import fs from 'node:fs';
const commandLeases=new Map<string,Promise<void>>();
/** Model agents remain parallel; commands sharing build/runtime output are serialized. */
export async function withCommandLease<T>(cwd:string,signal:AbortSignal|undefined,run:()=>Promise<T>,onStatus?:(status:'waiting'|'running')=>void):Promise<T>{
  const canonical=fs.realpathSync(cwd),key=process.platform==='win32'?canonical.toLowerCase():canonical;
  const previous=commandLeases.get(key)||Promise.resolve();let release!:()=>void;
  if(commandLeases.has(key))onStatus?.('waiting');
  const held=new Promise<void>(resolve=>release=resolve),tail=previous.then(()=>held);commandLeases.set(key,tail);
  try{
    signal?.throwIfAborted();
    await new Promise<void>((resolve,reject)=>{const abort=()=>{signal?.removeEventListener('abort',abort);reject(signal?.reason||new Error('Command wait cancelled'));};signal?.addEventListener('abort',abort,{once:true});previous.then(()=>{signal?.removeEventListener('abort',abort);resolve();},reject);if(signal?.aborted)abort();});
    signal?.throwIfAborted();onStatus?.('running');return await run();
  }finally{release();void tail.then(()=>{if(commandLeases.get(key)===tail)commandLeases.delete(key);});}
}

/** Own the deadline and terminate descendants before the shell loses their PIDs.
 * A shell timeout alone can leave Node/Chromium holding stdout open on Windows.
 */
export async function runCommand(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<{ exitCode?: number; stdout: string; stderr: string }> {
  signal?.throwIfAborted();
  const options = { cwd, windowsHide: true, reject: false as const, detached: process.platform !== 'win32', maxBuffer: 2 * 1024 * 1024 };
  const child = process.platform === 'win32' && (/^\s*@['"]\r?\n/.test(command)||/^\s*(?:Get-ChildItem|Get-Content|Select-String|Test-Path|Write-Output|Get-Process)\b/.test(command))
    ? execa('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], options)
    : execaCommand(command, { ...options, shell: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopping: Promise<never> | undefined;
  let rejectDeadline: (error: Error) => void = () => {};
  const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
  const stop = (reason: string) => {
    if (stopping) return;
    stopping = (async () => {
      if (child.pid && child.exitCode === null) {
        if (process.platform === 'win32') {
          // Literal PID, no shell interpolation; touch only this owned process tree.
          await execa('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true, reject: false, timeout: 3000, forceKillAfterDelay: 1000
          }).catch(() => {});
        } else { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
        child.kill('SIGKILL');
      }
      throw new Error(reason);
    })();
    stopping.catch(rejectDeadline);
  };
  const abort = () => stop('Command cancelled; owned process tree terminated. Inspect partial effects before retrying.');
  timer = setTimeout(() => stop(`Command timed out after ${timeoutMs} ms; owned process tree terminated. Inspect partial effects before retrying. Close browser/server handles in finally blocks.`), timeoutMs);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    const result = await Promise.race([child, deadline]);
    if (stopping) return await stopping;
    signal?.throwIfAborted();
    return result;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
