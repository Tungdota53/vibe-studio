const { app, BrowserWindow, ipcMain, dialog, safeStorage } = require('electron');
const { fork } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

let win, host, currentUrl, switching = false, quitting = false;
let settings = {};
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
function readSettings() {
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    if (settings.contextMode !== 'manual' && (!settings.contextWindow || settings.contextWindow <= 131072)) settings.contextWindow = 1000000;
    if (settings.encryptedKey && safeStorage.isEncryptionAvailable()) settings.apiKey = safeStorage.decryptString(Buffer.from(settings.encryptedKey, 'base64'));
  } catch { settings = {}; }
}
function saveSettings() {
  const { apiKey, encryptedKey, ...publicSettings } = settings;
  if (apiKey && safeStorage.isEncryptionAvailable()) publicSettings.encryptedKey = safeStorage.encryptString(apiKey).toString('base64');
  fs.writeFileSync(settingsPath(), JSON.stringify(publicSettings, null, 2));
}
function trusted(event) {
  if (!currentUrl || event.sender !== win?.webContents || event.senderFrame !== event.sender.mainFrame || new URL(event.senderFrame.url).origin !== new URL(currentUrl).origin) throw new Error('Untrusted window');
}
async function stopHost() {
  const child = host;
  host = undefined;
  if (!child || child.exitCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill(); resolve(); }, 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.send({ type: 'shutdown' });
  });
}
async function startHost() {
  const workspace = settings.workspace || process.env.VIBE_WORKSPACE || path.join(app.getPath('documents'), 'Vibe Projects');
  fs.mkdirSync(workspace, { recursive: true });
  const token = crypto.randomBytes(32).toString('hex');
  const node = app.isPackaged ? path.join(process.resourcesPath, 'runtime', 'node.exe') : 'node';
  const backend = app.isPackaged ? path.join(process.resourcesPath, 'runtime', 'desktop-host.mjs') : path.join(__dirname, '..', 'dist', 'studio', 'desktop-host.js');
  const child = fork(backend, [], {
    execPath: node, cwd: workspace, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, VIBE_WORKSPACE: workspace, VIBE_DESKTOP_TOKEN: token, VIBE_API_KEY: settings.apiKey || process.env.VIBE_API_KEY || '', VIBE_BASE_URL: settings.baseUrl || process.env.VIBE_BASE_URL || '', VIBE_MODEL: settings.model || process.env.VIBE_MODEL || '', VIBE_CONTEXT_MODE: settings.contextMode || process.env.VIBE_CONTEXT_MODE || 'auto', VIBE_CONTEXT_WINDOW: String(settings.contextWindow || process.env.VIBE_CONTEXT_WINDOW || ''), VIBE_OUTPUT_TOKENS: String(settings.maxOutputTokens || process.env.VIBE_OUTPUT_TOKENS || ''), PATH: `${app.isPackaged ? path.join(process.resourcesPath, 'runtime') : path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}` }
  });
  host = child;
  let log = '';
  child.stderr.on('data', chunk => { log = (log + chunk).slice(-4000); });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Backend khởi động quá thời gian.')); }, 20000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Backend đã dừng (${code}). ${log}`)); });
    child.on('message', msg => { if (msg.type === 'ready') { clearTimeout(timer); resolve(`${msg.url}?token=${token}`); } });
  });
  child.on('exit', () => {
    if (host === child && !switching && !quitting) dialog.showErrorBox('Vibe Studio', 'Backend đã dừng. Hãy mở lại ứng dụng.');
  });
  currentUrl = url;
  await win.loadURL(url);
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(async () => {
    readSettings();
    win = new BrowserWindow({ width: 1320, height: 900, minWidth: 800, minHeight: 600, show: false, frame: false, icon: path.join(__dirname, 'icon.png'), backgroundColor: '#141517', title: 'Vibe Studio', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event, url) => { if (!currentUrl || new URL(url).origin !== new URL(currentUrl).origin) event.preventDefault(); });
    ipcMain.handle('window-control', (event, action) => { trusted(event); if (action === 'minimize') win.minimize(); if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize(); if (action === 'close') win.close(); });
    ipcMain.handle('capture-preview', async (event, rect) => {
      trusted(event);
      const [width,height]=win.getContentSize();
      if(!rect||!['x','y','width','height'].every(key=>Number.isInteger(rect[key]))||rect.x<0||rect.y<0||rect.width<1||rect.height<1||rect.x+rect.width>width||rect.y+rect.height>height)throw new Error('Vùng chụp không hợp lệ');
      const full=await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
      const size=full.getSize(),scaleX=size.width/width,scaleY=size.height/height;
      const image=full.crop({x:Math.floor(rect.x*scaleX),y:Math.floor(rect.y*scaleY),width:Math.floor(rect.width*scaleX),height:Math.floor(rect.height*scaleY)});
      if(image.isEmpty())throw new Error('Preview chưa sẵn sàng để chụp');
      const workspace=settings.workspace||process.env.VIBE_WORKSPACE||path.join(app.getPath('documents'),'Vibe Projects');
      const directory=path.join(workspace,'.vibe','preview-snapshots');
      fs.mkdirSync(directory,{recursive:true});
      // Reject redirected storage instead of writing outside this project's state.
      const relative=path.relative(fs.realpathSync(workspace),fs.realpathSync(directory));
      if(path.isAbsolute(relative)||relative==='..'||relative.startsWith('..'+path.sep))throw new Error('Snapshot storage redirected outside project');
      const file=path.join(directory,crypto.randomUUID()+'.png');fs.writeFileSync(file,image.toPNG(),{flag:'wx'});return {file:path.relative(workspace,file),width:rect.width,height:rect.height};
    });
    ipcMain.handle('choose-workspace', async event => {
      trusted(event); if (switching) return false;
      const result = await dialog.showOpenDialog(win, { title: 'Chọn thư mục dự án', properties: ['openDirectory', 'createDirectory'] });
      if (result.canceled) return false;
      switching = true;
      try { await stopHost(); settings.workspace = result.filePaths[0]; saveSettings(); await startHost(); return true; }
      finally { switching = false; }
    });
    ipcMain.handle('save-settings', (event, values) => {
      trusted(event);
      if (!values || typeof values.baseUrl !== 'string' || typeof values.model !== 'string' || typeof values.apiKey !== 'string') throw new Error('Cấu hình không hợp lệ.');
      const url = new URL(values.baseUrl);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !values.model.trim()) throw new Error('Cấu hình không hợp lệ.');
      const contextWindow = values.contextWindow ?? 1000000, maxOutputTokens = values.maxOutputTokens ?? 4096, contextMode = values.contextMode ?? 'auto';
      if (!['auto', 'manual'].includes(contextMode) || !Number.isSafeInteger(contextWindow) || contextWindow < 4096 || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 128 || maxOutputTokens > contextWindow / 2) throw new Error('Giới hạn context/đầu ra không hợp lệ.');
      settings = { ...settings, baseUrl: values.baseUrl, model: values.model, apiKey: values.apiKey || settings.apiKey, contextMode, contextWindow, maxOutputTokens };
      saveSettings(); return { keySaved: !settings.apiKey || safeStorage.isEncryptionAvailable() };
    });
    try { await startHost(); if (!process.env.VIBE_SMOKE_TEST) win.show(); }
    catch (error) { dialog.showErrorBox('Không thể mở Vibe Studio', String(error)); app.quit(); }
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => { if (!quitting) { event.preventDefault(); quitting = true; stopHost().finally(() => app.quit()); } });
}
