'use strict';
// All labels from agents are rendered as text, never as HTML.
window.TeamMap = (() => {
  const get = id => document.getElementById(id);
  const phases = ['survey','specification','test_design','implementation','verification','review','challenge','audit','acceptance'];
  const phaseLabels = ['Khảo sát','Đặc tả','Viết test','Triển khai','Kiểm thử','Review','Phản biện','Audit','Nghiệm thu'];
  const statusLabels = { idle:'Theo dõi', pending:'Chờ phân công', ready:'Sẵn sàng', running:'Đang chạy', completed:'Hoàn tất', failed:'Lỗi', blocked:'Bị chặn', cancelled:'Đã dừng', interrupted:'Dở dang' };
  const roleIcons = { orchestrator:'◈',planner:'⌘',coder:'⌨',tester:'◎',reviewer:'◇',judge:'✦',general:'◌' };
  const stepLabels = { model_request:'Đang chờ model', user:'Nhận nhiệm vụ',assistant:'Tổng hợp kết quả',read_file:'Đọc tệp',write_file:'Ghi tệp',edit_file:'Sửa tệp',search_files:'Tìm trong dự án',run_command:'Chạy lệnh',run_tests:'Chạy kiểm thử',git_diff:'Đọc thay đổi',load_skill:'Nạp skill',read_skill_resource:'Đọc tài nguyên skill' };
  const stepText = value => value?.startsWith('Finished ') ? 'Xong · ' + (stepLabels[value.slice(9)] || value.slice(9)) : stepLabels[value] || value;
  stepLabels.management='Quản lý đang phân công';stepLabels.command_queue='Chờ quyền build/test · không gọi model';
  const fallbackPhase = { planner:'survey',coder:'implementation',tester:'verification',reviewer:'review',judge:'acceptance',general:'survey' };
  let tasks = [], roster = [], live = new Map(), selected = null, zoom = 1, width = 800, height = 400, diagram = 'agents', maxAgents = 4, roleModels = {}, defaultModel = '';
  let session = null, running = false, connected = true, follow = true, goal = '', gate = null, rendering = 0, planner = null, pipeline = null;
  const node = (tag, className, text) => { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; };
  const svgNode = (tag, attributes) => { const el = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [key,value] of Object.entries(attributes)) el.setAttribute(key, String(value)); return el; };
  const phaseOf = task => task.phase || fallbackPhase[task.role] || 'survey';
  const activeTask = task => { const state = { ...task, ...(live.get(task.id) || {}) }; if (state.status === 'running' && state.lastProgressAt) { const idle = Math.max(0,Math.floor((Date.now() - Date.parse(state.lastProgressAt)) / 1000)); if (idle >= 90) state.step = `Chờ ${idle}s · ${stepText(state.step) || 'kết quả'} · chưa có tiến độ mới`; } return state; };
  const agentFor = task => roster.find(agent => agent.id === (task.configuredAgentId || task.agentId));
  const titleFor = task => task.agentName || agentFor(task)?.name || task.role || 'Agent';
  const modelFor = task => task.model || agentFor(task)?.model || roleModels[task.role] || defaultModel || 'Theo cấu hình';
  const displayTasks = () => {const workers=tasks.length ? tasks.map(activeTask) : planner ? [{ ...planner, id:'planning', title:'Phân tích yêu cầu & phân công', phase:'survey', dependencies:[], status:planner.status === 'idle' ? 'completed' : planner.status, assignedAgentId:planner.agentId }] : [];return pipeline?.manager?[{id:'team-manager',title:pipeline.manager.summary||'Điều hành team và gọi agent cần thiết',agentName:'Team Manager',assignedAgentId:'agent-manager',role:'orchestrator',phase:'survey',dependencies:[],model:pipeline.manager.model,status:pipeline.manager.status==='running'?'running':pipeline.manager.status==='failed'?'failed':'idle',step:'management'},...workers]:workers;};
  function viewDiagram(value) {
    diagram = value;
    get('map-agent-grid').hidden = value !== 'agents';
    get('map-mode-agents').classList.toggle('active', value === 'agents'); get('map-mode-dag').classList.toggle('active', value === 'dag');
    get('map-mode-agents').setAttribute('aria-pressed',String(value === 'agents')); get('map-mode-dag').setAttribute('aria-pressed',String(value === 'dag'));
    get('map-zoom-in').disabled = get('map-zoom-out').disabled = value !== 'dag'; schedule();
  }
  function view(name) {
    const map = name === 'team'; document.body.dataset.view = name;
    get('team-map-view').hidden = !map;
    for (const id of ['view-chat','view-team']) { const active = id === 'view-' + name; get(id).classList.toggle('active', active); get(id).setAttribute('aria-pressed', String(active)); }
    if (map) { get('inspector').hidden = true; schedule(); }
  }
  function scale() {
    get('map-canvas').style.transform = `scale(${zoom})`;
    get('map-canvas-shell').style.width = `${width * zoom}px`; get('map-canvas-shell').style.height = `${height * zoom}px`;
    get('map-zoom-value').textContent = `${Math.round(zoom * 100)}%`;
  }
  const scrollBehavior = () => matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';
  function fit() { zoom = Math.max(.35, Math.min(1.2, (get('map-viewport').clientWidth - 56) / width)); scale(); get('map-viewport').scrollTo({ left:0, top:0, behavior:scrollBehavior() }); }
  function schedule() { if (!rendering) rendering = requestAnimationFrame(() => { rendering = 0; render(); }); }
  function render() {
    const all = displayTasks(), counts = {};
    for (const task of all.filter(task=>task.id!=='team-manager')) counts[task.status] = (counts[task.status] || 0) + 1;
    get('map-total').textContent = all.filter(task=>task.id!=='team-manager').length;
    get('map-running').textContent = `${counts.running || 0}/${maxAgents}`;
    get('map-completed').textContent = counts.completed || 0;
    get('map-failed').textContent = (counts.failed || 0) + (counts.blocked || 0) + (counts.interrupted || 0);
    get('map-gate').textContent = gate?.verdict || (running ? 'Đang đánh giá' : session ? 'Chưa xác minh' : 'Chưa chạy');
    get('map-gate').dataset.verdict = gate?.verdict || '';
    get('team-running-badge').hidden = !counts.running; get('team-running-badge').textContent = counts.running || 0;
    get('map-live-dot').classList.toggle('is-live', running && connected);
    get('map-session-label').textContent = !connected && running ? 'Mất kết nối · đang thử lại' : running ? 'Team đang hoạt động' : session ? 'Phiên Teamwork' : 'Team của bạn';
    get('map-goal').textContent = goal || 'Theo dõi cách team biến yêu cầu thành kết quả.';
    const monitor = get('map-pipeline-status');
    monitor.textContent = pipeline ? `${pipeline.total || all.length} task · cao điểm ${pipeline.peakConcurrency || 0}/${pipeline.maxAgents || maxAgents} agent song song · ${pipeline.toolCalls || 0} lượt công cụ · ${pipeline.successfulChecks || 0} kiểm tra đạt${pipeline.failedChecks ? ` · ${pipeline.failedChecks} kiểm tra lỗi` : ''}${pipeline.environmentWarnings ? ` · ${pipeline.environmentWarnings} lưu ý môi trường/công cụ` : ''} · ${pipeline.repairs?.length || 0} vòng tự sửa · ${pipeline.diagnostics?.length || 0} lưu ý kế hoạch · ${Math.floor((pipeline.elapsedMs || 0) / 1000)} giây · Bấm để xem` : 'Pipeline lưu lượt chạy, agent song song, kiểm tra và vòng sửa.';
    monitor.dataset.state = pipeline?.status === 'completed' && pipeline?.gate?.verdict === 'PASS' ? 'passed' : pipeline?.status === 'failed' || pipeline?.status === 'cancelled' || pipeline?.gate?.verdict === 'FAIL' ? 'failed' : pipeline?.status === 'running' ? 'active' : '';
    const report = get('map-pipeline-details'); report.replaceChildren();
    if (pipeline) {
      if(pipeline.manager)report.append(node('p','pipeline-note',`Team Manager · ${pipeline.manager.status||'chờ'} · ${pipeline.manager.revision||0} quyết định · ${pipeline.manager.summary||'Theo dõi kế hoạch'}${pipeline.manager.error?' · '+pipeline.manager.error:''}`));
      report.append(node('p','pipeline-detail-heading',`Pipeline ${pipeline.status} · lần lưu ${pipeline.sequence || 0} · đỉnh ${pipeline.peakConcurrency || 0}/${pipeline.maxAgents || maxAgents} slot · ${pipeline.attempts || 0} lượt agent · ${pipeline.toolCalls || 0} công cụ · ${pipeline.elapsedMs || 0} ms`));
      if (pipeline.execution?.failures?.length) { report.append(node('strong','pipeline-group-title','Lỗi gốc cần xử lý')); for (const failure of pipeline.execution.failures) report.append(node('p','pipeline-note',`${failure.taskId} · ${failure.error}`)); }
      if (pipeline.execution?.blocked?.length) { report.append(node('strong','pipeline-group-title','Tác vụ bị chặn theo phụ thuộc')); for (const blocked of pipeline.execution.blocked) report.append(node('p','pipeline-note',`${blocked.taskId} ← ${(blocked.blockedBy?.length ? blocked.blockedBy : blocked.dependencies).join(', ')}`)); }
      if (pipeline.diagnostics?.length) { report.append(node('strong','pipeline-group-title','Kế hoạch cần chú ý')); for (const issue of pipeline.diagnostics) report.append(node('p','pipeline-note',`${issue.taskId} · ${issue.message}`)); }
      if (pipeline.repairs?.length) { report.append(node('strong','pipeline-group-title','Lịch sử sửa lỗi')); for (const repair of pipeline.repairs) report.append(node('p','pipeline-note',`Vòng ${repair.round} · ${repair.taskId} · ${repair.findings.join(' | ')}`)); }
      if (pipeline.tasks?.length) { report.append(node('strong','pipeline-group-title','Tiêu chí và kiểm tra')); for (const task of pipeline.tasks.filter(item => item.criteria?.length || item.requiredCommands?.length)) report.append(node('p','pipeline-note',`${task.id} · ${(task.criteria || []).join(' / ') || 'Chưa khai báo tiêu chí'} · ${task.evidence?.requiredPassed ?? (task.requiredCommands || []).filter(command => task.evidence?.checks?.some(check => check.exitCode === 0 && check.command.trim() === command.trim())).length}/${(task.requiredCommands || []).length} lệnh bắt buộc đã đạt`)); }
      if (!pipeline.diagnostics?.length && !pipeline.repairs?.length) report.append(node('p','pipeline-note','Không có lưu ý lập kế hoạch hoặc vòng sửa tự động.'));
    }
    get('map-summary').textContent = gate ? `${gate.verdict} · ${(gate.reasons || []).join(' · ') || 'Đã tổng hợp gate nghiệm thu.'}` : session ? `${session} · ${counts.completed || 0}/${all.length} tác vụ hoàn tất` : 'Sơ đồ hiển thị dữ liệu thật từ phiên Teamwork.';
    renderFleet(all);
    get('map-phases').replaceChildren();
    phases.forEach((phase,index) => {
      const group = all.filter(task => phaseOf(task) === phase), active = group.some(task => task.status === 'running');
      const chip = node('span', 'phase-chip' + (active ? ' active' : group.length && group.every(task => task.status === 'completed') ? ' done' : ''));
      chip.append(node('b','',String(index + 1).padStart(2,'0')), document.createTextNode(phaseLabels[index])); get('map-phases').append(chip);
    });
    get('map-empty').hidden = all.length > 0; get('map-canvas-shell').hidden = !all.length || diagram !== 'dag'; get('map-agent-grid').hidden = !all.length || diagram !== 'agents';
    if (!all.length) { renderRoster(); if (running) get('map-session-label').textContent = 'Planner đang lên kế hoạch…'; renderDetails(); return; }
    // Topological layers keep dependency edges meaningful even when a phase repeats for repair.
    const byId = new Map(all.map(task => [task.id,task])), levels = new Map();
    function level(task, seen = new Set()) {
      if (levels.has(task.id)) return levels.get(task.id);
      if (seen.has(task.id)) return 0;
      const next = new Set(seen); next.add(task.id);
      const value = Math.min(48, Math.max(0, ...(task.dependencies || []).filter(id => byId.has(id)).map(id => level(byId.get(id),next) + 1)));
      levels.set(task.id,value); return value;
    }
    const columns = new Map(); all.forEach(task => { const col = level(task); if (!columns.has(col)) columns.set(col,[]); columns.get(col).push(task); });
    width = Math.max(800, columns.size * 292 + 64); height = Math.max(350, Math.max(...[...columns.values()].map(group => group.length)) * 154 + 100);
    const positions = new Map(); for (const [col,group] of columns) group.forEach((task,row) => positions.set(task.id, { x:32 + col*292, y:62 + row*154 }));
    const nodes = get('map-nodes'); const existing = new Map([...nodes.querySelectorAll('.agent-node')].map(el => [el.dataset.task,el]));
    for (const old of existing.values()) if (!byId.has(old.dataset.task)) old.remove();
    for (const task of all) {
      let card = existing.get(task.id);
      if (!card) { card = node('button','agent-node'); card.type = 'button'; card.dataset.task = task.id; card.onclick = () => { selected = task.id; schedule(); }; nodes.append(card); }
      const pos = positions.get(task.id); card.style.left = `${pos.x}px`; card.style.top = `${pos.y}px`;
      card.className = `agent-node ${task.status || 'pending'}${selected === task.id ? ' selected' : ''}`; card.setAttribute('aria-pressed', String(selected === task.id));
      card.replaceChildren();
      const top = node('div','node-top'); top.append(node('span','node-avatar',roleIcons[task.role] || '◌'), node('strong','node-name',titleFor(task)), node('span','node-status',statusLabels[task.status] || task.status));
      card.append(top,node('p','node-title',task.title || task.id));
      card.append(node('p','node-model',`AI · ${modelFor(task)}`));
      const bottom = node('div','node-bottom'); bottom.append(node('span','',task.id),node('span','',phaseLabels[phases.indexOf(phaseOf(task))] || phaseOf(task)),node('span','node-step',stepText(task.step) || (task.status === 'running' ? 'Đang thực hiện…' : task.retries ? `Lần thử ${task.retries + 1}` : ''))); card.append(bottom);
      card.setAttribute('aria-label', `${titleFor(task)}: ${task.title || task.id}, ${statusLabels[task.status] || task.status}`);
    }
    const edges = get('map-edges'); edges.replaceChildren(); edges.setAttribute('width',width); edges.setAttribute('height',height);
    const defs = svgNode('defs',{}), marker = svgNode('marker',{id:'map-arrow',viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:5,markerHeight:5,orient:'auto-start-reverse'});
    marker.append(svgNode('path',{d:'M 0 0 L 10 5 L 0 10 z',fill:'#607486'})); defs.append(marker); edges.append(defs);
    for (const task of all) for (const dep of task.dependencies || []) {
      const from = positions.get(dep), to = positions.get(task.id); if (!from || !to) continue;
      const x = from.x + 254, y = from.y + 59, tx = to.x - 6, ty = to.y + 59, mid = (x + tx)/2;
      const d = `M ${x} ${y} C ${mid} ${y}, ${mid} ${ty}, ${tx} ${ty}`;
      const linked = selected === dep || selected === task.id;
      edges.append(svgNode('path',{d,class:`map-edge${linked ? ' selected' : ''}`, 'marker-end':'url(#map-arrow)'}));
      if (task.status === 'running') edges.append(svgNode('path',{d,class:'map-edge-flow'}));
    }
    scale(); renderDetails();
    if (follow && diagram === 'dag' && document.body.dataset.view === 'team') {
      const current = all.find(task => task.status === 'running');
      if (current && get('map-viewport').dataset.following !== current.id) { get('map-viewport').dataset.following = current.id; const pos = positions.get(current.id); get('map-viewport').scrollTo({left:Math.max(0,pos.x*zoom - 60),top:Math.max(0,pos.y*zoom - 60),behavior:scrollBehavior()}); }
    }
  }
  function renderFleet(all) {
    const target = get('map-agent-grid'), active = all.filter(task => task.status === 'running');
    get('map-active-ais').replaceChildren();
    if (!active.length) get('map-active-ais').append(node('span','active-ai-empty',running ? 'Đang điều phối / chờ điều kiện chạy' : 'Không có AI đang chạy'));
    for (const task of active) { const tag = node('button','active-ai-pill'); tag.type = 'button'; tag.append(node('i',''),node('strong','',titleFor(task)),node('span','',modelFor(task)),node('small','',task.id)); tag.onclick = () => { selected = task.id; schedule(); }; get('map-active-ais').append(tag); }
    const order = {running:0,ready:1,pending:2,failed:3,blocked:3,completed:4,cancelled:5};
    const sorted = [...all].sort((a,b) => (order[a.status] ?? 5) - (order[b.status] ?? 5));
    const existing = new Map([...target.children].map(el => [el.dataset.task,el]));
    for (const old of existing.values()) if (!all.some(task => task.id === old.dataset.task)) old.remove();
    for (const task of sorted) {
      let card = existing.get(task.id);
      if (!card) { card = node('button','fleet-card'); card.type = 'button'; card.dataset.task = task.id; card.onclick = () => { selected = task.id; schedule(); }; }
      card.className = `fleet-card ${task.status}${selected === task.id ? ' selected' : ''}`; card.setAttribute('aria-pressed',String(selected === task.id)); card.replaceChildren();
      const top = node('div','fleet-card-top'); top.append(node('span','fleet-avatar',roleIcons[task.role] || '◌'),node('strong','',titleFor(task)),node('span','fleet-status',statusLabels[task.status] || task.status));
      card.append(top,node('p','fleet-model',`AI · ${modelFor(task)}`),node('h3','fleet-title',task.title || task.id));
      const state = task.status === 'running' ? stepText(task.step) || 'Đang thực hiện nhiệm vụ' : task.waitReason || (task.status === 'completed' ? 'Đã bàn giao kết quả' : task.error || 'Chưa phân công');
      card.append(node('p','fleet-step',state));
      const foot = node('div','fleet-foot'); foot.append(node('span','',task.id),node('span','',`${(task.skills || task.loadedSkills || []).length} skill`),node('span','',task.assignedAgentId || 'Chờ tạo agent')); card.append(foot);
      if (task.status === 'running') card.append(node('div','fleet-running-bar'));
      target.append(card);
    }
  }
  function renderRoster() {
    const target = get('map-roster'); target.replaceChildren();
    for (const agent of roster.filter(agent => agent.enabled)) { const item = node('span','roster-item'); item.append(node('b','',roleIcons[agent.role] || '◌'),document.createTextNode(agent.name)); target.append(item); }
  }
  function renderDetails() {
    const task = displayTasks().find(task => task.id === selected); if (!task) return;
    const state = activeTask(task), agent = agentFor(state), target = get('map-detail-content'); target.replaceChildren();
    const idle=state.lastProgressAt?Math.max(0,Math.floor((Date.now()-Date.parse(state.lastProgressAt))/1000)):null;
    if(idle!==null&&state.status==='running')target.append(node('p','muted',`${idle}s từ hoạt động thực tế gần nhất`));
    target.append(node('p','muted',`Tiếp theo: ${task.status==='running'?'Chờ kết quả bước hiện tại; kiểm tra bằng chứng trước khi bàn giao':task.waitReason||tasks.filter(item=>item.dependencies?.includes(task.id)&&item.status!=='completed').map(item=>item.title).join(' · ')||'Tổng hợp kết quả nghiệm thu'}`));
    target.append(node('p','eyebrow','AGENT / ' + task.id),node('h2','detail-agent-name',titleFor(state)),node('span','detail-status ' + state.status,statusLabels[state.status] || state.status),node('h3','detail-task-title',task.title || task.id));
    const facts = node('dl','detail-facts');
    for (const [key,value] of [['Vai trò',task.role],['AI / Model',modelFor(state)],['Agent ID',task.assignedAgentId || 'Chưa tạo'],['Pha',phaseLabels[phases.indexOf(phaseOf(task))] || phaseOf(task)],['Tiến độ gần nhất',state.lastProgressAt ? new Date(state.lastProgressAt).toLocaleTimeString('vi-VN') : 'Chưa có'],['Lần thử',String((task.retries || 0) + 1)],['Trạng thái',state.waitReason || stepText(state.step) || state.message || 'Chưa có cập nhật']]) { facts.append(node('dt','',key),node('dd','',value)); }
    target.append(facts);
    for (const [label,values] of [['Skill',state.skills || task.loadedSkills || []],['Phụ thuộc',task.dependencies || []],['Tệp được giao',task.expectedFiles || []],['Tệp đã đổi qua checkpoint',task.changedFiles || []]]) { target.append(node('h4','',label)); const chips = node('div','detail-chips'); for (const value of values) chips.append(node('span','',value)); if (!values.length) chips.append(node('small','muted','Chưa có')); target.append(chips); }
    const evidence = pipeline?.tasks?.find(item => item.id === task.id)?.evidence;
    if (task.acceptanceCriteria?.length) { target.append(node('h4','','Tiêu chí nghiệm thu')); for (const item of task.acceptanceCriteria) target.append(node('p','pipeline-note',item)); }
    if (task.verificationCommands?.length || evidence?.checks?.length) { target.append(node('h4','','Bằng chứng kiểm tra')); target.append(node('p','pipeline-note',`Đã đọc mã: ${evidence?.inspected ? 'Có' : 'Chưa'} · Bằng chứng cũ: ${evidence?.stale ? 'Đã mất hiệu lực' : 'Còn hiệu lực'}`)); for (const check of evidence?.checks || []) { target.append(node('p','pipeline-check',`${check.kind === 'probe' ? 'Dò môi trường · ' : check.kind === 'artifact' ? 'Ghi báo cáo · ' : ''}exit ${check.exitCode} · ${check.command}`)); if (check.excerpt) target.append(node('pre','pipeline-evidence',check.excerpt)); } }
    for (const error of evidence?.executionErrors || []) target.append(node('p','pipeline-note',`${error.command} · ${error.error}`));
    if (task.error || task.resultSummary) { const details = node('details','detail-result'); details.append(node('summary','',task.error ? 'Chi tiết lỗi' : 'Kết quả tác vụ'),node('pre','',task.error || task.resultSummary)); target.append(details); }
  }
  function feed(event) {
    if ((!event.message && !event.step) || event.step === 'budget') return;
    const target = get('map-feed'); if (!target.querySelector('.map-feed-entry')) target.replaceChildren();
    const row = node('div','map-feed-entry'); const stamp = new Date(event.timestamp || Date.now());
    row.append(node('time','',stamp.toLocaleTimeString('vi-VN',{hour:'2-digit',minute:'2-digit',second:'2-digit'})),node('p','',event.message || `${event.taskId || 'Agent'} · ${stepText(event.step)}`)); target.prepend(row);
    while (target.children.length > 80) target.lastChild.remove();
  }
  function reset() { tasks = []; live.clear(); planner = null; pipeline = null; get('map-pipeline-card').open = false; selected = null; gate = null; session = null; running = false; goal = ''; get('map-nodes').replaceChildren(); get('map-feed').replaceChildren(node('p','muted','Sự kiện mới sẽ xuất hiện ở đây.')); get('map-detail-content').replaceChildren(node('p','detail-placeholder','Chọn tác vụ để xem chi tiết agent.')); get('map-viewport').dataset.following = ''; schedule(); }
  function event(event) {
    if (event.type === 'session_start') { reset(); session = event.sessionId; goal = event.goal || ''; running = true; }
    if (event.agentId && !event.taskId && event.role === 'planner') planner = {...planner,...event};
    if(event.agentId==='agent-manager'&&pipeline?.manager)pipeline.manager={...pipeline.manager,status:event.status,model:event.model||pipeline.manager.model};
    if (event.type === 'task_snapshot') { pipeline = event.pipeline || pipeline; tasks = event.tasks || []; maxAgents = event.maxAgents || maxAgents; for (const task of tasks) { const prior = live.get(task.id); if (!prior) continue; if (task.assignedAgentId !== prior.agentId) live.delete(task.id); else if (task.status !== prior.status) live.set(task.id,{ agentId:prior.agentId, configuredAgentId:prior.configuredAgentId, agentName:prior.agentName, model:prior.model, skills:prior.skills, status:task.status }); } }
    if (event.taskId && event.type !== 'task_snapshot') {
      const task = tasks.find(task => task.id === event.taskId);
      // A failed old attempt must not overwrite a task already reset for repair.
      if (!(task?.status === 'pending' && event.type === 'task_failed')) live.set(event.taskId,{...live.get(event.taskId),...event,...(event.step === 'budget' ? {step:live.get(event.taskId)?.step || task?.step} : {})});
      if (!selected && event.type === 'task_start') selected = event.taskId;
    }
    if (event.type === 'session_end') { running = false; gate = event.gate; pipeline = event.pipeline || pipeline; }
    feed(event); schedule();
  }
  function restore(state, history = false) {
    if (!state) return;
    reset(); session = state.sessionId; goal = state.goal || ''; pipeline = state.pipeline || null; running = !history && state.status === 'running'; gate = state.gate || null; planner = state.planner || null;
    maxAgents = state.maxAgents || maxAgents; tasks = (state.tasks || []).map(task => history && ['running','ready'].includes(task.status) ? {...task,status:'interrupted'} : task); schedule();
  }
  get('view-team').onclick = get('open-map').onclick = () => view('team');
  get('view-chat').onclick = get('map-back').onclick = () => view('chat');
  get('map-configure').onclick = () => get('team-button').click();
  get('map-start').onclick = () => { view('chat'); get('mode').value = 'teamwork'; get('prompt').focus(); };
  get('map-zoom-in').onclick = () => { zoom = Math.min(1.8,zoom + .1); scale(); };
  get('map-zoom-out').onclick = () => { zoom = Math.max(.35,zoom - .1); scale(); };
  get('map-fit').onclick = () => { viewDiagram('dag'); fit(); };
  get('map-mode-agents').onclick = () => viewDiagram('agents'); get('map-mode-dag').onclick = () => viewDiagram('dag');
  get('map-follow').onclick = () => { follow = !follow; get('map-follow').setAttribute('aria-pressed',String(follow)); get('map-viewport').dataset.following = ''; schedule(); };
  view('chat');
  return { event, restore, reset, view, configure(data,model) { roster = data.namedAgents || []; maxAgents = data.maxAgents || maxAgents; roleModels = Object.fromEntries((data.roles || []).map(role => [role.id,role.model])); defaultModel = model || defaultModel; schedule(); }, connection(value) { connected = value; schedule(); }, end() { running = false; schedule(); } };
})();
