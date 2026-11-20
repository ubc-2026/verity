/* Audit ledger: reads a running Verity payment portal (portal/) with its read token.
   Nothing is fetched until the visitor loads it; the token stays in this tab (sessionStorage). */
(()=>{
  const EXPLORER='https://explorer.testnet.arc.io/tx/';
  const TX=/^0x[0-9a-f]{64}$/i;
  const store={get:(k,d)=>{try{return sessionStorage.getItem(k)??d}catch{return d}},set:(k,v)=>{try{sessionStorage.setItem(k,v)}catch{}}};
  const form=document.getElementById('ldgForm');if(!form)return;
  const urlIn=document.getElementById('ldgUrl'),tokIn=document.getElementById('ldgToken'),msg=document.getElementById('ldgMsg'),out=document.getElementById('ldgOut'),more=document.getElementById('ldgMore');
  urlIn.value=store.get('verity-portal-url','http://127.0.0.1:8788');tokIn.value=store.get('verity-portal-token','');
  let limit=100;
  const short=v=>v?esc(String(v).slice(0,8))+'…'+esc(String(v).slice(-4)):'—';
  const usdc=u=>{if(u==null)return'—';const n=Number(u)/1e6;return Number.isFinite(n)?esc(n.toLocaleString(undefined,{maximumFractionDigits:6})):esc(u)};
  const txLink=h=>typeof h==='string'&&TX.test(h)?`<a class="mono" href="${EXPLORER}${h}" target="_blank" rel="noopener">${short(h)}</a>`:'—';
  // Status tags carry a glyph and a word, never colour alone.
  const tone=s=>s==='Reconciled'?['ok','✓']:s==='Mismatch'||s==='Duplicate payment'?['no','✕']:s==='Paid, delivery missing'||s==='Delivered, payment unconfirmed'?['warn','!']:['neutral','–'];
  const say=t=>{msg.textContent=t};
  async function load(){
    let base;
    try{base=new URL(urlIn.value.trim());if(base.protocol!=='http:'&&base.protocol!=='https:')throw 0}catch{return say('Enter the portal address, for example http://127.0.0.1:8788.')}
    const token=tokIn.value.trim();if(!token)return say('Enter the portal read token.');
    store.set('verity-portal-url',base.origin);store.set('verity-portal-token',token);
    const headers={authorization:'Bearer '+token};say('Loading the ledger…');
    try{
      const [a,p]=await Promise.all([fetch(base.origin+'/activity?limit='+limit,{headers}),fetch(base.origin+'/purchases',{headers})]);
      if(a.status===401||p.status===401)return say('The portal refused that read token.');
      if(!a.ok||!p.ok)return say('The portal answered with an error ('+a.status+'/'+p.status+').');
      const act=await a.json(),pur=await p.json();render(act,Array.isArray(pur.purchases)?pur.purchases:[]);
    }catch{say("The portal did not answer. Start it (cd portal && npm start) with PORTAL_ALLOWED_ORIGINS set to this page's origin, then try again.")}
  }
  function render(act,purchases){
    const logs=Array.isArray(act.logs)?act.logs:[];
    out.hidden=false;
    document.getElementById('ldgLogs').innerHTML=logs.length?logs.map(r=>`<tr><td class="num">${esc(r.blockNumber)}</td><td>${txLink(r.txHash)}</td><td>${r.kind==='authorization'?'Authorization':'Transfer'}</td><td class="mono">${short(r.from)}</td><td class="mono">${short(r.to)}</td><td class="num">${usdc(r.amountBaseUnits)}</td><td class="mono">${short(r.nonce)}</td></tr>`).join(''):'<tr><td colspan="7" class="muted">No USDC logs yet.</td></tr>';
    document.getElementById('ldgPurch').innerHTML=purchases.length?purchases.map(r=>{const[t,g]=tone(r.ledgerStatus);return`<tr><td style="white-space:normal">${esc(r.purchaseId)}<br><span class="label">${esc(r.merchantLabel??'')}</span></td><td>${r.rail==='circle-gateway-batched'?'Gateway nanopayment':'Direct USDC'}</td><td style="white-space:normal"><span class="tag ${t}">${g} ${esc(r.ledgerStatus)}</span><br><span class="label">${esc(r.detail??'')}</span></td><td class="num">${usdc(r.amountBaseUnits)}</td><td>${r.quicknode==='not_claimed'||!r.txHash?'<span class="label">Not claimed</span>':txLink(r.txHash)}</td></tr>`}).join(''):'<tr><td colspan="5" class="muted">No purchases registered.</td></tr>';
    more.hidden=!(logs.length<(act.observations||0)&&limit<500);
    say(`LIVE from your portal: ${logs.length} of ${act.observations??0} USDC logs. Chain head ${act.head??'—'}.`);
  }
  form.addEventListener('submit',e=>{e.preventDefault();limit=100;load()});
  more.addEventListener('click',()=>{limit=Math.min(500,limit+100);load()});
})();
