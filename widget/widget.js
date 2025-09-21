(function(){
  const state = { publicKey:null, botId:null, faqFirst:true, conversationId:null };
  function el(tag, attrs={}, children=[]){
    const n = document.createElement(tag);
    Object.entries(attrs).forEach(([k,v])=>{
      if (k==='style') Object.assign(n.style,v);
      else if (k.startsWith('on')) n.addEventListener(k.slice(2),v);
      else n.setAttribute(k,v);
    });
    (Array.isArray(children)?children:[children]).forEach(c=> n.appendChild(typeof c==='string'?document.createTextNode(c):c));
    return n;
  }
  async function ensureConversation(){
    if (state.conversationId) return state.conversationId;
    const res = await fetch('/v1/conversations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({bot_id:state.botId,user:{id:'anon'}})});
    const data = await res.json(); state.conversationId = data.id; return state.conversationId;
  }
  async function sendMessage(text, ui){
    const cid = await ensureConversation();
    ui.append(renderMsg('user', text));
    const res = await fetch('/v1/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({conversation_id:cid,text})});
    const data = await res.json();
    ui.append(renderMsg('assistant', data.content)); ui.scrollTop = ui.scrollHeight;
  }
  function renderMsg(role, text){
    return el('div',{style:{margin:'6px 0',textAlign:role==='user'?'right':'left'}},
      el('div',{style:{display:'inline-block',padding:'8px 10px',borderRadius:'12px',background:role==='user'?'#1f2937':'#0ea5e9',color:'#fff',maxWidth:'80%',whiteSpace:'pre-wrap'}}, text));
  }
  function render(){
    if (document.getElementById('tubot-root')) return;
    const root = el('div',{id:'tubot-root',style:{position:'fixed',right:'20px',bottom:'20px',zIndex:999999}});
    const panel = el('div',{style:{width:'320px',height:'420px',background:'#0b1220',color:'#e5e7eb',border:'1px solid #1f2937',borderRadius:'16px',display:'none',boxShadow:'0 10px 30px rgba(0,0,0,0.5)'}});
    const header = el('div',{style:{padding:'10px 12px',borderBottom:'1px solid #1f2937',display:'flex',alignItems:'center',justifyContent:'space-between'}},[
      el('div',{},'Asistente'),
      el('button',{style:{background:'transparent',color:'#94a3b8',border:'none',cursor:'pointer'},onclick:()=>{panel.style.display='none';}},'×')
    ]);
    const body = el('div',{style:{padding:'10px',height:'320px',overflowY:'auto'}});
    const footer = el('div',{style:{padding:'10px',borderTop:'1px solid #1f2937'}});
    const input = el('input',{placeholder:'Escribe un mensaje…',style:{width:'100%',padding:'10px',borderRadius:'10px',border:'1px solid #334155',background:'#0b1220',color:'#e5e7eb'}});
    input.addEventListener('keydown',e=>{ if(e.key==='Enter' && input.value.trim()){ const t=input.value.trim(); input.value=''; sendMessage(t, body);} });
    footer.append(input);
    const handoffBar = el('div',{style:{padding:'8px 10px',borderTop:'1px dashed #1f2937',fontSize:'12px',color:'#94a3b8'}}, "¿Preferís un humano? Escribí 'agente humano', 'whatsapp' o 'correo'.");
    panel.append(header, body, footer, handoffBar);
    const btn = el('button',{style:{width:'56px',height:'56px',borderRadius:'999px',border:'none',cursor:'pointer',background:'#111827',color:'#fff',boxShadow:'0 8px 24px rgba(0,0,0,0.4)'},onclick:()=>{panel.style.display='block';}},'💬');
    root.append(panel, btn); document.body.appendChild(root);
  }
  window.TuBotAI = { mount(opts){ state.publicKey=opts.publicKey; state.botId=opts.botId; state.faqFirst=!!opts.faqFirst; render(); }, open({prefill}={}){ const panel=document.querySelector('#tubot-root > div'); if(panel){ panel.style.display='block'; const input=panel.querySelector('input'); if(prefill) input.value=prefill; input&&input.focus(); } } };
})();
