/* ---------- Live data: Gemini Exchange public API (no key, CORS-enabled) ---------- */
const GX='https://api.gemini.com';
const LIVE={events:[],total:null,pf:new Map(),spark:new Map(),lastOk:0,err:null,subs:[],timer:0,busy:false,
  on(f){this.subs.push(f);},
  emit(){this.subs.forEach(f=>{try{f(this);}catch(e){console.warn(e);}});},
  async get(path,ms=8000){const c=new AbortController(),t=setTimeout(()=>c.abort(),ms);try{const r=await fetch(GX+path,{cache:'no-store',signal:c.signal});if(!r.ok){let why='HTTP '+r.status;try{const j=await r.json();if(j&&j.reason)why=j.reason;}catch(e){}throw new Error(why);}return await r.json();}finally{clearTimeout(t);}},
  async poll(){if(this.busy||document.hidden)return;this.busy=true;
    try{const [p0,p1,pf]=await Promise.all([this.get('/v1/prediction-markets/events?status=active&limit=100'),this.get('/v1/prediction-markets/events?status=active&limit=100&offset=100').catch(()=>({data:[]})),this.get('/v1/pricefeed').catch(()=>null)]);
      if(!p0||!Array.isArray(p0.data))throw new Error('unexpected response');
      const seen=new Set();this.events=[...p0.data,...(p1.data||[])].filter(e=>!seen.has(e.ticker)&&seen.add(e.ticker));
      this.total=p0.pagination&&p0.pagination.total;if(Array.isArray(pf))pf.forEach(p=>this.pf.set(p.pair,p));
      this.lastOk=Date.now();this.err=null;}
    catch(e){this.err=e.message||'network error';console.warn('Gemini Exchange:',this.err);}
    finally{this.busy=false;this.emit();}},
  async sparks(){for(const s of CRYPTO){try{const j=await this.get('/v2/ticker/'+s.toLowerCase()+'usd');if(j&&Array.isArray(j.changes))this.spark.set(s,j.changes.map(Number).reverse().concat(+j.close));}catch(e){}}this.emit();},
  start(){this.poll();this.sparks();clearInterval(this.timer);this.timer=setInterval(()=>this.poll(),15000);setInterval(()=>this.sparks(),120000);
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)this.poll();});}
};
const CRYPTO=['BTC','ETH','SOL','XRP','DOGE','LINK','AVAX','LTC'];
const lnum=v=>v==null||v===''?null:+v;
const lmid=p=>{if(!p)return null;const b=lnum(p.bestBid),a=lnum(p.bestAsk);if(b!=null&&a!=null)return(b+a)/2;return lnum(p.lastTradePrice)??b??a;};
const lusd=v=>{v=+v||0;return v>=1e6?'$'+(v/1e6).toFixed(1)+'M':v>=1e4?'$'+Math.round(v/1e3)+'k':v>=1e3?'$'+(v/1e3).toFixed(1)+'k':'$'+Math.round(v);};
const lspot=v=>v>=1000?'$'+(+v).toLocaleString('en-US',{maximumFractionDigits:0}):v>=1?'$'+(+v).toFixed(2):'$'+(+v).toPrecision(3);
function plain(doc){if(!doc)return '';if(typeof doc==='string')return doc;let out='';(function walk(n){if(!n)return;if(n.value)out+=n.value;(n.content||[]).forEach(walk);if(n.nodeType==='paragraph')out+='\n';})(doc);return out.replace(/\[([^\]]+)\]\([^)]+\)/g,'$1').trim();}
function favourite(e){const cs=(e.contracts||[]).filter(c=>c.status==='active'&&c.prices&&lmid(c.prices)!=null);if(!cs.length)return null;const traded=cs.filter(c=>c.prices.lastTradePrice!=null);const pool=traded.length?traded:cs;return pool.reduce((a,b)=>lmid(b.prices)>lmid(a.prices)?b:a);}
function closesIn(iso){if(!iso)return '—';const ms=Date.parse(iso)-Date.now();if(ms<=0)return 'closing';const h=ms/36e5;if(h<1)return Math.max(1,Math.round(ms/6e4))+'m';if(h<48)return Math.round(h)+'h';return Math.round(h/24)+'d';}
const ltitle=t=>t.replace(/^Highest temperature in /,'High temp, ').replace(/ on (January|February|March|April|May|June|July|August|September|October|November|December) \d+, \d{4}\??$/,'').replace(/\?$/,'');

/* ---------- verity-rules-v1, browser port (mirrors analysis/verity/rules_analyst.py and scoring.liquidity_score) ---------- */
const RULES={
  SOURCE:[[3,/leaderboard|lm ?arena|lmsys|social|followers|views|likes|ranking/i,'third-party ranking that changes continuously or can be gamed'],
    [2,/\bnws\b|national weather service|climatolog|\bcli[a-z]{3}\b|preliminary|revis|\bbls\b|\bcpi\b|nonfarm|payrolls|\bgdp\b|bureau of/i,'official but revisable or preliminary data'],
    [1,/\bnba\b|\bnfl\b|\bnhl\b|\bmlb\b|\bncaa\b|\bmls\b|league|federal reserve|\bfomc\b|governing body|official (result|score)/i,'official primary source']],
  JUDGMENT:/style control|top[- ]ranked|\bbest\b|at (its|the exchange's) (sole )?discretion|determined by gemini|subjective/i,
  BANDS:/\d+\s*°?\s*[fc]?\s*(to|-|–)\s*\d+\s*°|\bbetween\s+\$?\d[\d.,]*\S*\s+and\s+\$?\d|\d[\d.,]*\s*°?\s*[fc]?\s+or\s+(more|higher|above|less|lower|below)/i,
  SCHED:/\bcpi\b|jobs report|nonfarm|payrolls|fomc|federal reserve|fed speak|injur|earnings|\bgdp\b/i};
function liquidity(vol,b,a,unquoted){
  if(vol==null&&b==null&&a==null)return [null,'No volume or quotes in the snapshot.'];
  if(b==null||a==null)return [3,'No two-sided live quote.'];
  const sp=Math.round((a-b)*100);
  if(vol!=null&&vol<100)return [3,`Volume $${vol} is under $100 (spread ${sp}c).`];
  if(sp>5)return [3,`Spread ${sp}c is over 5c.`];
  if(vol>=1000&&sp<=2&&!unquoted)return [1,`Volume $${vol} with a ${sp}c spread.`];
  return [2,`Volume $${vol}, spread ${sp}c.`];}
function analyzeLive(e,c){
  const text=[plain(e.description),plain(c.description)].filter(Boolean).join('\n');
  const srcHay=[e.sourceDetails?Object.values(e.sourceDetails).join(' '):'',text].join(' ');
  const amb=(()=>{if(!text.trim())return [null,'No rule text in the record.'];if(RULES.JUDGMENT.test(text))return [3,'Outcome depends on a setting, ranking or judgment named in the rules.'];
    const miss=['terms PDF not read (the browser does not fetch it)'];if(!e.termsLink&&!c.termsAndConditionsUrl)miss.push('event-level terms link is empty (Agent rule 3)');if(RULES.BANDS.test(c.label+'\n'+text))miss.push('numeric band edges decide the outcome');
    return [2,'Clear outcome, but '+miss.join('; ')+'.'];})();
  const src=(()=>{if(!srcHay.trim())return [null,'Settlement source not stated.'];for(const [s,re,l] of RULES.SOURCE){const m=srcHay.match(re);if(m)return [s,`Settlement source looks like ${l} (matched '${m[0]}').`];}return [null,'Settlement source is named but matches no Framework rule; a person should score it.'];})();
  const sib=e.gameId?LIVE.events.filter(x=>x.gameId===e.gameId&&x.ticker!==e.ticker):[];
  const cor=sib.length?[3,`${sib.length} sibling event(s) on the same game (Agent rule 7).`]:RULES.SCHED.test(text+' '+e.title)?[2,'Driven by scheduled data or news named in the rules.']:[1,'No sibling events and no scheduled data named; treated as stand-alone.'];
  const b=lnum(c.prices.bestBid),a=lnum(c.prices.bestAsk),vol=lnum(e.volume);
  const unq=(e.contracts||[]).some(x=>x.status==='active'&&(!x.prices||x.prices.bestBid==null||x.prices.bestAsk==null));
  const liq=liquidity(vol!=null?Math.round(vol*100)/100:null,b,a,unq);
  const scores={ambiguity:amb,source:src,liquidity:liq,correlation:cor};
  const known=Object.values(scores).filter(s=>s[0]!=null).map(s=>s[0]);const total=known.reduce((x,y)=>x+y,0);
  let rating=known.length===4?(total<=6?'Low':total<=8?'Medium':'High'):'Incomplete';
  if(known.length===4&&rating==='Low'&&(amb[0]===3||src[0]===3))rating='Medium';
  const gaps=[];if(src[0]===2)gaps.push({id:'GAP-1',gap_type:'settlement_source_version',affects:'resolution_risk',material:true,question:'Which issuance of the settlement data (preliminary, final, or a later correction) does Gemini use to settle?'});
  if(src[0]===3||(amb[0]===3&&/leaderboard|arena/i.test(srcHay)))gaps.push({id:'GAP-'+(gaps.length+1),gap_type:'leaderboard_snapshot',affects:'resolution_risk',material:true,question:'Which view and timestamp of the leaderboard settles the contract?'});
  return {e,c,text,scores,total,known:known.length,rating,gaps,sib,b,a,vol,unq};}
function liveMarket(e,c){const r=analyzeLive(e,c);const m=lmid(c.prices);
  return {key:'live',live:true,e,c,r,ticker:e.ticker,question:e.title+(c.label&&c.label!==e.title?': '+c.label+'?':''),short:ltitle(e.title),
    bid:r.b??m,ask:r.a??m,mid:m,vol:r.vol||0,volLabel:lusd(r.vol),symbol:c.instrumentSymbol,
    scores:Object.fromEntries(Object.entries(r.scores).map(([k,v])=>[k,[v[0],v[1]]])),total:r.total,rating:r.rating,file:'live · '+e.ticker+' · browser port of verity-rules-v1'};}

/* ---------- Hero: live market board ---------- */
const BOARD={topic:'overview',ids:''};
function boardTopics(){const cats={};LIVE.events.forEach(e=>{const k=e.category||'Other';cats[k]=(cats[k]||0)+1;});
  const order=['Crypto','Sports','Weather','Economics','Politics','Finance','Tech','Commodities','Culture','Other'];
  return [['overview','Overview',LIVE.events.length],...Object.keys(cats).sort((a,b)=>(order.indexOf(a)+99*(order.indexOf(a)<0))-(order.indexOf(b)+99*(order.indexOf(b)<0))).map(k=>[k,k,cats[k]])];}
function rowsFor(topic){const all=LIVE.events.map(e=>({e,c:favourite(e)})).filter(x=>x.c);
  const pool=topic==='overview'?all:all.filter(x=>(x.e.category||'Other')===topic);
  return pool.sort((a,b)=>(+b.e.volume24h||0)-(+a.e.volume24h||0)||(+b.e.volume||0)-(+a.e.volume||0));}
function rowHTML({e,c}){const m=lmid(c.prices),b=lnum(c.prices.bestBid),a=lnum(c.prices.bestAsk);const lab=c.label&&c.label!==e.title?c.label:'Yes';
  return `<li class="mrow" data-ev="${esc(e.ticker)}" data-c="${esc(c.id)}"><button class="mrow-btn" aria-label="Analyze ${esc(e.title)}, ${esc(lab)}">
   <span class="mrow-cat">${esc(e.category||'')}</span>
   <span class="mrow-t"><span class="mrow-title">${esc(ltitle(e.title))}</span><span class="mrow-out">${esc(lab)}</span></span>
   <span class="mrow-px num${b==null||a==null?' last':''}" data-px title="${b==null||a==null?'No live quote; last trade':'Mid of bid and ask'}">${(m*100).toFixed(1)}¢</span>
   <span class="mrow-ba num">${b!=null?Math.round(b*100):'—'} / ${a!=null?Math.round(a*100):'—'}</span>
   <span class="mrow-v num">${lusd(e.volume24h)}</span>
   <span class="mrow-x num">${closesIn(c.expiryDate||e.expiryDate)}</span></button></li>`;}
function listHTML(rows,title,n){return `<div class="mlist"><div class="mlist-head"><span class="label">${title}</span><span class="mlist-cols label" aria-hidden="true"><span>Price</span><span>Bid / ask</span><span>24h vol</span><span>Closes</span></span></div><ol>${rows.slice(0,n).map(rowHTML).join('')||'<li class="empty">No quoted markets in this topic right now.</li>'}</ol></div>`;}
function sparkSVG(arr,up){if(!arr||arr.length<2)return '';const lo=Math.min(...arr),hi=Math.max(...arr),sp=hi-lo||1;return `<svg class="cspark ${up?'up':'down'}" viewBox="0 0 80 22" aria-hidden="true"><polyline points="${arr.map((v,i)=>`${(i/(arr.length-1)*80).toFixed(1)},${(20-(v-lo)/sp*18).toFixed(1)}`).join(' ')}"/></svg>`;}
function cryptoHTML(){return `<div class="cgrid">${CRYPTO.map(s=>{const p=LIVE.pf.get(s+'USD');if(!p)return '';const ch=+p.percentChange24h*100,up=ch>=0;
  return `<div class="ccell"><div class="ccell-h"><b>${s}</b><span class="label">/USD</span></div><div class="num ccell-p" data-spot="${s}">${lspot(p.price)}</div><div class="num ${up?'up':'down'} ccell-c">${up?'▲':'▼'} ${Math.abs(ch).toFixed(2)}%</div>${sparkSVG(LIVE.spark.get(s),up)}</div>`;}).join('')}</div><p class="label" style="margin-top:6px">Spot from Gemini Exchange price feed · line is the last 24 hours, hourly</p>`;}
function renderBoard(force){
  const tabs=boardTopics();if(!tabs.some(t=>t[0]===BOARD.topic))BOARD.topic='overview';
  $('#topicTabs').innerHTML=tabs.map(([k,l,n])=>`<button role="tab" id="tt-${esc(k)}" aria-selected="${k===BOARD.topic}" tabindex="${k===BOARD.topic?0:-1}" aria-controls="topicPanel" data-topic="${esc(k)}">${esc(l)} <span class="num">${n}</span></button>`).join('');
  $$('#topicTabs [role=tab]').forEach((t,i,all)=>{t.addEventListener('click',()=>{BOARD.topic=t.dataset.topic;renderBoard(true);$('#tt-'+CSS.escape(BOARD.topic)).focus();});
    t.addEventListener('keydown',e=>{let j=null;if(e.key==='ArrowRight')j=(i+1)%all.length;if(e.key==='ArrowLeft')j=(i-1+all.length)%all.length;if(j!=null){e.preventDefault();all[j].click();}});});
  const p=$('#topicPanel');p.setAttribute('aria-labelledby','tt-'+BOARD.topic);
  const rows=rowsFor(BOARD.topic);const ids=BOARD.topic+rows.slice(0,8).map(r=>r.c.id).join();
  if(!force&&ids===BOARD.ids){ // update prices in place
    rows.slice(0,8).forEach(r=>{const el=p.querySelector(`[data-c="${CSS.escape(r.c.id)}"] [data-px]`);if(el){const t=(lmid(r.c.prices)*100).toFixed(1)+'¢';if(el.textContent!==t){el.textContent=t;el.classList.remove('flash');void el.offsetWidth;el.classList.add('flash');}}});return;}
  BOARD.ids=ids;
  let html='';
  if(BOARD.topic==='overview'){const soon=rows.filter(r=>Date.parse(r.c.expiryDate||r.e.expiryDate)>Date.now()&&(+r.e.volume24h||0)>0).sort((a,b)=>Date.parse(a.c.expiryDate||a.e.expiryDate)-Date.parse(b.c.expiryDate||b.e.expiryDate));
    html=listHTML(rows,'Most traded in the last 24 hours',6)+listHTML(soon,'Closing soonest, with trading today',3);}
  else if(BOARD.topic==='Crypto')html=cryptoHTML()+listHTML(rows,'Crypto prediction markets',5);
  else html=listHTML(rows,BOARD.topic+' markets, most traded first',8);
  p.innerHTML=html;
  $$('.mrow',p).forEach(li=>li.querySelector('button').addEventListener('click',()=>{const e=LIVE.events.find(x=>x.ticker===li.dataset.ev);const c=e&&e.contracts.find(x=>x.id===li.dataset.c);if(c)selectLive(e,c,true);}));
}
function renderStats(){
  const v24=LIVE.events.reduce((s,e)=>s+(+e.volume24h||0),0);const btc=LIVE.pf.get('BTCUSD'),eth=LIVE.pf.get('ETHUSD');
  const st=$('#boardStats');const cell=(l,v,n,cls='')=>`<div><dt class="label">${l}</dt><dd class="num ${cls}">${v}</dd><dd class="n">${n}</dd></div>`;
  const ch=p=>p?((+p.percentChange24h>=0?'▲ ':'▼ ')+Math.abs(+p.percentChange24h*100).toFixed(2)+'% 24h'):'';
  st.innerHTML=cell('Active markets',LIVE.total!=null?LIVE.total.toLocaleString():'—','on Gemini Exchange')+cell('24h volume',lusd(v24),'top '+LIVE.events.length+' markets')
    +cell('BTC',btc?lspot(btc.price):'—',ch(btc),btc&&+btc.percentChange24h<0?'down':'up')+cell('ETH',eth?lspot(eth.price):'—',ch(eth),eth&&+eth.percentChange24h<0?'down':'up');
  const s=$('#boardStatus');const age=Date.now()-LIVE.lastOk;
  if(LIVE.lastOk&&age<45000){s.className='tick-status live';s.innerHTML=`<span class="dot" aria-hidden="true"></span>Live · updated ${new Date(LIVE.lastOk).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'})} · refreshes every 15 s`;}
  else if(LIVE.lastOk){s.className='tick-status stale';s.textContent='Connection lost · showing data from '+new Date(LIVE.lastOk).toLocaleTimeString()+' · retrying';}
  else if(LIVE.err){s.className='tick-status stale';s.textContent='Gemini Exchange is unreachable right now ('+LIVE.err+'). Retrying every 15 s.';}
}
const ANCHOR={user:false};['wheel','touchmove','keydown'].forEach(ev=>addEventListener(ev,e=>{if(ev==='keydown'&&!/^(Arrow|Page|Home|End| )/.test(e.key))return;ANCHOR.user=true;anchorTarget=null;},{passive:true}));
let anchorTarget=null;$$('a[href^="#"]').forEach(a=>a.addEventListener('click',()=>{anchorTarget=a.getAttribute('href');ANCHOR.user=false;setTimeout(()=>{anchorTarget=null;},4000);}));
function keepAnchor(){const id=anchorTarget||(!ANCHOR.user&&location.hash);if(!id||id==='#top'||id.length<2)return;const el=document.querySelector(id);if(!el)return;const y=el.getBoundingClientRect().top+scrollY-(parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop)||0);if(Math.abs(scrollY-y)>8)scrollTo({top:y,behavior:'instant'});}
[300,1200,2500,5000].forEach(t=>setTimeout(keepAnchor,t));if(document.fonts)document.fonts.ready.then(keepAnchor);
LIVE.on(()=>{const first=!BOARD.rendered;if(LIVE.events.length){renderBoard(false);BOARD.rendered=true;if(first)keepAnchor();}else if(LIVE.err&&!LIVE.lastOk){$('#topicPanel').innerHTML='<p class="empty">Live markets could not be loaded. The page will keep retrying; the analysed Nov 18 markets below still work.</p>';}renderStats();});
setInterval(()=>{if(LIVE.lastOk)renderStats();},5000);
