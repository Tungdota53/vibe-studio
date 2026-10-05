const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
require('electron').dialog.showErrorBox = (title, message) => {
  fs.writeFileSync('release/smoke-result.json', JSON.stringify({ ok: false, error: `${title}: ${message}` }));
  app.exit(1);
};
const root = path.resolve(process.env.VIBE_SMOKE_WORKSPACE || '.vibe/desktop-smoke');
const smokeUserData=root+'-userdata';
fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(smokeUserData, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });
fs.mkdirSync(path.join(root, '.vibe'), { recursive: true });
fs.writeFileSync(path.join(root, '.vibe', 'config.json'), JSON.stringify({ useWorktrees: false }));
fs.mkdirSync(smokeUserData,{recursive:true});app.setPath('userData',smokeUserData);
process.env.VIBE_WORKSPACE = root;
process.env.VIBE_SMOKE_TEST = '1';
process.env.VIBE_AUTO_INTEGRATIONS='0';
process.env.VIBE_API_KEY = '';
const requests = [];
let plannerReplies = 0;
const model = http.createServer((req, res) => {
  if (req.url === '/v1/models') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'smoke-model' }, { id: 'agent-specific-model' }] })); return; }
  let body = ''; req.on('data', data => body += data); req.on('end', () => {
    requests.push(JSON.parse(body));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const request = requests.at(-1), user = request.messages.findLast(message => message.role === 'user')?.content || '';
    if ((user.includes('smoke-teamwork-page') || user.startsWith('Repair the previous plan')) && request.messages[0].content.includes('You are Vibe planner')) {
      if (plannerReplies++ === 0) {
        res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: '{"tasks":[{"title":"Create page","acceptanceCriteria":23}]}' } }] }) + '\n\ndata: [DONE]\n\n'); return;
      }
      assert(request.messages.some(message => message.role === 'assistant' && message.content?.includes('acceptanceCriteria')));
      const content = JSON.stringify({ tasks: [
        { id:'T1', acceptanceCriteria:'Tệp HTML thực tế chứa nội dung alo alo và có bằng chứng công cụ kiểm tra.', agentId:'frontend', title:'Create smoke page', role:'coder', description:'smoke-create-page', expectedFiles:['smoke-teamwork.html'], dependencies:[] },
        { id:'T1B', agentId:'backend', title:'Create independent styles', role:'coder', description:'smoke-style-page', expectedFiles:['smoke-teamwork.css'], dependencies:[] },
        { id:'T2', title:'Test smoke page', role:'tester', description:'smoke-check-page', dependencies:['T1','T1B'] },
        { id:'T3', title:'Review smoke page', role:'reviewer', description:'smoke-review-page', dependencies:['T1','T1B'] },
        { id:'T4', title:'Fresh audit', role:'tester', agentId:'victory-auditor', phase:'audit', description:'smoke-audit-page', dependencies:['T2','T3'] }
      ] });
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\ndata: [DONE]\n\n'); return;
    }
    if (user.startsWith('smoke-') && user.endsWith('-page')) {
      const tools = request.messages.filter(message => message.role === 'tool');
      if (!tools.length) {
        const write = ['smoke-create-page','smoke-style-page'].includes(user);
        const call = { index: 0, id: 'smoke-page-tool', type: 'function', function: { name: write ? 'write_file' : 'read_file', arguments: JSON.stringify(write ? { path: user === 'smoke-style-page' ? 'smoke-teamwork.css' : 'smoke-teamwork.html', content: user === 'smoke-style-page' ? 'body{color:teal}' : '<h1>alo alo</h1>' } : { path: 'smoke-teamwork.html' }) } };
        setTimeout(() => res.end('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [call] } }] }) + '\n\ndata: [DONE]\n\n'), 1100); return;
      }
      if (['smoke-check-page', 'smoke-audit-page'].includes(user) && tools.length === 1) {
        const call = { index: 0, id: 'smoke-executed-check', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: `node -e "process.exit(require('fs').readFileSync('smoke-teamwork.html','utf8').includes('alo alo')?0:1)"` }) } };
        res.end('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [call] } }] }) + '\n\ndata: [DONE]\n\n'); return;
      }
      if (['smoke-review-page', 'smoke-audit-page'].includes(user)) {
        res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: JSON.stringify({ verdict: 'PASS', findings: [], evidence: ['read_file smoke-teamwork.html'] }) } }] }) + '\n\ndata: [DONE]\n\n'); return;
      }
      assert(tools.every(tool => JSON.parse(tool.content).ok),tools.map(tool=>tool.content).join('\n'));
      if (!['smoke-create-page','smoke-style-page'].includes(user)) assert(tools.some(tool => tool.content.includes('alo alo')));
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Verified smoke page' } }] }) + '\n\ndata: [DONE]\n\n'); return;
    }
    if(user.startsWith('[TEAM MANAGER]')) { res.end('data: '+JSON.stringify({choices:[{delta:{content:JSON.stringify({summary:'Existing tester, reviewer and auditor provide necessary coverage',delegate:[]})}}]})+'\n\ndata: [DONE]\n\n'); return; }
    const text = requests.at(-1).tools ? 'Đã kiểm tra giao diện desktop.\n\n**Sẵn sàng làm việc.**\n\n```typescript\nconst studio = "Vibe";\n```' : 'Mục tiêu: kiểm tra desktop. Giữ kết quả đã xác nhận và tiếp tục từ lượt trước.';
    res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\ndata: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 351, completion_tokens: 24, total_tokens: 375, prompt_tokens_details: { cached_tokens: 123 } } }) + '\n\ndata: [DONE]\n\n');
  });
});
const timer = setTimeout(() => { fs.writeFileSync('release/smoke-result.json', JSON.stringify({ ok: false, error: 'timeout' })); app.exit(1); }, 120000);
async function wait(win, expression) {
  for (let i = 0; i < 250; i++) { if (await win.webContents.executeJavaScript(expression)) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('UI timeout: ' + expression);
}
app.on('browser-window-created', (_, win) => {
  win.webContents.setBackgroundThrottling(false);
  win.webContents.on('console-message', (_event, _level, message) => { if (String(message).includes('Error')) console.log(message); });
  win.webContents.once('did-finish-load', async () => {
    try {
      await win.webContents.executeJavaScript(`window.addEventListener('error', event => console.error(event.error?.stack || event.message));window.addEventListener('unhandledrejection', event => console.error(event.reason?.stack || event.reason));`);
      await wait(win, `document.getElementById('connection-text').textContent === 'Đã kết nối' && document.getElementById('workspace-name').textContent !== 'Dự án' && typeof window.desktop === 'object'`);
      fs.mkdirSync('release', { recursive: true });
      await win.webContents.capturePage();
      await new Promise(resolve => setTimeout(resolve, 350));
      fs.writeFileSync('release/preview.png', (await win.webContents.capturePage()).toPNG());
      await win.webContents.executeJavaScript(`document.getElementById('view-team').click();`);
      await wait(win, `document.querySelectorAll('.roster-item').length===16 && !document.getElementById('map-empty').hidden`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.agent-node').length`), 0);
      await win.webContents.executeJavaScript(`document.getElementById('map-back').click();`);
      const port = model.address().port;
      await win.webContents.executeJavaScript(`document.getElementById('team-button').click();`);
      await wait(win, `document.querySelectorAll('.role-card').length===7`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.named-agent-card').length`), 16);
      assert(await win.webContents.executeJavaScript(`!!document.querySelector('[data-agent=ui-ux] [data-field=model]') && !!document.querySelector('[data-agent=challenger]') && !!document.querySelector('[data-agent=auditor]')`));
      await win.webContents.executeJavaScript(`document.querySelector('[data-role=reviewer] [data-field=instructions]').value='Review authentication with evidence';document.getElementById('team-form').requestSubmit();`);
      await wait(win, `document.getElementById('team-status').textContent.includes('Đã lưu')`);
      const profiles = JSON.parse(fs.readFileSync(path.join(root, '.vibe/config.json'), 'utf8'));
      assert.equal(profiles.agentProfiles.reviewer.instructions, 'Review authentication with evidence');
      assert(profiles.agentProfiles.coder.skills.includes('builtin:scoped-implementation'));
      await win.webContents.executeJavaScript(`document.querySelector('[data-agent=assistant] [data-field=model]').value='agent-specific-model';document.querySelector('[data-agent=frontend] [data-field=model]').value='agent-specific-model';document.querySelector('[data-agent=backend] [data-field=model]').value='smoke-model';document.getElementById('team-form').requestSubmit();`);
      await wait(win, `document.querySelector('[data-agent=assistant] summary').textContent.includes('agent-specific-model')`);
      assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.vibe/config.json'), 'utf8')).namedAgents.find(agent=>agent.id==='assistant').model, 'agent-specific-model');
      await win.webContents.executeJavaScript(`document.getElementById('skill-search').value='review';document.getElementById('skill-search').dispatchEvent(new Event('input'));`);
      await wait(win, `document.getElementById('skill-results').textContent.includes('code-review') && !document.getElementById('skill-results').textContent.includes('imagegen')`);
      await new Promise(resolve => setTimeout(resolve, 350));
      fs.writeFileSync('release/preview-team.png', (await win.webContents.capturePage()).toPNG());
      await win.webContents.executeJavaScript(`document.getElementById('team-dialog').close();`);
      await win.webContents.executeJavaScript(`document.getElementById('settings-button').click();document.getElementById('base-url').value='http://127.0.0.1:${port}/v1';document.getElementById('model-input').value='smoke-model';document.getElementById('api-key').value='smoke-private-key';document.getElementById('context-window').value=16384;document.getElementById('output-tokens').value=2048;document.getElementById('settings-form').requestSubmit();`);
      await wait(win, `!document.getElementById('settings-dialog').open && document.getElementById('model-name').textContent === 'smoke-model'`);
      const saved = fs.readFileSync(path.join(smokeUserData, 'settings.json'), 'utf8'); assert(!saved.includes('smoke-private-key')); assert(saved.includes('encryptedKey'));
      await win.webContents.executeJavaScript(`document.getElementById('fetch-models').click();`);
      await wait(win, `document.querySelectorAll('#available-models option').length===2`);
      await win.webContents.executeJavaScript(`document.getElementById('prompt').value='Kiểm tra desktop';document.getElementById('composer').requestSubmit();`);
      await wait(win, `document.querySelector('.message.assistant .message-content strong') && !document.getElementById('stop-button').hidden === false`);
      assert.equal(requests.at(-1).model, 'smoke-model');
      assert.equal(requests.at(-1).max_tokens, 2048);
      assert(requests.at(-1).messages[0].content.includes('builtin:workspace-assistant'));
      await wait(win, `document.getElementById('usage-output').textContent==='24'`);
      assert(await win.webContents.executeJavaScript(`document.querySelectorAll('.code-toolbar button').length>0 && document.querySelectorAll('.syntax-keyword').length>0 && typeof window.ChatOutput.render==='function'`));
      await win.webContents.executeJavaScript(`document.getElementById('mcp-button').click();`);
      await wait(win, `document.getElementById('mcp-status').textContent.includes('Bật server')`);
      await win.webContents.executeJavaScript(`document.getElementById('mcp-add').click();document.getElementById('mcp-add').click();`);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.mcp-card').length`), 2);
      await win.webContents.executeJavaScript(`document.getElementById('mcp-dialog').close();`);
      await win.webContents.executeJavaScript(`document.getElementById('chat-agent').value='assistant';`);
      await win.webContents.executeJavaScript(`document.getElementById('prompt').value='Tiếp tục từ kết quả trên';document.getElementById('composer').requestSubmit();`);
      await wait(win, `document.querySelectorAll('.message.assistant').length===2 && document.getElementById('stop-button').hidden`);
      assert.equal(requests.at(-1).model, 'agent-specific-model');
      assert(requests.at(-1).messages.some(item => item.role==='assistant' && item.content.includes('Sẵn sàng làm việc')));
      await win.webContents.executeJavaScript(`document.getElementById('context-button').click();document.getElementById('compact-context').click();`);
      await wait(win, `Number(document.getElementById('context-compactions').textContent)>=1 && document.getElementById('stop-button').hidden`);
      await win.webContents.executeJavaScript(`document.getElementById('toast').hidden=true`);
      await win.webContents.capturePage();
      await new Promise(resolve => setTimeout(resolve, 350));
      fs.writeFileSync('release/preview-chat.png', (await win.webContents.capturePage()).toPNG());
      await win.webContents.executeJavaScript(`document.getElementById('new-chat').click();document.querySelector('#history button').click();`);
      await wait(win, `document.querySelectorAll('.message').length >= 2`);
      await win.webContents.executeJavaScript(`document.getElementById('mode').value='teamwork';document.getElementById('prompt').value='smoke-teamwork-page';document.getElementById('composer').requestSubmit();`);
      await wait(win, `document.querySelectorAll('.fleet-card.running').length>=2 && document.querySelectorAll('.agent-node').length===6`);
      assert.equal(await win.webContents.executeJavaScript(`document.body.dataset.view`), 'chat');
      assert(await win.webContents.executeJavaScript(`document.querySelectorAll('.progress-row').length>0`));
      await win.webContents.executeJavaScript(`document.getElementById('view-team').click();`);
      assert.equal(await win.webContents.executeJavaScript(`document.body.dataset.view`), 'team');
      assert(await win.webContents.executeJavaScript(`document.querySelectorAll('.active-ai-pill').length>=2 && document.getElementById('map-active-ais').textContent.includes('agent-specific-model') && document.getElementById('map-active-ais').textContent.includes('smoke-model')`));
      win.webContents.debugger.attach('1.3');
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name:'prefers-reduced-motion', value:'reduce' }] });
      await win.webContents.executeJavaScript(`document.querySelector('.fleet-card.running').click();document.getElementById('map-follow').click();`);
      await wait(win, `document.getElementById('map-detail-content').textContent.includes('coder')`);
      await win.webContents.capturePage();
      await new Promise(resolve => setTimeout(resolve, 150));
      fs.writeFileSync('release/preview-map-live.png', (await win.webContents.capturePage()).toPNG());
      await wait(win, `document.getElementById('stop-button').hidden && document.getElementById('messages').textContent.includes('Kết quả Teamwork')`);
      assert.equal(fs.readFileSync(path.join(root, 'smoke-teamwork.html'), 'utf8'), '<h1>alo alo</h1>');
      const report = await win.webContents.executeJavaScript(`document.getElementById('messages').textContent`);
      assert(!fs.existsSync(path.join(root, '.git')));
      assert(report.includes('Nghiệm thu: PASS'));
      assert(!/(?:^|\n)• [^:\n]+: (?:failed|blocked)/.test(report));
      await wait(win, `document.querySelectorAll('.agent-node.completed').length===5 && document.getElementById('map-gate').textContent==='PASS'`);
      const failedTasks = await win.webContents.executeJavaScript(`document.querySelectorAll('.agent-node.failed').length`);
      const blockedTasks = await win.webContents.executeJavaScript(`document.querySelectorAll('.agent-node.blocked').length`);
      assert.equal(failedTasks, 0);
      assert.equal(blockedTasks, 0);
      assert.equal(await win.webContents.executeJavaScript(`document.getElementById('map-gate').textContent`), 'PASS');
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.map-edge').length`), 6);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.map-edge-flow').length`), 0);
      await win.webContents.executeJavaScript(`document.querySelector('[data-task=T4]').click();document.getElementById('map-fit').click();`);
      await wait(win, `document.getElementById('map-detail-content').textContent.includes('Fresh audit')`);
      assert(await win.webContents.executeJavaScript(`document.getElementById('map-detail-content').textContent.includes('T3')`));
      await wait(win, `document.getElementById('map-detail-content').textContent.includes('Fresh audit')`);
      const beforeZoom = await win.webContents.executeJavaScript(`document.getElementById('map-zoom-value').textContent`);
      await win.webContents.executeJavaScript(`document.getElementById('map-zoom-in').click();`);
      assert.notEqual(await win.webContents.executeJavaScript(`document.getElementById('map-zoom-value').textContent`), beforeZoom);
      await win.webContents.executeJavaScript(`document.getElementById('map-fit').click();`);
      await win.webContents.capturePage();
      await new Promise(resolve => setTimeout(resolve, 400));
      assert(await win.webContents.executeJavaScript(`Math.abs(document.querySelector('.agent-node').getBoundingClientRect().width - 254 * parseInt(document.getElementById('map-zoom-value').textContent) / 100) < 3`));
      assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.agent-node')).animationName`), 'none');
      fs.writeFileSync('release/preview-map.png', (await win.webContents.capturePage()).toPNG());
      await win.webContents.executeJavaScript(`TeamMap.restore({sessionId:'stalled-fixture',status:'running',tasks:[{id:'stall',title:'Browser check',role:'coder',status:'running',dependencies:[],lastProgressAt:new Date(Date.now()-120000).toISOString(),step:'run_command'}]});TeamMap.event({type:'agent_status',taskId:'stall',step:'budget'});`);
      await wait(win, `document.querySelector('[data-task=stall]')`);
      await win.webContents.executeJavaScript(`document.querySelector('[data-task=stall]').click();`);
      await wait(win, `document.getElementById('map-detail-content').textContent.includes('chưa có tiến độ mới')`);
      assert(await win.webContents.executeJavaScript(`document.getElementById('map-detail-content').textContent.includes('Chạy lệnh') && document.getElementById('map-detail-content').textContent.includes('Tiến độ gần nhất') && !document.getElementById('map-detail-content').textContent.includes('budget')`));
      await win.webContents.executeJavaScript(`location.reload();`);
      await wait(win, `document.getElementById('connection-text').textContent==='Đã kết nối' && document.querySelectorAll('.agent-node.completed').length===5 && document.getElementById('map-gate').textContent==='PASS'`);
      await win.webContents.executeJavaScript(`document.getElementById('view-team').click();`);
      await win.webContents.executeJavaScript(`document.querySelector('#history button[title*="smoke-teamwork-page"]').click();`);
      await wait(win, `document.querySelectorAll('.agent-node.completed').length===5 && document.getElementById('map-gate').textContent==='PASS' && document.getElementById('map-session-label').textContent==='Phiên Teamwork'`);
      const plannerCountBeforeContinue = requests.filter(request => request.messages[0]?.content?.includes('You are Vibe planner')).length;
      await win.webContents.executeJavaScript(`window.__continuationPayload=null;window.__originalSocketSend=WebSocket.prototype.send;WebSocket.prototype.send=function(data){const payload=JSON.parse(data);if(payload.type==='chat')window.__continuationPayload=payload;return window.__originalSocketSend.call(this,data);};document.getElementById('mode').value='teamwork';document.getElementById('prompt').value='tiếp tục';document.getElementById('composer').requestSubmit();`);
      await wait(win, `document.getElementById('stop-button').hidden && document.getElementById('messages').textContent.includes('Teamwork session already completed')`);
      assert(await win.webContents.executeJavaScript(`window.__continuationPayload.sessionId.startsWith('session-')`));
      assert.equal(requests.filter(request => request.messages[0]?.content?.includes('You are Vibe planner')).length, plannerCountBeforeContinue);
      await win.webContents.executeJavaScript(`WebSocket.prototype.send=window.__originalSocketSend;void 0;`);
      // History restores task states and the actual persisted acceptance verdict.
      win.setMinimumSize(480, 600); win.setSize(620, 780);
      await new Promise(resolve => setTimeout(resolve, 250));
      assert(await win.webContents.executeJavaScript(`document.body.scrollWidth <= innerWidth`));
      await win.webContents.executeJavaScript(`document.getElementById('toggle-sidebar').click();`);
      assert(await win.webContents.executeJavaScript(`document.getElementById('sidebar').classList.contains('mobile-open')`));
      await win.webContents.executeJavaScript(`document.getElementById('toggle-sidebar').click();`);
      win.setSize(1320, 900);
      win.setSize(1400,900);
      await win.webContents.executeJavaScript(`document.getElementById('workbench-button').click()`);
      await wait(win, `document.querySelectorAll('.wb-section').length>=5`);
      assert(await win.webContents.executeJavaScript(`document.querySelectorAll('.wb-checkpoint').length>=2`));
      await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.wb-checkpoint')).find(b=>b.textContent.includes('write_file')).click()`);
      await wait(win, `document.querySelector('#wb-checkpoint-detail input[type=checkbox]')!==null`);
      await win.webContents.executeJavaScript(`{const section=Array.from(document.querySelectorAll('.wb-section')).find(s=>s.querySelector('h3').textContent.includes('Ngân sách mỗi'));const inputs=section.querySelectorAll('input');inputs[0].value='500000';inputs[3].value='2';inputs[4].value='5';section.querySelector('form').requestSubmit();}`);
      await wait(win, `document.getElementById('toast').textContent.includes('Đã lưu ngân sách')`);
      const savedBudget=JSON.parse(fs.readFileSync(path.join(root,'.vibe','config.json'),'utf8'));assert.equal(savedBudget.runBudget.maxTokens,500000);assert(Object.values(savedBudget.modelRates).some(rate=>rate.inputPerMillion===2&&rate.outputPerMillion===5));
      await wait(win, `document.getElementById('wb-operations')!==null`);
      assert(await win.webContents.executeJavaScript(`document.getElementById('wb-operations').textContent.includes('Lỗi gốc và tự phục hồi') && document.querySelector('#wb-operations input[type=range]') && document.getElementById('wb-operations').textContent.includes('Nguồn skill và quyền')`));
      await win.webContents.executeJavaScript(`{const section=Array.from(document.querySelectorAll('.wb-section')).find(s=>s.querySelector('h3').textContent==='Context được giữ');section.querySelector('textarea').value='Keep the acceptance test';section.querySelector('form').requestSubmit();}`);
      await wait(win, `document.getElementById('wb-content').textContent.includes('Ghi nhớ ·')`);
      await win.webContents.executeJavaScript(`document.getElementById('workbench-dialog').close()`);
      fs.writeFileSync(path.join(root,'preview-smoke.html'),'<html><head><title>Live preview</title></head><body><h1>Preview works</h1><script>console.log("preview-smoke-ok");throw new Error("preview-smoke-error")</script></body></html>');
      await win.webContents.executeJavaScript(`document.getElementById('preview-button').click();document.getElementById('preview-entry').value='preview-smoke.html';document.getElementById('preview-form').requestSubmit()`);
      await wait(win, `document.getElementById('preview-console').textContent.includes('preview-smoke-ok') && document.getElementById('preview-console').textContent.includes('preview-smoke-error')`);
      await win.webContents.executeJavaScript(`document.getElementById('preview-mobile').click();document.getElementById('preview-inspect').click();`);
      await wait(win, `document.getElementById('preview-console').textContent.includes('horizontalOverflow')`);
      assert.equal(await win.webContents.executeJavaScript(`document.getElementById('web-preview').getBoundingClientRect().width`),320);
      await win.webContents.executeJavaScript(`document.getElementById('preview-capture').click();`);
      await wait(win, `document.getElementById('toast').textContent.includes('hash HTML')`);
      for(let attempt=0;attempt<60;attempt++){const directory=path.join(root,'.vibe','preview-snapshots');if(fs.existsSync(directory)&&fs.readdirSync(directory).some(file=>file.endsWith('.png')))break;await new Promise(resolve=>setTimeout(resolve,100));}
      assert(fs.readdirSync(path.join(root,'.vibe','preview-snapshots')).some(file=>file.endsWith('.png')));
      assert(fs.readdirSync(path.join(root,'.vibe','operations','previews')).length>=2);
      await win.webContents.executeJavaScript(`document.getElementById('preview-mobile').click();`);
      fs.writeFileSync(path.join(root,'preview-smoke.html'),'<html><head><title>Live preview update</title></head><body><script>console.log("preview-reloaded-ok")</script></body></html>');
      await wait(win, `document.getElementById('preview-console').textContent.includes('preview-reloaded-ok')`);
      await win.webContents.executeJavaScript(`document.getElementById('preview-close').click()`);
      await win.webContents.executeJavaScript(`document.getElementById('integration-button').click()`);
      await wait(win, `document.getElementById('integration-results').querySelectorAll('section').length>0`);
      await wait(win, `document.getElementById('catalog-results').querySelectorAll('section').length===24`);
      await win.webContents.executeJavaScript(`document.getElementById('catalog-query').value='frontend';document.getElementById('catalog-kind').value='skills';document.getElementById('catalog-query').dispatchEvent(new Event('input'))`);
      await wait(win, `document.getElementById('catalog-results').textContent.includes('frontend-design')`);
      await win.webContents.executeJavaScript(`document.getElementById('catalog-results').querySelector('button').click()`);
      await wait(win, `!document.getElementById('catalog-detail').hidden && document.getElementById('catalog-preview').textContent.length>100`);
      await win.webContents.executeJavaScript(`document.getElementById('catalog-role').value='coder';document.getElementById('catalog-apply').click()`);
      await wait(win, `document.getElementById('catalog-status').textContent.includes('Đã gán')`);
      assert.ok(JSON.parse(fs.readFileSync(path.join(root,'.vibe','config.json'),'utf8')).agentProfiles.coder.skills.some(id=>id.startsWith('aitmpl:skills/')));
      await win.webContents.executeJavaScript(`document.getElementById('integration-auto').click()`);
      await wait(win, `document.getElementById('integration-auto').checked && !document.getElementById('integration-auto').disabled`);
      await win.webContents.executeJavaScript(`document.getElementById('integration-auto').click()`);
      await wait(win, `!document.getElementById('integration-auto').checked && !document.getElementById('integration-auto').disabled`);
      assert.equal(JSON.parse(fs.readFileSync(path.join(root,'.vibe','config.json'),'utf8')).autoIntegrations,false);
      await win.webContents.executeJavaScript(`document.getElementById('integration-dialog').close()`);
      const bounds = await win.webContents.executeJavaScript(`({width:innerWidth, scroll:document.body.scrollWidth, node:typeof window.require, sidebar:!!document.getElementById('history').children.length})`);
      assert.equal(bounds.node, 'undefined'); assert(bounds.scroll <= bounds.width); assert(bounds.sidebar);
      fs.writeFileSync('release/smoke-result.json', JSON.stringify({ ok: true, checks: ['planner repairs malformed output with retained context', 'desktop preload', 'encrypted settings', 'seven role profiles', 'sixteen specialized agents including manager', 'teamwork executed check and independent review gate', 'saved role instructions and selected skills', 'skill search', 'skill instructions in model input', 'configurable token limits', 'chat streaming', 'previous output reused as input', 'actual input/output/cache usage', 'manual compaction', 'history restore', 'inspector', 'renderer isolation', 'two simultaneous model requests and live AI cards', 'live task DAG and dependencies', 'agent details and zoom geometry', 'renderer reconnect snapshot', 'persisted historical acceptance gate', 'reduced motion', 'responsive navigation', 'layout', 'workbench checkpoint diff and context pins', 'budget configuration with model prices', 'isolated web preview and console errors', 'automatic web file refresh'], bounds }, null, 2));
      clearTimeout(timer); model.close(); app.quit();
    } catch (error) { fs.writeFileSync('release/smoke-result.json', JSON.stringify({ ok: false, error: String(error) })); clearTimeout(timer); model.close(); app.exit(1); }
  });
});
model.listen(0, '127.0.0.1', () => require('../desktop/main.cjs'));
