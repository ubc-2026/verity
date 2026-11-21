/* ---------- Crypto news (publisher RSS via Verity's Worker; Hacker News fallback) ---------- */
const NEWS={items:[],src:'',filter:'all',fetched:0,timer:0};
const NEWS_TOPICS=[['all','All',null],['btc','Bitcoin',/bitcoin|\bbtc\b|satoshi|miner/i],['eth','Ethereum',/ether|\beth\b|vitalik|layer[- ]?2|rollup/i],['reg','Regulation',/sec\b|regulat|cftc|law|bill|congress|court|lawsuit|ban|tax|policy|senat/i],['mkt','Markets',/etf|price|rally|drop|fall|surge|market|trader|inflow|outflow|liquidat|stock|fed\b|rate/i],['pm','Prediction markets',/prediction market|polymarket|kalshi|gemini|bet|odds|forecast/i]];
function agoStr(iso){if(!iso)return '';const m=Math.round((Date.now()-Date.parse(iso))/6e4);if(m<1)return 'just now';if(m<60)return m+'m ago';const h=Math.round(m/60);if(h<48)return h+'h ago';return Math.round(h/24)+'d ago';}
async function newsFromWorker(){const r=await fetch(GAI.endpoint.replace(/\/review$/,'/news'),{cache:'no-store'});if(!r.ok)throw new Error('HTTP '+r.status);const j=await r.json();if(!Array.isArray(j.items)||!j.items.length)throw new Error('no items');
  return {items:j.items,src:'Publisher feeds: '+(j.sources||[]).filter(s=>s.items).map(s=>s.name).join(', ')};}
async function newsFromHN(){const qs=['bitcoin','ethereum','cryptocurrency','stablecoin','crypto','coinbase','solana','blockchain'];const since=Math.floor(Date.now()/1000)-10*86400;
  const ON=/\b(bitcoin|btc|ethereum|ether|eth|cryptocurrenc(y|ies)|crypto|stablecoins?|usdc|usdt|tether|defi|blockchain|solana|xrp|ripple|coinbase|binance|kraken|gemini|crypto ?etfs?|memecoins?|tokens?|web3|on-?chain|wallet|polymarket|kalshi|prediction markets?)\b/i,OFF=/cryptograph|encrypt|cryptic/i;
  const lists=await Promise.all(qs.map(q=>fetch(`https://hn.algolia.com/api/v1/search_by_date?query=${q}&tags=story&restrictSearchableAttributes=title&numericFilters=created_at_i>${since},points>1&hitsPerPage=30`).then(r=>r.ok?r.json():{hits:[]}).catch(()=>({hits:[]}))));
  const seen=new Set();const items=lists.flatMap(l=>l.hits||[]).filter(h=>h.url&&h.title&&ON.test(h.title)&&!OFF.test(h.title)&&!/^(show|ask|tell) hn/i.test(h.title)&&!seen.has(h.objectID)&&seen.add(h.objectID))
    .map(h=>{let host='';try{host=new URL(h.url).hostname.replace(/^www\./,'');}catch(e){}return {title:h.title,link:h.url,source:host||'Hacker News',published:h.created_at,summary:`${h.points} points · ${h.num_comments||0} comments on Hacker News`,image:null};})
    .sort((a,b)=>Date.parse(b.published)-Date.parse(a.published)).slice(0,40);
  if(!items.length)throw new Error('no items');return {items,src:'Hacker News crypto stories (publisher feeds unavailable)'};}
function logoFor(i){let host='';try{host=new URL(i.link).hostname;}catch(e){}return host?`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=128`:null;}
function pic(i,cls){const src=i.image?safeHref(i.image):logoFor(i);if(!src)return `<span class="news-noimg ${cls}" aria-hidden="true"></span>`;return `<span class="news-pic ${cls}${i.image?'':' logo'}"><img src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentNode.classList.add('broken');this.remove()"></span>`;}
function safeHref(u){try{const x=new URL(u);return /^https?:$/.test(x.protocol)?x.href:'#';}catch(e){return '#';}}
function renderNews(){const list=$('#newsList'),lead=$('#leadStory');const re=(NEWS_TOPICS.find(t=>t[0]===NEWS.filter)||[])[2];
  const items=re?NEWS.items.filter(i=>re.test(i.title+' '+(i.summary||''))):NEWS.items;
  $$('#newsFilters button').forEach(b=>b.setAttribute('aria-pressed',b.dataset.f===NEWS.filter));
  if(!NEWS.items.length){list.innerHTML='<li class="empty">Loading headlines…</li>';return;}
  const top=items[0];
  lead.innerHTML=top?`<a class="lead-link" href="${esc(safeHref(top.link))}" target="_blank" rel="noopener noreferrer">${pic(top,'lead-pic')}<span class="label">${esc(top.source)} · ${agoStr(top.published)}</span><span class="lead-title">${esc(top.title)}</span>${top.summary?`<span class="lead-sum">${esc(top.summary)}</span>`:''}</a>`:'<p class="muted">No headlines in this topic right now.</p>';
  list.innerHTML=items.slice(1,9).map(i=>`<li><a class="news-item" href="${esc(safeHref(i.link))}" target="_blank" rel="noopener noreferrer">${pic(i,'item-pic')}<span class="news-text"><span class="news-title">${esc(i.title)}</span><span class="label">${esc(i.source)} · ${agoStr(i.published)}</span></span></a></li>`).join('')||(top?'':'<li class="empty">No headlines in this topic right now.</li>');
  const s=$('#newsStatus');s.className='tick-status live';s.innerHTML=`<span class="dot" aria-hidden="true"></span>Live · ${esc(NEWS.src)}`;}
async function loadNews(){if(document.hidden)return;
  try{let r;try{r=await newsFromWorker();}catch(e){r=await newsFromHN();}NEWS.items=r.items;NEWS.src=r.src;NEWS.fetched=Date.now();renderNews();}
  catch(e){if(!NEWS.items.length){$('#newsList').innerHTML='<li class="empty">Headlines are unavailable right now. Retrying in a few minutes.</li>';$('#leadStory').innerHTML='';const s=$('#newsStatus');s.className='tick-status stale';s.textContent='News unavailable · retrying';}}}
(function newsInit(){$('#newsFilters').innerHTML=NEWS_TOPICS.map(([k,l])=>`<button type="button" data-f="${k}" aria-pressed="${k==='all'}">${l}</button>`).join('');
  $$('#newsFilters button').forEach(b=>b.addEventListener('click',()=>{NEWS.filter=b.dataset.f;renderNews();}));
  (window.VERITY_GATE||Promise.resolve()).then(()=>{loadNews();NEWS.timer=setInterval(loadNews,10*60000);});document.addEventListener('visibilitychange',()=>{if(!document.hidden&&Date.now()-NEWS.fetched>10*60000)loadNews();});})();

/* ---------- More research via Exa (through Verity's Worker) ---------- */
const RES={q:'',busy:false};
const RES_URL=q=>GAI.endpoint.replace(/\/review$/,'/research')+'?q='+encodeURIComponent(q)+'&days=7';
function resErr(e){if(e.status===-1||e.status===403)return e.message||'Verification failed. Reload the page and try again.';
  if(e.status===503)return e.message||'Exa research needs an Exa API key on the Worker. Run the v6 redeploy script and add the key when it asks.';
  if(e.status===429)return 'Too many searches from this connection. Wait a minute.';if(e.status===400)return e.message||'Try a different search.';
  if(e.status===0||e.status===404)return 'Exa research turns on after the Worker v6 update.';return 'Exa research is unavailable right now.';}
async function fetchResearch(q,days=7){const tok=await aiToken();let r;try{r=await fetch(GAI.endpoint.replace(/\/review$/,'/research')+'?q='+encodeURIComponent(q)+'&days='+days,{cache:'no-store',headers:{'cf-turnstile-response':tok}});}catch(e){throw Object.assign(new Error('network'),{status:0});}
  const j=await r.json().catch(()=>({}));if(!r.ok)throw Object.assign(new Error(j.error||''),{status:r.status});return j.items||[];}
function resItems(items){return items.map(i=>`<li><a class="news-item" href="${esc(safeHref(i.link))}" target="_blank" rel="noopener noreferrer">${pic(i,'item-pic')}<span class="news-text"><span class="news-title">${esc(i.title)}</span>${i.summary?`<span class="res-sum">${esc(i.summary)}</span>`:''}<span class="label">${esc(i.source)}${i.published?' · '+agoStr(i.published):''}</span></span></a></li>`).join('');}
async function runResearch(q,auto){q=(q||'').trim()||'crypto market trends bitcoin ethereum stablecoins regulation';if(RES.busy||(auto&&RES.autoDone))return;RES.busy=true;RES.q=q;if(auto)RES.autoDone=true;
  const list=$('#resList'),st=$('#resStatus'),btn=$('#resGo');btn.setAttribute('aria-busy','true');st.className='tick-status';st.textContent='Searching Exa…';
  try{const items=await fetchResearch(q);list.innerHTML=resItems(items)||'<li class="empty">No recent articles for that search.</li>';st.className='tick-status live';st.innerHTML=`<span class="dot" aria-hidden="true"></span>Exa · ${items.length} articles from the last 7 days`;}
  catch(e){if(auto){RES.q='';list.innerHTML='<li class="empty">Search recent coverage above, or pick a topic.</li>';st.className='tick-status';st.textContent='Exa research';} // the automatic load stays quiet; errors show only after someone searches
    else{list.innerHTML='';st.className='tick-status stale';st.textContent=resErr(e);}}
  finally{RES.busy=false;btn.removeAttribute('aria-busy');}}
(function resInit(){$('#resForm').addEventListener('submit',e=>{e.preventDefault();runResearch($('#resQ').value);});
  $$('#resChips button').forEach(b=>b.addEventListener('click',()=>{$('#resQ').value=b.dataset.q;runResearch(b.dataset.q);}));
  // No automatic search: it would trigger the human check before anyone asked for anything.
  $('#resList').innerHTML='<li class="empty">Search recent coverage above, or pick a topic.</li>';const st=$('#resStatus');st.className='tick-status';st.textContent='Exa search';})(); // don't rely only on the visibility observer

/* Research for the market selected in the terminal (AI panel) */
async function runMarketResearch(){const m=MARKETS[term.market];const out=$('#gaiOut');const btn=$('#mresRun');
  const q=(m.live?m.e.title+' '+(m.c.label&&m.c.label!==m.e.title?m.c.label:''):m.key==='nyc'?'New York Central Park high temperature NWS climate report':'Atlanta Hawks Oklahoma City Thunder').slice(0,200);
  btn.setAttribute('aria-busy','true');out.innerHTML='<p class="muted">Searching Exa for recent coverage…</p>';gaiStatus('Searching Exa…');
  try{const items=await fetchResearch(q,30);out.innerHTML=`<div class="gai-meta"><span class="tag info">Exa research · last 30 days</span><span class="label">${items.length} articles · ${esc(q)}</span></div><ol class="news-list">${resItems(items)||'<li class="empty">No recent coverage found.</li>'}</ol><p class="fc-note">Forecasts use this research automatically once Exa is set up on the Worker.</p>`;gaiStatus('Research loaded.','ok');}
  catch(e){const msg=resErr(e);out.innerHTML=`<div class="box warn"><span class="tag warn">! Research unavailable</span><p style="font-size:.86rem;margin-top:8px">${esc(msg)}</p></div>`;gaiStatus(msg,'warn');}
  finally{btn.removeAttribute('aria-busy');}}
$('#mresRun').addEventListener('click',runMarketResearch);
