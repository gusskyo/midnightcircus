-- ============================================================
-- MIDNIGHT CIRCUS — JOGOS DA TENDA
-- Backend Supabase para GitHub Pages
-- Execute TODO este arquivo no SQL Editor do Supabase.
-- ============================================================

create extension if not exists pgcrypto with schema extensions;

-- -------------------- TABELAS --------------------
create table if not exists public.circus_rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  host_key_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.circus_players (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.circus_rooms(id) on delete cascade,
  name text not null,
  player_key_hash text not null,
  tickets integer not null default 0 check (tickets >= 0),
  joined_at timestamptz not null default now()
);

create unique index if not exists circus_players_unique_name
  on public.circus_players(room_id, lower(name));

create table if not exists public.circus_games (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.circus_rooms(id) on delete cascade,
  game_key text not null check (game_key in ('roulette','cups','tightrope','oracle','darts','cards','bones','mirrors')),
  status text not null default 'active' check (status in ('active','finished')),
  participant_ids uuid[] not null,
  public_state jsonb not null default '{}'::jsonb,
  secret_state jsonb not null default '{}'::jsonb,
  winner_ids uuid[] not null default '{}'::uuid[],
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

create unique index if not exists circus_one_active_game_per_room
  on public.circus_games(room_id) where status='active';

create table if not exists public.circus_logs (
  id bigserial primary key,
  room_id uuid not null references public.circus_rooms(id) on delete cascade,
  message text not null,
  created_at timestamptz not null default now()
);

-- -------------------- RLS / BLOQUEIO DIRETO --------------------
alter table public.circus_rooms enable row level security;
alter table public.circus_players enable row level security;
alter table public.circus_games enable row level security;
alter table public.circus_logs enable row level security;

revoke all on table public.circus_rooms from anon, authenticated;
revoke all on table public.circus_players from anon, authenticated;
revoke all on table public.circus_games from anon, authenticated;
revoke all on table public.circus_logs from anon, authenticated;

-- -------------------- HELPERS INTERNOS --------------------
create or replace function public.circus_log(p_room_id uuid, p_message text)
returns void language plpgsql security definer
set search_path=public, extensions
as $$
begin
  insert into public.circus_logs(room_id,message) values(p_room_id,p_message);
end;
$$;
revoke all on function public.circus_log(uuid,text) from public, anon, authenticated;

-- -------------------- CRIAR SALA --------------------
create or replace function public.circus_create_room(p_code text, p_host_key text)
returns jsonb language plpgsql security definer
set search_path=public, extensions
as $$
declare v_id uuid; v_code text;
begin
  v_code := upper(regexp_replace(trim(p_code),'[^A-Z0-9]','','g'));
  if length(v_code) < 4 or length(v_code) > 6 then raise exception 'O código deve ter entre 4 e 6 caracteres.'; end if;
  if exists(select 1 from public.circus_rooms where code=v_code) then raise exception 'Esse código já está em uso.'; end if;
  insert into public.circus_rooms(code,host_key_hash)
    values(v_code,crypt(p_host_key,gen_salt('bf'))) returning id into v_id;
  perform public.circus_log(v_id,'As portas do Midnight Circus foram abertas.');
  return jsonb_build_object('room_id',v_id,'code',v_code);
end;
$$;

-- -------------------- ENTRAR --------------------
create or replace function public.circus_join_room(p_code text, p_name text, p_player_key text)
returns jsonb language plpgsql security definer
set search_path=public, extensions
as $$
declare r public.circus_rooms%rowtype; v_id uuid; v_name text;
begin
  v_name:=trim(p_name);
  if length(v_name)<1 or length(v_name)>28 then raise exception 'Nome inválido.'; end if;
  select * into r from public.circus_rooms where code=upper(trim(p_code)) for update;
  if not found then raise exception 'Sala não encontrada.'; end if;
  if (select count(*) from public.circus_players where room_id=r.id)>=12 then raise exception 'A sessão atingiu o limite de 12 pessoas.'; end if;
  if exists(select 1 from public.circus_players where room_id=r.id and lower(name)=lower(v_name)) then raise exception 'Já existe alguém com esse nome na sala.'; end if;
  insert into public.circus_players(room_id,name,player_key_hash)
    values(r.id,v_name,crypt(p_player_key,gen_salt('bf'))) returning id into v_id;
  perform public.circus_log(r.id,v_name||' entrou na tenda.');
  return jsonb_build_object('room_id',r.id,'player_id',v_id,'code',r.code);
end;
$$;

-- -------------------- SAIR --------------------
create or replace function public.circus_leave_room(p_room_id uuid,p_player_id uuid,p_player_key text)
returns jsonb language plpgsql security definer
set search_path=public, extensions
as $$
declare p public.circus_players%rowtype;
begin
  select * into p from public.circus_players where id=p_player_id and room_id=p_room_id;
  if not found or crypt(p_player_key,p.player_key_hash)<>p.player_key_hash then raise exception 'Acesso inválido.'; end if;
  if exists(select 1 from public.circus_games where room_id=p_room_id and status='active' and p_player_id=any(participant_ids)) then
    raise exception 'Você está participando de uma atração. Espere ela terminar antes de sair.';
  end if;
  delete from public.circus_players where id=p_player_id;
  perform public.circus_log(p_room_id,p.name||' deixou a tenda.');
  return jsonb_build_object('ok',true);
end;
$$;

-- -------------------- DAR / REMOVER TICKETS --------------------
create or replace function public.circus_award_tickets(p_room_id uuid,p_host_key text,p_player_id uuid,p_delta integer)
returns jsonb language plpgsql security definer
set search_path=public, extensions
as $$
declare r public.circus_rooms%rowtype; p public.circus_players%rowtype; v_new integer;
begin
  select * into r from public.circus_rooms where id=p_room_id;
  if not found or crypt(p_host_key,r.host_key_hash)<>r.host_key_hash then raise exception 'Acesso de mestre inválido.'; end if;
  if p_delta < -50 or p_delta > 50 or p_delta=0 then raise exception 'Quantidade inválida.'; end if;
  select * into p from public.circus_players where id=p_player_id and room_id=p_room_id for update;
  if not found then raise exception 'Jogador não encontrado.'; end if;
  v_new:=greatest(0,p.tickets+p_delta);
  update public.circus_players set tickets=v_new where id=p_player_id;
  perform public.circus_log(p_room_id,p.name||case when p_delta>0 then ' recebeu '||p_delta else ' perdeu '||abs(p_delta) end||' ticket(s).');
  return jsonb_build_object('ok',true,'tickets',v_new);
end;
$$;

-- -------------------- INICIAR JOGO --------------------
create or replace function public.circus_start_game(p_room_id uuid,p_host_key text,p_game_key text,p_player_ids uuid[])
returns jsonb language plpgsql security definer
set search_path=public, extensions
as $$
declare r public.circus_rooms%rowtype; v_id uuid; v_count int; v_expected int; v_pub jsonb; v_sec jsonb; p1 text; p2 text;
begin
  select * into r from public.circus_rooms where id=p_room_id;
  if not found or crypt(p_host_key,r.host_key_hash)<>r.host_key_hash then raise exception 'Acesso de mestre inválido.'; end if;
  if exists(select 1 from public.circus_games where room_id=p_room_id and status='active') then raise exception 'Já existe uma atração em andamento.'; end if;
  if p_game_key not in ('roulette','cups','tightrope','oracle','darts','cards','bones','mirrors') then raise exception 'Jogo inválido.'; end if;
  v_count:=coalesce(array_length(p_player_ids,1),0);
  v_expected:=case when p_game_key in ('cards','bones','mirrors') then 2 else 1 end;
  if v_count<>v_expected then raise exception 'Quantidade de jogadores incorreta para esta atração.'; end if;
  if (select count(*) from public.circus_players where room_id=p_room_id and id=any(p_player_ids))<>v_expected then raise exception 'Um dos jogadores selecionados não pertence à sala.'; end if;

  p1:=p_player_ids[1]::text; if v_expected=2 then p2:=p_player_ids[2]::text; end if;
  case p_game_key
    when 'roulette' then v_pub:='{}'::jsonb; v_sec:='{}'::jsonb;
    when 'cups' then v_pub:='{}'::jsonb; v_sec:=jsonb_build_object('cup',floor(random()*3)::int+1);
    when 'tightrope' then v_pub:=jsonb_build_object('progress',0); v_sec:='{}'::jsonb;
    when 'oracle' then v_pub:=jsonb_build_object('attempts',0,'history','[]'::jsonb); v_sec:=jsonb_build_object('target',floor(random()*20)::int+1);
    when 'darts' then v_pub:=jsonb_build_object('score',0,'throws',0,'history','[]'::jsonb); v_sec:='{}'::jsonb;
    when 'cards' then v_pub:=jsonb_build_object('round',1,'pending_count',0,'scores',jsonb_build_object(p1,0,p2,0)); v_sec:=jsonb_build_object('moves','{}'::jsonb);
    when 'bones' then v_pub:=jsonb_build_object('round',1,'pending_count',0,'budgets',jsonb_build_object(p1,10,p2,10),'wins',jsonb_build_object(p1,0,p2,0)); v_sec:=jsonb_build_object('bids','{}'::jsonb);
    when 'mirrors' then v_pub:=jsonb_build_object('round',1,'pending_count',0,'success',0,'puzzle',jsonb_build_object('question','2 • 4 • 8 • 16 • ?','options',jsonb_build_array('24','32','34'))); v_sec:=jsonb_build_object('answer','32','answers','{}'::jsonb);
  end case;

  insert into public.circus_games(room_id,game_key,participant_ids,public_state,secret_state)
    values(p_room_id,p_game_key,p_player_ids,v_pub,v_sec) returning id into v_id;
  perform public.circus_log(p_room_id,'A atração “'||case p_game_key when 'roulette' then 'Roleta Rubra' when 'cups' then 'Copos do Arlequim' when 'tightrope' then 'Corda do Acrobata' when 'oracle' then 'Oráculo dos Números' when 'darts' then 'Dardos do Diabo' when 'cards' then 'Duelo das Cartas' when 'bones' then 'Leilão de Ossos' else 'Espelhos Gêmeos' end||'” começou.');
  return jsonb_build_object('ok',true,'game_id',v_id);
end;
$$;

-- -------------------- ENCERRAR MANUALMENTE --------------------
create or replace function public.circus_end_game(p_room_id uuid,p_host_key text)
returns jsonb language plpgsql security definer
set search_path=public, extensions
as $$
declare r public.circus_rooms%rowtype; g public.circus_games%rowtype;
begin
  select * into r from public.circus_rooms where id=p_room_id;
  if not found or crypt(p_host_key,r.host_key_hash)<>r.host_key_hash then raise exception 'Acesso de mestre inválido.'; end if;
  select * into g from public.circus_games where room_id=p_room_id and status='active' for update;
  if not found then raise exception 'Não há atração ativa.'; end if;
  update public.circus_games set status='finished',finished_at=now() where id=g.id;
  perform public.circus_log(p_room_id,'O mestre encerrou a atração.');
  return jsonb_build_object('ok',true);
end;
$$;

-- -------------------- AÇÃO DE JOGO --------------------
create or replace function public.circus_game_action(p_game_id uuid,p_player_id uuid,p_player_key text,p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer
set search_path=public, extensions
as $$
declare
  g public.circus_games%rowtype; p public.circus_players%rowtype;
  v text; n int; roll int; prog int; pts int; attempts int; target int; total int; throws_n int;
  p1 uuid; p2 uuid; k1 text; k2 text; a1 text; a2 text; s1 int; s2 int; round_n int; success_n int; win1 int; win2 int; b1 int; b2 int; bid int;
  pub jsonb; sec jsonb; hist jsonb; budgets jsonb; wins jsonb; scores jsonb; pending jsonb; lastmsg text; correct text;
begin
  select * into g from public.circus_games where id=p_game_id for update;
  if not found or g.status<>'active' then raise exception 'Essa atração não está ativa.'; end if;
  select * into p from public.circus_players where id=p_player_id and room_id=g.room_id;
  if not found or crypt(p_player_key,p.player_key_hash)<>p.player_key_hash then raise exception 'Acesso de jogador inválido.'; end if;
  if not (p_player_id=any(g.participant_ids)) then raise exception 'Você está apenas assistindo esta atração.'; end if;
  pub:=g.public_state; sec:=g.secret_state; v:=p_payload->>'value';

  -- ROLETA
  if g.game_key='roulette' then
    if p_action<>'pick' or v not in ('red','black','gold') then raise exception 'Escolha inválida.'; end if;
    roll:=floor(random()*12)::int+1;
    lastmsg:=case when roll=12 then 'DOURADO' when mod(roll,2)=1 then 'VERMELHO' else 'PRETO' end;
    update public.circus_games set public_state=jsonb_build_object('result',lastmsg,'roll',roll),status='finished',finished_at=now(),winner_ids=case when lower(lastmsg)=v then array[p_player_id] else '{}'::uuid[] end where id=g.id;
    perform public.circus_log(g.room_id,p.name||' apostou em '||upper(v)||'. A roleta parou em '||lastmsg||'.');

  -- COPOS
  elsif g.game_key='cups' then
    if p_action<>'pick' or v not in ('1','2','3') then raise exception 'Copo inválido.'; end if;
    n:=(sec->>'cup')::int;
    update public.circus_games set public_state=jsonb_build_object('reveal',n,'picked',v::int),status='finished',finished_at=now(),winner_ids=case when v::int=n then array[p_player_id] else '{}'::uuid[] end where id=g.id;
    perform public.circus_log(g.room_id,p.name||' escolheu o Copo '||v||'. A pérola estava no Copo '||n||'.');

  -- CORDA
  elsif g.game_key='tightrope' then
    if p_action<>'step' or v not in ('safe','bold') then raise exception 'Passo inválido.'; end if;
    prog:=coalesce((pub->>'progress')::int,0); roll:=floor(random()*100)::int+1;
    if (v='safe' and roll<=12) or (v='bold' and roll<=32) then
      lastmsg:=p.name||' perdeu o equilíbrio e caiu da corda.';
      update public.circus_games set public_state=pub||jsonb_build_object('last',lastmsg),status='finished',finished_at=now() where id=g.id;
      perform public.circus_log(g.room_id,lastmsg);
    else
      n:=case when v='safe' then 1 else floor(random()*2)::int+2 end; prog:=least(10,prog+n);
      lastmsg:=p.name||' avançou '||n||' espaço(s) pela corda.';
      update public.circus_games set public_state=pub||jsonb_build_object('progress',prog,'last',lastmsg),status=case when prog>=10 then 'finished' else 'active' end,finished_at=case when prog>=10 then now() else null end,winner_ids=case when prog>=10 then array[p_player_id] else '{}'::uuid[] end where id=g.id;
      perform public.circus_log(g.room_id,lastmsg||case when prog>=10 then ' Chegou ao outro lado!' else '' end);
    end if;

  -- ORÁCULO
  elsif g.game_key='oracle' then
    if p_action<>'guess' then raise exception 'Ação inválida.'; end if;
    n:=v::int; if n<1 or n>20 then raise exception 'O número deve estar entre 1 e 20.'; end if;
    attempts:=coalesce((pub->>'attempts')::int,0)+1; target:=(sec->>'target')::int; hist:=coalesce(pub->'history','[]'::jsonb);
    if n=target then
      lastmsg:='Tentativa '||attempts||': '||n||' — O véu se abriu. Você acertou.';
      update public.circus_games set public_state=pub||jsonb_build_object('attempts',attempts,'history',hist||jsonb_build_array(lastmsg)),status='finished',finished_at=now(),winner_ids=array[p_player_id] where id=g.id;
      perform public.circus_log(g.room_id,p.name||' desvendou o número do Oráculo: '||target||'.');
    elsif attempts>=5 then
      lastmsg:='Tentativa '||attempts||': '||n||' — Fim. O número era '||target||'.';
      update public.circus_games set public_state=pub||jsonb_build_object('attempts',attempts,'history',hist||jsonb_build_array(lastmsg)),status='finished',finished_at=now() where id=g.id;
      perform public.circus_log(g.room_id,'O Oráculo derrotou '||p.name||'. O número era '||target||'.');
    else
      lastmsg:='Tentativa '||attempts||': '||n||' — O número secreto é '||case when target>n then 'MAIOR.' else 'MENOR.' end;
      update public.circus_games set public_state=pub||jsonb_build_object('attempts',attempts,'history',hist||jsonb_build_array(lastmsg)) where id=g.id;
      perform public.circus_log(g.room_id,p.name||' tentou '||n||'. O Oráculo respondeu: '||case when target>n then 'MAIOR.' else 'MENOR.' end);
    end if;

  -- DARDOS
  elsif g.game_key='darts' then
    if p_action<>'throw' or v not in ('safe','risk','cursed') then raise exception 'Arremesso inválido.'; end if;
    throws_n:=coalesce((pub->>'throws')::int,0)+1; total:=coalesce((pub->>'score')::int,0); hist:=coalesce(pub->'history','[]'::jsonb);
    pts:=case when v='safe' then floor(random()*3)::int+3 when v='risk' then floor(random()*8)::int when random()<0.5 then 0 else 8 end;
    total:=total+pts; lastmsg:='Dardo '||throws_n||': '||upper(v)||' rendeu '||pts||' ponto(s).';
    if throws_n>=3 then
      update public.circus_games set public_state=pub||jsonb_build_object('throws',throws_n,'score',total,'history',hist||jsonb_build_array(lastmsg)),status='finished',finished_at=now(),winner_ids=case when total>=12 then array[p_player_id] else '{}'::uuid[] end where id=g.id;
      perform public.circus_log(g.room_id,p.name||' terminou os Dardos do Diabo com '||total||' pontos.');
    else
      update public.circus_games set public_state=pub||jsonb_build_object('throws',throws_n,'score',total,'history',hist||jsonb_build_array(lastmsg)) where id=g.id;
      perform public.circus_log(g.room_id,p.name||' marcou '||pts||' ponto(s) no arremesso.');
    end if;

  -- JOGOS DE 2 PARTICIPANTES
  else
    p1:=g.participant_ids[1]; p2:=g.participant_ids[2]; k1:=p1::text; k2:=p2::text;

    -- CARTAS
    if g.game_key='cards' then
      if p_action<>'card' or v not in ('sun','moon','star') then raise exception 'Carta inválida.'; end if;
      pending:=coalesce(sec->'moves','{}'::jsonb);
      if pending ? p_player_id::text then raise exception 'Sua escolha desta rodada já foi registrada.'; end if;
      pending:=jsonb_set(pending,array[p_player_id::text],to_jsonb(v),true);
      n:=(select count(*) from jsonb_object_keys(pending));
      if n<2 then
        update public.circus_games set secret_state=jsonb_set(sec,'{moves}',pending),public_state=jsonb_set(pub,'{pending_count}',to_jsonb(n)) where id=g.id;
        return jsonb_build_object('ok',true);
      end if;
      a1:=pending->>k1; a2:=pending->>k2; scores:=pub->'scores'; s1:=coalesce((scores->>k1)::int,0); s2:=coalesce((scores->>k2)::int,0);
      if a1=a2 then lastmsg:='Os dois revelaram '||upper(a1)||'. A rodada empatou.';
      elsif (a1='sun' and a2='moon') or (a1='moon' and a2='star') or (a1='star' and a2='sun') then s1:=s1+1; lastmsg:=(select name from public.circus_players where id=p1)||' venceu a rodada.';
      else s2:=s2+1; lastmsg:=(select name from public.circus_players where id=p2)||' venceu a rodada.'; end if;
      scores:=jsonb_build_object(k1,s1,k2,s2); round_n:=coalesce((pub->>'round')::int,1)+1;
      if s1>=2 or s2>=2 then
        update public.circus_games set public_state=pub||jsonb_build_object('scores',scores,'pending_count',0,'last',lastmsg),secret_state=jsonb_build_object('moves','{}'::jsonb),status='finished',finished_at=now(),winner_ids=case when s1>=2 then array[p1] else array[p2] end where id=g.id;
      else
        update public.circus_games set public_state=pub||jsonb_build_object('scores',scores,'pending_count',0,'round',round_n,'last',lastmsg),secret_state=jsonb_build_object('moves','{}'::jsonb) where id=g.id;
      end if;
      perform public.circus_log(g.room_id,'Duelo das Cartas: '||upper(a1)||' contra '||upper(a2)||'. '||lastmsg);

    -- OSSOS
    elsif g.game_key='bones' then
      if p_action<>'bid' then raise exception 'Ação inválida.'; end if;
      bid:=v::int; if bid<0 then raise exception 'Aposta inválida.'; end if;
      budgets:=pub->'budgets'; if bid>coalesce((budgets->>p_player_id::text)::int,0) then raise exception 'Você não possui tantos ossos.'; end if;
      pending:=coalesce(sec->'bids','{}'::jsonb); if pending ? p_player_id::text then raise exception 'Sua aposta já foi registrada.'; end if;
      pending:=jsonb_set(pending,array[p_player_id::text],to_jsonb(bid),true); n:=(select count(*) from jsonb_object_keys(pending));
      if n<2 then update public.circus_games set secret_state=jsonb_set(sec,'{bids}',pending),public_state=jsonb_set(pub,'{pending_count}',to_jsonb(n)) where id=g.id; return jsonb_build_object('ok',true); end if;
      b1:=(pending->>k1)::int; b2:=(pending->>k2)::int; budgets:=jsonb_build_object(k1,(budgets->>k1)::int-b1,k2,(budgets->>k2)::int-b2); wins:=pub->'wins'; win1:=coalesce((wins->>k1)::int,0); win2:=coalesce((wins->>k2)::int,0);
      if b1>b2 then win1:=win1+1; lastmsg:=(select name from public.circus_players where id=p1)||' venceu a rodada com '||b1||' ossos contra '||b2||'.';
      elsif b2>b1 then win2:=win2+1; lastmsg:=(select name from public.circus_players where id=p2)||' venceu a rodada com '||b2||' ossos contra '||b1||'.';
      else lastmsg:='As apostas empataram em '||b1||'. Ninguém domina a rodada.'; end if;
      wins:=jsonb_build_object(k1,win1,k2,win2); round_n:=coalesce((pub->>'round')::int,1);
      if round_n>=3 then
        update public.circus_games set public_state=pub||jsonb_build_object('budgets',budgets,'wins',wins,'pending_count',0,'last',lastmsg),secret_state=jsonb_build_object('bids','{}'::jsonb),status='finished',finished_at=now(),winner_ids=case when win1>win2 then array[p1] when win2>win1 then array[p2] when (budgets->>k1)::int>(budgets->>k2)::int then array[p1] when (budgets->>k2)::int>(budgets->>k1)::int then array[p2] else '{}'::uuid[] end where id=g.id;
      else
        update public.circus_games set public_state=pub||jsonb_build_object('budgets',budgets,'wins',wins,'pending_count',0,'round',round_n+1,'last',lastmsg),secret_state=jsonb_build_object('bids','{}'::jsonb) where id=g.id;
      end if;
      perform public.circus_log(g.room_id,'Leilão de Ossos: '||lastmsg);

    -- ESPELHOS
    elsif g.game_key='mirrors' then
      if p_action<>'answer' then raise exception 'Ação inválida.'; end if;
      if not (v = any(array(select jsonb_array_elements_text(pub->'puzzle'->'options')))) then raise exception 'Resposta inválida.'; end if;
      pending:=coalesce(sec->'answers','{}'::jsonb); if pending ? p_player_id::text then raise exception 'Sua resposta já foi registrada.'; end if;
      pending:=jsonb_set(pending,array[p_player_id::text],to_jsonb(v),true); n:=(select count(*) from jsonb_object_keys(pending));
      if n<2 then update public.circus_games set secret_state=sec||jsonb_build_object('answers',pending),public_state=jsonb_set(pub,'{pending_count}',to_jsonb(n)) where id=g.id; return jsonb_build_object('ok',true); end if;
      correct:=sec->>'answer'; a1:=pending->>k1; a2:=pending->>k2; success_n:=coalesce((pub->>'success')::int,0); round_n:=coalesce((pub->>'round')::int,1);
      if a1=correct and a2=correct then success_n:=success_n+1; lastmsg:='Os dois reflexos responderam '||correct||'. O espelho permaneceu inteiro.'; else lastmsg:='As respostas foram '||a1||' e '||a2||'. A resposta correta era '||correct||'. O espelho rachou.'; end if;
      if success_n>=3 then
        update public.circus_games set public_state=pub||jsonb_build_object('success',success_n,'pending_count',0,'last',lastmsg),status='finished',finished_at=now(),winner_ids=array[p1,p2] where id=g.id;
      elsif round_n>=4 then
        update public.circus_games set public_state=pub||jsonb_build_object('success',success_n,'pending_count',0,'last',lastmsg),status='finished',finished_at=now() where id=g.id;
      else
        round_n:=round_n+1;
        if round_n=2 then pub:=pub||jsonb_build_object('round',2,'pending_count',0,'success',success_n,'last',lastmsg,'puzzle',jsonb_build_object('question','▲ • ■ • ▲ • ■ • ▲ • ?','options',jsonb_build_array('▲','■','●'))); sec:=jsonb_build_object('answer','■','answers','{}'::jsonb);
        elsif round_n=3 then pub:=pub||jsonb_build_object('round',3,'pending_count',0,'success',success_n,'last',lastmsg,'puzzle',jsonb_build_object('question','1 • 1 • 2 • 3 • 5 • ?','options',jsonb_build_array('6','8','10'))); sec:=jsonb_build_object('answer','8','answers','{}'::jsonb);
        else pub:=pub||jsonb_build_object('round',4,'pending_count',0,'success',success_n,'last',lastmsg,'puzzle',jsonb_build_object('question','A • C • F • J • ?','options',jsonb_build_array('N','O','P'))); sec:=jsonb_build_object('answer','O','answers','{}'::jsonb); end if;
        update public.circus_games set public_state=pub,secret_state=sec where id=g.id;
      end if;
      perform public.circus_log(g.room_id,'Espelhos Gêmeos: '||lastmsg);
    end if;
  end if;
  return jsonb_build_object('ok',true);
end;
$$;

-- -------------------- ESTADO DA SALA --------------------
create or replace function public.circus_get_state(p_room_id uuid,p_access_key text)
returns jsonb language plpgsql security definer
set search_path=public, extensions
as $$
declare r public.circus_rooms%rowtype; viewer_type text; viewer_id uuid; g public.circus_games%rowtype; g_json jsonb;
begin
  select * into r from public.circus_rooms where id=p_room_id;
  if not found then raise exception 'Sala não encontrada.'; end if;
  if crypt(p_access_key,r.host_key_hash)=r.host_key_hash then viewer_type:='host';
  else
    select id into viewer_id from public.circus_players where room_id=p_room_id and crypt(p_access_key,player_key_hash)=player_key_hash limit 1;
    if viewer_id is null then raise exception 'Acesso inválido para esta sala.'; end if;
    viewer_type:='player';
  end if;

  select * into g from public.circus_games where room_id=p_room_id order by (status='active') desc, created_at desc limit 1;
  if found then
    g_json:=jsonb_build_object(
      'id',g.id,'game_key',g.game_key,'status',g.status,'participant_ids',to_jsonb(g.participant_ids),'state',g.public_state,'winner_ids',to_jsonb(g.winner_ids),
      'participants',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'tickets',p.tickets) order by array_position(g.participant_ids,p.id)) from public.circus_players p where p.id=any(g.participant_ids)),'[]'::jsonb)
    );
  else g_json:=null; end if;

  return jsonb_build_object(
    'room',jsonb_build_object('id',r.id,'code',r.code),
    'viewer',jsonb_build_object('type',viewer_type,'player_id',viewer_id),
    'players',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'tickets',p.tickets,'joined_at',p.joined_at) order by p.joined_at) from public.circus_players p where p.room_id=p_room_id),'[]'::jsonb),
    'active_game',g_json,
    'logs',coalesce((select jsonb_agg(x.obj) from (select jsonb_build_object('message',l.message,'created_at',l.created_at) obj from public.circus_logs l where l.room_id=p_room_id order by l.id desc limit 80) x),'[]'::jsonb)
  );
end;
$$;

-- -------------------- GRANTS --------------------
grant execute on function public.circus_create_room(text,text) to anon, authenticated;
grant execute on function public.circus_join_room(text,text,text) to anon, authenticated;
grant execute on function public.circus_leave_room(uuid,uuid,text) to anon, authenticated;
grant execute on function public.circus_award_tickets(uuid,text,uuid,integer) to anon, authenticated;
grant execute on function public.circus_start_game(uuid,text,text,uuid[]) to anon, authenticated;
grant execute on function public.circus_end_game(uuid,text) to anon, authenticated;
grant execute on function public.circus_game_action(uuid,uuid,text,text,jsonb) to anon, authenticated;
grant execute on function public.circus_get_state(uuid,text) to anon, authenticated;

-- Pronto. O frontend usa apenas RPCs; tabelas permanecem sem acesso direto.
