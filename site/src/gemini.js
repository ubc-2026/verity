/* ---------- Google Gemini (the AI model) — optional second opinion ----------
   Not Gemini Exchange. Requests go to Verity's Cloudflare Worker, which holds the
   Google API key as a Worker secret. No key is ever in this page, in the browser,
   or in this repo. verity-rules-v1 remains the score of record. */
const GAI={endpoint:'https://verity-gemini.safe-572.workers.dev/review',model:'gemini-2.5-flash',busy:false,last:null};
/* Turnstile token for each paid AI call (Gemini, Exa). The Worker verifies it server-side; tokens are single use.
   Same public site key as the sign-in page. Calls run one at a time so only one widget exists. */
const AITS={site:'0x4AAAAAAGKN-DMfLk3IAK3l',load:null,q:Promise.resolve()};
function aiTsLoad(){return AITS.load||(AITS.load=new Promise((ok,no)=>{const s=document.createElement('script');s.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';s.async=true;s.onload=()=>window.turnstile?ok(window.turnstile):no(new Error('verification unavailable'));s.onerror=()=>{AITS.load=null;no(new Error('verification unavailable'));};document.head.appendChild(s);}));}
function aiToken(){const run=()=>aiTsLoad().then(ts=>new Promise((ok,no)=>{let box=document.getElementById('aiTs');
  if(!box){box=document.createElement('div');box.id='aiTs';box.style.cssText='position:fixed;right:12px;bottom:12px;z-index:9999';document.body.appendChild(box);}
  let id=null;const end=()=>{try{if(id!==null)ts.remove(id);}catch(e){}};
  id=ts.render(box,{sitekey:AITS.site,action:'verity_ai',appearance:'interaction-only',
    callback:t=>{end();ok(t);},'error-callback':()=>{end();no(Object.assign(new Error('Verification failed. Reload the page and try again.'),{status:-1}));},
    'timeout-callback':()=>{end();no(Object.assign(new Error('Verification timed out. Try again.'),{status:-1}));}});}));
  return AITS.q=AITS.q.catch(()=>{}).then(run);}
const FALLBACK_WHY={quota:'Google Gemini’s quota was used up',unreachable:'Google Gemini could not be reached',no_key:'Google Gemini is not configured',blocked:'Google Gemini declined to answer',empty:'Google Gemini returned an empty answer'};
function providerOf(j){const backup=j.provider==='workers-ai';const name=backup?'Workers AI ('+String(j.modelVersion||'').replace(/^@cf\/[^/]+\//,'')+')':'Google Gemini';
  const why=backup?(FALLBACK_WHY[j.fallbackReason]||('Google Gemini was unavailable'+(j.fallbackReason?' ('+j.fallbackReason+')':''))):'';
  return {backup,name,tag:backup?'<span class="tag warn">! Backup · Cloudflare Workers AI</span>':'<span class="tag info">Google Gemini · advisory</span>',note:backup?`<p class="gai-note">${esc(why)}, so Verity’s backup model answered.</p>`:''};}
try{localStorage.removeItem('verity.googleGeminiKey');}catch(e){} // clean up keys saved by the earlier bring-your-own-key version
function gaiErr(status,msg){
  if(status===429)return msg&&/quota/i.test(msg)?'Google Gemini’s quota is used up for now. Try again later.':'Too many reviews from this connection. Wait a minute and try again (limit: 6 per minute).';
  if(status===503)return msg||'The review service is still being set up.';
  if(status===502)return msg||'Both Google Gemini and the backup model are unavailable right now. Try again in a minute.';
  if(status===403)return msg||'The review service only answers requests from verityresearch.us.';
  if(status===413)return 'This market’s data is too large to send. Try another market.';
  if(status===0)return 'Couldn’t reach the review service. Check your connection and try again.';
  return msg||('The review service returned an error (HTTP '+status+').');}
function gaiStatus(msg,cls){const s=$('#gaiStatus');s.className='gai-status '+(cls||'');s.textContent=msg;}
function marketContext(){const m=MARKETS[term.market];
  if(m.live){const r=m.r;return {source:'live Gemini Exchange market',event_ticker:m.e.ticker,title:m.e.title,category:m.e.category,outcome:m.c.label,
    best_bid:m.c.prices.bestBid??null,best_ask:m.c.prices.bestAsk??null,last_trade:m.c.prices.lastTradePrice??null,volume_usd:m.e.volume,volume_24h_usd:m.e.volume24h,expiry:m.c.expiryDate||m.e.expiryDate,
    settlement_source_details:m.e.sourceDetails||null,terms_pdf:m.e.termsLink||m.c.termsAndConditionsUrl||null,rules_text:(r.text||'').slice(0,6000),
    verity_rules_v1:{ambiguity:r.scores.ambiguity,source:r.scores.source,liquidity:r.scores.liquidity,correlation:r.scores.correlation,total:r.total,rating:r.rating,gaps:r.gaps}};}
  const J=m.key==='nyc'?NYC_JSON:OKC_JSON;return {source:'captured Nov 18, 2026 analysis',title:m.question,quote:J.quoted_price,
    rules_text:m.key==='nyc'?'Weather terms Rule 13.111(i)(2): "only the first published version that includes confirmation of the ___ will be used." Primary source is the NWS Climatological Report (Daily) for Central Park, then Weather Underground or weather.com, then the Iowa Environmental Mesonet.':'NBA moneyline. Source agencies in order: the league governing body (NBA), ESPN, Fox Sports, and the broadcast partner.',
    verity_rules_v1:{scores:Object.fromEntries(Object.entries(m.scores).map(([k,v])=>[k,{score:v[0],rationale:v[1]}])),total:m.total,rating:m.rating}};}
function fitContext(ctx){let s=JSON.stringify(ctx);while(s.length>20000&&ctx.rules_text&&ctx.rules_text.length>500){ctx.rules_text=ctx.rules_text.slice(0,Math.floor(ctx.rules_text.length*.7))+'…';s=JSON.stringify(ctx);}return ctx;} // Worker limit is 24 KB
async function gaiRun(mode){if(GAI.busy)return;const q=$('#gaiQ').value.trim();
  if(mode==='ask'&&!q){gaiStatus('Type a question first.','warn');$('#gaiQ').focus();return;}
  if(q.length>1500&&mode==='ask'){gaiStatus('Questions can be up to 1,500 characters.','warn');return;}
  const ctx=fitContext(marketContext());GAI.busy=true;const btn=mode==='ask'?$('#gaiAsk'):$('#gaiReview');btn.setAttribute('aria-busy','true');$$('#gaiPanel [data-gai]').forEach(x=>x.disabled=true);
  const out=$('#gaiOut');out.innerHTML='<p class="muted">Asking Google Gemini about '+esc(ctx.title||'this market')+'…</p>';gaiStatus('Waiting for Google Gemini…');
  const t0=performance.now();let status=0;
  try{const r=await fetch(GAI.endpoint,{method:'POST',headers:{'content-type':'application/json','cf-turnstile-response':await aiToken()},body:JSON.stringify(mode==='ask'?{mode,question:q,market:ctx}:{mode,market:ctx})});
    status=r.status;const j=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(new Error(j.error||''),{status});
    const cand=j.candidates&&j.candidates[0];const text=cand&&cand.content&&cand.content.parts?cand.content.parts.map(p=>p.text||'').join(''):'';
    if(!text)throw Object.assign(new Error(j.promptFeedback&&j.promptFeedback.blockReason?'Google Gemini declined to answer ('+j.promptFeedback.blockReason+').':'Google Gemini returned an empty answer'+(cand&&cand.finishReason?' ('+cand.finishReason+')':'')+'.'),{status:-1});
    const pv=providerOf(j);const meta=`${esc(j.modelVersion||GAI.model)} · ${(Math.round(performance.now()-t0)/1000).toFixed(1)} s${j.usageMetadata&&j.usageMetadata.totalTokenCount?' · '+j.usageMetadata.totalTokenCount+' tokens':''} · ${new Date().toLocaleTimeString()}`;
    if(mode==='ask'){GAI.last={mode,text};out.innerHTML=`<div class="gai-meta">${pv.tag}<span class="label">${meta}</span></div>${pv.note}<div class="gai-text">${mdLite(text)}</div>`;}
    else{let res;try{res=JSON.parse(text);}catch(e){throw Object.assign(new Error('Google Gemini’s answer wasn’t valid JSON. Try again.'),{status:-1});}GAI.last={mode,result:res};out.innerHTML=reviewHTML(res,ctx,meta,pv);}
    gaiStatus((pv.backup?'Answered by the backup model. ':'')+'Done. This is a model opinion; verity-rules-v1 is still the score Verity uses.',pv.backup?'warn':'ok');}
  catch(e){const msg=e.status===-1?e.message:gaiErr(e.status??status,e.message);out.innerHTML=`<div class="box no"><span class="tag no">✕ Not available</span><p style="font-size:.86rem;margin-top:8px">${esc(msg)}</p></div>`;gaiStatus(msg,'no');}
  finally{GAI.busy=false;btn.removeAttribute('aria-busy');$$('#gaiPanel [data-gai]').forEach(x=>x.disabled=false);}}
function mdLite(t){return esc(t).replace(/\*\*(.+?)\*\*/g,'<b>$1</b>').replace(/^\s*[-*] (.+)$/gm,'<li>$1</li>').replace(/(<li>.*<\/li>\n?)+/g,s=>'<ul>'+s.replace(/\n/g,'')+'</ul>').replace(/\n{2,}/g,'</p><p>').replace(/\n/g,'<br>').replace(/^/,'<p>')+'</p>';}
function reviewHTML(r,ctx,meta,pv){pv=pv||{name:'Google Gemini',tag:'<span class="tag info">Google Gemini · advisory</span>',note:''};const ru=ctx.verity_rules_v1||{};const rs=k=>{const v=ru[k]||(ru.scores&&ru.scores[k]);return v?(Array.isArray(v)?v[0]:v.score):null;};
  const s=r.scores||{};const row=(k,l)=>`<tr><td>${l}</td><td class="num">${esc(rs(k)??'—')}</td><td class="num">${esc(s[k]??'—')}</td><td>${rs(k)!=null&&s[k]!=null&&rs(k)!==s[k]?'<span class="tag warn">! differs</span>':'<span class="tag neutral">– same</span>'}</td></tr>`;
  return `<div class="gai-meta">${pv.tag}<span class="label">${meta}</span></div>${pv.note}
   <p class="gai-sum">${esc(r.summary||'')}</p>
   <dl class="kv"><dt>Settlement source</dt><dd>${esc(r.settlement_source||'unknown')}</dd><dt>Model confidence</dt><dd>${esc(r.confidence||'—')}</dd><dt>Agrees with rules</dt><dd>${r.agrees_with_rules_analyst?'<span class="tag ok">✓ yes</span>':'<span class="tag warn">! no</span>'} ${esc(r.disagreement||'')}</dd></dl>
   <table class="gai-cmp"><thead><tr><th>Category</th><th class="num">verity-rules-v1</th><th class="num">${esc(pv.name)}</th><th></th></tr></thead><tbody>${row('ambiguity','Ambiguity')}${row('source','Source')}${row('correlation','Correlation')}</tbody></table>
   ${(r.ambiguities||[]).length?`<h4 class="label" style="margin:14px 0 6px">Ambiguities it found</h4><ul class="gai-list">${r.ambiguities.map(a=>`<li><b>${esc(a.issue)}</b>${a.quote?`<div class="excerpt">${esc(a.quote)}</div>`:''}<span class="muted">${esc(a.why_it_matters||'')}</span></li>`).join('')}</ul>`:''}
   ${(r.research_to_close_gaps||[]).length?`<h4 class="label" style="margin:14px 0 6px">Research it suggests</h4><ul class="gai-list">${r.research_to_close_gaps.map(x=>`<li>${esc(x)}</li>`).join('')}</ul><p class="label">Suggestions only. Verity buys nothing from this panel.</p>`:''}`;}
function gaiSyncMarket(){const el=$('#gaiMarket');if(!el)return;const m=MARKETS[term.market];el.textContent=m?(m.live?'Live · ':'Nov 18 analysis · ')+m.question:'—';}
const AID={open:false,last:null};
function aiOpen(from){AID.last=from||document.activeElement;AID.open=true;gaiSyncMarket();const d=$('#aiDock');d.classList.add('open');d.setAttribute('aria-hidden','false');$('#aiTab').setAttribute('aria-expanded','true');document.body.classList.add('ai-open');setTimeout(()=>$('#gaiReview').focus(),RM.matches?0:200);}
function aiClose(){AID.open=false;const d=$('#aiDock');d.classList.remove('open');d.setAttribute('aria-hidden','true');$('#aiTab').setAttribute('aria-expanded','false');document.body.classList.remove('ai-open');const t=AID.last&&document.contains(AID.last)?AID.last:$('#aiTab');t.focus();}
(function gaiInit(){
  $('#aiTab').addEventListener('click',e=>AID.open?aiClose():aiOpen(e.currentTarget));$('#aiClose').addEventListener('click',aiClose);
  $$('[data-ai-open]').forEach(b=>b.addEventListener('click',e=>aiOpen(e.currentTarget)));
  $$('[data-ai-change]').forEach(a=>a.addEventListener('click',()=>{if(matchMedia('(max-width:760px)').matches)aiClose();}));
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&AID.open&&!$('#drawer').classList.contains('open'))aiClose();});
  gaiSyncMarket();
  $('#gaiReview').addEventListener('click',()=>gaiRun('review'));$('#gaiAsk').addEventListener('click',()=>gaiRun('ask'));
  $('#gaiQ').addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){e.preventDefault();gaiRun('ask');}});
  $('#gaiCopy').addEventListener('click',()=>{if(!GAI.last){toast('Run a review first.');return;}copy(GAI.last.mode==='ask'?GAI.last.text:JSON.stringify(GAI.last.result,null,2),'Google Gemini answer copied');});
})();

/* ---------- Combined AI forecast (Google Gemini + Workers AI) ---------- */
const FC={busy:false,byContract:new Map()};
const r3=v=>v==null||isNaN(v)?null:Math.round(v*1000)/1000;
async function historyFor(m){
  const [h,d]=await Promise.all([gxCandles(m.symbol,'1hr',168).catch(()=>[]),gxCandles(m.symbol,'1day',90).catch(()=>[])]);
  if(h.length<2&&d.length<2)return null;
  const hc=h.map(x=>x.c),last=hc.length?hc[hc.length-1]:d[d.length-1].c;
  const ago=n=>hc.length>n?hc[hc.length-1-n]:null;
  const rets=hc.slice(1).map((v,i)=>v-hc[i]);const mean=rets.reduce((a,b)=>a+b,0)/(rets.length||1);
  const sd=Math.sqrt(rets.reduce((a,b)=>a+(b-mean)**2,0)/(rets.length||1));
  const vol24=h.slice(-24).reduce((a,x)=>a+x.v,0),vol7=h.reduce((a,x)=>a+x.v,0);
  return {source:'Gemini Exchange v2 candles (closes are implied probability, 0-1)',hourly_points:h.length,daily_points:d.length,
    last_close:r3(last),change_1h:r3(ago(1)!=null?last-ago(1):null),change_24h:r3(ago(24)!=null?last-ago(24):null),change_7d:r3(hc.length>1?last-hc[0]:null),
    min_7d:r3(hc.length?Math.min(...hc):null),max_7d:r3(hc.length?Math.max(...hc):null),hourly_volatility:r3(sd),
    hours_with_trades_7d:h.filter(x=>x.v>0).length,volume_24h:Math.round(vol24),volume_7d:Math.round(vol7),
    hourly_closes_every_4h:h.filter((x,i)=>i%4===0||i===h.length-1).map(x=>[new Date(x.t).toISOString().slice(0,13),r3(x.c)]),
    daily_closes:d.slice(-60).map(x=>[new Date(x.t).toISOString().slice(0,10),r3(x.c)])};}
function pct(p){return p==null?'—':(p*100).toFixed(1)+'%';}
function fcHTML(res,m,hist,ms){const ok=res.forecasts.filter(f=>f.ok);const ps=ok.map(f=>+f.result.probability_yes);
  const ens=ps.length?ps.reduce((a,b)=>a+b,0)/ps.length:null;const spread=ps.length===2?Math.abs(ps[0]-ps[1]):null;
  const agree=spread==null?'Only one model answered':spread<=.05?'The two models agree closely':spread<=.15?'The two models roughly agree':'The two models disagree';
  const bar=(label,p,cls,sub)=>`<div class="fc-row"><span class="fc-l">${label}${sub?`<span class="label">${esc(sub)}</span>`:''}</span><span class="fc-bar"><i class="${cls}" style="width:${p==null?0:Math.max(1,p*100)}%"></i></span><span class="num fc-v">${pct(p)}</span></div>`;
  const name=f=>f.provider==='google-gemini'?'Google Gemini':'Workers AI';
  return `<div class="gai-meta"><span class="tag info">Combined AI forecast · experimental</span><span class="label">${(ms/1000).toFixed(1)} s · ${new Date().toLocaleTimeString()}</span></div>
   <div class="fc-big"><span class="label">Combined estimate, P(${esc(m.c.label||'Yes')})</span><span class="num">${pct(ens)}</span><span class="muted">${agree}${spread!=null?' (gap '+(spread*100).toFixed(1)+' pts)':''}. Market price: ${pct(m.mid)}.</span></div>
   ${bar('Market price',m.mid,'mk','Gemini Exchange mid')}
   ${res.forecasts.map(f=>f.ok?bar(name(f),+f.result.probability_yes,f.provider==='google-gemini'?'gg':'wa',String(f.model||'').replace(/^@cf\/[^/]+\//,'')+' · '+f.result.confidence+' confidence'):`<div class="fc-row"><span class="fc-l">${name(f)}<span class="label">unavailable (${esc(f.reason)})</span></span><span class="fc-bar"></span><span class="num fc-v">—</span></div>`).join('')}
   ${bar('Combined',ens,'en','average of the models that answered')}
   ${ok.map(f=>`<details class="fc-why"><summary>${name(f)}: why</summary><p>${esc(f.result.reasoning||'')}</p>${(f.result.drivers||[]).length?`<p class="label">Drivers</p><ul class="gai-list">${f.result.drivers.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`:''}${(f.result.risks||[]).length?`<p class="label">Risks</p><ul class="gai-list">${f.result.risks.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`:''}</details>`).join('')}
   ${(res.research||[]).length?`<details class="fc-why" open><summary>Research both models read (Exa)</summary><ul class="gai-list">${res.research.map(r=>`<li><a href="${esc(safeHref(r.link))}" target="_blank" rel="noopener noreferrer">${esc(r.title)}</a> <span class="label">${esc(r.source||'')}${r.published?' · '+agoStr(r.published):''}</span></li>`).join('')}</ul></details>`:''}
   <p class="fc-note">Built from ${hist.hourly_points} hourly and ${hist.daily_points} daily Gemini Exchange candles${(res.research||[]).length?', '+res.research.length+' recent articles found by Exa,':''} plus the settlement rules. This is an experimental model estimate, not a verified result or trading advice. The market price already combines traders’ views and is often the better guide. Verity places no trades.</p>`;}
async function runForecast(){if(FC.busy)return;const m=MARKETS[term.market];const out=$('#gaiOut');
  if(!m.live){gaiStatus('Forecasts need a live market with real price history. Pick one in the terminal.','warn');out.innerHTML='<div class="box warn"><span class="tag warn">! Live market needed</span><p style="font-size:.86rem;margin-top:8px">The Nov 18 markets only have demo price paths, so they can’t be forecast honestly. Choose a live market in the terminal.</p></div>';return;}
  if(!m.symbol){gaiStatus('This contract has no price history to forecast from.','warn');return;}
  FC.busy=true;const btn=$('#fcRun');btn.setAttribute('aria-busy','true');$$('#gaiPanel [data-gai]').forEach(x=>x.disabled=true);
  out.innerHTML='<p class="muted">Reading Gemini Exchange price history…</p>';gaiStatus('Loading price history…');const t0=performance.now();
  try{const hist=await historyFor(m);if(!hist)throw Object.assign(new Error('This contract has no trading history yet, so there is nothing to forecast from.'),{status:-1});
    out.innerHTML='<p class="muted">Asking Google Gemini and Workers AI…</p>';gaiStatus('Waiting for both models…');
    const ctx=fitContext(marketContext());ctx.history=hist;
    const r=await fetch(GAI.endpoint,{method:'POST',headers:{'content-type':'application/json','cf-turnstile-response':await aiToken()},body:JSON.stringify({mode:'forecast',market:ctx})});
    const j=await r.json().catch(()=>({}));
    if(r.status===400&&/review mode/i.test(j.error||''))throw Object.assign(new Error('The AI service needs the v4 update to run forecasts. Run the latest redeploy-verity-gemini.ps1.'),{status:-1});
    if(!r.ok)throw Object.assign(new Error(j.error||''),{status:r.status});
    if(!Array.isArray(j.forecasts))throw Object.assign(new Error('Unexpected response from the AI service.'),{status:-1});
    out.innerHTML=fcHTML(j,m,hist,performance.now()-t0);
    const ps=j.forecasts.filter(f=>f.ok).map(f=>+f.result.probability_yes);
    if(ps.length){FC.byContract.set(m.c.id,{p:ps.reduce((a,b)=>a+b,0)/ps.length,t:Date.now()});drawProb();}
    GAI.last={mode:'forecast',result:j};gaiStatus('Forecast ready. The dashed line on the terminal chart marks the combined estimate.','ok');}
  catch(e){const msg=e.status===-1?e.message:gaiErr(e.status||0,e.message);out.innerHTML=`<div class="box no"><span class="tag no">✕ Not available</span><p style="font-size:.86rem;margin-top:8px">${esc(msg)}</p></div>`;gaiStatus(msg,'no');}
  finally{FC.busy=false;btn.removeAttribute('aria-busy');$$('#gaiPanel [data-gai]').forEach(x=>x.disabled=false);}}
$('#fcRun').addEventListener('click',runForecast);

/* ---------- Movable, resizable AI window ---------- */
(function aiWindow(){const d=$('#aiDock'),root=document.documentElement,KEY='verity.aiWindow.v2';
  const small=()=>matchMedia('(max-width:760px)').matches;
  const S={mode:'docked',x:0,y:0,w:440,h:0};
  try{Object.assign(S,JSON.parse(localStorage.getItem(KEY)||'{}'));}catch(e){}
  const navH=()=>($('#nav')?$('#nav').getBoundingClientRect().bottom:64);
  function clamp(){const vw=innerWidth,vh=innerHeight;S.w=Math.max(320,Math.min(S.w||440,vw-24));
    if(S.mode==='floating'){S.h=Math.max(280,Math.min(S.h||vh-160,vh-24));S.x=Math.max(8,Math.min(S.x,vw-S.w-8));S.y=Math.max(8,Math.min(S.y,vh-S.h-8));}}
  function apply(save){clamp();const fl=S.mode==='floating'&&!small();d.classList.toggle('floating',fl);document.body.classList.toggle('ai-float',fl);
    root.style.setProperty('--ai-w',S.w+'px');root.style.setProperty('--ai-h',(S.h||400)+'px');root.style.setProperty('--ai-x',S.x+'px');root.style.setProperty('--ai-y',S.y+'px');
    $('#aiDockBtn').hidden=!fl;$('#aiResize').setAttribute('aria-valuenow',Math.round(S.w));if(save)try{localStorage.setItem(KEY,JSON.stringify(S));}catch(e){}}
  function toFloating(){if(S.mode==='floating')return;const r=d.getBoundingClientRect();S.mode='floating';S.x=r.left;S.y=r.top;S.w=r.width;S.h=r.height;}
  function drag(e,kind){if(small()||e.button>0)return;if(kind==='move'&&e.target.closest('button,a,input,textarea,select'))return;e.preventDefault();
    const el=e.currentTarget;el.setPointerCapture(e.pointerId);if(kind!=='w'||S.mode==='floating')toFloating();
    const s={...S,px:e.clientX,py:e.clientY};d.classList.add('resizing');
    const move=ev=>{const dx=ev.clientX-s.px,dy=ev.clientY-s.py;
      if(kind==='move'){S.x=s.x+dx;S.y=s.y+dy;}
      if(kind==='w'){if(S.mode==='floating'){S.w=s.w-dx;S.x=s.x+dx;if(S.w<320){S.x-=320-S.w;}}else S.w=innerWidth-ev.clientX-12;}
      if(kind==='e'||kind==='se'||kind==='ne')S.w=s.w+dx;
      if(kind==='sw'){S.w=s.w-dx;S.x=s.x+dx;}
      if(kind==='s'||kind==='se'||kind==='sw')S.h=s.h+dy;
      if(kind==='n'||kind==='ne'){S.h=s.h-dy;S.y=s.y+dy;}
      apply(false);};
    const up=()=>{el.removeEventListener('pointermove',move);el.removeEventListener('pointerup',up);el.removeEventListener('pointercancel',up);d.classList.remove('resizing');apply(true);};
    el.addEventListener('pointermove',move);el.addEventListener('pointerup',up);el.addEventListener('pointercancel',up);}
  $('.ai-dock-head').addEventListener('pointerdown',e=>drag(e,'move'));
  $('#aiResize').addEventListener('pointerdown',e=>drag(e,'w'));
  $$('.ai-grip').forEach(g=>g.addEventListener('pointerdown',e=>drag(e,g.dataset.k)));
  // keyboard: move with the Move button + arrows, resize with the left edge + arrows
  $('#aiMove').addEventListener('keydown',e=>{const st=e.shiftKey?64:16;const k={ArrowLeft:[-st,0],ArrowRight:[st,0],ArrowUp:[0,-st],ArrowDown:[0,st]}[e.key];if(!k||small())return;e.preventDefault();toFloating();S.x+=k[0];S.y+=k[1];apply(true);});
  $('#aiMove').addEventListener('click',()=>{if(small())return;toFloating();apply(true);$('#aiMove').focus();});
  $('#aiResize').addEventListener('keydown',e=>{const st=e.shiftKey?96:32;let f=null;if(e.key==='ArrowLeft')f=st;if(e.key==='ArrowRight')f=-st;if(e.key==='ArrowUp'&&S.mode==='floating'){e.preventDefault();S.h-=st;apply(true);return;}if(e.key==='ArrowDown'&&S.mode==='floating'){e.preventDefault();S.h+=st;apply(true);return;}
    if(f!=null){e.preventDefault();if(S.mode==='floating'){S.w+=f;S.x-=f;}else S.w+=f;apply(true);}});
  $('#aiResize').addEventListener('dblclick',()=>{S.w=440;if(S.mode==='floating')S.h=Math.min(640,innerHeight-120);apply(true);});
  $('#aiDockBtn').addEventListener('click',()=>{S.mode='docked';S.h=0;apply(true);$('#aiMove').focus();});
  addEventListener('resize',()=>apply(false));
  apply(false);})();
