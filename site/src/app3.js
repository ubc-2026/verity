/* ---------- Reconciler ledger (demo fixtures) ---------- */
const STATUS={ok:['ok','✓ Matched & verified'],pnd:['no','✕ Paid, not delivered'],dnp:['warn','! Delivered, not paid'],dup:['info','≡ Duplicate, deduplicated'],nonce:['info','≡ Replay blocked, nonce used'],mis:['no','✕ Mismatched request']};
const FORECAST_REQ={...REQ,resource:'/v1/catalog/cat-point-forecast-v1',amount:'20000',request_id:'req-nyc-0002',expires_at:'2026-11-18T01:12:00Z'};
const LB_REQ={...REQ,resource:'/v1/catalog/cat-lm-arena-snapshot-v1',params:{board:'text',timestamp:'2026-11-18T00:00:00Z'},request_id:'req-ai-0003',expires_at:'2026-11-18T01:20:00Z'};
const EVENTS=[ // fixture event stream, in arrival order
  {ev:'e1',id:'P-0001',rail:'Arc direct',req:REQ,tx:'demo-tx-0001',delivery:DELIVERY,ts:'2026-11-18T01:02:10Z',kind:'ok'},
  {ev:'e2',id:'P-0002',rail:'Arc direct',req:FORECAST_REQ,tx:'demo-tx-0002',delivery:null,ts:'2026-11-18T01:03:40Z',kind:'pnd',sla:'No delivery 10 min after settlement. SLA alert raised.'},
  {ev:'e3',id:'P-0001',rail:'Arc direct',req:REQ,tx:'demo-tx-0001',delivery:DELIVERY,ts:'2026-11-18T01:04:05Z',kind:'dup',note:'Same transaction and nonce as event e1. Counted once; no second charge.'},
  {ev:'e4',id:'P-0003',rail:'Circle Gateway',req:LB_REQ,tx:'demo-batch-07',delivery:{item:'cat-lm-arena-snapshot-v1',fixture:true},ts:'2026-11-18T01:06:30Z',kind:'dnp',note:'Delivery is recorded. Batch demo-batch-07 is confirmed on Arc, but no Gateway transfer record names this purchase, so payment is not established.'},
  {ev:'e5',id:'P-0004',rail:'Arc direct',req:REQ,tx:'—',delivery:null,ts:'2026-11-18T01:07:15Z',kind:'nonce',note:'A second authorization with the P-0001 nonce was rejected before submission. Nothing settled.'},
  {ev:'e6',id:'P-0005',rail:'Arc direct',req:{...REQ,params:{station:'KLGA',date:'2026-11-18'},request_id:'req-nyc-0005'},signedReq:REQ,tx:'demo-tx-0005',delivery:{...DELIVERY,station:'KLGA'},ts:'2026-11-18T01:09:00Z',kind:'mis',note:'The settled authorization commits to the KNYC request; the merchant delivered for KLGA. Hashes differ.'}];
const R={rows:[],filter:'all',sort:{k:'ts',dir:1},replay:0,sel:null};
async function rowFrom(e){const reqHash=kec(canon(e.req));const signed=e.signedReq?kec(canon(e.signedReq)):reqHash;const content=e.delivery?await sha256(canon(e.delivery)):null;
  return {...e,amount:(+e.req.amount/1e6),reqHash,signedHash:signed,content,merchant:e.req.merchant,status:e.kind};}
function statusGroup(k){return k==='ok'?'ok':(k==='dup'||k==='nonce')?'other':'flag';}
function renderLedger(){
  const rows=R.rows.filter(r=>R.filter==='all'||(R.filter==='ok'?r.status==='ok':statusGroup(r.status)==='flag'));
  const {k,dir}=R.sort;rows.sort((a,b)=>{const x=k==='amount'?a.amount-b.amount:String(a[k]).localeCompare(String(b[k]));return x*dir;});
  const tb=$('#recBody');
  if(!R.rows.length)tb.innerHTML=`<tr><td colspan="9" class="empty">No records yet. Replay the fixture stream to ingest demo events.</td></tr>`;
  else if(!rows.length)tb.innerHTML=`<tr><td colspan="9" class="empty">No records match this filter.</td></tr>`;
  else tb.innerHTML=rows.map(r=>`<tr tabindex="0" data-ev="${r.ev}" class="${r.fresh?'new':''}" aria-selected="${R.sel===r.ev}"><td class="mono">${r.id}${r.status==='dup'?' <span class="label">event 2</span>':''}</td><td>${r.rail}</td><td class="mono" style="font-size:.74rem">${r.merchant}</td><td class="num">${r.status==='nonce'?'0.00':r.amount.toFixed(2)} USDC</td>
    <td><span class="trunc"><code title="${r.reqHash}">${short(r.reqHash)}</code><button class="icon-btn" data-c="${r.reqHash}" aria-label="Copy request hash">⧉</button></span></td>
    <td><span class="trunc"><code>${r.tx}</code></span></td>
    <td>${r.content?`<span class="trunc"><code title="${r.content}">${short(r.content)}</code><button class="icon-btn" data-c="${r.content}" aria-label="Copy content hash">⧉</button></span>`:'<span class="muted">none</span>'}</td>
    <td><span class="tag ${STATUS[r.status][0]}">${STATUS[r.status][1]}</span></td><td class="mono" style="font-size:.74rem" title="Fixture timestamp">${r.ts.replace('T',' ').replace('Z','')}</td></tr>`).join('');
  R.rows.forEach(r=>r.fresh=false);
  $$('#recBody tr[data-ev]').forEach(tr=>{const open=()=>{R.sel=tr.dataset.ev;$$('#recBody tr').forEach(x=>x.setAttribute('aria-selected',x===tr));openDrawer(recordView(R.rows.find(r=>r.ev===tr.dataset.ev)),tr);};tr.addEventListener('click',e=>{if(e.target.closest('[data-c]'))return;open();});tr.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open();}});});
  $$('#recBody [data-c]').forEach(b=>b.addEventListener('click',e=>{e.stopPropagation();copy(b.dataset.c,'Hash copied');}));
  const uniq=new Set(R.rows.filter(r=>r.status!=='dup'&&r.status!=='nonce'&&r.rail==='Arc direct').map(r=>r.tx));
  const settled=R.rows.filter(r=>['ok','pnd','mis'].includes(r.status)).reduce((s,r)=>s+r.amount,0);
  $('#recCounts').innerHTML=`<span>Records <b>${R.rows.length}</b></span><span>Verified <b>${R.rows.filter(r=>r.status==='ok').length}</b></span><span>Exceptions <b>${R.rows.filter(r=>statusGroup(r.status)==='flag').length}</b></span><span>Duplicates and replays blocked <b>${R.rows.filter(r=>r.status==='dup'||r.status==='nonce').length}</b></span><span>Unique settled <b>${settled.toFixed(2)} USDC</b> across ${uniq.size} tx</span><span class="demo">DEMO FIXTURE</span>`;
}
async function loadAll(){R.rows=[];for(const e of EVENTS)R.rows.push(await rowFrom(e));renderLedger();}
async function replay(){const b=$('#recReplay');clearInterval(R.replay);R.rows=[];renderLedger();b.setAttribute('aria-busy','true');b.disabled=true;let i=0;
  const next=async()=>{if(i>=EVENTS.length){clearInterval(R.replay);b.removeAttribute('aria-busy');b.disabled=false;toast('Fixture stream replayed: 6 events, 1 duplicate suppressed');return;}const r=await rowFrom(EVENTS[i++]);r.fresh=true;R.rows.push(r);renderLedger();};
  await next();R.replay=setInterval(next,RM.matches?200:800);}
$('#recReplay').addEventListener('click',replay);
$('#recClear').addEventListener('click',()=>{clearInterval(R.replay);$('#recReplay').disabled=false;$('#recReplay').removeAttribute('aria-busy');R.rows=[];renderLedger();});
$$('#recFilter button').forEach(b=>b.addEventListener('click',()=>{R.filter=b.dataset.f;$$('#recFilter button').forEach(x=>x.setAttribute('aria-pressed',x===b));renderLedger();}));
$$('[data-sort]').forEach(b=>b.addEventListener('click',()=>{const k=b.dataset.sort;R.sort={k,dir:R.sort.k===k?-R.sort.dir:1};$$('[data-sort]').forEach(x=>{x.closest('th').removeAttribute('aria-sort');x.textContent=x.textContent.replace(/ [▲▼]$/,'');});b.closest('th').setAttribute('aria-sort',R.sort.dir>0?'ascending':'descending');b.textContent+=R.sort.dir>0?' ▲':' ▼';renderLedger();}));

/* ---------- Drawer ---------- */
function recordView(r){const decision={ok:'Matched: settlement, request commitment and content hash agree.',pnd:'Exception: payment settled with no qualifying delivery. '+(r.sla||''),dnp:'Exception: '+(r.note||''),dup:'Deduplicated: '+(r.note||''),nonce:'Blocked: '+(r.note||''),mis:'Exception: '+(r.note||'')}[r.status];
  return {title:r.id+' · '+STATUS[r.status][1].slice(2),sections:[
    ['Canonical request',`<pre class="code" style="max-height:200px;white-space:pre-wrap;word-break:break-all;border:1px solid var(--border-hairline);border-radius:4px">${esc(canon(r.req))}</pre><div class="hashline">${r.reqHash}</div>`],
    ['Authorization metadata',`<dl class="kv"><dt>scheme</dt><dd class="mono">EIP-3009 TransferWithAuthorization</dd><dt>nonce</dt><dd class="mono" style="font-size:.72rem">${r.signedHash}</dd><dt>signature</dt><dd><span class="demo">SIMULATED</span> not a real signature</dd></dl>${r.signedHash!==r.reqHash?`<div class="hashline bad">Signed over ${short(r.signedHash)} but delivered request hashes to ${short(r.reqHash)}</div>`:''}`],
    ['Payment evidence',`<dl class="kv"><dt>rail</dt><dd>${r.rail}</dd><dt>reference</dt><dd class="mono">${r.tx}</dd><dt>amount</dt><dd class="num">${r.status==='nonce'?'0.00 (not submitted)':r.amount.toFixed(2)+' USDC'}</dd></dl>${r.rail==='Circle Gateway'?'<p class="muted" style="font-size:.82rem">Gateway attribution: the batch transaction proves the batch settled. Only Gateway’s individual transfer record can attribute this purchase, and none was found.</p>':''}`],
    ['Merchant receipt and content hash',r.content?`<p class="muted" style="font-size:.82rem">Response body (demo fixture), SHA-256 computed in your browser:</p><div class="hashline ${r.status==='mis'?'bad':'good'}">${r.content}</div>`:'<p class="muted">No delivery recorded.</p>'],
    ['Reconciliation decision',`<div class="box ${STATUS[r.status][0]}"><span class="tag ${STATUS[r.status][0]}">${STATUS[r.status][1]}</span><p style="font-size:.86rem;margin-top:8px">${decision}</p></div>`],
    ['Evidence source and time',`<dl class="kv"><dt>source</dt><dd>Demo fixture stream (not QuickNode)</dd><dt>event</dt><dd class="mono">${r.ev}</dd><dt>timestamp</dt><dd class="mono">${r.ts} (fixture)</dd></dl>`]]};}
async function runRecordRow(){return rowFrom({ev:'run',id:'Current run',rail:'Arc direct',req:W.tampered?{...REQ,params:{station:'KLGA',date:'2026-11-18'}}:REQ,signedReq:REQ,tx:W.tampered?'—':'demo-tx-0001',delivery:W.tampered?null:DELIVERY,ts:'2026-11-18T01:02:10Z',kind:W.tampered?'mis':'ok',note:'The tampered request was rejected before payment; nothing settled.'});}
function runRecord(){return {title:'Current run evidence',async:true};}
let lastFocus=null;
async function openDrawer(view,from){lastFocus=from||document.activeElement;if(view.async){const r=await runRecordRow();if(W.tampered){r.tx='—';}view=recordView(r);view.title='Current walkthrough run · '+(W.tampered?'request rejected':'matched');}
  $('#drawerTitle').textContent=view.title;$('#drawerBody').innerHTML=view.sections.map(([h,b])=>`<h3>${h}</h3>${b}`).join('');
  const d=$('#drawer');d.classList.add('open');d.setAttribute('aria-hidden','false');$('#drawerBg').classList.add('open');document.body.style.overflow='hidden';$('#drawerClose').focus();}
function closeDrawer(){const d=$('#drawer');d.classList.remove('open');d.setAttribute('aria-hidden','true');$('#drawerBg').classList.remove('open');document.body.style.overflow='';if(lastFocus&&lastFocus.focus)lastFocus.focus();}
$('#drawerClose').addEventListener('click',closeDrawer);$('#drawerBg').addEventListener('click',closeDrawer);
document.addEventListener('keydown',e=>{const d=$('#drawer');if(!d.classList.contains('open'))return;if(e.key==='Escape'){closeDrawer();return;}
  if(e.key==='Tab'){const f=$$('button,[href],[tabindex]:not([tabindex="-1"]),summary',d).filter(x=>!x.disabled&&x.offsetParent!==null);if(!f.length)return;const a=f[0],z=f[f.length-1];if(e.shiftKey&&document.activeElement===a){e.preventDefault();z.focus();}else if(!e.shiftKey&&document.activeElement===z){e.preventDefault();a.focus();}}});

/* ---------- Init ---------- */
(async function init(){
  try{await computeHashes();}catch(e){console.warn(e);}
  renderTerm();renderAll();renderTabs();await loadAll();
  if(document.fonts&&document.fonts.ready)document.fonts.ready.then(()=>{drawProb();drawCandles();});
})();
