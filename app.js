(() => {
  const cfg = window.CIRCUS_CONFIG || {};
  const badConfig = !cfg.supabaseUrl || !cfg.supabaseKey || cfg.supabaseUrl.includes('COLE_') || cfg.supabaseKey.includes('COLE_');
  const sb = badConfig ? null : window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey);

  const GAMES = {
    roulette: {title:'Roleta Rubra', icon:'◉', min:1,max:1,type:'SORTE', desc:'Escolha uma cor e entregue seu destino à roda.'},
    cups: {title:'Copos do Arlequim', icon:'♠', min:1,max:1,type:'SORTE', desc:'Uma bolinha, três copos e apenas uma chance.'},
    tightrope: {title:'Corda do Acrobata', icon:'⚖', min:1,max:1,type:'RISCO', desc:'Avance com cuidado ou arrisque passos maiores até o outro lado.'},
    oracle: {title:'Oráculo dos Números', icon:'✦', min:1,max:1,type:'RACIOCÍNIO', desc:'Descubra o número secreto usando apenas as pistas do oráculo.'},
    darts: {title:'Dardos do Diabo', icon:'✥', min:1,max:1,type:'SORTE + ESCOLHA', desc:'Escolha seu estilo de arremesso e tente somar 12 pontos.'},
    cards: {title:'Duelo das Cartas', icon:'♦', min:2,max:2,type:'ESTRATÉGIA', desc:'Sol, Lua e Estrela se vencem em um ciclo. Primeiro a 2 pontos.'},
    bones: {title:'Leilão de Ossos', icon:'☠', min:2,max:2,type:'ESTRATÉGIA', desc:'Aposte seus 10 ossos em três rodadas. Quem dominar mais rodadas vence.'},
    mirrors: {title:'Espelhos Gêmeos', icon:'◇', min:2,max:2,type:'LÓGICA COOPERATIVA', desc:'Dois jogadores, uma resposta. Resolva padrões sem quebrar o reflexo.'}
  };

  const $ = id => document.getElementById(id);
  const screens = {home:$('screen-home'), room:$('screen-room')};
  const memKey = 'midnight_circus_session_v1';
  let auth = JSON.parse(localStorage.getItem(memKey) || 'null');
  let state = null;
  let poller = null;
  let selectedGameKey = null;
  let selectedPlayers = new Set();
  let lastStateSignature = '';

  function uid(){ return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`; }
  function randomCode(){ const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; return Array.from({length:5},()=>chars[Math.floor(Math.random()*chars.length)]).join(''); }
  function esc(s=''){ return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
  function toast(msg, ms=3000){ const el=$('toast'); el.textContent=msg; el.classList.remove('hidden'); clearTimeout(el._t); el._t=setTimeout(()=>el.classList.add('hidden'),ms); }
  function showScreen(name){ Object.values(screens).forEach(x=>x.classList.remove('active')); screens[name].classList.add('active'); }
  function setAuth(v){ auth=v; if(v)localStorage.setItem(memKey,JSON.stringify(v)); else localStorage.removeItem(memKey); }
  async function rpc(name,args){ const {data,error}=await sb.rpc(name,args); if(error) throw error; return data; }
  function errMsg(e){ return e?.message || e?.error_description || String(e); }

  function setupHome(){
    $('host-code').value=randomCode();
    $('btn-random-code').onclick=()=> $('host-code').value=randomCode();
    $('btn-create-room').onclick=createRoom;
    $('btn-join-room').onclick=joinRoom;
    if(badConfig){ const w=$('config-warning'); w.classList.remove('hidden'); w.innerHTML='<strong>Falta conectar o Supabase.</strong> Preencha <code>config.js</code> com Project URL e Publishable Key.'; }
  }

  async function createRoom(){
    if(badConfig) return toast('Configure o Supabase primeiro.');
    const code=$('host-code').value.trim().toUpperCase();
    if(code.length<4) return toast('Use um código com pelo menos 4 caracteres.');
    const key=uid()+uid();
    try{
      const data=await rpc('circus_create_room',{p_code:code,p_host_key:key});
      setAuth({role:'host',roomId:data.room_id,key,code:data.code});
      enterRoom();
    }catch(e){ toast(errMsg(e)); }
  }

  async function joinRoom(){
    if(badConfig) return toast('Configure o Supabase primeiro.');
    const name=$('join-name').value.trim();
    const code=$('join-code').value.trim().toUpperCase();
    if(!name||!code) return toast('Preencha seu nome e o código da sala.');
    const key=uid()+uid();
    try{
      const data=await rpc('circus_join_room',{p_code:code,p_name:name,p_player_key:key});
      setAuth({role:'player',roomId:data.room_id,playerId:data.player_id,key,code:data.code,name});
      enterRoom();
    }catch(e){ toast(errMsg(e)); }
  }

  function enterRoom(){
    showScreen('room');
    $('room-code-label').textContent=`SALA • ${auth.code || '------'}`;
    $('viewer-badge').textContent=auth.role==='host'?'MESTRE':'JOGADOR';
    $('host-controls').classList.toggle('hidden',auth.role!=='host');
    $('btn-leave').onclick=leaveRoom;
    $('btn-open-games').onclick=()=>openGameModal();
    $('btn-end-game').onclick=endGame;
    document.querySelectorAll('[data-ticket]').forEach(b=>b.onclick=()=>awardTickets(Number(b.dataset.ticket)));
    document.querySelectorAll('[data-close-modal]').forEach(x=>x.onclick=closeGameModal);
    document.querySelectorAll('[data-close-player-modal]').forEach(x=>x.onclick=closePlayerModal);
    $('btn-start-selected-game').onclick=startSelectedGame;
    loadState(true);
    clearInterval(poller); poller=setInterval(()=>loadState(false),1200);
  }

  async function leaveRoom(){
    if(auth?.role==='player'){
      try{ await rpc('circus_leave_room',{p_room_id:auth.roomId,p_player_id:auth.playerId,p_player_key:auth.key}); }catch(_){ }
    }
    clearInterval(poller); setAuth(null); state=null; showScreen('home');
  }

  async function loadState(showErrors){
    if(!auth||!sb) return;
    try{
      const s=await rpc('circus_get_state',{p_room_id:auth.roomId,p_access_key:auth.key});
      const sig=JSON.stringify(s);
      if(sig!==lastStateSignature){ lastStateSignature=sig; state=s; render(); }
    }catch(e){ if(showErrors) toast(errMsg(e)); }
  }

  function render(){
    if(!state) return;
    auth.code=state.room.code; localStorage.setItem(memKey,JSON.stringify(auth));
    $('room-code-label').textContent=`SALA • ${state.room.code}`;
    renderPlayers(); renderHost(); renderLogs(); renderStage();
  }

  function renderPlayers(){
    const activeIds=new Set((state.active_game?.participant_ids)||[]);
    $('player-list').innerHTML=(state.players||[]).map(p=>`
      <div class="player-card ${activeIds.has(p.id)?'active-player':''}">
        <div class="player-name"><span>${esc(p.name)}</span>${p.id===auth.playerId?'<span>VOCÊ</span>':''}</div>
        <div class="tickets">🎟 ${p.tickets} ticket${p.tickets===1?'':'s'}</div>
      </div>`).join('') || '<div class="small-note">A tenda ainda está vazia.</div>';
  }

  function renderHost(){
    if(auth.role!=='host') return;
    const sel=$('ticket-player-select'); const keep=sel.value;
    sel.innerHTML='<option value="">Escolha um jogador</option>'+state.players.map(p=>`<option value="${p.id}">${esc(p.name)} — 🎟 ${p.tickets}</option>`).join('');
    if([...sel.options].some(o=>o.value===keep)) sel.value=keep;
    $('btn-open-games').disabled=!!state.active_game;
    $('btn-end-game').classList.toggle('hidden',!state.active_game);
  }

  function renderLogs(){
    $('event-log').innerHTML=(state.logs||[]).map(x=>`<div class="log-item">${esc(x.message)}</div>`).join('') || '<div class="small-note">Nenhum acontecimento ainda.</div>';
  }

  function renderStage(){
    const g=state.active_game;
    $('idle-stage').classList.toggle('hidden',!!g); $('game-stage').classList.toggle('hidden',!g);
    if(!g){ $('idle-message').textContent=auth.role==='host'?'Escolha um jogo no painel do mestre.':'O mestre da cerimônia está escolhendo o próximo jogo.'; return; }
    const def=GAMES[g.game_key];
    $('game-type-chip').textContent=def.type; $('game-title').textContent=def.title; $('game-subtitle').textContent=def.desc;
    $('game-status-badge').textContent=g.status==='finished'?'ENCERRADO':'EM ANDAMENTO';
    $('participants-strip').innerHTML=g.participants.map(p=>`<div class="participant-pill ${p.id===auth.playerId?'me':''}">${esc(p.name)} • 🎟 ${p.tickets}</div>`).join('');
    const canPlay=auth.role==='player' && g.participant_ids.includes(auth.playerId) && g.status==='active';
    $('game-board').innerHTML=renderGameBoard(g,canPlay);
    bindGameActions(g,canPlay);
    const result=$('game-result');
    if(g.status==='finished'){
      result.classList.remove('hidden');
      const winners=(g.winner_ids||[]).map(id=>state.players.find(p=>p.id===id)?.name).filter(Boolean);
      result.innerHTML=`<div><div class="result-badge">AS LUZES SE APAGAM</div><h3>${winners.length?'VITÓRIA!':'FIM DA ATRAÇÃO'}</h3><p>${winners.length?`${esc(winners.join(' & '))} venceu${winners.length>1?'ram':''} esta atração.`:'O jogo terminou sem vencedor.'}</p>${auth.role==='host'?'<p class="small-note">Você pode distribuir tickets pelo painel à direita.</p>':'<p class="small-note">O mestre decide a premiação em tickets.</p>'}</div>`;
    } else result.classList.add('hidden');
  }

  function spectator(g,canPlay){
    if(canPlay) return '';
    const participating=auth.role==='player' && g.participant_ids.includes(auth.playerId);
    return `<div class="spectator-note">${participating?'Sua jogada foi registrada. Aguarde o outro participante.':'Você está assistindo esta atração em tempo real.'}</div>`;
  }

  function renderGameBoard(g,canPlay){
    const s=g.state||{}; const wait=spectator(g,canPlay);
    switch(g.game_key){
      case 'roulette': return `<div class="game-card-center"><div class="big-symbol">◉</div><h3>Escolha onde a roda vai parar.</h3><p class="game-instruction">Vermelho e Preto têm chances iguais. Dourado é raro, mas glorioso.</p><div class="choice-grid"><button class="choice-btn game-action" data-action="pick" data-value="red" ${!canPlay?'disabled':''}><span class="choice-icon">♥</span>VERMELHO</button><button class="choice-btn game-action" data-action="pick" data-value="black" ${!canPlay?'disabled':''}><span class="choice-icon">♠</span>PRETO</button><button class="choice-btn game-action" data-action="pick" data-value="gold" ${!canPlay?'disabled':''}><span class="choice-icon">★</span>DOURADO</button></div>${s.result?`<div class="history">A roda mostrou: <strong>${esc(s.result)}</strong></div>`:''}${wait}</div>`;
      case 'cups': return `<div class="game-card-center"><div class="big-symbol">♣</div><h3>Onde está a pérola?</h3><p class="game-instruction">O arlequim embaralhou três copos. Escolha apenas um.</p><div class="choice-grid"><button class="choice-btn game-action" data-action="pick" data-value="1" ${!canPlay?'disabled':''}>COPO I</button><button class="choice-btn game-action" data-action="pick" data-value="2" ${!canPlay?'disabled':''}>COPO II</button><button class="choice-btn game-action" data-action="pick" data-value="3" ${!canPlay?'disabled':''}>COPO III</button></div>${s.reveal?`<div class="history">A pérola estava no <strong>Copo ${esc(s.reveal)}</strong>.</div>`:''}${wait}</div>`;
      case 'tightrope': { const progress=Number(s.progress||0); return `<div class="game-card-center"><div class="big-symbol">⚖</div><h3>Cruze a corda sem olhar para baixo.</h3><p class="game-instruction">Passos firmes avançam pouco e são mais seguros. Passos ousados avançam mais, mas podem derrubar você.</p><div class="meter"><div class="meter-fill" style="width:${Math.min(100,progress*10)}%"></div></div><div class="result-badge">PROGRESSO ${progress}/10</div><div class="choice-grid"><button class="choice-btn game-action" data-action="step" data-value="safe" ${!canPlay?'disabled':''}>PASSO FIRME<br><small>+1 • risco baixo</small></button><button class="choice-btn game-action" data-action="step" data-value="bold" ${!canPlay?'disabled':''}>PASSO OUSADO<br><small>+2 ou +3 • risco alto</small></button></div>${s.last?`<div class="history">${esc(s.last)}</div>`:''}${wait}</div>`; }
      case 'oracle': return `<div class="game-card-center"><div class="big-symbol">✦</div><h3>O Oráculo escolheu um número de 1 a 20.</h3><p class="game-instruction">Você possui até cinco tentativas. Cada erro revela se o número secreto é maior ou menor.</p><div class="result-badge">TENTATIVAS ${s.attempts||0}/5</div><div class="oracle-input"><input id="oracle-guess" type="number" min="1" max="20" placeholder="1–20" ${!canPlay?'disabled':''}><button id="oracle-submit" class="btn btn-red" ${!canPlay?'disabled':''}>REVELAR</button></div><div class="history">${(s.history||[]).map(h=>`<div>${esc(h)}</div>`).join('')||'O véu ainda não foi tocado.'}</div>${wait}</div>`;
      case 'darts': return `<div class="game-card-center"><div class="big-symbol">✥</div><h3>Três arremessos. Doze pontos para vencer.</h3><p class="game-instruction">Seguro quase sempre pontua; Arriscado oscila; Maldito pode valer muito… ou nada.</p><div class="score-row"><div class="score-box"><strong>${s.score||0}</strong>PONTOS</div><div class="score-box"><strong>${s.throws||0}/3</strong>DARDOS</div></div><div class="choice-grid"><button class="choice-btn game-action" data-action="throw" data-value="safe" ${!canPlay?'disabled':''}>SEGURO</button><button class="choice-btn game-action" data-action="throw" data-value="risk" ${!canPlay?'disabled':''}>ARRISCADO</button><button class="choice-btn game-action" data-action="throw" data-value="cursed" ${!canPlay?'disabled':''}>MALDITO</button></div><div class="history">${(s.history||[]).map(h=>`<div>${esc(h)}</div>`).join('')||'Os dardos ainda repousam na mesa.'}</div>${wait}</div>`;
      case 'cards': { const names=g.participants; const scores=s.scores||{}; return `<div class="game-card-center"><div class="big-symbol">♦</div><h3>Escolha sua carta em segredo.</h3><p class="game-instruction">SOL vence LUA • LUA vence ESTRELA • ESTRELA vence SOL.</p><div class="score-row">${names.map(p=>`<div class="score-box"><strong>${scores[p.id]||0}</strong>${esc(p.name)}</div>`).join('')}</div><div class="cards-row"><button class="choice-btn game-action" data-action="card" data-value="sun" ${!canPlay?'disabled':''}><span class="choice-icon">☀</span>SOL</button><button class="choice-btn game-action" data-action="card" data-value="moon" ${!canPlay?'disabled':''}><span class="choice-icon">☾</span>LUA</button><button class="choice-btn game-action" data-action="card" data-value="star" ${!canPlay?'disabled':''}><span class="choice-icon">★</span>ESTRELA</button></div><div class="small-note">Rodada ${s.round||1} • ${s.pending_count||0}/2 escolhas recebidas</div>${s.last?`<div class="history">${esc(s.last)}</div>`:''}${wait}</div>`; }
      case 'bones': { const budgets=s.budgets||{}, wins=s.wins||{}; return `<div class="game-card-center"><div class="big-symbol">☠</div><h3>Aposte seus ossos.</h3><p class="game-instruction">São três rodadas. Apostas são secretas e os ossos gastos não voltam.</p><div class="score-row">${g.participants.map(p=>`<div class="score-box"><strong>${wins[p.id]||0} vitória${(wins[p.id]||0)===1?'':'s'}</strong>${esc(p.name)} • ${budgets[p.id]??10} ossos</div>`).join('')}</div><div class="oracle-input"><input id="bone-bid" type="number" min="0" max="10" placeholder="Aposta" ${!canPlay?'disabled':''}><button id="bone-submit" class="btn btn-red" ${!canPlay?'disabled':''}>APOSTAR</button></div><div class="small-note">Rodada ${s.round||1}/3 • ${s.pending_count||0}/2 apostas recebidas</div>${s.last?`<div class="history">${esc(s.last)}</div>`:''}${wait}</div>`; }
      case 'mirrors': return `<div class="game-card-center"><div class="big-symbol">◇</div><h3>Não quebre o reflexo.</h3><p class="game-instruction">Os dois participantes devem resolver o mesmo padrão. As respostas ficam secretas até ambos responderem.</p><div class="puzzle">${esc(s.puzzle?.question||'Preparando o espelho…')}</div><div class="choice-grid">${(s.puzzle?.options||[]).map(o=>`<button class="choice-btn game-action" data-action="answer" data-value="${esc(o)}" ${!canPlay?'disabled':''}>${esc(o)}</button>`).join('')}</div><div class="score-row"><div class="score-box"><strong>${s.success||0}/3</strong>ACERTOS</div><div class="score-box"><strong>${s.round||1}/4</strong>ESPELHO</div></div>${s.last?`<div class="history">${esc(s.last)}</div>`:''}${wait}</div>`;
    }
    return '<div class="game-card-center">A atração está sendo preparada.</div>';
  }

  function bindGameActions(g,canPlay){
    if(!canPlay) return;
    document.querySelectorAll('.game-action').forEach(btn=>btn.onclick=()=>sendGameAction(g.id,btn.dataset.action,{value:btn.dataset.value}));
    if($('oracle-submit')) $('oracle-submit').onclick=()=>{ const v=Number($('oracle-guess').value); if(v>=1&&v<=20) sendGameAction(g.id,'guess',{value:v}); else toast('Escolha um número entre 1 e 20.'); };
    if($('bone-submit')) $('bone-submit').onclick=()=>{ const v=Number($('bone-bid').value); if(Number.isInteger(v)&&v>=0) sendGameAction(g.id,'bid',{value:v}); else toast('Digite uma aposta válida.'); };
  }

  async function sendGameAction(gameId,action,payload){
    try{ await rpc('circus_game_action',{p_game_id:gameId,p_player_id:auth.playerId,p_player_key:auth.key,p_action:action,p_payload:payload}); await loadState(false); }catch(e){ toast(errMsg(e)); }
  }

  function openGameModal(){
    if(auth.role!=='host'||state.active_game) return;
    $('game-catalog').innerHTML=Object.entries(GAMES).map(([key,g])=>`<article class="catalog-card" data-game="${key}"><div class="catalog-icon">${g.icon}</div><div class="catalog-meta">${g.type} • ${g.min===g.max?g.max:`${g.min}-${g.max}`} JOGADOR${g.max>1?'ES':''}</div><h3>${g.title}</h3><p>${g.desc}</p></article>`).join('');
    document.querySelectorAll('.catalog-card').forEach(c=>c.onclick=()=>openPlayerPicker(c.dataset.game));
    $('game-picker-modal').classList.remove('hidden');
  }
  function closeGameModal(){ $('game-picker-modal').classList.add('hidden'); }
  function openPlayerPicker(key){
    selectedGameKey=key; selectedPlayers.clear(); const g=GAMES[key];
    $('picker-game-title').textContent=g.title;
    $('picker-game-capacity').textContent=g.min===g.max?`Escolha exatamente ${g.max} jogador${g.max>1?'es':''}.`:`Escolha de ${g.min} a ${g.max} jogadores.`;
    $('player-picker-list').innerHTML=state.players.map(p=>`<label class="picker-player" data-player="${p.id}"><input type="checkbox" value="${p.id}"><span>${esc(p.name)} • 🎟 ${p.tickets}</span></label>`).join('');
    document.querySelectorAll('.picker-player').forEach(label=>label.onclick=e=>{ if(e.target.tagName!=='INPUT') e.preventDefault(); const id=label.dataset.player; if(selectedPlayers.has(id)){selectedPlayers.delete(id);label.classList.remove('selected');label.querySelector('input').checked=false;} else if(selectedPlayers.size<g.max){selectedPlayers.add(id);label.classList.add('selected');label.querySelector('input').checked=true;} else toast(`Este jogo aceita no máximo ${g.max}.`); });
    $('game-picker-modal').classList.add('hidden'); $('player-picker-modal').classList.remove('hidden');
  }
  function closePlayerModal(){ $('player-picker-modal').classList.add('hidden'); }

  async function startSelectedGame(){
    const g=GAMES[selectedGameKey]; if(selectedPlayers.size<g.min||selectedPlayers.size>g.max) return toast(`Selecione ${g.min===g.max?g.min:`de ${g.min} a ${g.max}`} jogador(es).`);
    try{ await rpc('circus_start_game',{p_room_id:auth.roomId,p_host_key:auth.key,p_game_key:selectedGameKey,p_player_ids:[...selectedPlayers]}); closePlayerModal(); await loadState(false); }catch(e){ toast(errMsg(e)); }
  }

  async function endGame(){
    if(!state.active_game) return;
    if(!confirm('Encerrar a atração atual?')) return;
    try{ await rpc('circus_end_game',{p_room_id:auth.roomId,p_host_key:auth.key}); await loadState(false); }catch(e){ toast(errMsg(e)); }
  }

  async function awardTickets(delta){
    const pid=$('ticket-player-select').value; if(!pid) return toast('Escolha um jogador.');
    try{ await rpc('circus_award_tickets',{p_room_id:auth.roomId,p_host_key:auth.key,p_player_id:pid,p_delta:delta}); await loadState(false); toast(`${delta>0?'+':''}${delta} ticket${Math.abs(delta)===1?'':'s'} aplicado.`); }catch(e){ toast(errMsg(e)); }
  }

  setupHome();
  if(auth && !badConfig) enterRoom(); else showScreen('home');
})();
