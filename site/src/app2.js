/* ---------- Terminal: scores, gauge, inspector ---------- */
const NYC_JSON={version:'verity-risk-analysis-v1',contract_id:'fx-nyc-high-20261118',event_ticker:'WXHIGH-NYC-2611190459',analyzed_at_utc:'2026-11-18T01:00:00Z',
  quoted_price:{outcome_label:'62°F to 63°F',best_bid:'0.54',best_ask:'0.58',mid:'0.56',implied_probability:'0.56',volume_usd:'7'},
  scores:{ambiguity:{score:2,citation_ids:['C-NYC-1','C-NYC-2']},source:{score:2,citation_ids:['C-NYC-1']},liquidity:{score:3,citation_ids:['C-NYC-3']},correlation:{score:1,citation_ids:[]}},
  rating:{known_total:8,final_rating:'Medium',overrides:[{rule:'High (3) in Liquidity -> never trade more than top-of-book',effect:'treat the quoted price as an unreliable signal; rating unchanged'}]},
  research_action:'investigate',
  evidence_gaps:[{id:'GAP-NYC-SETTLE',gap_type:'settlement_source_version',affects:'resolution_risk',material:true,free_checks:['nyc-settlement-version']},{id:'GAP-NYC-FORECAST',gap_type:'outcome_forecast',affects:'outcome_probability',material:false,free_checks:[]}],
  data_quality_flags:['source_mode=fixture','snapshot_time_unrecorded','event_terms_url_empty','rules_paraphrased']};
const OKC_JSON={version:'verity-risk-analysis-v1',event_ticker:'NBA-2611190100-ATL-OKC-M',snapshot:{source_mode:'live',source_label:'Gemini Exchange events API',snapshot_date:'2026-11-18',snapshot_hash:'sha256:5c564d21bafcf0085684fab03d57c949071ced4b2e697d0fb0a3592fac11f8e7'},
  quoted_price:{outcome_label:'Oklahoma City',best_bid:'0.69',best_ask:'0.7',mid:'0.695',implied_probability:'0.695',volume_usd:'1392.14'},
  scores:{ambiguity:{score:1},source:{score:1},liquidity:{score:1},correlation:{score:3,rationale:'5 sibling event(s) on the same underlying (Agent rule 7).'}},
  rating:{known_total:6,final_rating:'Low'},evidence_gaps:[],purchase_request:null,data_quality_flags:['analyst=verity-rules-v1 (code rules, no LLM)']};
const FLAGS={
  nyc:[
    {sev:'warn',title:'Missing word in the settlement rule',prov:'Weather terms PDF, Rule 13.111(i)(2), read 2026-11-18',body:'The rule says which report version counts, but a word is missing, so it is unclear whether the partial 4 PM report or the full-day report settles the market.',ex:'only the first published version that includes confirmation of the <mark>___</mark> will be used'},
    {sev:'warn',title:'Gap: which NWS issuance settles (material)',prov:'GAP-NYC-SETTLE · affects resolution risk',body:'If a correction moves the max across a 2°F band edge, the version used decides the outcome. The free check nyc-settlement-version ran on 2026-11-18 and was inconclusive.',ex:'Primary source is the applicable NWS Climatological Report, then Weather Underground or weather.com, then the Iowa Environmental Mesonet.'},
    {sev:'no',title:'Thin market: $7 traded, 4¢ spread',prov:'contracts[62-63F].prices · C-NYC-3',body:'Liquidity scores 3, so the quoted price is treated as an unreliable signal. The rating stays Medium.',ex:'bestBid 0.54, bestAsk 0.58; event volume 7'},
    {sev:'info',title:'Event-level terms link is empty',prov:'event.termsAndConditionsUrl · C-NYC-2',body:'The terms PDF was found only through the contract rules. Agent rule 3 raises ambiguity to at least 2.',ex:'(empty)'},
    {sev:'neutral',title:'Not a gap: the temperature forecast',prov:'GAP-NYC-FORECAST · affects outcome probability',body:'A forecast changes the chance of the event, not how the contract settles. Verity is research-only and places no trades, so it is not proposed.',ex:null}],
  okc:[
    {sev:'info',title:'Correlated siblings',prov:'Agent rule 7 · live read',body:'Five sibling events share the same game. That raises correlation to 3, but no settlement gap is open.',ex:null},
    {sev:'ok',title:'Clear settlement source',prov:'sourceDetails · live read',body:'The league result settles it, with ESPN, Fox Sports and the broadcast partner as named fallbacks.',ex:'Sources in order: the league governing body, ESPN, Fox Sports, and the broadcast partner.'}]
};
const PURCH={
  nyc:[
    {t:'NWS daily climate report: settlement-version check',id:'cat-nws-cli-settlement-version-v1',p:'0.05',state:['ok','✓ Allowed · tier 1, automatic'],meta:'Proposed for GAP-NYC-SETTLE after the free check came back inconclusive. Not purchased here: a proposal is not a payment.'},
    {t:'Point temperature forecast',id:'cat-point-forecast-v1',p:'0.02',state:['neutral','– Not proposed'],meta:'Affects outcome probability, not resolution risk.'},
    {t:'LM Arena leaderboard snapshot',id:'cat-lm-arena-snapshot-v1',p:'0.05',state:['neutral','✕ Not applicable'],meta:'Answers a leaderboard gap; no such gap here.'},
    {t:'Full NWS issuance archive',id:'(none in catalog)',p:'—',state:['warn','! Unsupported by catalog'],meta:'The merchant catalog has no item for this, so Verity cannot buy it.'}],
  okc:[{t:'Nothing to buy',id:'—',p:'0.00',state:['ok','✓ No material gap'],meta:'Total 6, Low. generate_purchase_request returned None.'}]
};
function liveJSON(m){const r=m.r,sc=k=>({score:r.scores[k][0],rationale:r.scores[k][1]});
  return {version:'verity-risk-analysis-v1',analyst:'verity-rules-v1 (browser port, code rules, no LLM)',event_ticker:m.e.ticker,instrument_symbol:m.symbol||null,
    snapshot:{source_mode:'live',source_label:'Gemini Exchange events API',observed_at_utc:new Date(LIVE.lastOk||Date.now()).toISOString()},
    quoted_price:{outcome_label:m.c.label,best_bid:m.c.prices.bestBid??null,best_ask:m.c.prices.bestAsk??null,mid:m.mid!=null?m.mid.toFixed(3):null,last_trade:m.c.prices.lastTradePrice??null,volume_usd:m.e.volume,volume_24h_usd:m.e.volume24h},
    scores:{ambiguity:sc('ambiguity'),source:sc('source'),liquidity:sc('liquidity'),correlation:sc('correlation')},
    rating:{known_total:r.total,complete:r.known===4,final_rating:r.rating},evidence_gaps:r.gaps,
    sibling_events:r.sib.map(x=>x.ticker),data_quality_flags:['terms_not_read: the browser does not fetch the terms PDF',...(r.unq?['some_strikes_unquoted']:[])]};}
function liveFlags(m){const r=m.r,f=[];const ex=r.text?r.text.slice(0,260)+(r.text.length>260?'…':''):null;
  const sev=v=>v==null?'info':v===3?'no':v===2?'warn':'ok';
  [['ambiguity','Ambiguity'],['source','Settlement source'],['liquidity','Liquidity'],['correlation','Correlation']].forEach(([k,t])=>{const [v,why]=r.scores[k];f.push({sev:sev(v),title:`${t}: ${v==null?'needs a person':v+' of 3'}`,prov:'verity-rules-v1 · live read',body:why,ex:k==='ambiguity'||k==='source'?ex:null});});
  r.gaps.forEach(g=>f.unshift({sev:'warn',title:'Gap: '+g.gap_type.replace(/_/g,' '),prov:g.id+' · affects resolution risk',body:g.question,ex:null}));
  if(m.e.termsLink)f.push({sev:'neutral',title:'Terms PDF linked, not read here',prov:'event.termsLink',body:`The full rules are at <a href="${esc(safeHref(m.e.termsLink))}" target="_blank" rel="noopener">the terms PDF</a>. The Python analyst reads it; the browser port does not, so ambiguity stays at least 2.`,ex:null});
  return f;}
function livePurch(m){const r=m.r;if(!r.gaps.length)return [{t:'Nothing to buy',id:'—',p:'0.00',state:['ok','✓ No material gap'],meta:'The rules found no open settlement gap for this market.'}];
  return r.gaps.map(g=>{if(g.gap_type==='settlement_source_version'&&/\bnws\b|national weather|climatolog/i.test(r.text))return {t:'NWS daily climate report: settlement-version check',id:'cat-nws-cli-settlement-version-v1',p:'0.05',state:['ok','✓ Allowed · tier 1, automatic'],meta:'Would be proposed for '+g.id+'. A proposal is not a payment; nothing is bought here.'};
    if(g.gap_type==='leaderboard_snapshot')return {t:'LM Arena leaderboard snapshot',id:'cat-lm-arena-snapshot-v1',p:'0.05',state:['ok','✓ Allowed · tier 1, automatic'],meta:'Would be proposed for '+g.id+'.'};
    return {t:'Evidence for '+g.gap_type.replace(/_/g,' '),id:'(none in catalog)',p:'—',state:['warn','! Unsupported by catalog'],meta:'catalog v1 has no item for this source, so Verity cannot buy it.'};});}
function renderTerm(light){
  const m=MARKETS[term.market];
  $('#qMid').textContent=(m.mid*100).toFixed(1)+'¢';$('#qBA').textContent=Math.round(m.bid*100)+'¢ / '+Math.round(m.ask*100)+'¢';$('#qVol').textContent=m.volLabel;
  $('#riskTotal').textContent=m.rating==='Incomplete'?m.total+' + ?':m.total+' / 12';const cls=m.rating==='Low'?'ok':m.rating==='Medium'?'warn':m.rating==='Incomplete'?'neutral':'no';
  const tg=$('#riskTag');tg.className='tag '+cls;tg.textContent=({ok:'✓ ',warn:'! ',neutral:'– ',no:'✕ '})[cls]+m.rating;
  const segs=$$('#gaugeTrack span');segs.forEach((s,i)=>{s.classList.toggle('on',i===(m.total<=6?0:m.total<=8?1:2));s.style.color=['#00C853','#F59E0B','#FF3B30'][i];});
  $('#gaugeMarker').style.left='calc('+(Math.max(0,Math.min(8,m.total-4))/8*100)+'% - 1px)';
  $('#scoreGrid').innerHTML=Object.entries(m.scores).map(([k,[v,why]])=>`<div title="${esc(why)}"><div class="label">${k[0].toUpperCase()+k.slice(1)}</div><div class="v">${v==null?'—':v}</div><div class="pips" aria-label="${v==null?'not scored':v+' of 3'}">${[1,2,3].map(i=>`<i class="${i<=v?'on':''}"></i>`).join('')}</div></div>`).join('');
  $('#riskWhy').textContent=m.live?(m.r.gaps.length?'Open settlement question: '+m.r.gaps[0].question:'Scored live by the rules port. Risk is how the contract settles, not how likely the outcome is.'):m.key==='nyc'?'Medium because the rule names a report version with a word missing, and the market is thin. Risk is not a probability.':'Low: a clear source and a deep book. Risk is how the contract settles, not how likely OKC is to win.';
  const J=m.live?liveJSON(m):m.key==='nyc'?NYC_JSON:OKC_JSON;term.json=J;$('#riskJson').innerHTML=hl(JSON.stringify(J,null,2));$('#inspSrc').textContent=m.file;
  const openF=new Set($$('#flagList .flag>button[aria-expanded="true"]').map(b=>b.textContent));$('#flagList').innerHTML=(m.live?liveFlags(m):FLAGS[m.key]).map((f,i)=>`<div class="flag"><button aria-expanded="false" aria-controls="fb${i}"><span class="tag ${f.sev}">${{warn:'!',no:'✕',info:'i',ok:'✓',neutral:'–'}[f.sev]}</span><span><span style="display:block;font-size:.9rem">${f.title}</span><span class="label">${f.prov}</span></span><span class="chev" aria-hidden="true">›</span></button><div class="flag-body" id="fb${i}">${f.body}${f.ex?`<div class="excerpt"><span class="label" style="display:block;margin-bottom:4px">Contract excerpt · ${f.prov.split('·')[0]}</span>${f.ex}</div>`:''}</div></div>`).join('');
  $$('#flagList .flag>button').forEach(b=>{if(light&&openF.has(b.textContent)){b.setAttribute('aria-expanded','true');$('#'+b.getAttribute('aria-controls')).classList.add('open');}});$$('#flagList .flag>button').forEach(b=>b.addEventListener('click',()=>{const o=b.getAttribute('aria-expanded')!=='true';b.setAttribute('aria-expanded',o);$('#'+b.getAttribute('aria-controls')).classList.toggle('open',o);}));
  $('#purchaseList').innerHTML=(m.live?livePurch(m):PURCH[m.key]).map(p=>`<div class="purchase"><span>${p.t}</span><span class="num">${p.p} USDC</span><span class="meta"><span class="tag ${p.state[0]}">${p.state[1]}</span> <code class="mono" style="font-size:.7rem">${p.id}</code><br>${p.meta}</span></div>`).join('');
  const pb=$('#probBadge'),cb=$('#candleBadge');pb.className=cb.className=m.live?'real':'demo';pb.textContent=m.live?'Gemini Exchange candles':'Demo price path';cb.textContent=m.live?'Gemini Exchange':'Demo candles';
  if(!light||!m.live)$('#probFoot').textContent=m.live?(term.foot||'Closing price of each Gemini Exchange candle for the contract shown. The band is the live bid–ask.'):'The path ends at the real captured mid. Earlier points are a deterministic demo fixture.';
  $('#candleFoot').textContent=m.live?'Real 5-minute candles and live top of book. Order-book depth is not public.':'Top of book is real; candles and depth beyond it are fixtures.';
  $('#mktQ').textContent=m.question;if(typeof gaiSyncMarket==='function')gaiSyncMarket();
  renderMarketPanel(m);
  if(light){drawProb();drawCandles();return;}
  renderProb();seedCandles();drawCandles();
}
function renderMarketPanel(m){const dl=$('#mktDetails'),tb=$('#mktOutcomes');if(!dl)return;
  const row=(k,v)=>v==null||v===''?'':`<dt>${k}</dt><dd>${v}</dd>`;const when=iso=>iso?new Date(iso).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})+' ('+closesIn(iso)+')':null;
  if(m.live){const e=m.e,c=m.c,p=c.prices||{};const b=lnum(p.bestBid),a=lnum(p.bestAsk);
    $('#mktSrc').textContent='live · Gemini Exchange · '+new Date(LIVE.lastOk||Date.now()).toLocaleTimeString();
    dl.innerHTML=row('Event',esc(e.title))+row('Category',esc([e.category,typeof e.subcategory==='string'?e.subcategory:(e.subcategory&&(e.subcategory.name||e.subcategory.label||e.subcategory.title))].filter(Boolean).join(' · ')))+row('Ticker','<span class="mono">'+esc(e.ticker)+'</span>')
      +row('Selected outcome',esc(c.label))+row('Bid / ask',b!=null||a!=null?`<span class="num">${b!=null?(b*100).toFixed(0)+'¢':'—'} / ${a!=null?(a*100).toFixed(0)+'¢':'—'}${b!=null&&a!=null?' · spread '+Math.round((a-b)*100)+'¢':''}</span>`:'No live quote')
      +row('Last trade',p.lastTradePrice!=null?'<span class="num">'+(+p.lastTradePrice*100).toFixed(1)+'¢</span>':'No trades yet')
      +row('Volume','<span class="num">'+lusd(e.volume)+' total · '+lusd(e.volume24h)+' in 24h</span>')
      +row('Closes',when(c.expiryDate||e.expiryDate))+row('Starts',e.startTime?(Date.parse(e.startTime)<=Date.now()?new Date(e.startTime).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})+' (started)':when(e.startTime)):null)
      +row('Settlement source',e.sourceDetails?esc(Object.values(e.sourceDetails).join(' · ')):null)
      +row('Rules',e.termsLink||c.termsAndConditionsUrl?`<a href="${esc(safeHref(e.termsLink||c.termsAndConditionsUrl))}" target="_blank" rel="noopener">Terms PDF</a>`:'No terms link')
      +row('Outcomes',String((e.contracts||[]).length));
    const cs=(e.contracts||[]).slice().sort((x,y)=>(lmid(y.prices)??-1)-(lmid(x.prices)??-1));
    tb.innerHTML=cs.map(x=>{const q=x.prices||{},mm=lmid(q),sel=x.id===c.id;const f=v=>v==null?'—':(+v*100).toFixed(0)+'¢';
      return `<tr class="${sel?'sel':''}"><td style="white-space:normal">${esc(x.label)}${x.status!=='active'?' <span class="label">'+esc(x.status)+'</span>':''}</td><td class="num">${f(q.bestBid)}</td><td class="num">${f(q.bestAsk)}</td><td class="num">${f(q.lastTradePrice)}</td><td class="num">${mm==null?'—':(mm*100).toFixed(1)+'¢'}</td><td>${sel?'<span class="tag info">Shown</span>':`<button class="btn sm" data-pick="${esc(x.id)}" ${mm==null?'disabled title="No price yet"':''}>Show</button>`}</td></tr>`;}).join('');
    $$('#mktOutcomes [data-pick]').forEach(btn=>btn.addEventListener('click',()=>{const x=e.contracts.find(k=>k.id===btn.dataset.pick);if(x)selectLive(e,x,false);}));}
  else{const J=m.key==='nyc'?NYC_JSON:OKC_JSON,q=J.quoted_price;$('#mktSrc').textContent='Nov 18, 2026 capture';
    dl.innerHTML=row('Market',esc(m.question))+row('Ticker','<span class="mono">'+esc(J.event_ticker)+'</span>')+row('Outcome',esc(q.outcome_label))+row('Bid / ask','<span class="num">'+(q.best_bid*100).toFixed(0)+'¢ / '+(q.best_ask*100).toFixed(0)+'¢</span>')+row('Volume','<span class="num">$'+(+q.volume_usd).toLocaleString()+'</span>')+row('Source',esc(m.source));
    tb.innerHTML=`<tr><td colspan="6" class="muted" style="white-space:normal">Only the analysed outcome was captured on Nov 18. Pick a live market to see every outcome with live prices.</td></tr>`;}}
function selectLive(e,c,scroll){MARKETS.live=liveMarket(e,c);term.market='live';term.userPicked=true;
  $$('[data-market]').forEach(x=>x.setAttribute('aria-pressed',x.dataset.market==='live'));$('#liveBtn').disabled=false;$('#liveBtn').textContent='Live: '+ltitle(e.title).slice(0,34);
  const sel=$('#liveSel');if(sel)sel.value=c.id;renderTerm();if(scroll)$('#terminal').scrollIntoView({behavior:RM.matches?'auto':'smooth'});}
function fillLiveSel(){const sel=$('#liveSel');const rows=LIVE.events.map(e=>({e,c:favourite(e)})).filter(x=>x.c).sort((a,b)=>(+b.e.volume24h||0)-(+a.e.volume24h||0)).slice(0,40);
  const cur=MARKETS.live&&MARKETS.live.c.id;const ids=rows.map(r=>r.c.id).join();if(sel.dataset.ids===ids&&(!cur||sel.value===cur))return;sel.dataset.ids=ids;
  sel.innerHTML='<option value="">Pick a live market…</option>'+rows.map(r=>`<option value="${esc(r.c.id)}" data-ev="${esc(r.e.ticker)}">${esc(r.e.category)} · ${esc(ltitle(r.e.title).slice(0,46))} · ${(lmid(r.c.prices)*100).toFixed(0)}¢</option>`).join('');
  if(cur&&rows.some(r=>r.c.id===cur))sel.value=cur;}
$('#liveSel').addEventListener('change',e=>{const o=e.target.selectedOptions[0];if(!o||!o.value)return;const ev=LIVE.events.find(x=>x.ticker===o.dataset.ev);const c=ev&&ev.contracts.find(x=>x.id===o.value);if(c)selectLive(ev,c,false);});
LIVE.on(()=>{if(!LIVE.events.length)return;fillLiveSel();
  if(!term.userPicked&&!MARKETS.live){const top=LIVE.events.map(e=>({e,c:favourite(e)})).filter(x=>x.c&&x.c.instrumentSymbol).sort((a,b)=>(+b.e.volume24h||0)-(+a.e.volume24h||0))[0];
    if(top){selectLive(top.e,top.c,false);term.userPicked=false;}}
  else if(MARKETS.live){const e=LIVE.events.find(x=>x.ticker===MARKETS.live.e.ticker);const c=e&&e.contracts.find(x=>x.id===MARKETS.live.c.id);
    if(c&&lmid(c.prices)!=null){MARKETS.live=liveMarket(e,c);if(term.market==='live')renderTerm(true);}}});
$$('[data-market]').forEach(b=>b.addEventListener('click',()=>{if(b.dataset.market==='live'&&!MARKETS.live)return;term.market=b.dataset.market;term.userPicked=true;$$('[data-market]').forEach(x=>x.setAttribute('aria-pressed',x===b));renderTerm();}));
$('#copyJson').addEventListener('click',()=>copy(JSON.stringify(term.json,null,2),'Risk JSON copied'));
$$('[data-inspect]').forEach(a=>a.addEventListener('click',()=>setTimeout(()=>{const b=$('#flagList .flag>button');if(b&&b.getAttribute('aria-expanded')!=='true')b.click();},400)));

/* ---------- Walkthrough ---------- */
const REQ={method:'GET',resource:'/v1/catalog/cat-nws-cli-settlement-version-v1',params:{station:'KNYC',date:'2026-11-18'},amount:'50000',asset:'USDC',chain:'arc-testnet',merchant:'verity-demo-merchant',expires_at:'2026-11-18T01:10:00Z',request_id:'req-nyc-0001'};
const DELIVERY={item:'cat-nws-cli-settlement-version-v1',station:'KNYC',date:'2026-11-18',fixture:true,note:'Demo fixture body. A real report would list each NWS CLI issuance with times and quote the exchange rule that names the version.'};
const W={step:0,running:false,timer:0,tampered:false,approval:'idle',testAmt:0.05,approvalTimer:0,deadline:0,hashes:{},done:new Set()};
const STEPS=[
  {t:'Contract ingestion',nodes:['gx','ra'],edges:['gx-ra']},
  {t:'Gap detection',nodes:['ra'],edges:[]},
  {t:'Policy gate',nodes:['pg','ow'],edges:['ra-pg','pg-ow','ow-pg']},
  {t:'x402 payment',nodes:['ps','mc'],edges:['pg-ps','ps-mc','mc-ps']},
  {t:'Settlement and delivery',nodes:['arc','qn','mc'],edges:['ps-arc','arc-qn','mc-rc']},
  {t:'Audit report',nodes:['rc'],edges:['qn-rc','mc-rc']}];
function tierOf(a){if(a<=0)return null;if(a<=0.10)return 0;if(a<=0.50)return 1;if(a<=2.00)return 2;return 3;}
const TIERS=[['0.01–0.10','Automatic once shared checks pass (allowlisted merchant, valid quote, not a duplicate)'],['0.11–0.50','Automatic only for an open gap with no free or cached answer'],['0.51–2.00','Owner approval: Verity explains by voice, the owner signs with the wallet'],['Over 2.00','Rejected']];
function stepStatus(i){
  if(i===3&&W.tampered)return['fail','rejected'];
  if(i===2&&W.approval==='pending')return['wait','awaiting owner'];
  if(i===4&&W.tampered&&W.done.has(4))return['fail','not settled'];
  if(W.done.has(i))return['done','complete'];
  if(i===W.step)return['','in view'];return['','pending'];}
function renderTimeline(){
  $('#timeline').innerHTML=STEPS.map((s,i)=>{const [c,st]=stepStatus(i);return `<li><button data-step="${i}" class="${c}" ${i===W.step?'aria-current="step"':''}><span class="n">Step ${i+1}</span><span class="t">${s.t}</span><span class="st">${c==='done'?'✓ ':c==='fail'?'✕ ':c==='wait'?'! ':''}${st}</span></button></li>`;}).join('');
  $$('#timeline button').forEach(b=>b.addEventListener('click',()=>go(+b.dataset.step)));
}
async function computeHashes(){
  const c0=canon(REQ),t=JSON.parse(JSON.stringify(REQ));t.params.station='KLGA';const c1=canon(t);
  W.hashes={canon:c0,canonT:c1,req:kec(c0),reqT:kec(c1),content:await sha256(canon(DELIVERY)),deliveryCanon:canon(DELIVERY)};
}
function stageHTML(i){
  const H=W.hashes;
  if(i===0)return `<span class="label">Step 1 · Contract ingestion</span><h3 style="margin-top:6px">${MARKETS.nyc.question}</h3>
   <dl class="kv"><dt>Event ticker</dt><dd class="mono">WXHIGH-NYC-2611190459</dd><dt>Resolution source</dt><dd>NWS Climatological Report (Daily), Central Park</dd><dt>Expiry (UTC)</dt><dd class="mono">2026-11-19T04:59:00Z</dd><dt>Quote</dt><dd class="num">bid 0.54 · ask 0.58 · mid 0.56 · vol $7</dd><dt>Analyst</dt><dd class="mono">verity-rules-v1 (code rules, no LLM)</dd></dl>
   <div class="box"><span class="label">Rule 13.111(i)(2), weather terms PDF</span><p class="excerpt" style="margin-top:8px">only the first published version that includes confirmation of the <mark>___</mark> will be used</p><p class="muted" style="font-size:.84rem;margin-top:8px"><span class="tag warn">! ambiguity detected</span> A word is missing, so the rule does not say which report version counts.</p></div>`;
  if(i===1)return `<span class="label">Step 2 · Information gap detection</span><h3 style="margin-top:6px">One material gap, one non-gap</h3>
   <table style="margin-top:12px"><thead><tr><th>Gap</th><th>Affects</th><th>Priority</th><th class="num">Cost</th></tr></thead><tbody>
   <tr><td style="white-space:normal">Which NWS issuance settles<br><span class="label">GAP-NYC-SETTLE</span></td><td>Resolution risk</td><td><span class="tag warn">! Material</span></td><td class="num">0.05 USDC</td></tr>
   <tr><td style="white-space:normal">Likely max temperature<br><span class="label">GAP-NYC-FORECAST</span></td><td>Outcome probability</td><td><span class="tag neutral">– Not material</span></td><td class="num">not proposed</td></tr></tbody></table>
   <dl class="kv"><dt>Why it matters</dt><dd>A correction that moves the max across a 2°F band edge flips the outcome.</dd><dt>Free check first</dt><dd><span class="mono">nyc-settlement-version</span>: inconclusive (observed 2026-11-18)</dd><dt>Provider</dt><dd class="mono">verity-demo-merchant · cat-nws-cli-settlement-version-v1</dd><dt>Relevance vs confidence</dt><dd>Relevance is high: it targets the open rule. This says nothing about the outcome, and no confidence score is claimed.</dd></dl>`;
  if(i===2){const t=tierOf(W.testAmt);const need=t===2;return `<span class="label">Step 3 · Policy gate</span><h3 style="margin-top:6px">0.05 USDC clears tier 1 automatically</h3>
   <ul class="chain" style="margin-top:12px"><li class="ok"><span class="t">Merchant allowlisted</span><div class="d">verity-demo-merchant is in catalog v1’s allowlist</div></li><li class="ok"><span class="t">Quote valid</span><div class="d">50000 base units, expires 01:10 UTC</div></li><li class="ok"><span class="t">Not a duplicate</span><div class="d">No earlier purchase for req-nyc-0001</div></li><li class="ok"><span class="t">Budget</span><div class="d">0.05 of 25 USDC reserved, including money already reserved</div></li></ul>
   <div class="box"><div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><span class="label">Policy tester · does not change this run</span><span class="num" id="amtOut">${W.testAmt.toFixed(2)} USDC</span></div>
   <input type="range" class="range" id="amt" min="0.01" max="2.5" step="0.01" value="${W.testAmt}" aria-label="Test purchase amount in USDC" aria-valuetext="${W.testAmt.toFixed(2)} USDC">
   <table class="tiers"><thead><tr><th>Amount (USDC)</th><th>Behaviour</th></tr></thead><tbody>${TIERS.map((r,k)=>`<tr class="${k===t?'active':''}"><td class="num" style="text-align:left">${r[0]}</td><td>${r[1]}</td></tr>`).join('')}</tbody></table>
   <div class="budget" aria-hidden="true"><i class="spent" style="width:${0.05/25*100}%"></i><i class="res" style="left:${0.05/25*100}%;width:${Math.min(2,W.testAmt)/25*100}%"></i></div><div class="label" style="margin-top:4px">Budget 25 USDC · 0.05 reserved by this run · striped = tested amount</div>
   ${need?voiceHTML():t===3?`<div class="box no"><span class="tag no">✕ Rejected</span> Over 2.00 USDC is never purchased, with or without approval.</div>`:''}</div>`;}
  if(i===3){const a=W.tampered;return `<span class="label">Step 4 · Hardened x402 payment</span><h3 style="margin-top:6px">The payment is bound to this exact request</h3>
   <p class="muted" style="font-size:.86rem;margin-top:6px">Canonical form: sorted-key JSON with no whitespace (demo canonicalization). <code class="mono">requestHash = keccak256(canonicalRequest)</code>, computed in your browser.</p>
   <pre class="code" style="max-height:none;margin-top:10px;border:1px solid var(--border-hairline);border-radius:4px;white-space:pre-wrap;word-break:break-all">${esc(H.canon)}</pre>
   <span class="label" style="display:block;margin-top:10px">Signed request hash</span><div class="hashline good">${H.req}</div>
   ${a?`<span class="label" style="display:block;margin-top:10px">Tampered request (params.station → <span class="diff">KLGA</span>)</span><pre class="code" style="max-height:none;margin-top:6px;border:1px solid var(--signal-no);border-radius:4px;white-space:pre-wrap;word-break:break-all">${esc(H.canonT).replace('KLGA','<span class="diff">KLGA</span>')}</pre><span class="label" style="display:block;margin-top:10px">Recomputed by merchant</span><div class="hashline bad">${H.reqT}</div>
   <div class="box no"><span class="tag no">✕ Merchant rejects</span><p style="font-size:.86rem;margin-top:8px">The commitments differ (${H.req.slice(0,10)}… ≠ ${H.reqT.slice(0,10)}…). The authorization was signed over the KNYC request, so accepting it for KLGA would pay for a resource the agent never approved. Demo response: <code class="mono">request_hash_mismatch</code>. The real status code follows the payment service’s API contract; it is not a 402, which only means payment is required.</p></div>`:
   `<div class="box ok"><span class="tag ok">✓ Commitment matches</span><p style="font-size:.86rem;margin-top:8px">The merchant recomputes the hash from the request it received and compares it with the hash in the authorization. EIP-3009 adds a one-time nonce so the same authorization cannot be used twice.</p></div>`}
   <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px"><button class="btn sm" id="tamper" aria-pressed="${a}">${a?'Restore original request':'Tamper request field'}</button><button class="btn sm ghost" id="copyCanon">Copy canonical request</button></div>`;}
  if(i===4){const a=W.tampered;return `<span class="label">Step 5 · Settlement evidence and delivery</span><h3 style="margin-top:6px">${a?'Nothing settles for a rejected request':'Payment and delivery, recorded separately'}</h3>
   <ul class="chain">
   <li class="${a?'no':'ok'}"><span class="t">Payment authorization</span><div class="d">EIP-3009 TransferWithAuthorization over ${short(H.req)} <span class="demo">SIMULATED SIGNATURE</span></div></li>
   <li class="${a?'no':'ok'}"><span class="t">Payment submission</span><div class="d">${a?'Not submitted: the merchant rejected the request':'<span class="mono">demo-tx-0001</span>, direct Arc Testnet settlement'}</div></li>
   <li class="${a?'no':'ok'}"><span class="t">Settlement evidence</span><div class="d">${a?'None':'QuickNode-shaped event, AuthorizationUsed + Transfer <span class="demo">SIMULATED</span>'}</div></li>
   <li class="${a?'no':'ok'}"><span class="t">Merchant delivery</span><div class="d">${a?'None':'Response body received (demo fixture)'}</div></li>
   <li class="${a?'no':H.content?'ok':'warn'}"><span class="t">Content hash verification</span><div class="d">${a?'—':H.content?`<span class="mono">${short(H.content)}</span> computed from the body matches the merchant’s receipt`:'SHA-256 is unavailable in this browser context'}</div></li>
   <li class="${a?'no':'ok'}"><span class="t">Reconciliation ingestion</span><div class="d">${a?'Recorded as a rejected request, no charge':'One payment, one delivery, keyed by request hash and nonce'}</div></li></ul>
   <div class="box"><span class="label">Rails are not interchangeable</span><p style="font-size:.84rem;margin-top:6px">This run uses direct Arc settlement, where one transaction carries one transfer. With Circle Gateway, many transfers settle in one batch transaction; an individual purchase is attributed from Gateway’s own transfer record, never from the batch receipt alone.</p></div>`;}
  if(i===5){const r=report();return `<span class="label">Step 6 · Final risk and audit report</span><h3 style="margin-top:6px">${r.status}</h3>
   <dl class="kv"><dt>Original finding</dt><dd>${r.finding}</dd><dt>Purchased evidence</dt><dd>${r.evidence}</dd><dt>Updated risk</dt><dd>${r.risk}</dd><dt>Authorized spend</dt><dd class="num">${r.spend} USDC of 25</dd><dt>Confirmed payments</dt><dd class="num">${r.payments}</dd><dt>Verified deliveries</dt><dd class="num">${r.deliveries}</dd><dt>Policy test</dt><dd>${r.policy}</dd><dt>Remaining uncertainty</dt><dd>${r.left}</dd></dl>
   <details class="box"><summary style="cursor:pointer">Technical audit trail</summary><dl class="kv"><dt>request_id</dt><dd class="mono">req-nyc-0001</dd><dt>requestHash</dt><dd class="mono">${W.tampered?H.reqT+' (rejected)':H.req}</dd><dt>transaction</dt><dd class="mono">${W.tampered?'none':'demo-tx-0001 (demo identifier)'}</dd><dt>contentHash</dt><dd class="mono">${W.tampered?'none':H.content||'unavailable'}</dd></dl></details>
   <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px"><button class="btn sm" id="copyReport">Copy demo summary</button><button class="btn sm" id="dlReport">Download JSON</button></div>`;}
}
function report(){const ok=!W.tampered&&!!W.hashes.content;
  return {status:ok?'Reconciled: payment matches delivery':W.tampered?'Not reconciled: request rejected':'Incomplete: content hash unavailable',
    finding:'Medium resolution risk (8 of 12). The rule naming the settling report is missing a word.',
    evidence:ok?'Settlement-version report, 0.05 USDC (demo fixture body)':'None',
    risk:'8 of 12, Medium, unchanged. The delivered body is a fixture, so no real answer was read; a real report could lower ambiguity and source.',
    spend:ok?'0.05':'0.00',payments:ok?'1 (demo)':'0',deliveries:ok?'1 verified (demo)':'0',
    policy:W.approval==='approved'?`${W.testAmt.toFixed(2)} USDC tested: owner approved and signed (simulated)`:W.approval==='denied'?`${W.testAmt.toFixed(2)} USDC tested: denied by owner`:W.approval==='timeout'?`${W.testAmt.toFixed(2)} USDC tested: approval timed out, not purchased`:'No escalation tested',
    left:'Which NWS issuance settles remains open until a real report is read.',
    requestHash:W.tampered?W.hashes.reqT:W.hashes.req,contentHash:ok?W.hashes.content:null,demo:true};}
function voiceHTML(){const s=W.approval;const left=Math.max(0,Math.ceil((W.deadline-Date.now())/1000));
  return `<div class="voice" aria-live="polite"><div class="voice-head"><span><b style="font-size:.9rem">Verity agent → owner</b> <span class="label">voice approval</span></span><span class="demo">SIMULATED CALL · NO AUDIO</span></div>
   <div class="wave" id="wave" aria-hidden="true">${Array.from({length:40},()=>'<i></i>').join('')}</div>
   <div class="voice-body"><dl class="kv" style="margin:0"><dt>Merchant</dt><dd class="mono">verity-demo-merchant</dd><dt>Resource</dt><dd>Hypothetical item priced at ${W.testAmt.toFixed(2)} USDC</dd><dt>Amount</dt><dd class="num">${W.testAmt.toFixed(2)} USDC</dd><dt>Deadline</dt><dd class="num">${s==='pending'?left+' s':'20 s once requested'}</dd><dt>State</dt><dd>${{idle:'<span class="tag neutral">– not requested</span>',pending:'<span class="tag warn">! awaiting owner</span>',heard:'<span class="tag warn">! verbal yes, signature needed</span>',approved:'<span class="tag ok">✓ signed (simulated)</span>',denied:'<span class="tag no">✕ denied</span>',timeout:'<span class="tag no">✕ timed out</span>'}[s]}</dd></dl>
   <p class="muted" style="font-size:.8rem;margin-top:10px">Voice is the interface. The wallet signature is the authorization. A spoken yes alone never pays.</p></div>
   <div class="voice-actions">${s==='idle'||s==='denied'||s==='timeout'||s==='approved'?`<button class="btn sm primary" id="vReq">Request approval</button>`:''}${s==='pending'?`<button class="btn sm" id="vYes">Owner says yes</button><button class="btn sm" id="vNo">Deny</button>`:''}${s==='heard'?`<button class="btn sm primary" id="vSign">Authorize with wallet signature</button><button class="btn sm" id="vNo">Deny</button>`:''}</div></div>`;}
let waveRaf=0;
function animateWave(){cancelAnimationFrame(waveRaf);const bars=$$('#wave i');if(!bars.length||RM.matches||W.approval!=='pending'&&W.approval!=='heard')return;const t0=performance.now();
  const f=t=>{const k=(t-t0)/1000;bars.forEach((b,i)=>{b.style.height=(6+Math.abs(Math.sin(k*5+i*.5)*Math.sin(k*1.7+i*.13))*36)+'px';});if(W.step===2&&(W.approval==='pending'||W.approval==='heard'))waveRaf=requestAnimationFrame(f);};waveRaf=requestAnimationFrame(f);}
function bindStage(){
  const amt=$('#amt');if(amt)amt.addEventListener('input',()=>{W.testAmt=+amt.value;if(W.approval!=='idle'){W.approval='idle';clearInterval(W.approvalTimer);}const pos=amt.selectionStart;renderStage(true);const n=$('#amt');n&&n.focus();});
  const tm=$('#tamper');if(tm)tm.addEventListener('click',()=>{W.tampered=!W.tampered;renderAll();$('#tamper')&&$('#tamper').focus();});
  const cc=$('#copyCanon');if(cc)cc.addEventListener('click',()=>copy(W.tampered?W.hashes.canonT:W.hashes.canon,'Canonical request copied'));
  const cr=$('#copyReport');if(cr)cr.addEventListener('click',()=>{const r=report();copy(`Verity demo run (SIMULATED)\n${r.status}\nFinding: ${r.finding}\nEvidence: ${r.evidence}\nRisk: ${r.risk}\nSpend: ${r.spend} USDC of 25\nRequest hash: ${r.requestHash}\nContent hash: ${r.contentHash||'none'}\nPolicy test: ${r.policy}`,'Summary copied');});
  const dl=$('#dlReport');if(dl)dl.addEventListener('click',()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(report(),null,2)],{type:'application/json'}));a.download='verity-demo-run.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);});
  const vr=$('#vReq');if(vr)vr.addEventListener('click',()=>{W.approval='pending';W.deadline=Date.now()+20000;clearInterval(W.approvalTimer);W.approvalTimer=setInterval(()=>{if(Date.now()>=W.deadline&&(W.approval==='pending'||W.approval==='heard')){W.approval='timeout';clearInterval(W.approvalTimer);renderAll();}else if(W.step===2){const d=$$('.voice .kv dd')[3];if(d)d.textContent=Math.max(0,Math.ceil((W.deadline-Date.now())/1000))+' s';}},500);renderAll();$('#vYes')&&$('#vYes').focus();});
  const vy=$('#vYes');if(vy)vy.addEventListener('click',()=>{W.approval='heard';renderAll();$('#vSign')&&$('#vSign').focus();});
  const vn=$('#vNo');if(vn)vn.addEventListener('click',()=>{W.approval='denied';clearInterval(W.approvalTimer);renderAll();$('#vReq')&&$('#vReq').focus();});
  const vs=$('#vSign');if(vs)vs.addEventListener('click',()=>{vs.setAttribute('aria-busy','true');vs.disabled=true;setTimeout(()=>{W.approval='approved';clearInterval(W.approvalTimer);renderAll();toast('Simulated signature recorded. No wallet was contacted.');},700);});
  animateWave();
}
function renderStage(keep){const st=$('#stage');st.innerHTML=`<div class="stage-body"${keep?' style="animation:none"':''}>${stageHTML(W.step)}</div>`;bindStage();}
function renderAll(){renderTimeline();renderStage();updateArch();$('#archStep').textContent='Step '+(W.step+1)+' of 6';
  $('#wtPrev').disabled=W.step===0;$('#wtNext').disabled=W.step===5;}
function go(i){W.step=Math.max(0,Math.min(5,i));for(let k=0;k<W.step;k++)W.done.add(k);renderAll();}
function stopRun(){W.running=false;clearInterval(W.timer);$('#wtRun').textContent='Simulate agent run';$('#wtRun').removeAttribute('aria-busy');$('#wtPause').disabled=true;$('#wtPause').textContent='Pause';}
function startRun(fromStart){if(fromStart){W.done.clear();W.tampered=false;W.step=0;}W.running=true;$('#wtRun').textContent='Running';$('#wtRun').setAttribute('aria-busy','true');$('#wtPause').disabled=false;$('#wtPause').textContent='Pause';renderAll();
  clearInterval(W.timer);W.timer=setInterval(()=>{if(W.step>=5){W.done.add(5);stopRun();renderAll();toast('Run complete. See the audit report.');return;}W.done.add(W.step);go(W.step+1);},RM.matches?1800:2600);}
$('#wtRun').addEventListener('click',()=>{if(W.running)return;startRun(W.step===5||W.step===0);});
$('#wtPause').addEventListener('click',()=>{if(W.running){W.running=false;clearInterval(W.timer);$('#wtPause').textContent='Resume';$('#wtRun').textContent='Paused';$('#wtRun').removeAttribute('aria-busy');}else startRun(false);});
$('#wtReset').addEventListener('click',()=>{stopRun();W.done.clear();W.tampered=false;W.approval='idle';W.testAmt=.05;clearInterval(W.approvalTimer);W.step=0;renderAll();});
$('#wtNext').addEventListener('click',()=>{W.done.add(W.step);go(W.step+1);});
$('#wtPrev').addEventListener('click',()=>go(W.step-1));
$('#wtEvidence').addEventListener('click',e=>openDrawer(runRecord(),e.currentTarget));
$$('[data-launch]').forEach(a=>a.addEventListener('click',()=>setTimeout(()=>{if(!W.running&&W.step===0)startRun(true);},500)));

/* ---------- Architecture SVG ---------- */
const NODES={gx:[20,20,'Gemini Exchange API','public market data'],ra:[20,108,'Rules analyst','verity-rules-v1'],pg:[20,196,'Policy gate','tiers · budget'],ow:[290,196,'Owner','voice + wallet'],
  ps:[20,284,'Payment service','holds the signer'],mc:[290,284,'Merchant (x402)','recomputes hash'],arc:[20,420,'Arc Testnet','USDC settlement'],qn:[290,420,'QuickNode Streams','event delivery'],rc:[155,508,'Reconciler','payment ↔ delivery']};
const NTIP={gx:'Public event endpoint. Reading market data needs no key.',ra:'Scores ambiguity, source, liquidity and correlation with code rules, then lists gaps.',pg:'Checks the tier, the 25 USDC budget, the allowlist, the quote and duplicates.',ow:'For 0.51–2.00 USDC: Verity explains by voice, the owner signs. Voice alone never authorizes.',ps:'Separate from analysis. Builds the canonical request, hashes it and signs EIP-3009.',mc:'Answers 402 with a quote, recomputes the request hash and rejects mismatches.',arc:'USDC transfer settles on Arc Testnet.',qn:'Streams AuthorizationUsed and Transfer events to the auditor.',rc:'Joins settlement events to verified deliveries and flags exceptions.'};
const EDGES={'gx-ra':['gx','ra'],'ra-pg':['ra','pg'],'pg-ow':['pg','ow'],'ow-pg':['ow','pg',1],'pg-ps':['pg','ps'],'ps-mc':['ps','mc'],'mc-ps':['mc','ps',1],'ps-arc':['ps','arc'],'arc-qn':['arc','qn'],'qn-rc':['qn','rc'],'mc-rc':['mc','rc']};
(function buildArch(){const NW=210,NH=56;let s=`<svg viewBox="0 0 520 584" role="group" aria-label="System path diagram"><defs><marker id="ah" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L8 4 0 8z" fill="#2A3550"/></marker><marker id="ahOn" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L8 4 0 8z" fill="#2E5CFF"/></marker></defs>`;
  s+=`<line x1="0" y1="372" x2="520" y2="372" stroke="#2A3550" stroke-dasharray="4 4"/><text x="262" y="364" fill="#8B9BB4" font-family="JetBrains Mono,monospace" font-size="10" text-anchor="middle">OFFCHAIN</text><text x="262" y="388" fill="#8B9BB4" font-family="JetBrains Mono,monospace" font-size="10" text-anchor="middle">ONCHAIN · ARC TESTNET</text>`;
  const c=(k,side)=>{const [x,y]=NODES[k];return side==='b'?[x+NW/2,y+NH]:side==='t'?[x+NW/2,y]:side==='r'?[x+NW,y+NH/2]:[x,y+NH/2];};
  for(const [id,[a,b,resp]] of Object.entries(EDGES)){let p;const A=NODES[a],B=NODES[b];
    if(A[0]===B[0]){const [x1,y1]=c(a,'b'),[x2,y2]=c(b,'t');p=`M${x1-(resp?24:0)} ${y1}L${x2-(resp?24:0)} ${y2-2}`;}
    else if(A[1]===B[1]){const r=A[0]<B[0];const [x1,y1]=c(a,r?'r':'l'),[x2,y2]=c(b,r?'l':'r');const o=resp?14:-6;p=`M${x1} ${y1+o}L${x2+(r?-2:2)} ${y2+o}`;}
    else{const [x1,y1]=c(a,'b'),[x2,y2]=c(b,'t');const my=(y1+y2)/2;p=`M${x1+(a==='mc'?40:0)} ${y1}C${x1+(a==='mc'?40:0)} ${my} ${x2} ${my} ${x2+(a==='mc'?24:-24)} ${y2-2}`;}
    if(id==='mc-rc')p='M500 312L510 312L510 536L369 536';if(id==='qn-rc')p='M395 476C395 492 300 490 300 506';s+=`<path class="edge${resp?' resp':''}" id="e-${id}" d="${p}" marker-end="url(#ah)"/>`;}
  for(const [k,[x,y,t,sub]] of Object.entries(NODES))s+=`<g class="node" id="n-${k}" tabindex="0" role="img" aria-label="${t}: ${NTIP[k]}"><rect x="${x}" y="${y}" width="${NW}" height="${NH}" rx="6"/><text class="tt" x="${x+14}" y="${y+24}">${t}</text><text x="${x+14}" y="${y+42}">${sub}</text></g>`;
  $('#arch').innerHTML=s+'</svg>';
  $$('#arch .node').forEach(g=>{const k=g.id.slice(2);const show=()=>{$('#archTip').innerHTML=`<b style="color:var(--text-primary)">${NODES[k][2]}</b> · ${NTIP[k]}`;};g.addEventListener('mouseenter',show);g.addEventListener('focus',show);g.addEventListener('click',show);});
})();
function updateArch(){const st=STEPS[W.step];$$('#arch .node').forEach(n=>n.classList.remove('on','err','ok'));$$('#arch .edge').forEach(e=>{e.classList.remove('on','err');e.setAttribute('marker-end','url(#ah)');});
  st.nodes.forEach(k=>$('#n-'+k).classList.add('on'));st.edges.forEach(k=>{const e=$('#e-'+k);if(e){e.classList.add('on');e.setAttribute('marker-end','url(#ahOn)');}});
  if(W.tampered&&W.step>=3){$('#n-mc').classList.remove('on');$('#n-mc').classList.add('err');$('#e-ps-mc').classList.remove('on');$('#e-ps-mc').classList.add('err');if(W.step===4){['arc','qn'].forEach(k=>$('#n-'+k).classList.remove('on'));['ps-arc','arc-qn'].forEach(k=>{$('#e-'+k).classList.remove('on');$('#e-'+k).setAttribute('marker-end','url(#ah)');});}}
  if(W.step===5&&!W.tampered)$('#n-rc').classList.add('ok');
  if(W.step===2&&tierOf(W.testAmt)!==2){$('#n-ow').classList.remove('on');['pg-ow','ow-pg'].forEach(k=>{$('#e-'+k).classList.remove('on');$('#e-'+k).setAttribute('marker-end','url(#ah)');});}
}

/* ---------- Code tabs ---------- */
function tabContent(){const H=W.hashes,vb=Math.floor(Date.parse(REQ.expires_at)/1000);
  return {
  '402':{lang:'http',label:'Illustrative · field names follow the public x402 spec; Verity’s merchant response is not in this repo',code:`HTTP/1.1 402 Payment Required
Content-Type: application/json

${JSON.stringify({x402Version:1,accepts:[{scheme:'exact',network:'arc-testnet',maxAmountRequired:'50000',resource:REQ.resource+'?date=2026-11-18&station=KNYC',description:'NWS daily climate report: settlement-version check',payTo:'<merchant address, not in fixtures>',asset:'<USDC on Arc Testnet>',maxTimeoutSeconds:600,extra:{requestHash:H.req}}]},null,2)}`,
   ex:['The merchant answers an unpaid request with 402 and a quote. 50000 base units is 0.05 USDC (6 decimals), the catalog v1 price.','The request hash travels with the quote, so the agent signs over exactly this resource and these parameters.']},
  '3009':{lang:'json',label:'Pseudocode · assumes nonce = requestHash; confirm against the payment service',code:JSON.stringify({primaryType:'TransferWithAuthorization',domain:{name:'USDC',version:'2',chainId:'<Arc Testnet chain id>',verifyingContract:'<USDC contract>'},types:{TransferWithAuthorization:[{name:'from',type:'address'},{name:'to',type:'address'},{name:'value',type:'uint256'},{name:'validAfter',type:'uint256'},{name:'validBefore',type:'uint256'},{name:'nonce',type:'bytes32'}]},message:{from:'<agent wallet>',to:'<merchant address>',value:'50000',validAfter:'0',validBefore:String(vb),nonce:H.req}},null,2),
   ex:['EIP-3009 lets the token contract move USDC with a signed authorization. Each nonce can be used once, which blocks replays.','Putting the request hash in the nonce ties the signature to one canonical request. The merchant still has to recompute the hash and compare.',`validBefore ${vb} is ${REQ.expires_at}, the quote expiry.`]},
  'risk':{lang:'json',label:'Real output · samples/nyc_high_gap_remains.json (excerpt)',code:JSON.stringify(NYC_JSON,null,2),ex:['This is what the rules analyst writes for the NYC market. No LLM is involved; scoring is code in rules_analyst.py.','Totals: 4–6 Low, 7–8 Medium, 9–12 High. Liquidity is computed from bid, ask and volume.']},
  'qn':{lang:'json',label:'Simulated · shape of a filtered stream payload; not real QuickNode output',code:JSON.stringify({stream:'demo-arc-usdc',network:'arc-testnet',simulated:true,data:[{transactionHash:'demo-tx-0001',logs:[{event:'AuthorizationUsed',authorizer:'<agent wallet>',nonce:H.req},{event:'Transfer',from:'<agent wallet>',to:'<merchant address>',value:'50000'}]}]},null,2),
   ex:['The auditor listens for AuthorizationUsed, which EIP-3009 emits per nonce, and the matching Transfer.','A replayed event carries the same nonce, so the ledger deduplicates it instead of counting a second charge.']}};}
function renderTabs(){const C=tabContent();$('#tabPanels').innerHTML=Object.entries(C).map(([k,v],i)=>`<div class="tabpanel" role="tabpanel" id="panel-${k}" aria-labelledby="tab-${k}" ${i?'hidden':''} tabindex="0"><div style="min-width:0"><div class="copy-row"><span class="${v.label.startsWith('Real')?'real':'demo'}">${esc(v.label)}</span><button class="btn sm" data-copy="${k}">Copy</button></div><pre class="code" style="max-height:420px">${v.lang==='http'?hl(v.code).replace(/^HTTP\/1\.1 402 Payment Required/,'<span class="b">HTTP/1.1 402 Payment Required</span>'):hl(v.code)}</pre></div><div class="explain">${v.ex.map(p=>`<p>${p}</p>`).join('')}</div></div>`).join('');
  $$('[data-copy]').forEach(b=>b.addEventListener('click',()=>copy(C[b.dataset.copy].code,'Code copied')));}
(function tabs(){const tabs=$$('#tablist [role=tab]');const sel=t=>{tabs.forEach(x=>{const on=x===t;x.setAttribute('aria-selected',on);x.tabIndex=on?0:-1;$('#'+x.getAttribute('aria-controls')).hidden=!on;});};
  tabs.forEach((t,i)=>{t.addEventListener('click',()=>sel(t));t.addEventListener('keydown',e=>{let j=null;if(e.key==='ArrowRight')j=(i+1)%tabs.length;if(e.key==='ArrowLeft')j=(i-1+tabs.length)%tabs.length;if(e.key==='Home')j=0;if(e.key==='End')j=tabs.length-1;if(j!=null){e.preventDefault();tabs[j].focus();sel(tabs[j]);}});});})();

/* Front page hand-off: a market picked from the constellation opens in the terminal */
window.verityPickMarket=async function(){let pick;try{pick=JSON.parse(sessionStorage.getItem('verity.pick')||'null');sessionStorage.removeItem('verity.pick');}catch(e){}
  if(!pick||!pick.ticker)return;if(window.VERITY_GATE)await window.VERITY_GATE;await new Promise(r=>setTimeout(r,400));
  try{const j=await LIVE.get('/v1/prediction-markets/events/'+encodeURIComponent(pick.ticker));const ev=j&&j.data&&!Array.isArray(j.data)?j.data:j;
    const c=ev&&(ev.contracts||[]).find(x=>x.id===pick.contract);if(c)selectLive(ev,c,true);else $('#terminal').scrollIntoView();}
  catch(e){console.warn('Pick market:',e.message);$('#terminal').scrollIntoView();}};
