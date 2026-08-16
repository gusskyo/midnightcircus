(() => {
  const cfg = window.CIRCUS_CONFIG || {};
  const badConfig = !cfg.supabaseUrl || !cfg.supabaseKey || cfg.supabaseUrl.includes('COLE_') || cfg.supabaseKey.includes('COLE_');
  const sb = badConfig ? null : window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey);

  const GAMES = {
    roulette: {title:'Roleta Rubra', icon:'◉', min:1,max:1,type:'SORTE', desc:'Escolha uma cor e entregue seu destino à roda.'},
    cups: {title:'Copos do Arlequim', icon:'♠', min:1,max:1,type:'ATENÇÃO', desc:'Veja a pérola, acompanhe o embaralhamento e encontre o copo certo.'},
    tightrope: {title:'Corda do Acrobata', icon:'⚖', min:1,max:1,type:'REFLEXO', desc:'Alterne as teclas rapidamente para manter o equilíbrio sobre a corda.'},
    oracle: {title:'Oráculo dos Números', icon:'✦', min:1,max:1,type:'RACIOCÍNIO', desc:'Descubra o número secreto usando apenas as pistas do oráculo.'},
    darts: {title:'Dardos do Diabo', icon:'✥', min:1,max:1,type:'HABILIDADE', desc:'Pare o marcador no centro. A cada dardo, a barra fica mais rápida.'},
    cards: {title:'Cartas da Cartomante', icon:'♦', min:2,max:2,type:'RACIOCÍNIO COOPERATIVO', desc:'Juntem duas pistas para descobrir qual símbolo o circo esconde.'},
    bones: {title:'Cofre de Ossos', icon:'☠', min:2,max:2,type:'COOPERAÇÃO', desc:'Cada jogador recebe ossos de pesos diferentes. Escolham um de cada mão para equilibrar o cofre.'},
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
        const posName=n=>n===1?'ESQUERDA':n===2?'CENTRO':'DIREITA';
        return `<div class="game-card-center cups-scene">
          <div class="arlequin-title">♠ O ARLEQUIM SORRI ♠</div>
          <h3>${revealed?'A escolha foi feita.':'Siga a pérola com os olhos.'}</h3>
          <p class="game-instruction">O Arlequim ergue um copo, esconde a pérola e troca os copos em movimentos claros. Não há números nos copos: escolha pela posição final.</p>
          <div id="cup-table" class="cup-table ${revealed?'cups-finished':''}">
            <div id="pearl" class="pearl ${revealed?'pearl-revealed':''}">●</div>
            ${[1,2,3].map(i=>`<button class="circus-cup game-action ${i===initial&&!revealed?'cup-initial':''} ${picked===i?'cup-picked':''} ${revealed===i?'cup-winner':''}" data-cup="${i}" data-action="pick" data-value="${i}" ${(!canPlay||!revealed)?'disabled':''}><span class="cup-top"></span><span class="cup-body"><span class="cup-mark">♠</span></span></button>`).join('')}
            <div class="cup-position-label left">ESQUERDA</div><div class="cup-position-label center">CENTRO</div><div class="cup-position-label right">DIREITA</div>
          </div>
          <div id="shuffle-caption" class="result-badge">${revealed?`A pérola terminou à ${posName(revealed)}.`:`MEMORIZE: ${posName(initial)}`}</div>
          ${wait}</div>`;
      }
      case 'tightrope': {
        const round=Number(s.round||1), taps=Number(s.live_taps||0), target=Number(s.target||18), active=!!s.round_active;
        const pct=Math.min(100,(taps/Math.max(1,target))*100);
        return `<div class="game-card-center tightrope-scene">
          <div class="circus-sky"><div class="spotlight-cone"></div><div class="rope-line"></div><div class="acrobat" style="left:${12+Math.min(76,pct*.76)}%">♟</div></div>
          <h3>Corda do Acrobata — Travessia ${round}/3</h3>
          <p class="game-instruction">Quando o sinal aparecer, alterne <strong>A</strong> e <strong>D</strong> o mais rápido possível. Repetir a mesma tecla não conta. Cada travessia fica mais exigente.</p>
          <div class="rope-keys"><kbd id="rope-key-a">A</kbd><span>↔</span><kbd id="rope-key-d">D</kbd></div>
          <div class="meter"><div class="meter-fill" style="width:${pct}%"></div></div>
          <div class="score-row"><div class="score-box"><strong id="rope-taps">${taps}</strong>ALTERNÂNCIAS</div><div class="score-box"><strong>${target}</strong>META</div></div>
          <div id="rope-countdown" class="result-badge">${active?'MANTENHA O EQUILÍBRIO!':'PREPARE-SE…'}</div>
          ${s.last?`<div class="history">${esc(s.last)}</div>`:''}${wait}</div>`;
      }
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
        const sym=x=>x==='sun'?'☀':x==='moon'?'☾':x==='star'?'★':x==='eye'?'◉':x==='key'?'⚿':'?';
        const visibleClues=Object.entries(clues);
        return `<div class="game-card-center cards-scene"><h3>Cartas da Cartomante</h3>
          <p class="game-instruction">A Cartomante esconde um símbolo. Cada jogador recebe <strong>somente uma pista</strong>. Conversem e deduzam juntos. Espectadores e mestre enxergam as duas pistas.</p>
          <div class="coop-banner">VOCÊS DOIS <span>VS</span> A CARTOMANTE</div>
          <div class="clue-grid ${visibleClues.length===1?'single-clue':''}">${visibleClues.map(([id,clue])=>{const pp=g.participants.find(x=>x.id===id);return `<div class="clue-card"><strong>PISTA DE ${esc(pp?.name||'JOGADOR')}</strong><span>${esc(clue)}</span></div>`}).join('')}</div>
          <div class="duel-table coop-table">${g.participants.map(p=>`<div class="duelist"><div class="duel-name">${esc(p.name)}</div><div class="tarot-card ${choices[p.id]?'card-reveal':''}"><div class="card-back">✦</div><div class="card-face">${sym(choices[p.id])}</div></div></div>`).join('')}</div>
          <div class="cards-row five-symbols"><button class="choice-btn game-action" data-action="card" data-value="sun" ${!canPlay?'disabled':''}>☀<small>SOL</small></button><button class="choice-btn game-action" data-action="card" data-value="moon" ${!canPlay?'disabled':''}>☾<small>LUA</small></button><button class="choice-btn game-action" data-action="card" data-value="star" ${!canPlay?'disabled':''}>★<small>ESTRELA</small></button><button class="choice-btn game-action" data-action="card" data-value="eye" ${!canPlay?'disabled':''}>◉<small>OLHO</small></button><button class="choice-btn game-action" data-action="card" data-value="key" ${!canPlay?'disabled':''}>⚿<small>CHAVE</small></button></div>
          <div class="score-row"><div class="score-box"><strong>${success}/3</strong>ACERTOS</div><div class="score-box"><strong>${s.round||1}/4</strong>RODADA</div></div><div class="small-note">${s.pending_count||0}/2 respostas entregues</div>${s.last?`<div class="history">${esc(s.last)}</div>`:''}${wait}</div>`;
      }
      case 'bones': {
        const target=Number(s.target||0), success=Number(s.success||0), hands=s.hands||{}, used=s.used||{}, last=s.last||'';
        return `<div class="game-card-center bones-scene"><div class="bone-pile">☠ ✦ ☠ ✦ ☠</div><h3>O Cofre de Ossos</h3>
          <p class="game-instruction">A fechadura exige peso <strong>${target}</strong>. Cada jogador possui três ossos com pesos diferentes e vê apenas a própria mão. Escolham <strong>um osso cada</strong>; a soma precisa ser exatamente o número gravado no cofre.</p>
          <div class="coop-banner">VOCÊS DOIS <span>VS</span> A BALANÇA DO CIRCO</div>
          <div class="target-number">${target}</div>
          <div class="bone-hands">${Object.entries(hands).map(([id,arr])=>{const pp=g.participants.find(x=>x.id===id);return `<div class="bone-hand"><strong>${esc(pp?.name||'JOGADOR')}</strong><div class="bone-options">${arr.map((val,idx)=>`<button class="bone-piece game-action" data-action="bone" data-value="${idx}" ${!canPlay||id!==auth.playerId?'disabled':''}><span>☠</span><b>${val}</b></button>`).join('')}</div></div>`}).join('')}</div>
          <div class="score-row"><div class="score-box"><strong>${success}/2</strong>FECHADURAS</div><div class="score-box"><strong>${s.round||1}/3</strong>RODADA</div></div><div class="small-note">${s.pending_count||0}/2 ossos colocados na balança</div>${last?`<div class="history">${esc(last)}</div>`:''}${wait}</div>`;
      }
      case 'mirrors': {
        const cracked=s.last&&String(s.last).includes('rachou');
        return `<div class="game-card-center mirrors-scene"><div class="mirror-frame ${cracked?'mirror-cracked':''}"><div class="mirror-glass"><span>${esc(s.puzzle?.question||'…')}</span></div></div><h3>Espelhos Gêmeos</h3><p class="game-instruction">Vocês dois enfrentam o próprio Circo. Ambos precisam responder corretamente para manter o reflexo inteiro. Três reflexos perfeitos vencem a atração.</p><div class="coop-banner">VOCÊS DOIS <span>VS</span> O ESPELHO</div><div class="choice-grid">${(s.puzzle?.options||[]).map(o=>`<button class="choice-btn game-action" data-action="answer" data-value="${esc(o)}" ${!canPlay?'disabled':''}>${esc(o)}</button>`).join('')}</div><div class="score-row"><div class="score-box"><strong>${s.success||0}/3</strong>REFLEXOS</div><div class="score-box"><strong>${s.round||1}/4</strong>RODADA</div></div><div class="small-note">${s.pending_count||0}/2 respostas entregues</div>${s.last?`<div class="history">${esc(s.last)}</div>`:''}${wait}</div>`;
      }
    }
    return '<div class="game-card-center">A atração está sendo preparada.</div>';
  }

  function runGameVisuals(g,canPlay){
    if(g.game_key==='cups') runCupShuffle(g,canPlay);
    if(g.game_key==='roulette' && g.state?.result){
      const reveal=$('roulette-reveal'); if(reveal){ setTimeout(()=>reveal.classList.add('show'),2600); }
    }
    if(g.game_key==='darts' && g.status==='active') runDartSkill(g,canPlay);
    if(g.game_key==='tightrope' && g.status==='active') runRopeSkill(g,canPlay);
  }

  function runCupShuffle(g,canPlay){
    const table=$('cup-table'), pearl=$('pearl'), caption=$('shuffle-caption');
    if(!table||!pearl) return;

    const cups=[...table.querySelectorAll('.circus-cup')];
    const bySlot={1:cups[0],2:cups[1],3:cups[2]};
    const initial=Number(g.state?.initial_pearl||2);
    const revealed=Number(g.state?.reveal||0);
    const posName=n=>n===1?'ESQUERDA':n===2?'CENTRO':'DIREITA';

    const setCup=(el,slot,extra='')=>{
      if(!el)return;
      el.dataset.slot=slot;
      el.dataset.value=slot;
      el.style.transform=`translateX(${(slot-2)*175}px) ${extra}`;
    };
    const setPearlSlot=slot=>{
      pearl.style.transform=`translateX(${(slot-2)*175}px)`;
    };
    cups.forEach((c,i)=>setCup(c,i+1));

    // Jogo já terminou: revela a posição final.
    if(revealed){
      pearl.classList.remove('pearl-hide');
      setPearlSlot(revealed);
      Object.entries(bySlot).forEach(([slot,c])=>setCup(c,Number(slot),Number(slot)===revealed?'translateY(-82px)':'translateY(-8px)'));
      caption.textContent=`A PÉROLA ESTAVA À ${posName(revealed)}.`;
      return;
    }

    const sequence=g.state?.shuffle||[];
    const startsAt=Date.parse(g.state?.shuffle_starts_at||'')||Date.now();
    const now=Date.now();

    // Linha do tempo relativa ao instante em que a pérola é mostrada.
    const REVEAL_MS=2600;       // copo fica levantado com a pérola visível
    const DROP_MS=700;          // tempo para o copo descer
    const FIRST_SWAP_MS=REVEAL_MS+DROP_MS+450;
    const gaps=[560,510,455,400,350,310,275,245];
    const swapTimes=[];
    let acc=FIRST_SWAP_MS;
    sequence.forEach((_,i)=>{ swapTimes.push(acc); acc+=gaps[Math.min(i,gaps.length-1)]; });
    const READY_MS=acc+500;

    const applySwap=pair=>{
      const [a,b]=pair.map(Number), ca=bySlot[a], cb=bySlot[b];
      if(!ca||!cb)return;
      bySlot[a]=cb; bySlot[b]=ca;
      ca.classList.add('cup-moving');
      cb.classList.add('cup-moving');
      setCup(ca,b);
      setCup(cb,a);
      setTimeout(()=>{
        if(ca.isConnected)ca.classList.remove('cup-moving');
        if(cb.isConnected)cb.classList.remove('cup-moving');
      },220);
    };

    const showPearl=()=>{
      if(!table.isConnected)return;
      cups.forEach((c,i)=>setCup(c,i+1));
      const initialCup=cups[initial-1];
      setCup(initialCup,initial,'translateY(-90px)');
      setPearlSlot(initial);
      pearl.classList.remove('pearl-hide');
      pearl.classList.add('pearl-attention');
      caption.textContent=`● A PÉROLA ESTÁ À ${posName(initial)} ●`;
      table.classList.add('pearl-showing');
    };

    const dropCup=()=>{
      if(!table.isConnected)return;
      const initialCup=cups[initial-1];
      setCup(initialCup,initial,'translateY(0)');
      pearl.classList.remove('pearl-attention');
      caption.textContent=`MEMORIZE O COPO DA ${posName(initial)}…`;
    };

    const hidePearl=()=>{
      if(!table.isConnected)return;
      pearl.classList.add('pearl-hide');
      table.classList.remove('pearl-showing');
      caption.textContent='NÃO TIRE OS OLHOS DO COPO.';
    };

    const ready=()=>{
      if(!table.isConnected)return;
      caption.textContent='AGORA ESCOLHA: ESQUERDA, CENTRO OU DIREITA.';
      table.classList.add('cups-ready');
      if(canPlay)cups.forEach(c=>c.disabled=false);
    };

    const elapsed=now-startsAt;

    // Reconstrói o estado correto para alguém que entrou/recarregou no meio da animação.
    if(elapsed < 0){
      pearl.classList.add('pearl-hide');
      caption.textContent='O ARLEQUIM PREPARA A PÉROLA…';
    } else if(elapsed < REVEAL_MS){
      showPearl();
    } else if(elapsed < REVEAL_MS+DROP_MS){
      showPearl();
      dropCup();
    } else {
      pearl.classList.add('pearl-hide');
      sequence.forEach((pair,i)=>{ if(elapsed>=swapTimes[i]) applySwap(pair); });
      caption.textContent=elapsed>=READY_MS?'AGORA ESCOLHA: ESQUERDA, CENTRO OU DIREITA.':'NÃO TIRE OS OLHOS DO COPO.';
    }

    // IMPORTANTE: agenda também a revelação. Esse timer era o que faltava na V5.
    if(elapsed<0){
      setTimeout(showPearl,Math.max(0,-elapsed));
    }
    if(elapsed<REVEAL_MS){
      setTimeout(dropCup,Math.max(0,REVEAL_MS-elapsed));
    }
    if(elapsed<REVEAL_MS+DROP_MS){
      setTimeout(hidePearl,Math.max(0,REVEAL_MS+DROP_MS-elapsed));
    }

    sequence.forEach((pair,i)=>{
      const when=swapTimes[i];
      if(when<=elapsed)return;
      setTimeout(()=>{
        if(!table.isConnected)return;
        hidePearl();
        applySwap(pair);
        caption.textContent=i<2?'SIGA O COPO…':i<5?'O ARLEQUIM ACELERA…':'ÚLTIMAS TROCAS!';
      },Math.max(0,when-elapsed));
    });

    if(elapsed>=READY_MS) ready();
    else setTimeout(ready,Math.max(0,READY_MS-elapsed));
  }

  function runDartSkill(g,canPlay){
    const needle=$('dart-needle'), stop=$('dart-stop');
    if(!needle||!stop) return;
    const readyAt=Date.parse(g.state?.dart_ready_at||'')||Date.now();
    const duration=Number(g.state?.dart_duration_ms||1500);
    let frozen=false, raf=0;

    const tick=()=>{
      if(!needle.isConnected||frozen) return;
      const now=Date.now();
      if(now<readyAt){
        const left=Math.max(0,(readyAt-now)/1000);
        stop.disabled=true;
        stop.textContent=`PREPARE-SE… ${left.toFixed(1)}`;
        needle.style.left='50%';
        raf=requestAnimationFrame(tick); return;
      }
      if(canPlay){ stop.disabled=false; stop.textContent='LANÇAR!'; }
      const t=((now-readyAt)%duration)/duration;
      const pos=t<.5?t*200:(1-t)*200;
      needle.style.left=`${pos}%`; needle.dataset.pos=String(pos);
      raf=requestAnimationFrame(tick);
    };
    raf=requestAnimationFrame(tick);

    if(canPlay){
      stop.onclick=()=>{
        if(Date.now()<readyAt||frozen)return;
        frozen=true; cancelAnimationFrame(raf);
        const pos=Math.max(0,Math.min(100,Number(needle.dataset.pos||50)));
        stop.disabled=true; stop.textContent='DARDO LANÇADO!';
        needle.classList.add('needle-frozen');
        sendGameAction(g.id,'throw',{value:pos.toFixed(2)});
      };
    }
  }

  function runRopeSkill(g,canPlay){
    const counter=$('rope-taps'), caption=$('rope-countdown'), ka=$('rope-key-a'), kd=$('rope-key-d');
    if(!counter||!caption) return;
    const readyAt=Date.parse(g.state?.ready_at||'')||Date.now();
    const endAt=Date.parse(g.state?.ends_at||'')||readyAt;
    const round=Number(g.state?.round||1), target=Number(g.state?.target||18);
    let taps=Number(g.state?.live_taps||0), lastKey='', started=false, finished=false, lastSync=0;

    const sync=()=>{
      if(!canPlay||!started||finished)return;
      const now=Date.now(); if(now-lastSync<700)return; lastSync=now;
      rpc('circus_game_action',{p_game_id:g.id,p_player_id:auth.playerId,p_player_key:auth.key,p_action:'rope_sync',p_payload:{value:taps,round}}).catch(()=>{});
    };
    const keydown=e=>{
      if(!canPlay||!started||finished)return;
      const k=e.key.toLowerCase(); if(k!=='a'&&k!=='d')return;
      e.preventDefault(); if(k===lastKey)return;
      lastKey=k; taps++; counter.textContent=taps;
      (k==='a'?ka:kd)?.classList.add('key-hit'); setTimeout(()=> (k==='a'?ka:kd)?.classList.remove('key-hit'),90);
      const fill=document.querySelector('.tightrope-scene .meter-fill'); if(fill)fill.style.width=`${Math.min(100,taps/target*100)}%`;
      sync();
    };
    if(canPlay) window.addEventListener('keydown',keydown);

    const loop=()=>{
      if(!caption.isConnected){ if(canPlay)window.removeEventListener('keydown',keydown); return; }
      const now=Date.now();
      if(now<readyAt){ caption.textContent=`PREPARE-SE… ${Math.max(1,Math.ceil((readyAt-now)/1000))}`; }
      else if(now<endAt){ started=true; caption.textContent=`A ↔ D • ${(endAt-now)/1000|0}.${Math.floor(((endAt-now)%1000)/100)}s`; }
      else if(!finished){
        finished=true; if(canPlay)window.removeEventListener('keydown',keydown);
        caption.textContent='A CORDA DECIDIU…';
        if(canPlay) sendGameAction(g.id,'rope_finish',{value:taps,round});
        return;
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
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
