'use strict';
window.ProjectSetup=(()=>{
  let api, catalogOffset=0, catalogTotal=0, catalogDetail, catalogTimer;
  const el=id=>document.getElementById(id),node=(tag,text)=>{const n=document.createElement(tag);n.textContent=text || '';return n;};
  function catalogSearch(offset=0){catalogOffset=offset;api.send({type:'search_templates',query:el('catalog-query').value,kind:el('catalog-kind').value,offset});}
  function catalogEvent(msg){
    if(msg.type==='template_results'){
      catalogTotal=msg.total;catalogOffset=msg.offset;el('catalog-summary').textContent=`AITMPL · ${msg.summary.entries} thành phần · ${msg.summary.resources} tài nguyên · commit ${msg.summary.commit.slice(0,12)}\n`+Object.entries(msg.summary.counts).map(([kind,count])=>`${kind}: ${count}`).join(' · ');
      const target=el('catalog-results');target.replaceChildren();
      for(const item of msg.items){const card=node('section');card.className='wb-section';card.append(node('h3',`${item.name} · ${item.kind}`),node('p',item.description||item.id));const button=node('button','Xem và áp dụng');button.type='button';button.className='quiet-button';button.onclick=()=>api.send({type:'read_template',id:item.id});card.append(button);target.append(card);}
      el('catalog-page').textContent=`${msg.total?msg.offset+1:0}–${Math.min(msg.offset+msg.items.length,msg.total)} / ${msg.total}`;el('catalog-prev').disabled=msg.offset===0;el('catalog-next').disabled=msg.offset+msg.items.length>=msg.total;
    }
    if(msg.type==='template_detail'){
      catalogDetail=msg;el('catalog-detail').hidden=false;el('catalog-title').textContent=msg.item.id;el('catalog-preview').textContent=msg.content;el('catalog-apply').disabled=false;
      const resource=el('catalog-resource');resource.replaceChildren();for(const file of msg.item.resources){const name=file.slice(msg.item.base.length+1),option=node('option',name);option.value=name;resource.append(option);}resource.value=msg.resource;
      el('catalog-more').disabled=!msg.nextLine;const type=msg.item.kind;el('catalog-apply').textContent=type==='mcps'?'Nhập MCP (tắt, chờ cấu hình)':type==='agents'?'Thêm agent vào team':['skills','commands','loops'].includes(type)?'Gán hướng dẫn cho vai':'Lưu tài nguyên tham khảo';
      el('catalog-compatibility').textContent=['skills','agents','commands','loops'].includes(type)?'Hướng dẫn dùng được trong Vibe; quyền công cụ và tiêu chí nghiệm thu của app vẫn áp dụng. Không đổi model.':type==='mcps'?'Nhập cấu hình, điền token/đường dẫn trong mục MCP rồi bật và kiểm tra kết nối.':'Tài nguyên giữ nguyên để tham khảo/chuyển đổi. Hook, mod, plugin và setting riêng cho Claude chưa có engine tương ứng trong Vibe.';
      const link=el('catalog-source');link.href=msg.item.url;link.textContent='Nguồn và giấy phép: '+msg.item.license;
      el('catalog-detail').scrollIntoView({block:'nearest'});
    }
    if(msg.type==='template_applied'){el('catalog-status').textContent=msg.message;el('catalog-apply').disabled=false;}
    if(msg.type==='error'){el('catalog-status').textContent=msg.message;el('catalog-apply').disabled=false;}
  }
  function event(msg){
    catalogEvent(msg);
    if(msg.type==='integration_progress'){el('integration-status').textContent=msg.message;el('run-text').textContent=msg.message;return;}
    if(msg.type==='integration_state'){
      el('integration-auto').checked=msg.enabled;el('integration-auto').disabled=false;el('integration-sync').disabled=false;
      const target=el('integration-results');target.replaceChildren();
      const project=msg.plan?.project;if(project)target.append(node('p','Phát hiện: '+[...project.files,...project.dependencies].join(', ')));
      for(const item of [...(msg.plan?.skills || []),...(msg.plan?.mcp || [])]){const card=node('section');card.className='wb-section';card.append(node('h3',item.name),node('p',item.reason || 'Gán cho vai: '+item.roles.join(', ')));const link=node('a','Xem nguồn');link.href=item.url?.startsWith('https://github.com/')?item.url:item.source || `https://github.com/${item.repository}`;link.target='_blank';link.rel='noreferrer';card.append(link);if(item.commit)card.append(node('p',`Commit ${item.commit.slice(0,12)} · ${item.license}`));target.append(card);}
      for(const result of msg.report?.results || [])target.append(node('p',`${result.status} · ${result.id}: ${result.message}`));
      for(const server of msg.report?.connections || [])target.append(node('p',`MCP ${server.id}: ${server.status} · ${server.toolCount} công cụ${server.error?' · '+server.error:''}`));
      el('integration-status').textContent=msg.report?'Đã xử lý các nguồn; xem kết quả và trạng thái từng kết nối.':'Sẵn sàng phân tích dự án. Khi bật tự động, app thiết lập trước lượt làm việc đầu tiên hoặc khi công nghệ thay đổi.';
    }
    if(msg.type==='error'&&el('integration-dialog').open){el('integration-status').textContent=msg.message;el('integration-sync').disabled=false;el('integration-auto').disabled=false;}
  }
  function init(options){api=options;el('catalog-query').oninput=()=>{clearTimeout(catalogTimer);catalogTimer=setTimeout(()=>catalogSearch(),250);};el('catalog-kind').onchange=()=>catalogSearch();el('catalog-prev').onclick=()=>catalogSearch(Math.max(0,catalogOffset-24));el('catalog-next').onclick=()=>catalogSearch(catalogOffset+24);el('catalog-resource').onchange=()=>api.send({type:'read_template',id:catalogDetail.item.id,resource:el('catalog-resource').value});el('catalog-more').onclick=()=>api.send({type:'read_template',id:catalogDetail.item.id,resource:catalogDetail.resource,startLine:catalogDetail.nextLine});el('catalog-apply').onclick=()=>{el('catalog-apply').disabled=true;el('catalog-status').textContent='Đang áp dụng…';if(!api.send({type:'apply_template',id:catalogDetail.item.id,role:el('catalog-role').value||undefined}))el('catalog-apply').disabled=false;};el('integration-stop').onclick=()=>api.send({type:'stop'});el('integration-button').onclick=()=>{el('integration-dialog').showModal();api.send({type:'get_integrations'});catalogSearch();};el('integration-auto').onchange=()=>{el('integration-auto').disabled=true;if(!api.send({type:'configure_integrations',enabled:el('integration-auto').checked}))el('integration-auto').disabled=false;};el('integration-sync').onclick=()=>{el('integration-sync').disabled=true;el('integration-status').textContent='Đang tải và thiết lập…';if(!api.send({type:'sync_integrations'}))el('integration-sync').disabled=false;};}
  return {event,init};
})();
