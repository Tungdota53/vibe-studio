'use strict';
const $ = id => document.getElementById(id);
const credential = new URLSearchParams(location.search).get('token');
let ws, config, busy = false, currentSession = null, assistant = null, response = '', reconnectTimer, toastTimer;
let pendingSettings = null;
let currentContext = null;
let modelCapabilities = [];
let teamData = null, skillSearchTimer;
const liveAgents = new Map();
const approvalQueue = [];
let approvalsTimer;
let streamFrame, streamTimer, progressCard;
const progressRows = new Map();
function resetProgress() { clearTimeout(streamTimer); streamTimer = null; cancelAnimationFrame(streamFrame); streamFrame = null; progressCard = null; progressRows.clear(); }
function progress(event) {
  if (!event?.message && !event?.tool) return;
  if (event.sessionId && progressRows.has('run-request')) { progressRows.get('run-request').remove(); progressRows.delete('run-request'); }
  $('welcome').hidden = true;
  if (!progressCard) {
    progressCard = document.createElement('details'); progressCard.className = 'chat-progress'; progressCard.open = true;
    const summary = document.createElement('summary'); summary.textContent = 'Tiến độ thực hiện'; progressCard.append(summary, document.createElement('div')); $('messages').append(progressCard);
  }
  const id = event.id || `${event.type || 'step'}:${event.taskId || event.tool || event.message}`;
  let row = progressRows.get(id);
  if (!row) { row = document.createElement('div'); row.className = 'progress-row'; progressRows.set(id, row); progressCard.lastChild.append(row); }
  const eventType = event.eventType || event.type || '';
  row.dataset.status = event.status || (/failed|error/.test(eventType) ? 'failed' : /_end|complete/.test(eventType) ? 'completed' : 'running');
  row.replaceChildren(); const mark = document.createElement('span'); mark.className = 'progress-mark'; mark.textContent = /failed|error|blocked/.test(row.dataset.status) ? '!' : /completed|done/.test(row.dataset.status) ? '✓' : '◌';
  const text = document.createElement('span'); text.textContent = event.message || event.tool; row.append(mark, text);
  if (event.agentId) { const badge = document.createElement('small'); badge.textContent = event.agentId; row.append(badge); }
  while (progressCard.lastChild.children.length > 60) { const first = progressCard.lastChild.firstChild; for (const [key, value] of progressRows) if (value === first) progressRows.delete(key); first.remove(); }
  progressCard.firstChild.textContent = /failed|error/.test(row.dataset.status) ? 'Tiến độ · cần xử lý' : 'Tiến độ · ' + (event.message || event.tool);
  scrollEnd();
}
function flushStream(final = false) {
  clearTimeout(streamTimer); streamTimer = null; cancelAnimationFrame(streamFrame); streamFrame = null;
  if (!assistant) return;
  assistant.classList.toggle('streaming', !final); renderText(assistant, response); scrollEnd();
}
function send(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) { toast('Mất kết nối. Đang thử kết nối lại…'); return false; }
  ws.send(JSON.stringify(payload)); return true;
}
function toast(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 4500); }
function setBusy(value) {
  busy = value;
  $('send-button').hidden = value; $('stop-button').hidden = !value; $('run-status').hidden = !value;
  $('new-chat').disabled = value; $('workspace-button').disabled = value; $('mode').disabled = value;
  $('settings-form').querySelector('[type=submit]').disabled = value;
  $('compact-context').disabled = value || !currentSession;
  $('team-form').querySelector('[type=submit]').disabled = value;
  $('run-text').textContent = 'Đang xử lý…';
}
function configure(next) {
  if (config && (config.baseUrl !== next.baseUrl || config.model !== next.model)) modelCapabilities = [];
  config = next;
  if (teamData) TeamMap.configure(teamData, next.model);
  const parts = next.workspace.split(/[\\/]/).filter(Boolean);
  $('workspace-name').textContent = parts.at(-1) || next.workspace;
  $('workspace-path').textContent = next.workspace; $('workspace-button').title = next.workspace;
  $('model-name').textContent = next.model;
  $('base-url').value = next.baseUrl; $('model-input').value = next.model;
  $('context-mode').value = next.contextMode || 'auto';
  $('context-window').value = next.contextWindow || 1000000; $('output-tokens').value = next.maxOutputTokens || 4096;
  showContextCapability();
  if (!currentContext) showContext(null);
  $('api-key').placeholder = next.apiKey ? 'Đã có khóa · để trống để giữ nguyên' : 'Nhập khóa API';
  $('key-note').textContent = window.desktop ? 'Khóa được mã hóa bằng Windows và lưu trên máy của bạn.' : 'Khóa chỉ được giữ trong phiên backend hiện tại.';
}
function showContextCapability() {
  const model = $('model-input').value.trim();
  const capacity = modelCapabilities.find(item => item.id === model);
  const auto = $('context-mode').value === 'auto';
  $('context-capability-note').textContent = auto ? capacity?.contextWindow ? 'API công bố ' + formatTokens(capacity.contextWindow) + ' token; app dùng tối đa cửa sổ này cho model ' + model + '.' : 'API chưa cung cấp giới hạn context. App dùng số dự phòng đã nhập cho đến khi có metadata; số này cần khớp tài liệu nhà cung cấp.' : 'Dùng số context thủ công, không vượt khả năng thực tế của model. Đầu ra tối đa một nửa context.';
}
const formatTokens = number => new Intl.NumberFormat('vi-VN').format(number || 0);
function showContext(stats, summary) {
  currentContext = stats;
  const windowSize = stats?.window || config?.contextWindow || 1000000;
  $('context-button').textContent = stats ? `Ngữ cảnh ~${stats.percent}%` : `Ngữ cảnh ${formatTokens(windowSize)}`;
  $('context-window-value').textContent = formatTokens(windowSize);
  $('context-input-value').textContent = stats ? '~' + formatTokens(stats.estimatedInput) : 'Chưa gửi';
  $('context-budget-value').textContent = stats ? formatTokens(stats.inputBudget) : 'Chưa gửi';
  $('context-output-value').textContent = formatTokens(stats?.outputReserve || config?.maxOutputTokens || 4096);
  $('context-compactions').textContent = formatTokens(stats?.compactions);
  $('context-progress').value = stats?.percent || 0;
  const usage = stats?.usage;
  $('usage-input').textContent = (usage?.estimated ? '~' : '') + formatTokens(usage?.prompt);
  $('usage-output').textContent = (usage?.estimated ? '~' : '') + formatTokens(usage?.completion);
  $('usage-cache').textContent = formatTokens(usage?.cached);
  $('usage-note').textContent = usage?.estimated ? 'Nhà cung cấp chưa trả đủ usage. Số có dấu ~ là ước tính, không dùng để tính tiền.' : 'Vào/ra là tổng usage nhà cung cấp trả về trong phiên, bao gồm các lượt nén.';
  if (summary !== undefined) $('context-summary').textContent = summary || 'Chưa cần nén. Các lượt trò chuyện và kết quả công cụ được giữ trong ngữ cảnh.';
  $('compact-context').disabled = busy || !currentSession;
}
function selectTab(name) {
  document.querySelectorAll('[data-tab]').forEach(node => node.classList.toggle('active', node.dataset.tab === name));
  for (const tab of ['diff', 'activity', 'context']) $(tab + '-panel').hidden = tab !== name;
}
function addMessage(role, content = '') {
  $('welcome').hidden = true;
  const article = document.createElement('article'); article.className = `message ${role}`;
  const header = document.createElement('div'); header.className = 'message-header';
  const avatar = document.createElement('span'); avatar.className = 'avatar'; avatar.textContent = role === 'user' ? 'B' : 'v';
  const name = document.createElement('span'); name.textContent = role === 'user' ? 'Bạn' : 'Vibe';
  header.append(avatar, name);
  const body = document.createElement('div'); body.className = 'message-content'; body.textContent = content;
  body.dataset.raw = content;
  const copy = document.createElement('button'); copy.className = 'message-copy'; copy.type = 'button'; copy.textContent = 'Sao chép'; copy.onclick = () => ChatOutput.copy(body.dataset.raw || body.textContent, copy); header.append(copy);
  article.append(header, body); $('messages').append(article); scrollEnd(); return body;
}
function scrollEnd() { const el = $('chat-scroll'); if (el.scrollHeight - el.scrollTop - el.clientHeight < 200 || busy) el.scrollTop = el.scrollHeight; }
// Markdown is constructed as DOM nodes; model output never becomes HTML.
function renderText(target, text) { ChatOutput.render(target, text); }
function showHistory(sessions) {
  $('history').replaceChildren();
  if (!sessions.length) { const p = document.createElement('p'); p.className = 'sidebar-empty'; p.textContent = 'Ý tưởng tiếp theo bắt đầu ở đây.'; $('history').append(p); }
  for (const session of sessions) {
    const button = document.createElement('button'); button.className = session.id === currentSession ? 'active' : '';
    const icon = document.createElement('span'); icon.textContent = session.id.startsWith('chat-') ? '◌' : '◈';
    const label = document.createElement('span'); label.textContent = session.task || session.id;
    button.append(icon, label); button.title = `${session.task || session.id}\n${session.status}`;
    button.onclick = () => {
      if (busy) return toast('Hãy dừng tác vụ trước khi chuyển cuộc trò chuyện.');
      currentSession = session.id; $('chat-title').textContent = session.task || 'Cuộc trò chuyện';
      cancelAnimationFrame(streamFrame); resetProgress(); assistant = null; response = ''; $('messages').replaceChildren(); $('welcome').hidden = true; progress({id:'history-loading',message:'Đang tải cuộc trò chuyện…',status:'running'});
      send({ type: 'get_conversation', sessionId: session.id }); showHistory(sessions);
    };
    $('history').append(button);
  }
}
function showDiff(diff) {
  $('diff-output').replaceChildren();
  let added = 0, removed = 0, files = 0;
  if (!diff) { $('diff-output').textContent = 'Chưa có thay đổi Git trong thư mục này.'; }
  else for (const line of diff.split('\n')) {
    const span = document.createElement('span'); span.textContent = line + '\n';
    if (line.startsWith('diff --git')) { files++; span.className = 'diff-header'; }
    else if (line.startsWith('+') && !line.startsWith('+++')) { added++; span.className = 'diff-add'; }
    else if (line.startsWith('-') && !line.startsWith('---')) { removed++; span.className = 'diff-remove'; }
    $('diff-output').append(span);
  }
  $('change-count').textContent = files; $('diff-stats').textContent = files ? `${files} tệp · +${added} / −${removed}` : 'Chưa có thay đổi';
}
function log(text) {
  const output = $('activity-output');
  if (!output.querySelector('.activity-entry')) output.replaceChildren();
  const entry = document.createElement('div'); entry.className = 'activity-entry'; entry.textContent = text;
  output.append(entry); while (output.children.length > 300) output.firstChild.remove(); output.scrollTop = output.scrollHeight;
}
function nextApproval() {
  if (!approvalQueue.length) { $('approval-dialog').close(); return; }
  const item = approvalQueue[0];
  $('approval-command').textContent = item.command;
  $('approval-risk').textContent = `${item.tool} · ${item.riskLevel}`;
  if (!$('approval-dialog').open) $('approval-dialog').showModal();
  clearTimeout(approvalsTimer);
  approvalsTimer = setTimeout(() => { approvalQueue.shift(); nextApproval(); }, Math.max(1, item.deadline - Date.now()));
}
function answerApproval(approved) {
  const item = approvalQueue.shift(); clearTimeout(approvalsTimer);
  if (item) send({ type: 'approval_response', id: item.id, approved }); nextApproval();
}
function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/${credential ? '?token=' + encodeURIComponent(credential) : ''}`);
  ws.onopen = () => { TeamMap.connection(true); send({ type: 'get_team' }); send({type:'get_mcp'}); $('connection-dot').classList.add('online'); $('connection-text').textContent = 'Đã kết nối'; $('send-button').disabled = false; };
  ws.onclose = () => {
    TeamMap.connection(false);
    $('connection-dot').classList.remove('online'); $('connection-text').textContent = 'Đang kết nối lại'; $('send-button').disabled = true;
    setBusy(false); approvalQueue.length = 0; nextApproval();
    clearTimeout(reconnectTimer); reconnectTimer = setTimeout(connect, 2000);
  };
  ws.onerror = () => {};
  ws.onmessage = async ({ data }) => {
    let msg; try { msg = JSON.parse(data); } catch { return; }
    Workbench.event(msg);
    ProjectSetup.event(msg);
    switch (msg.type) {
      case 'team_config': showTeam(msg); if (msg.saved) { $('team-status').textContent = 'Đã lưu phân vai cho dự án.'; toast('Đã lưu phân vai và skill.'); } break;
      case 'model_catalog': modelCapabilities = msg.capabilities || []; showContextCapability(); $('available-models').replaceChildren(); for (const id of msg.models || []) { const option=document.createElement('option'); option.value=id; $('available-models').append(option); } $('team-status').textContent='Đã lấy ' + (msg.models || []).length + ' model từ API.'; break;
      case 'skill_results': showSkills(msg.skills || []); break;
      case 'init': configure(msg.config); showHistory(msg.sessions || []); showDiff(msg.diff || ''); setBusy(Boolean(msg.busy)); TeamMap.restore(msg.teamworkState); send({ type: 'get_team' }); break;
      case 'configured':
        configure(msg.config);
        if (pendingSettings && window.desktop) {
          try { const result = await window.desktop.saveSettings(pendingSettings); if (!result.keySaved) toast('Windows không hỗ trợ mã hóa. Khóa chỉ được giữ trong phiên này.'); }
          catch (error) { toast(`Đã áp dụng, nhưng không lưu được: ${error.message}`); }
        }
        pendingSettings = null; $('api-key').value = ''; $('settings-dialog').close(); toast('Đã cập nhật kết nối.'); if (currentSession) send({ type: 'get_conversation', sessionId: currentSession }); break;
      case 'sessions': showHistory(msg.sessions || []); break;
      case 'conversation':
        if (msg.sessionId !== currentSession) break;
        TeamMap.restore({ sessionId: msg.sessionId.startsWith('session-') ? msg.sessionId : null, tasks: msg.tasks || [], gate: msg.gate, pipeline: msg.pipeline, goal: $('chat-title').textContent }, true);
        resetProgress(); $('messages').replaceChildren();
        for (const item of msg.messages || []) renderText(addMessage(item.role, item.content), item.content);
        if (!msg.messages?.length) addMessage('assistant', msg.summary || 'Phiên teamwork này chưa có nội dung trò chuyện.');
        for (const event of msg.progress || []) progress(event);
        if (progressCard) progressCard.open = false;
        showContext(msg.context, msg.memorySummary);
        scrollEnd(); break;
      case 'context_stats': if (msg.sessionId === currentSession) showContext(msg.stats); break;
      case 'memory_summary': if (msg.sessionId === currentSession) $('context-summary').textContent = msg.summary || 'Chưa cần nén ngữ cảnh.'; break;
      case 'compaction_start': if (msg.sessionId === currentSession) { $('run-text').textContent = 'Đang tóm tắt ngữ cảnh cũ…'; log('Đang nén ngữ cảnh để tiếp tục cuộc trò chuyện.'); } break;
      case 'compaction_end': if (msg.sessionId === currentSession) { $('run-text').textContent = 'Đang tiếp tục…'; log(msg.skipped ? 'Giữ nguyên ngữ cảnh vì bản tóm tắt không ngắn hơn.' : `Đã nén ngữ cảnh · lần ${msg.compactions}${msg.mode === 'extractive' ? ' · dùng trích đoạn dự phòng, cần kiểm tra lại chi tiết' : ''}${msg.before != null ? ` · ${formatTokens(msg.before)} → ${formatTokens(msg.after)} token ước tính` : ''}.`); } break;
      case 'run_start': setBusy(true); break;
      case 'run_end': flushStream(true); setBusy(false); TeamMap.end(); approvalQueue.length = 0; clearTimeout(approvalsTimer); nextApproval(); send({ type: 'get_sessions' }); send({ type: 'get_diff' }); break;
      case 'stream_chunk':
        if (!assistant) assistant = addMessage('assistant'); response += msg.token || ''; if (!streamFrame && !streamTimer) streamTimer = setTimeout(() => { streamTimer = null; streamFrame = requestAnimationFrame(() => flushStream()); }, 70); break;
      case 'stream_end': flushStream(true); break;
      case 'progress_event': if (msg.sessionId === currentSession) progress(msg.event || msg); break;
      case 'chat_session': if (msg.previousSessionId === currentSession) currentSession = msg.sessionId; break;
      case 'mcp_status': showMcp(msg); break;
      case 'thinking': $('run-text').textContent = 'Đang phân tích yêu cầu…'; break;
      case 'terminal_log': log(msg.text || ''); break;
      case 'teamwork_event': TeamMap.event(msg.event); showAgent(msg.event); if (msg.event.message) log(msg.event.message); $('run-text').textContent = msg.event.message || msg.event.step || 'Nhóm đang thực hiện tác vụ…'; break;
      case 'diff': showDiff(msg.diff || ''); break;
      case 'approval_request': approvalQueue.push({ ...msg, deadline: Date.now() + msg.timeoutMs }); nextApproval(); break;
      case 'error': toast(msg.message); if ($('mcp-dialog').open) { $('mcp-status').textContent = msg.message; $('mcp-form').querySelector('[type=submit]').disabled = false; } if ($('team-dialog').open) $('team-status').textContent = msg.message; if (pendingSettings) { $('settings-status').textContent = msg.message; pendingSettings = null; } break;
    }
  };
}
function newChat() {
  if (busy) return;
  TeamMap.reset(); TeamMap.view('chat');
  resetProgress(); cancelAnimationFrame(streamFrame); currentSession = null; assistant = null; response = ''; $('messages').replaceChildren(); $('welcome').hidden = false; $('chat-title').textContent = 'Cuộc trò chuyện mới'; $('prompt').value = ''; $('prompt').focus();
  showContext(null, '');
  send({ type: 'get_sessions' });
}
$('composer').onsubmit = event => {
  event.preventDefault(); const prompt = $('prompt').value.trim(); if (!prompt || busy) return;
  if (!config?.apiKey) { $('settings-status').textContent = 'Nhập khóa API để bắt đầu.'; $('settings-dialog').showModal(); return; }
  const teamwork = $('mode').value === 'teamwork';
  if (!currentSession) currentSession = `chat-${crypto.randomUUID()}`;
  if (!send({ type: 'chat', prompt: teamwork ? `/teamwork ${prompt}` : prompt, sessionId: currentSession, mode: ['ask','plan','execute','verify','repair'].includes($('mode').value)?$('mode').value:undefined, agentId: teamwork ? undefined : $('chat-agent').value || undefined })) return;
  setBusy(true); resetProgress(); assistant = null; response = ''; addMessage('user', prompt); progress({id:'run-request',message: teamwork ? 'Đang xử lý yêu cầu cho nhóm agent…' : 'Đã nhận yêu cầu · đang kết nối model…',status:'running'}); $('chat-title').textContent = prompt.slice(0, 80); $('prompt').value = ''; $('prompt').style.height = '';
};
$('prompt').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('composer').requestSubmit(); } };
$('prompt').oninput = () => { $('prompt').style.height = 'auto'; $('prompt').style.height = `${Math.min(180, $('prompt').scrollHeight)}px`; };
$('stop-button').onclick = () => { send({ type: 'stop' }); $('run-text').textContent = 'Đang dừng…'; };
$('new-chat').onclick = newChat;
$('toggle-sidebar').onclick = () => { if (innerWidth <= 650) { $('sidebar').hidden = false; $('sidebar').classList.toggle('mobile-open'); } else $('sidebar').hidden = !$('sidebar').hidden; };
$('toggle-inspector').onclick = () => { TeamMap.view('chat'); $('inspector').hidden = !$('inspector').hidden; if (!$('inspector').hidden) send({ type: 'get_diff' }); };
$('close-inspector').onclick = () => $('inspector').hidden = true;
$('refresh-diff').onclick = () => send({ type: 'get_diff' });
$('refresh-sessions').onclick = () => send({ type: 'get_sessions' });
$('clear-log').onclick = () => $('activity-output').replaceChildren();
$('workspace-button').onclick = async () => { if (busy) return; if (!window.desktop) return toast('Chọn thư mục có sẵn trong bản desktop .exe.'); try { await window.desktop.chooseWorkspace(); } catch (error) { toast(error.message); } };
function openSettings() { $('settings-status').textContent = ''; $('settings-dialog').showModal(); }
$('settings-button').onclick = openSettings; $('model-button').onclick = openSettings;
$('settings-form').onsubmit = event => {
  event.preventDefault(); if (busy) { $('settings-status').textContent = 'Hãy dừng tác vụ trước khi đổi kết nối.'; return; }
  pendingSettings = { baseUrl: $('base-url').value.trim(), model: $('model-input').value.trim(), apiKey: $('api-key').value.trim(), contextMode: $('context-mode').value, contextWindow: Number($('context-window').value), maxOutputTokens: Number($('output-tokens').value) };
  if (!send({ type: 'configure', ...pendingSettings })) pendingSettings = null;
};
for (const button of document.querySelectorAll('[data-close]')) button.onclick = () => $(button.dataset.close).close();
for (const button of document.querySelectorAll('[data-prompt]')) button.onclick = () => { $('prompt').value = button.dataset.prompt; $('prompt').focus(); };
for (const button of document.querySelectorAll('[data-tab]')) button.onclick = () => {
  selectTab(button.dataset.tab);
};
$('context-button').onclick = () => { $('inspector').hidden = false; selectTab('context'); };
$('compact-context').onclick = () => {
  if (busy || !currentSession) return;
  assistant = null; response = '';
  if (send({ type: 'command', line: '/compact', sessionId: currentSession })) setBusy(true);
};
$('accept-approval').onclick = () => answerApproval(true); $('reject-approval').onclick = () => answerApproval(false);
$('approval-dialog').oncancel = event => { event.preventDefault(); answerApproval(false); };
if (window.desktop) { $('window-actions').hidden = false; for (const button of document.querySelectorAll('[data-window]')) button.onclick = () => window.desktop.control(button.dataset.window); }
document.addEventListener('keydown', event => { if (event.ctrlKey && event.key.toLowerCase() === 'n') { event.preventDefault(); newChat(); } if (event.ctrlKey && event.key === ',') { event.preventDefault(); openSettings(); } });
function showSkills(skills) {
  $('skill-results').replaceChildren();
  for (const skill of skills.slice(0, 20)) {
    const row = document.createElement('p');
    const name = document.createElement('strong'); name.textContent = skill.name;
      const detail = document.createElement('small'); detail.textContent = `${skill.id} · ${skill.description}${skill.recommendedRoles?.length ? '\nVai phù hợp: ' + skill.recommendedRoles.join(', ') : ''}${skill.requires?.length ? '\nCần: ' + skill.requires.join(', ') : ''}`;
    if (skill.provenance) {
      const source = document.createElement('a'); source.href = skill.provenance.url; source.target = '_blank'; source.rel = 'noopener noreferrer';
      source.textContent = `${skill.provenance.repository} · ${skill.provenance.license} · ${skill.provenance.commit.slice(0, 8)} · ${skill.provenance.integrity ? 'Checksum khớp' : 'Checksum không khớp'}`;
      row.append(source);
    }
    row.append(name, detail); $('skill-results').append(row);
  }
  if (!skills.length) $('skill-results').textContent = 'Không tìm thấy skill phù hợp.';
}
function showTeam(data) {
  TeamMap.configure(data, config?.model);
  teamData = data; $('team-max').value = data.maxAgents; $('agent-iterations').value = data.maxAgentIterations ?? 0; $('agent-tools').value = data.maxAgentToolCalls ?? 0;
  showNamedAgents(data);
  const previousRole = $('role-picker').value || 'coder';
  $('role-picker').replaceChildren();
  for (const role of data.roles) { const option = document.createElement('option'); option.value = role.id; option.textContent = `${role.label} · ${role.id}`; $('role-picker').append(option); }
  $('role-picker').value = previousRole;
  $('role-cards').replaceChildren();
  for (const role of data.roles) {
    const card = document.createElement('section'); card.className = 'role-card'; card.dataset.role = role.id; card.hidden = role.id !== previousRole;
    const title = document.createElement('h3'); title.textContent = `${role.label} · ${role.id}`;
    const description = document.createElement('p'); description.textContent = role.responsibility;
    const access = document.createElement('small'); access.textContent = role.readOnly ? 'Công cụ chỉ đọc' : role.id === 'tester' ? 'Chạy kiểm thử/lệnh; chặn công cụ sửa tệp' : 'Đọc, sửa và chạy lệnh trong workspace';
    const modelLabel = document.createElement('label'); modelLabel.className = 'field'; modelLabel.textContent = 'Model riêng';
    const model = document.createElement('input'); model.dataset.field = 'model'; model.value = role.model || ''; model.placeholder = 'Dùng model mặc định'; modelLabel.append(model);
    const instructionsLabel = document.createElement('label'); instructionsLabel.className = 'field'; instructionsLabel.textContent = 'Hướng dẫn cho vai';
    const instructions = document.createElement('textarea'); instructions.dataset.field = 'instructions'; instructions.value = role.instructions; instructions.maxLength = 6000; instructions.rows = 2; instructionsLabel.append(instructions);
    const autoLabel = document.createElement('label'); autoLabel.className = 'skill-option';
    const auto = document.createElement('input'); auto.type = 'checkbox'; auto.dataset.field = 'autoSkills'; auto.checked = role.autoSkills; autoLabel.append(auto, document.createTextNode('Tự nạp skill theo vai và nhiệm vụ (GitHub đã kiểm tra nguồn + dự án)'));
    const choices = document.createElement('div'); choices.className = 'skill-choices';
    for (const skill of [...data.skills].sort((a, b) => Number(b.source === 'builtin') - Number(a.source === 'builtin'))) {
      const label = document.createElement('label'); label.className = 'skill-option'; label.title = skill.description;
      const input = document.createElement('input'); input.type = 'checkbox'; input.dataset.skill = skill.id; input.checked = role.skills.includes(skill.id) || role.skills.includes(skill.name);
      label.append(input, document.createTextNode(`${skill.name} · ${skill.source}`)); choices.append(label);
    }
    card.append(title, description, access, modelLabel, instructionsLabel, autoLabel, choices); $('role-cards').append(card);
  }
  showSkills(data.skills);
  if ($('skill-search').value.trim()) send({ type: 'search_skills', query: $('skill-search').value });
}
function showAgent(event) {
  if (event.type === 'session_start') { liveAgents.clear(); $('live-agents').replaceChildren(); }
  if (!event.agentId) return;
  const state = { ...liveAgents.get(event.agentId), ...event }; liveAgents.set(event.agentId, state);
  $('live-agents').replaceChildren();
  for (const [id, agent] of liveAgents) {
    const row = document.createElement('p'); row.textContent = `${agent.agentName || id} · ${agent.role} · ${agent.status || agent.type}\n${agent.taskId || ''} ${agent.model || ''} · ${agent.phase || ''}\nSkill: ${(agent.skills || []).join(', ') || 'Đang chọn'}`;
    $('live-agents').append(row);
  }
}
$('team-button').onclick = () => { $('team-status').textContent = ''; $('team-dialog').showModal(); send({ type: 'get_team' }); };
$('role-picker').onchange = () => { for (const card of $('role-cards').children) card.hidden = card.dataset.role !== $('role-picker').value; };
$('skill-search').oninput = () => { clearTimeout(skillSearchTimer); skillSearchTimer = setTimeout(() => send({ type: 'search_skills', query: $('skill-search').value }), 200); };
$('team-form').onsubmit = event => {
  event.preventDefault(); if (busy) return toast('Hãy dừng tác vụ trước khi đổi phân vai.');
  const profiles = {};
  for (const card of $('role-cards').children) profiles[card.dataset.role] = {
    model: card.querySelector('[data-field=model]').value.trim(), instructions: card.querySelector('[data-field=instructions]').value,
    autoSkills: card.querySelector('[data-field=autoSkills]').checked,
    skills: [...card.querySelectorAll('[data-skill]:checked')].map(node => node.dataset.skill)
  };
  const namedAgents = [...$('named-agent-cards').children].map(card => ({
    id: card.dataset.agent, name: card.querySelector('[data-field=name]').value.trim(), role: card.querySelector('[data-field=role]').value,
    model: card.querySelector('[data-field=model]').value.trim(), enabled: card.querySelector('[data-field=enabled]').checked,
    instructions: card.querySelector('[data-field=instructions]').value,
    skills: [...card.querySelectorAll('[data-skill]:checked')].map(input => input.dataset.skill)
  }));
  send({ type: 'configure_team', profiles, namedAgents, maxAgents: Number($('team-max').value), maxAgentIterations: Number($('agent-iterations').value), maxAgentToolCalls: Number($('agent-tools').value) });
};
function namedAgentCard(agent, data) {
  const card = document.createElement('details'); card.className = 'named-agent-card'; card.dataset.agent = agent.id;
  const summary = document.createElement('summary'); summary.textContent = `${agent.name} · ${agent.role} · ${agent.model || 'Model theo vai'}`; card.append(summary);
  const fields = document.createElement('div'); fields.className = 'named-agent-fields';
  for (const [key, label, type] of [['name', 'Tên agent', 'input'], ['role', 'Vai trò', 'select'], ['model', 'Model riêng', 'input'], ['instructions', 'Hướng dẫn riêng', 'textarea']]) {
    const field = document.createElement('label'); field.className = 'field'; field.textContent = label;
    const input = document.createElement(type); input.dataset.field = key;
    if (key === 'role') for (const role of data.roles) { const option = document.createElement('option'); option.value = role.id; option.textContent = role.label; input.append(option); }
    input.value = agent[key] || ''; if (key === 'name') input.required = true;
    if (key === 'model') { input.setAttribute('list', 'available-models'); input.placeholder = 'Nhập hoặc chọn model từ API'; }
    field.append(input); fields.append(field);
  }
  const enabledLabel = document.createElement('label'); enabledLabel.className = 'skill-option';
  const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.dataset.field = 'enabled'; enabled.checked = agent.enabled; enabledLabel.append(enabled, document.createTextNode('Cho phép phân công tác vụ')); fields.append(enabledLabel);
  const skills = document.createElement('div'); skills.className = 'skill-choices';
  for (const skill of data.skills.filter(skill => skill.source === 'github' || (agent.skills || []).includes(skill.id))) {
    const label = document.createElement('label'); label.className = 'skill-option'; const input = document.createElement('input'); input.type = 'checkbox'; input.dataset.skill = skill.id; input.checked = (agent.skills || []).includes(skill.id);
    label.append(input, document.createTextNode(skill.name)); skills.append(label);
  }
  fields.append(skills);
  const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'quiet-button'; remove.textContent = 'Xóa agent'; remove.onclick = () => card.remove(); fields.append(remove);
  card.append(fields); return card;
}
function showNamedAgents(data) {
  const selected = $('chat-agent').value; $('chat-agent').replaceChildren();
  const defaultOption = document.createElement('option'); defaultOption.value = ''; defaultOption.textContent = 'Trợ lý mặc định'; $('chat-agent').append(defaultOption);
  $('named-agent-cards').replaceChildren();
  for (const agent of data.namedAgents || []) {
    $('named-agent-cards').append(namedAgentCard(agent, data));
    if (agent.enabled) { const option = document.createElement('option'); option.value = agent.id; option.textContent = agent.name; $('chat-agent').append(option); }
  }
  $('chat-agent').value = [...$('chat-agent').options].some(option => option.value === selected) ? selected : '';
}
$('add-agent').onclick = () => { if (!teamData || busy) return; const card = namedAgentCard({ id: 'agent-' + crypto.randomUUID().slice(0, 8), name: 'Agent mới', role: 'coder', model: '', instructions: '', skills: [], enabled: true }, teamData); card.open = true; $('named-agent-cards').append(card); };
  $('add-specialists').onclick = () => {
    if (!teamData || busy) return;
    const existing = new Set([...$('named-agent-cards').children].map(card => card.dataset.agent));
    for (const preset of teamData.presets || []) if (!existing.has(preset.id)) $('named-agent-cards').append(namedAgentCard(preset, teamData));
    $('team-status').textContent = 'Đã thêm agent chuyên môn còn thiếu. Chọn model rồi lưu phân vai.';
  };
$('fetch-models').onclick = () => send({ type: 'get_models' });
$('context-mode').onchange = showContextCapability;
$('model-input').oninput = showContextCapability;
function mcpCard(server = {}) {
  const card = document.createElement('section'); card.className = 'mcp-card'; card.dataset.id = server.id || 'server-' + crypto.randomUUID().slice(0, 8);
  const head = document.createElement('div'); head.className = 'mcp-card-head';
  const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.checked = server.enabled !== false; enabled.dataset.field = 'enabled'; enabled.setAttribute('aria-label', 'Bật server');
  const title = document.createElement('strong'); title.textContent = card.dataset.id;
  const state = document.createElement('span'); state.className = 'mcp-state'; state.dataset.status = server.status || 'configured'; state.textContent = `${server.status || 'Chưa kết nối'} · ${server.toolCount || 0} công cụ`;
  const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'icon-button'; remove.textContent = '×'; remove.setAttribute('aria-label', 'Xóa server'); remove.onclick = () => card.remove(); head.append(enabled, title, state, remove); card.append(head);
  const field = (name, label, value, type = 'text') => { const el = document.createElement('label'); el.className = 'field'; el.append(document.createTextNode(label)); const input = document.createElement('input'); input.type = type; input.dataset.field = name; input.value = value || ''; el.append(input); card.append(el); return el; };
  const transportLabel = document.createElement('label'); transportLabel.className = 'field'; transportLabel.textContent = 'Loại kết nối'; const transport = document.createElement('select'); transport.dataset.field = 'transport'; for (const [value, name] of [['http','HTTP'],['stdio','Stdio']]) { const option = document.createElement('option'); option.value = value; option.textContent = name; transport.append(option); } transport.value = server.transport || 'http'; transportLabel.append(transport); card.append(transportLabel);
  const url = field('url', 'URL server', server.url, 'url'); url.querySelector('input').placeholder = 'https://server.example/mcp';
  const command = field('command', 'Chương trình', server.command); command.querySelector('input').placeholder = 'npx hoặc đường dẫn executable';
  const args = field('args', 'Tham số (mảng JSON)', JSON.stringify(server.args || []));
  if (server.hasSensitiveArgs) { args.querySelector('input').value = ''; args.querySelector('input').placeholder = 'Đã lưu tham số bảo mật · để trống để giữ'; card.dataset.secretArgs = 'true'; }
  const env = field('env', server.hasEnv ? 'Biến môi trường JSON (đã lưu · để trống để giữ)' : 'Biến môi trường JSON (tùy chọn)', '', 'password');
  const token = field('token', server.hasHeaders ? 'Bearer token (đã lưu · để trống để giữ)' : 'Bearer token (tùy chọn)', '', 'password'); token.querySelector('input').autocomplete = 'off';
  const toggle = () => { url.hidden = token.hidden = transport.value !== 'http'; command.hidden = args.hidden = env.hidden = transport.value !== 'stdio'; }; transport.onchange = toggle; toggle();
  if (server.error) { const error = document.createElement('p'); error.className = 'mcp-error'; error.textContent = server.error; card.append(error); }
  return card;
}
function showMcp(msg) {
  $('mcp-servers').replaceChildren(...(msg.servers || []).map(mcpCard));
  $('mcp-count').textContent = (msg.servers || []).filter(server => server.status === 'connected').length;
  $('mcp-status').textContent = msg.saved ? 'Đã lưu cấu hình. Công cụ MCP sẵn sàng cho tác vụ tiếp theo.' : 'Bật server cần dùng rồi lưu để kết nối.';
  $('mcp-form').querySelector('[type=submit]').disabled = false;
}
$('mcp-button').onclick = () => { $('mcp-dialog').showModal(); send({type:'get_mcp'}); };
$('mcp-add').onclick = () => $('mcp-servers').append(mcpCard());
$('mcp-form').onsubmit = event => {
  event.preventDefault(); if (busy) { $('mcp-status').textContent = 'Dừng tác vụ trước khi thay đổi MCP.'; return; }
  try {
    const servers = {};
    for (const card of $('mcp-servers').children) {
      const value = name => card.querySelector(`[data-field="${name}"]`).value.trim();
      const transport = value('transport'), entry = { enabled: card.querySelector('[data-field="enabled"]').checked, transport };
      if (transport === 'http') { entry.url = value('url'); if (value('token')) entry.headers = { Authorization: 'Bearer ' + value('token') }; }
      else {
        entry.command = value('command');
        if (value('args') || card.dataset.secretArgs !== 'true') { entry.args = JSON.parse(value('args') || '[]'); if (!Array.isArray(entry.args) || entry.args.some(arg => typeof arg !== 'string')) throw new Error('Tham số phải là mảng các chuỗi JSON.'); }
        if (value('env')) { entry.env = JSON.parse(value('env')); if (!entry.env || typeof entry.env !== 'object' || Array.isArray(entry.env) || Object.values(entry.env).some(item => typeof item !== 'string')) throw new Error('Biến môi trường phải là object JSON với giá trị chuỗi.'); }
      }
      servers[card.dataset.id] = entry;
    }
    if (send({type:'configure_mcp',servers})) { $('mcp-status').textContent = 'Đang kết nối các server…'; $('mcp-form').querySelector('[type=submit]').disabled = true; }
  } catch (error) { $('mcp-status').textContent = error.message; }
};
Workbench.init({send,toast,config:()=>config,busy:()=>busy,session:()=>currentSession,ensureSession:()=>{if(!currentSession)currentSession=`chat-${crypto.randomUUID()}`;},resume:()=>{assistant=null;response='';send({type:'resume_chat',sessionId:currentSession});}});
ProjectSetup.init({send});
connect();
