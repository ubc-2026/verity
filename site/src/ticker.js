/* ---------- Ticker: live Gemini Exchange prediction markets ---------- */
(function ticker(){
  const RESELECT=5*60000, N=18, STALE=35000;
  const tk=$('#ticker'),tr=$('#tickerTrack'),lab=$('#tickerLabel'),btn=$('#tickerPause');
  const hist=new Map(); // contract id -> [mid,...] observed this session
  let picks=[],lastOk=0,lastSelect=0,timer=0,busy=false,paused=false,mode='init';
  const num=v=>v==null||v===''?null:+v;
  const midOf=p=>{if(!p)return null;const b=num(p.bestBid),a=num(p.bestAsk);if(b!=null&&a!=null)return(b+a)/2;return num(p.lastTradePrice)??b??a;};
  const usd=v=>{v=+v||0;return v>=1e6?'$'+(v/1e6).toFixed(1)+'M':v>=1e4?'$'+Math.round(v/1e3)+'k':v>=1e3?'$'+(v/1e3).toFixed(1)+'k':'$'+Math.round(v);};
  const shortTitle=t=>t.replace(/^Highest temperature in /,'High temp ').replace(/ on (January|February|March|April|May|June|July|August|September|October|November|December) \d+, \d{4}\??$/,'').replace(/\?$/,'').slice(0,42);
  function choose(events){
    const rows=[];
    for(const e of events){
      const cs=(e.contracts||[]).filter(c=>c.status==='active'&&c.prices&&midOf(c.prices)!=null);
      if(!cs.length)continue;
      const c=cs.reduce((a,b)=>midOf(b.prices)>midOf(a.prices)?b:a); // the market's current favourite
      rows.push({e,c,vol:+(e.volume24h||e.volume||0)});
    }
    rows.sort((a,b)=>b.vol-a.vol);
    // keep a mix: at most 9 from any one category
    const per={},out=[];for(const r of rows){const k=r.e.category;per[k]=(per[k]||0)+1;if(per[k]<=9)out.push(r);if(out.length>=N)break;}
    return out;
  }
  function spark(id){const h=hist.get(id)||[];if(h.length<2)return '<svg class="spark" viewBox="0 0 48 14" aria-hidden="true"><line x1="0" y1="7" x2="48" y2="7"/></svg>';
    const lo=Math.min(...h),hi=Math.max(...h),sp=Math.max(.005,hi-lo);const pts=h.map((v,i)=>`${(i/(h.length-1)*48).toFixed(1)},${(12-(v-lo)/sp*10).toFixed(1)}`).join(' ');
    const up=h[h.length-1]>=h[0];return `<svg class="spark ${up?'up':'down'}" viewBox="0 0 48 14" aria-hidden="true"><polyline points="${pts}"/></svg>`;}
  function itemHTML(r){const p=r.c.prices,b=num(p.bestBid),a=num(p.bestAsk),m=midOf(p);
    const bar=b!=null&&a!=null?`<span class="spread-bar" title="Bid–ask on a 0–100¢ scale" aria-hidden="true"><i style="left:${b*100}%;width:${Math.max(2,(a-b)*100)}%"></i></span>`:'';
    const lbl=r.e.type==='binary'||r.c.label===r.e.title?'':`<span class="muted">${esc(r.c.label.slice(0,28))}</span>`;
    return `<a class="tick-item" data-id="${esc(r.c.id)}" href="https://www.gemini.com/predictions" target="_blank" rel="noopener" title="${esc(r.e.title)}: ${esc(r.c.label)}"><span class="cat">${esc((r.e.category||'').slice(0,7))}</span><span class="sym">${esc(shortTitle(r.e.title))}</span>${lbl}<span class="px" data-px>${(m*100).toFixed(1)}¢</span><span class="chg" data-chg aria-hidden="true"></span>${bar}<span data-sp>${spark(r.c.id)}</span><span class="muted">${usd(r.vol)} 24h</span></a>`;}
  function render(){
    const html=picks.map(itemHTML).join('');
    tr.innerHTML=`<span class="tick-set">${html}</span><span class="tick-set" aria-hidden="true">${html.replace(/<a /g,'<a tabindex="-1" ')}</span>`;
    const w=tr.firstElementChild.getBoundingClientRect().width;tr.style.setProperty('--tick-dur',Math.max(30,w/45)+'s');
  }
  function update(){ // in place, so the marquee never jumps
    for(const r of picks){const m=midOf(r.c.prices);if(m==null)continue;const h=hist.get(r.c.id)||[];const prev=h.length?h[h.length-1]:null;
      if(prev==null||Math.abs(prev-m)>1e-9){h.push(m);if(h.length>40)h.shift();hist.set(r.c.id,h);}
      $$(`[data-id="${CSS.escape(r.c.id)}"]`,tr).forEach(el=>{const px=$('[data-px]',el),ch=$('[data-chg]',el);const txt=(m*100).toFixed(1)+'¢';
        if(px.textContent!==txt){const up=prev!=null&&m>prev;px.textContent=txt;px.classList.remove('flash-up','flash-down');void px.offsetWidth;if(prev!=null){px.classList.add(up?'flash-up':'flash-down');ch.textContent=up?'▲':'▼';ch.className='chg '+(up?'up':'down');}}
        $('[data-sp]',el).innerHTML=spark(r.c.id);});}
  }
  function setLabel(){const age=Date.now()-lastOk;
    if(mode==='live'&&age<STALE){lab.className='tick-status live';lab.innerHTML=`<span class="dot" aria-hidden="true"></span>Live<span class="src"> · Gemini Exchange</span><span class="num"> · ${new Date(lastOk).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'})}</span>`;}
    else if(mode==='live'){lab.className='tick-status stale';lab.textContent='Stale · retrying Gemini Exchange';}
    else if(mode==='fallback'){lab.className='tick-status stale';lab.textContent='Live feed unavailable · Nov 18 snapshot';}
    else{lab.className='tick-status';lab.textContent='Connecting to Gemini Exchange…';}}
  function onData(){
    if(LIVE.events.length&&LIVE.lastOk){lastOk=LIVE.lastOk;
      const byId=new Map();LIVE.events.forEach(e=>(e.contracts||[]).forEach(c=>byId.set(c.id,{e,c})));
      if(mode!=='live'||Date.now()-lastSelect>RESELECT){picks=choose(LIVE.events);lastSelect=Date.now();if(picks.length){mode='live';render();update();}}
      else{picks=picks.map(p=>{const n=byId.get(p.c.id);return n?{...p,e:n.e,c:n.c,vol:+(n.e.volume24h||n.e.volume||0)}:p;});update();}}
    else if(mode!=='live'&&LIVE.err){mode='fallback';fallback();}
    setLabel();}
  function fallback(){ // last captured snapshot, clearly labelled
    tr.innerHTML=['<span class="tick-set">','<span class="tick-set" aria-hidden="true">'].map(s=>s+TICKER.map(t=>`<span class="tick-item"><span class="sym">${t.sym}</span><span class="px">${t.bid!=null?Math.round((t.bid+t.ask)*50)+'¢':t.prob||t.text}</span>${t.extra?`<span class="muted">${t.extra}</span>`:''}</span>`).join('')+'</span>').join('');}
  btn.addEventListener('click',()=>{paused=!paused;tk.classList.toggle('paused',paused);btn.setAttribute('aria-pressed',paused);btn.textContent=paused?'Play':'Pause';btn.setAttribute('aria-label',paused?'Play ticker scroll':'Pause ticker scroll');});
  LIVE.on(onData);setInterval(setLabel,5000);setLabel();
})();
