(() => {
  const cfg = window.CIRCUS_CONFIG || {};
  const badConfig = !cfg.supabaseUrl || !cfg.supabaseKey || cfg.supabaseUrl.includes('COLE_') || cfg.supabaseKey.includes('COLE_');
  const sb = badConfig ? null : window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey);

  const GAMES = {
    roulette: {title:'Roleta Rubra', icon:'◉', min:1,max:1,type:'SORTE', desc:'Escolha uma cor e entregue seu destino à roda.'},
    cups: {title:'Copos do Arlequim', icon:'♠', min:1,max:1,type:'SORTE', desc:'Uma bolinha, três copos e apenas uma chance.'},
    tightrope: {title:'Corda do Acrobata', icon:'⚖', min:1,max:1,type:'RISCO', desc:'Avance com cuidado ou arrisque passos maiores até o outro lado.'},
    oracle: {title:'Oráculo dos Números', icon:'✦', min:1,max:1,type:'RACIOCÍNIO', desc:'Descubra o número secreto usando apenas as pistas do oráculo.'},
    darts: {title:'Dardos do Diabo', icon:'✥', min:1,max:1,type:'HABILIDADE', desc:'Pare o marcador no centro. A cada dardo, a barra fica mais rápida.'},
    cards: {title:'Cartas da Cartomante', icon:'♦', min:2,max:2,type:'RACIOCÍNIO COOPERATIVO', desc:'Juntem duas pistas para descobrir qual símbolo o circo esconde.'},
    bones: {title:'Cofre de Ossos', icon:'☠', min:2,max:2,type:'ESTRATÉGIA COOPERATIVA', desc:'Somem suas ofertas secretas para atingir exatamente o número exigido pelo circo.'},
    mirrors: {title:'Espelhos Gêmeos', icon:'◇', min:2,max:2,type:'LÓGICA COOPERATIVA', desc:'Dois jogadores contra o espelho. Resolva padrões sem quebrar o reflexo.'}
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
  let finishRevealTimer = null;

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
    const g=state.active_game;
    $('btn-open-games').disabled=!!(g && g.status==='active');
    $('btn-open-games').textContent=g?.status==='finished'?'PRÓXIMA ATRAÇÃO':'ESCOLHER JOGO';
    $('btn-end-game').classList.toggle('hidden',!g);
    $('btn-end-game').textContent=g?.status==='finished'?'FECHAR PICADEIRO':'ENCERRAR ATRAÇÃO';
  }

  function renderLogs(){
    $('event-log').innerHTML=(state.logs||[]).map(x=>`<div class="log-item">${esc(x.message)}</div>`).join('') || '<div class="small-note">Nenhum acontecimento ainda.</div>';
  }

  function renderStage(){
    const g=state.active_game;
    $('idle-stage').classList.toggle('hidden',!!g); $('game-stage').classList.toggle('hidden',!g);
    if(!g){
      $('idle-message').textContent=auth.role==='host'?'Escolha um jogo no painel do mestre.':'O mestre da cerimônia está escolhendo o próximo jogo.';
      return;
    }
    const def=GAMES[g.game_key];
    $('game-type-chip').textContent=def.type; $('game-title').textContent=def.title; $('game-subtitle').textContent=def.desc;
    $('game-status-badge').textContent=g.status==='finished'?'FINALIZADO':'EM ANDAMENTO';
    $('participants-strip').innerHTML=g.participants.map(p=>`<div class="participant-pill ${p.id===auth.playerId?'me':''}">${esc(p.name)} • 🎟 ${p.tickets}</div>`).join('');
    const canPlay=auth.role==='player' && g.participant_ids.includes(auth.playerId) && g.status==='active';
    $('game-board').innerHTML=renderGameBoard(g,canPlay);
    bindGameActions(g,canPlay);
    runGameVisuals(g,canPlay);

    const result=$('game-result');
    clearTimeout(finishRevealTimer);
    if(g.status==='finished'){
      result.classList.remove('hidden');
      result.classList.add('result-delayed');
      const winners=(g.winner_ids||[]).map(id=>state.players.find(p=>p.id===id)?.name).filter(Boolean);
      result.innerHTML=`<div class="result-inner"><div class="result-badge">AS LUZES SE APAGAM</div><h3>${winners.length?'VITÓRIA!':'FIM DA ATRAÇÃO'}</h3><p>${winners.length?`${esc(winners.join(' & '))} venceu${winners.length>1?'ram':''} esta atração.`:'O número não sorriu para ninguém desta vez.'}</p>${auth.role==='host'?'<div class="result-actions"><button id="result-next" class="btn btn-gold">PRÓXIMA ATRAÇÃO</button><button id="result-close" class="btn btn-ghost">FECHAR PICADEIRO</button></div><p class="small-note">Os tickets podem ser entregues pelo painel do mestre a qualquer momento.</p>':'<p class="small-note">Aguarde o mestre preparar a próxima atração.</p>'}</div>`;
      const delay={roulette:2900,cups:1200,darts:1300,cards:900,bones:900,mirrors:800}[g.game_key]||500;
      finishRevealTimer=setTimeout(()=>result.classList.remove('result-delayed'),delay);
      if(auth.role==='host'){
        const next=$('result-next'); const close=$('result-close');
        if(next) next.onclick=openGameModal;
        if(close) close.onclick=endGame;
      }
    } else {
      result.classList.add('hidden');
      result.classList.remove('result-delayed');
    }
  }

  function spectator(g,canPlay){
    if(canPlay) return '';
    const participating=auth.role==='player' && g.participant_ids.includes(auth.playerId);
    return `<div class="spectator-note">${participating?'Sua jogada foi registrada. Aguarde o outro participante.':'Você está assistindo esta atração em tempo real.'}</div>`;
  }

  function renderGameBoard(g,canPlay){
    const s=g.state||{}; const wait=spectator(g,canPlay);
    switch(g.game_key){
      case 'roulette': {
        const result=s.result||'';
        const spin=Number(s.spin_deg||1800);
        return `<div class="game-card-center roulette-scene">
          <div class="roulette-wrap"><div id="roulette-wheel" class="roulette-wheel ${result?'roulette-spinning':''}" style="--spin-end:${spin}deg"><div class="roulette-center">✦</div></div><div class="roulette-pointer">▼</div></div>
          <h3>${result?'A roda está decidindo o destino…':'Faça sua aposta.'}</h3>
          <p class="game-instruction">Vermelho e Preto dividem a roda. Dourado aparece apenas uma vez.</p>
          <div class="choice-grid roulette-choices">
            <button class="choice-btn game-action" data-action="pick" data-value="red" ${!canPlay||result?'disabled':''}><span class="choice-icon">♥</span>VERMELHO</button>
            <button class="choice-btn game-action" data-action="pick" data-value="black" ${!canPlay||result?'disabled':''}><span class="choice-icon">♠</span>PRETO</button>
            <button class="choice-btn game-action" data-action="pick" data-value="gold" ${!canPlay||result?'disabled':''}><span class="choice-icon">★</span>DOURADO</button>
          </div>
          ${result?`<div id="roulette-reveal" class="history visual-reveal">A roleta parou em <strong>${esc(result)}</strong>.</div>`:''}${wait}</div>`;
      }
      case 'cups': {
        const revealed=Number(s.reveal||0), picked=Number(s.picked||0), initial=Number(s.initial_pearl||2);
        return `<div class="game-card-center cups-scene">
          <div class="arlequin-title">♠ O ARLEQUIM SORRI ♠</div>
          <h3>${revealed?'A escolha foi feita.':'Primeiro, veja onde a pérola está.'}</h3>
          <p class="game-instruction">Um dos copos será erguido por um instante. Memorize a pérola. Depois acompanhe o mesmo copo durante o embaralhamento frenético.</p>
          <div id="cup-table" class="cup-table ${revealed?'cups-finished':''}">
            <div id="pearl" class="pearl ${revealed?'pearl-revealed':''}">●</div>
            ${[1,2,3].map(i=>`<button class="circus-cup game-action ${i===initial&&!revealed?'cup-initial':''} ${picked===i?'cup-picked':''} ${revealed===i?'cup-winner':''}" data-cup="${i}" data-action="pick" data-value="${i}" ${(!canPlay||!revealed)?'disabled':''}><span class="cup-top"></span><span class="cup-body">${i}</span></button>`).join('')}
          </div>
          <div id="shuffle-caption" class="result-badge">${revealed?`A pérola estava no COPO ${revealed}`:`OLHE: A PÉROLA ESTÁ SOB O COPO ${initial}`}</div>
          ${wait}</div>`;
      }
      case 'tightrope': { const progress=Number(s.progress||0); const fell=String(s.last||'').toLowerCase().includes('caiu'); return `<div class="game-card-center tightrope-scene">
        <div class="circus-sky"><div class="spotlight-cone"></div><div class="rope-line"></div><div class="acrobat ${fell?'acrobat-fall':''}" style="left:${8+Math.min(84,progress*8.4)}%">♟</div></div>
        <h3>Cruze a corda sem olhar para baixo.</h3><p class="game-instruction">Passos firmes são seguros. Passos ousados atravessam mais rápido, mas qualquer erro encerra a atração.</p>
        <div class="meter"><div class="meter-fill" style="width:${Math.min(100,progress*10)}%"></div></div><div class="result-badge">PROGRESSO ${progress}/10</div>
        <div class="choice-grid"><button class="choice-btn game-action" data-action="step" data-value="safe" ${!canPlay?'disabled':''}>PASSO FIRME<br><small>+1 • risco baixo</small></button><button class="choice-btn game-action" data-action="step" data-value="bold" ${!canPlay?'disabled':''}>PASSO OUSADO<br><small>+2 ou +3 • risco alto</small></button></div>${s.last?`<div class="history">${esc(s.last)}</div>`:''}${wait}</div>`; }
      case 'oracle': return `<div class="game-card-center oracle-scene"><div class="crystal-wrap"><div class="crystal-ball"><span>${s.attempts?Math.max(0,5-s.attempts):'?'}</span></div><div class="crystal-smoke"></div></div><h3>O Oráculo escolheu um número de 1 a 20.</h3><p class="game-instruction">Você possui cinco tentativas. Cada erro faz a névoa sussurrar MAIOR ou MENOR.</p><div class="result-badge">TENTATIVAS ${s.attempts||0}/5</div><div class="oracle-input"><input id="oracle-guess" type="number" min="1" max="20" placeholder="1–20" ${!canPlay?'disabled':''}><button id="oracle-submit" class="btn btn-red" ${!canPlay?'disabled':''}>CONSULTAR</button></div><div class="history oracle-history">${(s.history||[]).map(h=>`<div>${esc(h)}</div>`).join('')||'A névoa ainda não respondeu.'}</div>${wait}</div>`;
      case 'darts': {
        const throws=Number(s.throws||0), score=Number(s.score||0), precision=Number(s.last_precision??-1);
        return `<div class="game-card-center darts-scene">
          <div class="dart-stage"><div class="dartboard"><span class="ring r1"></span><span class="ring r2"></span><span class="ring r3"></span><span class="bull">✦</span>${precision>=0?`<span class="dart-hit" style="--miss:${Math.min(44,Math.abs(precision-50)*.88)}px"></span>`:''}</div></div>
          <h3>Dardo ${Math.min(5,throws+1)} de 5</h3>
          <p class="game-instruction">O marcador vai de um lado ao outro. Pare o ponteiro o mais perto possível do centro. A cada arremesso ele fica mais rápido. Só o centro perfeito pontua.</p>
          <div class="skill-check-wrap">
            <div class="skill-check-bar"><div class="skill-danger left"></div><div class="skill-good"></div><div class="skill-bull"></div><div class="skill-danger right"></div><div id="dart-needle" class="skill-needle"></div></div>
            <button id="dart-stop" class="btn btn-red" ${!canPlay?'disabled':''}>LANÇAR!</button>
          </div>
          <div class="score-row"><div class="score-box"><strong>${score}</strong>CENTROS</div><div class="score-box"><strong>${throws}/5</strong>DARDOS</div></div>
          <div class="history">${(s.history||[]).map(h=>`<div>${esc(h)}</div>`).join('')||'O primeiro dardo reluz sob o refletor.'}</div>${wait}</div>`;
      }
      case 'cards': {
        const clues=s.clues||{}, choices=s.last_choices||{}, success=Number(s.success||0);
        const p1=g.participants[0], p2=g.participants[1];
        const sym=x=>x==='sun'?'☀':x==='moon'?'☾':x==='star'?'★':'?';
        return `<div class="game-card-center cards-scene"><h3>Cartas da Cartomante</h3>
          <p class="game-instruction">O circo esconde um único símbolo. Cada jogador recebe uma pista diferente. Juntem as pistas e escolham o MESMO símbolo correto. Vocês jogam juntos contra a Cartomante.</p>
          <div class="coop-banner">VOCÊS DOIS <span>VS</span> O CIRCO</div>
          <div class="clue-grid">
            <div class="clue-card"><strong>PISTA DE ${esc(p1?.name||'JOGADOR 1')}</strong><span>${esc(clues[p1?.id]||'A carta ainda está virada.')}</span></div>
            <div class="clue-card"><strong>PISTA DE ${esc(p2?.name||'JOGADOR 2')}</strong><span>${esc(clues[p2?.id]||'A carta ainda está virada.')}</span></div>
          </div>
          <div class="duel-table coop-table">${g.participants.map(p=>`<div class="duelist"><div class="duel-name">${esc(p.name)}</div><div class="tarot-card ${choices[p.id]?'card-reveal':''}"><div class="card-back">✦</div><div class="card-face">${sym(choices[p.id])}</div></div></div>`).join('')}</div>
          <div class="cards-row"><button class="choice-btn game-action" data-action="card" data-value="sun" ${!canPlay?'disabled':''}><span class="choice-icon">☀</span>SOL</button><button class="choice-btn game-action" data-action="card" data-value="moon" ${!canPlay?'disabled':''}><span class="choice-icon">☾</span>LUA</button><button class="choice-btn game-action" data-action="card" data-value="star" ${!canPlay?'disabled':''}><span class="choice-icon">★</span>ESTRELA</button></div>
          <div class="score-row"><div class="score-box"><strong>${success}/3</strong>ACERTOS</div><div class="score-box"><strong>${s.round||1}/4</strong>RODADA</div></div><div class="small-note">${s.pending_count||0}/2 respostas entregues</div>${s.last?`<div class="history">${esc(s.last)}</div>`:''}${wait}</div>`;
      }
      case 'bones': {
        const budgets=s.budgets||{}, bids=s.last_bids||{}, success=Number(s.success||0), target=Number(s.target||0);
        return `<div class="game-card-center bones-scene"><div class="bone-pile">☠ ☠ ☠ ☠ ☠</div><h3>O Cofre de Ossos</h3>
          <p class="game-instruction">O Circo exige exatamente <strong>${target} ossos</strong>. Cada um fecha uma quantidade na mão sem ver a escolha do outro. Se a soma for exata, o cofre abre.</p>
          <div class="coop-banner">VOCÊS DOIS <span>VS</span> O COFRE</div>
          <div class="score-row">${g.participants.map(p=>`<div class="score-box bone-player"><strong>${budgets[p.id]??10} ☠</strong>${esc(p.name)}${bids[p.id]!==undefined?`<div class="bid-reveal">última oferta: ${bids[p.id]}</div>`:''}</div>`).join('')}</div>
          <div class="target-number">${target}</div>
          <div class="oracle-input"><input id="bone-bid" type="number" min="0" max="10" placeholder="Sua oferta" ${!canPlay?'disabled':''}><button id="bone-submit" class="btn btn-red" ${!canPlay?'disabled':''}>FECHAR A MÃO</button></div>
          <div class="score-row"><div class="score-box"><strong>${success}/2</strong>COFRES ABERTOS</div><div class="score-box"><strong>${s.round||1}/3</strong>RODADA</div></div><div class="small-note">${s.pending_count||0}/2 mãos fechadas</div>${s.last?`<div class="history">${esc(s.last)}</div>`:''}${wait}</div>`;
      }
      case 'mirrors': {
        const cracked=s.last&&String(s.last).includes('rachou');
        return `<div class="game-card-center mirrors-scene"><div class="mirror-frame ${cracked?'mirror-cracked':''}"><div class="mirror-glass"><span>${esc(s.puzzle?.question||'…')}</span></div></div><h3>Espelhos Gêmeos</h3><p class="game-instruction">Vocês dois enfrentam o próprio Circo. Ambos precisam responder corretamente para manter o reflexo inteiro. Três reflexos perfeitos vencem a atração.</p><div class="coop-banner">VOCÊS DOIS <span>VS</span> O ESPELHO</div><div class="choice-grid">${(s.puzzle?.options||[]).map(o=>`<button class="choice-btn game-action" data-action="answer" data-value="${esc(o)}" ${!canPlay?'disabled':''}>${esc(o)}</button>`).join('')}</div><div class="score-row"><div class="score-box"><strong>${s.success||0}/3</strong>REFLEXOS</div><div class="score-box"><strong>${s.round||1}/4</strong>RODADA</div></div><div class="small-note">${s.pending_count||0}/2 respostas entregues</div>${s.last?`<div class="history">${esc(s.last)}</div>`:''}${wait}</div>`;
      }
    }
    return '<div class="game-card-center">A atração está sendo preparada.</div>';
  }

  function runGameVisuals(g,canPlay){
    if(g.game_key==='cups' && g.status==='active') runCupShuffle(g,canPlay);
    if(g.game_key==='roulette' && g.state?.result){
      const reveal=$('roulette-reveal'); if(reveal){ setTimeout(()=>reveal.classList.add('show'),2600); }
    }
    if(g.game_key==='darts' && g.status==='active') runDartSkill(g,canPlay);
  }

  function runCupShuffle(g,canPlay){
    const table=$('cup-table'), pearl=$('pearl'), caption=$('shuffle-caption');
    if(!table||!pearl) return;
    const cups=[...table.querySelectorAll('.circus-cup')];
    const bySlot={1:cups[0],2:cups[1],3:cups[2]};
    const setCup=(el,slot,extra='')=>{ el.dataset.slot=slot; el.style.transform=`translateX(${(slot-2)*155}px) ${extra}`; };
    cups.forEach((c,i)=>setCup(c,i+1));

    const revealed=Number(g.state?.reveal||0);
    const initial=Number(g.state?.initial_pearl||2);
    if(revealed){
      pearl.classList.remove('pearl-hide');
      pearl.style.transform=`translateX(${(revealed-2)*155}px)`;
      cups.forEach((c,i)=>setCup(c,i+1, revealed===i+1?'translateY(-72px)':'translateY(-12px)'));
      return;
    }

    const sequence=g.state?.shuffle||[];
    const startsAt=Date.parse(g.state?.shuffle_starts_at||g.state?.shuffle_started_at||'')||Date.now();
    const now=Date.now();
    const elapsed=now-startsAt;
    const revealLift=1400, revealDrop=1750, firstSwap=2200, gap=205, readyAt=firstSwap+sequence.length*gap+260;
    const swapAt=i=>firstSwap+i*gap;
    const applySwap=pair=>{
      const [a,b]=pair.map(Number), ca=bySlot[a], cb=bySlot[b];
      bySlot[a]=cb; bySlot[b]=ca; setCup(ca,b); setCup(cb,a);
      table.classList.add('shuffle-jolt'); setTimeout(()=>table.classList.remove('shuffle-jolt'),70);
    };

    if(elapsed>=0){
      sequence.forEach((pair,i)=>{ if(elapsed>=swapAt(i)) applySwap(pair); });
    }

    if(elapsed<0){
      setCup(cups[initial-1],initial,'translateY(-78px)');
      pearl.classList.remove('pearl-hide');
      pearl.style.transform=`translateX(${(initial-2)*155}px)`;
      caption.textContent='O ARLEQUIM ESTÁ SE PREPARANDO…';
    }else if(elapsed<revealLift){
      setCup(cups[initial-1],initial,'translateY(-78px)');
      pearl.classList.remove('pearl-hide');
      pearl.style.transform=`translateX(${(initial-2)*155}px)`;
      caption.textContent=`OLHE BEM: A PÉROLA ESTÁ SOB O COPO ${initial}`;
    }else if(elapsed<revealDrop){
      setCup(cups[initial-1],initial,'translateY(0)');
      pearl.classList.remove('pearl-hide');
      pearl.style.transform=`translateX(${(initial-2)*155}px)`;
      caption.textContent='O COPO VAI DESCER…';
    }else{
      pearl.classList.add('pearl-hide');
      caption.textContent='NÃO PISQUE.';
    }

    sequence.forEach((pair,i)=>{
      const when=swapAt(i); if(when<=elapsed) return;
      setTimeout(()=>{ if(!table.isConnected)return; applySwap(pair); pearl.classList.add('pearl-hide'); caption.textContent=i<6?'ACOMPANHE O COPO…':'MAIS RÁPIDO!'; },Math.max(0,when-elapsed));
    });
    const ready=()=>{
      if(!table.isConnected)return;
      caption.textContent='AGORA. EM QUAL COPO ESTÁ A PÉROLA?';
      table.classList.add('cups-ready'); if(canPlay)cups.forEach(c=>c.disabled=false);
    };
    if(elapsed>=readyAt) ready(); else setTimeout(ready,Math.max(0,readyAt-elapsed));
  }

  function runDartSkill(g,canPlay){
    const needle=$('dart-needle'), stop=$('dart-stop');
    if(!needle||!stop) return;
    const throws=Number(g.state?.throws||0);
    const duration=Math.max(520,1250-throws*155);
    const epoch=Date.now();
    const tick=()=>{
      if(!needle.isConnected) return;
      const t=((Date.now()-epoch)%duration)/duration;
      const pos=t<.5?t*200:(1-t)*200;
      needle.style.left=`${pos}%`;
      needle.dataset.pos=String(pos);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    if(canPlay){
      stop.onclick=()=>{
        const pos=Math.max(0,Math.min(100,Number(needle.dataset.pos||0)));
        stop.disabled=true;
        sendGameAction(g.id,'throw',{value:pos.toFixed(2)});
      };
    }
  }

  function bindGameActions(g,canPlay){
    if(!canPlay) return;
    document.querySelectorAll('.game-action').forEach(btn=>btn.onclick=()=>sendGameAction(g.id,btn.dataset.action,{value:btn.dataset.value}));
    if($('oracle-submit')) $('oracle-submit').onclick=()=>{ const v=Number($('oracle-guess').value); if(v>=1&&v<=20) sendGameAction(g.id,'guess',{value:v}); else toast('Escolha um número entre 1 e 20.'); };
    if($('bone-submit')) $('bone-submit').onclick=()=>{ const v=Number($('bone-bid').value); if(Number.isInteger(v)&&v>=0) sendGameAction(g.id,'bid',{value:v}); else toast('Digite uma oferta válida.'); };
  }

  async function sendGameAction(gameId,action,payload){
    try{ await rpc('circus_game_action',{p_game_id:gameId,p_player_id:auth.playerId,p_player_key:auth.key,p_action:action,p_payload:payload}); await loadState(false); }catch(e){ toast(errMsg(e)); }
  }

  function openGameModal(){
    if(auth.role!=='host'||(state.active_game && state.active_game.status==='active')) return;
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
    const g=state.active_game;
    if(!g) return toast('Não há atração no picadeiro.');
    const msg=g.status==='active'?'Encerrar a atração atual antes do fim?':'Fechar as cortinas e limpar o picadeiro para a próxima atração?';
    if(!confirm(msg)) return;
    try{ await rpc('circus_end_game',{p_room_id:auth.roomId,p_host_key:auth.key}); await loadState(false); }catch(e){ toast(errMsg(e)); }
  }

  async function awardTickets(delta){
    const pid=$('ticket-player-select').value; if(!pid) return toast('Escolha um jogador.');
    try{ await rpc('circus_award_tickets',{p_room_id:auth.roomId,p_host_key:auth.key,p_player_id:pid,p_delta:delta}); await loadState(false); toast(`${delta>0?'+':''}${delta} ticket${Math.abs(delta)===1?'':'s'} aplicado.`); }catch(e){ toast(errMsg(e)); }
  }

  setupHome();
  if(auth && !badConfig) enterRoom(); else showScreen('home');
})();
