/* Verity terminal. Vanilla JS, no framework. Demo controls never touch a wallet, signer or payment endpoint. */
const $=(s,r=document)=>r.querySelector(s), $$=(s,r=document)=>[...r.querySelectorAll(s)];
const RM=window.matchMedia('(prefers-reduced-motion: reduce)');
const enc=s=>new TextEncoder().encode(s);
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const short=h=>h&&h.length>18?h.slice(0,10)+'…'+h.slice(-6):h;
async function sha256(s){
  if(!(window.crypto&&crypto.subtle))return null;
  const b=await crypto.subtle.digest('SHA-256',enc(s));
  return 'sha256:'+[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');
}
const kec=s=>keccak256(enc(s));
function canon(o){ // sorted-key JSON, no whitespace (demo canonicalization)
  if(Array.isArray(o))return '['+o.map(canon).join(',')+']';
  if(o&&typeof o==='object')return '{'+Object.keys(o).sort().map(k=>JSON.stringify(k)+':'+canon(o[k])).join(',')+'}';
  return JSON.stringify(o);
}
let toastT;
function toast(msg){const t=$('#toast');t.textContent=msg;t.classList.add('on');clearTimeout(toastT);toastT=setTimeout(()=>t.classList.remove('on'),2200);}
async function copy(text,what='Copied'){
  try{
    if(navigator.clipboard&&window.isSecureContext){await navigator.clipboard.writeText(text);}
    else{const ta=document.createElement('textarea');ta.value=text;ta.setAttribute('readonly','');ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();const ok=document.execCommand('copy');ta.remove();if(!ok)throw 0;}
    toast(what+' to clipboard');
  }catch(e){toast('Clipboard is blocked here. Select the text and copy it manually.');}
}
function hl(json){ // JSON syntax highlight
  return esc(json).replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;)(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?)/g,(m,str,colon,b,n)=>{
    if(str)return colon?'<span class="k">'+str+'</span>'+colon:'<span class="s">'+str+'</span>';
    if(b)return '<span class="b">'+b+'</span>';
    return '<span class="n">'+n+'</span>';
  });
}
function rng(seed){let a=0;for(const c of seed)a=(a*31+c.charCodeAt(0))>>>0;return()=>{a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}
function onVisible(el,cb){if(!('IntersectionObserver'in window)){cb(true);return;}new IntersectionObserver(es=>es.forEach(e=>cb(e.isIntersecting)),{rootMargin:'100px'}).observe(el);}
function fitCanvas(c){const r=c.getBoundingClientRect(),d=Math.min(window.devicePixelRatio||1,2);const w=Math.max(1,Math.round(r.width*d)),h=Math.max(1,Math.round(r.height*d));if(c.width!==w||c.height!==h){c.width=w;c.height=h;}const x=c.getContext('2d');x.setTransform(d,0,0,d,0,0);return{x,w:r.width,h:r.height};}
const CSSV=n=>getComputedStyle(document.documentElement).getPropertyValue(n).trim();

/* ---------- Real data ---------- */
const MARKETS={
  nyc:{key:'nyc',ticker:'WXHIGH-NYC-2611190459',question:'Highest temperature in NYC (Central Park) on Nov 18, 2026: 62°F to 63°F?',short:'NYC high 62–63°F',
    bid:.54,ask:.58,mid:.56,vol:7,volLabel:'$7',source:'Gemini Exchange, fixture captured 2026-11-17',
    scores:{ambiguity:[2,'Outcome is numeric, but the event-level terms link is empty and 2°F bands make edge readings decisive.'],source:[2,'Official NWS source, but the daily climate report can be issued preliminarily and corrected later.'],liquidity:[3,'Volume $7 is under $100 (spread 4¢).'],correlation:[1,'Stand-alone bucket; the other bands are the same event’s mutually exclusive outcomes.']},
    total:8,rating:'Medium',file:'samples/nyc_high_gap_remains.json'},
  okc:{key:'okc',ticker:'NBA-2611190100-ATL-OKC-M',question:'Atlanta vs Oklahoma City, NBA moneyline (Nov 18, 2026): will Oklahoma City win?',short:'ATL vs OKC, OKC',
    bid:.69,ask:.70,mid:.695,vol:1392.14,volLabel:'$1,392',source:'Gemini Exchange events API, live read 2026-11-18',
    scores:{ambiguity:[1,'Clear win/lose outcome; terms PDF read on the live run.'],source:[1,'Official primary source (league), with named fallbacks.'],liquidity:[1,'Volume $1,392.14 with a 1¢ spread.'],correlation:[3,'5 sibling events on the same underlying (Agent rule 7).']},
    total:6,rating:'Low',file:'live run, NBA-2611190100-ATL-OKC-M, 2026-11-18'}
};
const TICKER=[
  {sym:'OKC win · ATL vs OKC',bid:.69,ask:.70,extra:'vol $1,392'},
  {sym:'ATL win · ATL vs OKC',bid:.30,ask:.31,extra:'last 29¢'},
  {sym:'NYC high 62–63°F',bid:.54,ask:.58,extra:'vol $7'},
  {sym:'MSU −1.5 · MSU vs TENN',bid:.51,ask:.54,extra:'vol $858'},
  {sym:'Fed Dec · hike 25bps',prob:'82.4%',extra:'reported, 7 pt spread'},
  {sym:'x402 purchase · NWS version check',text:'0.05 USDC'},
  {sym:'Resolution risk · NYC',text:'8/12 Medium',cls:'warn'},
  {sym:'Resolution risk · OKC',text:'6/12 Low',cls:'ok'},
  {sym:'Mission budget',text:'25 USDC'},
  {sym:"Settlement",text:"Arc Testnet · demo"}
];

/* Ticker: see ticker.js (live Gemini Exchange feed; TICKER above is the labelled fallback) */
/* ---------- Nav ---------- */
(function nav(){
  const mb=$('#menuBtn'),mm=$('#mobileMenu');
  const set=o=>{mb.setAttribute('aria-expanded',o);mm.classList.toggle('open',o);mb.setAttribute('aria-label',o?'Close menu':'Open menu');};
  mb.addEventListener('click',()=>set(mb.getAttribute('aria-expanded')!=='true'));
  $$('#mobileMenu a').forEach(a=>a.addEventListener('click',()=>set(false)));
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&mb.getAttribute('aria-expanded')==='true'){set(false);mb.focus();}});
  const links=$$('.nav-links a');const secs=links.map(a=>$(a.getAttribute('href')));
  if('IntersectionObserver'in window){const io=new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting){links.forEach(a=>a.removeAttribute('aria-current'));const i=secs.indexOf(e.target);if(i>=0)links[i].setAttribute('aria-current','true');}}),{rootMargin:'-45% 0px -50% 0px'});secs.forEach(s=>s&&io.observe(s));}
})();

/* ---------- Three.js coin ---------- */
(function coin(){
  const stage=$('#coinStage');
  const fail=()=>{stage.classList.add('fallback');$('#coinHint').textContent='Static view (WebGL unavailable)';};
  const hasGL=(()=>{try{const c=document.createElement('canvas');return !!(c.getContext('webgl')||c.getContext('experimental-webgl'));}catch(e){return false;}})();
  if(!hasGL){fail();return;}
  const s=document.createElement('script');
  s.src='https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
  s.integrity='sha512-dLxUelApnYxpLt6K2iomGngnHO83iUvZytA3YjDUCjT0HDOHKXnVYdf3hU4JjM8uEhxf9nD1/ey98U3t2vZ0qQ==';
  s.crossOrigin='anonymous';s.referrerPolicy='no-referrer';
  s.onload=()=>{try{build();}catch(e){console.warn(e);fail();}};s.onerror=fail;
  document.head.appendChild(s);
  function btc(g,m){ // vector bitcoin mark, independent of font coverage
    const u=m/512;g.save();g.translate(m,m);g.scale(u,u);
    const bar=(x,y,w,h)=>g.fillRect(x,y,w,h);
    bar(-60,-250,34,80);bar(10,-250,34,80);bar(-60,170,34,80);bar(10,170,34,80);
    g.beginPath();g.moveTo(-130,-180);g.lineTo(40,-180);g.bezierCurveTo(150,-180,175,-105,145,-55);g.bezierCurveTo(130,-30,110,-18,90,-12);
    g.bezierCurveTo(130,0,175,35,170,90);g.bezierCurveTo(165,160,110,190,40,190);g.lineTo(-130,190);g.lineTo(-130,150);g.lineTo(-90,150);g.lineTo(-90,-140);g.lineTo(-130,-140);g.closePath();
    g.moveTo(-25,-128);g.lineTo(30,-128);g.bezierCurveTo(85,-128,85,-38,30,-38);g.lineTo(-25,-38);g.closePath();
    g.moveTo(-25,18);g.lineTo(40,18);g.bezierCurveTo(105,18,105,138,40,138);g.lineTo(-25,138);g.closePath();
    g.fill('evenodd');g.restore();}
  function faceTexture(){
    const N=1024,c=document.createElement('canvas');c.width=c.height=N;const g=c.getContext('2d'),m=N/2;
    const gr=g.createRadialGradient(m*.8,m*.7,40,m,m,m);gr.addColorStop(0,'#f7e2a0');gr.addColorStop(.55,'#cda349');gr.addColorStop(1,'#8a6a26');
    g.fillStyle=gr;g.fillRect(0,0,N,N);
    // brushed texture
    const r=rng('brush');g.globalAlpha=.06;for(let i=0;i<2200;i++){g.strokeStyle=r()>.5?'#fff':'#5a4210';g.lineWidth=r()*1.4;g.beginPath();const a=r()*Math.PI*2,rr=r()*m;g.arc(m,m,rr,a,a+.15+r()*.3);g.stroke();}
    g.globalAlpha=1;
    // grooves
    g.strokeStyle='rgba(70,50,12,.55)';[0.97,0.80,0.765,0.30].forEach((k,i)=>{g.lineWidth=i===0?10:2.5;g.beginPath();g.arc(m,m,m*k,0,Math.PI*2);g.stroke();});
    // micro-engraving
    g.fillStyle='rgba(60,42,10,.8)';g.font='600 22px "JetBrains Mono",monospace';g.textAlign='center';g.textBaseline='middle';
    const ring='KECCAK-256 · SHA-256 · EIP-3009 · NONCE · TRANSFERWITHAUTHORIZATION · REQUEST HASH · ';
    const txt=ring+ring.slice(0,22);const R=m*.885;for(let i=0;i<txt.length;i++){const a=(i/txt.length)*Math.PI*2-Math.PI/2;g.save();g.translate(m+Math.cos(a)*R,m+Math.sin(a)*R);g.rotate(a+Math.PI/2);g.fillText(txt[i],0,0);g.restore();}
    // hex dots ring
    for(let i=0;i<96;i++){const a=i/96*Math.PI*2;g.beginPath();g.arc(m+Math.cos(a)*m*.70,m+Math.sin(a)*m*.70,i%8?2:4,0,Math.PI*2);g.fill();}
    // emblem
    g.fillStyle='#f3d88a';g.shadowColor='rgba(40,28,6,.85)';g.shadowBlur=26;g.shadowOffsetX=10;g.shadowOffsetY=14;btc(g,m);
    g.shadowColor='transparent';
    // bump (grayscale) from same drawing
    const b=document.createElement('canvas');b.width=b.height=N;const bg=b.getContext('2d');bg.fillStyle='#777';bg.fillRect(0,0,N,N);
    bg.strokeStyle='#222';[0.97,0.80,0.765,0.30].forEach((k,i)=>{bg.lineWidth=i===0?10:2.5;bg.beginPath();bg.arc(m,m,m*k,0,Math.PI*2);bg.stroke();});
    bg.fillStyle='#333';bg.font=g.font.replace('520px','22px');for(let i=0;i<96;i++){const a=i/96*Math.PI*2;bg.beginPath();bg.arc(m+Math.cos(a)*m*.70,m+Math.sin(a)*m*.70,i%8?2:4,0,Math.PI*2);bg.fill();}
    bg.fillStyle='#fff';btc(bg,m);
    return [c,b];
  }
  function edgeTexture(){const c=document.createElement('canvas');c.width=512;c.height=32;const g=c.getContext('2d');for(let i=0;i<512;i+=4){g.fillStyle=(i/4)%2?'#3a3a3a':'#e0e0e0';g.fillRect(i,0,4,32);}return c;}
  function build(){
    const T=window.THREE;if(!T)throw new Error('no three');
    const renderer=new T.WebGLRenderer({antialias:true,alpha:true,powerPreference:'low-power'});
    renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2));renderer.outputEncoding=T.sRGBEncoding;renderer.toneMapping=T.ACESFilmicToneMapping;renderer.toneMappingExposure=1.05;
    stage.prepend(renderer.domElement);renderer.domElement.setAttribute('aria-hidden','true');
    const scene=new T.Scene(),cam=new T.PerspectiveCamera(32,1,.1,50);cam.position.set(0,0,6.2);
    // environment for metal reflections
    const pm=new T.PMREMGenerator(renderer),env=new T.Scene();
    const room=new T.Mesh(new T.BoxGeometry(10,10,10),new T.MeshBasicMaterial({color:0x0b0f16,side:T.BackSide}));env.add(room);
    const panel=(col,x,y,z,w,h,i)=>{const m=new T.Mesh(new T.PlaneGeometry(w,h),new T.MeshBasicMaterial({color:new T.Color(col).multiplyScalar(i),side:T.DoubleSide}));m.position.set(x,y,z);m.lookAt(0,0,0);env.add(m);};
    panel(0xffe2b0,-3,3,3,4,2,3.2);panel(0x2e5cff,4,-1,-2,2,4,2.4);panel(0xffffff,0,4.5,0,6,1,1.4);panel(0x00c853,-4,-3,1,1.5,1.5,1.1);
    scene.environment=pm.fromScene(env,.04).texture;
    const [fc,fb]=faceTexture();const ft=new T.CanvasTexture(fc),fbt=new T.CanvasTexture(fb);ft.encoding=T.sRGBEncoding;ft.anisotropy=4;[ft,fbt].forEach(t=>{t.center.set(.5,.5);t.rotation=Math.PI/2;});
    const et=new T.CanvasTexture(edgeTexture());et.wrapS=T.RepeatWrapping;et.repeat.set(5,1);
    const faceM=new T.MeshStandardMaterial({map:ft,bumpMap:fbt,bumpScale:.035,metalness:.92,roughness:.34,envMapIntensity:1.15});const ft2=ft.clone(),fbt2=fbt.clone();[ft2,fbt2].forEach(t=>{t.needsUpdate=true;t.wrapS=T.RepeatWrapping;t.center.set(.5,.5);t.rotation=-Math.PI/2;t.repeat.set(-1,1);});const backM=new T.MeshStandardMaterial({map:ft2,bumpMap:fbt2,bumpScale:.035,metalness:.92,roughness:.34,envMapIntensity:1.15});
    const edgeM=new T.MeshStandardMaterial({color:0xb8bcc4,bumpMap:et,bumpScale:.02,roughnessMap:et,metalness:1,roughness:.38,envMapIntensity:1.2});
    const geo=new T.CylinderGeometry(1.5,1.5,.2,96,1,false);
    const coin=new T.Mesh(geo,[edgeM,faceM,backM]);coin.rotation.x=Math.PI/2;
    const rim=new T.Mesh(new T.TorusGeometry(1.5,.03,12,96),edgeM);
    const grp=new T.Group();grp.add(coin);grp.add(rim);const rim2=rim.clone();rim.position.z=.1;rim2.position.z=-.1;grp.add(rim2);scene.add(grp);
    const key=new T.DirectionalLight(0xffd9a0,2.2);key.position.set(-3,3,4);scene.add(key);
    const rimL=new T.DirectionalLight(0x2e5cff,2.6);rimL.position.set(3.5,-.5,-3);scene.add(rimL);
    const em=new T.PointLight(0x00c853,1.1,9);em.position.set(-2.4,-2.2,2);scene.add(em);
    scene.add(new T.AmbientLight(0x8b9bb4,.18));
    let vis=true,raf=0,last=0,spin=0,vel=0,tx=0,ty=0,cx=0,cy=0,base=RM.matches?0:1.9;vel=base;
    function size(){const r=stage.getBoundingClientRect();renderer.setSize(r.width,r.height,false);cam.aspect=r.width/r.height;cam.updateProjectionMatrix();cam.position.z=r.width/r.height<1.05?7.2:6.2;draw();}
    function draw(){renderer.render(scene,cam);}
    function loop(t){raf=0;const dt=Math.min(.05,last?(t-last)/1000:0);last=t;
      vel+=(base-vel)*Math.min(1,dt*1.4);spin+=vel*dt;
      cx+=(tx-cx)*Math.min(1,dt*5);cy+=(ty-cy)*Math.min(1,dt*5);
      grp.rotation.y=spin;grp.rotation.x=cy*.35;grp.rotation.z=-cx*.08;
      cam.position.x=cx*.35;cam.position.y=-cy*.25;cam.lookAt(0,0,0);
      draw();
      const moving=base>0||Math.abs(vel)>.002||Math.abs(tx-cx)>.001||Math.abs(ty-cy)>.001;
      if(vis&&moving)raf=requestAnimationFrame(loop);else last=0;}
    const kick=()=>{if(vis&&!raf)raf=requestAnimationFrame(loop);};
    stage.addEventListener('pointermove',e=>{if(e.pointerType==='touch')return;const r=stage.getBoundingClientRect();tx=(e.clientX-r.left)/r.width*2-1;ty=(e.clientY-r.top)/r.height*2-1;kick();});
    stage.addEventListener('pointerleave',()=>{tx=ty=0;kick();});
    stage.addEventListener('click',()=>{if(RM.matches){spin+=Math.PI*2;draw();}else vel+=14;kick();});
    $('#coinHint').textContent=matchMedia('(hover:hover)').matches?'Move to tilt · click to spin':'Tap to spin';
    onVisible(stage,v=>{vis=v;if(v)kick();});
    if('ResizeObserver'in window)new ResizeObserver(size).observe(stage);else window.addEventListener('resize',size);
    RM.addEventListener&&RM.addEventListener('change',()=>{base=RM.matches?0:1.9;kick();});
    size();kick();
  }
})();

/* ---------- Terminal: probability chart ---------- */
const TF={ '1H':{n:60,step:60e3,vol:.004},'24H':{n:96,step:15*60e3,vol:.012},'7D':{n:84,step:2*3600e3,vol:.02},'30D':{n:90,step:8*3600e3,vol:.03},'ALL':{n:120,step:24*3600e3,vol:.035}};
const term={market:'nyc',tf:'24H',cursor:null,series:[],msg:'',userPicked:false};
const CTF={'1H':['1m',60],'24H':['15m',96],'7D':['1hr',168],'30D':['6hr',120],'ALL':['1day',400]};
const candleCache=new Map();
async function gxCandles(sym,tf,n){const k=sym+'|'+tf;const hit=candleCache.get(k);if(hit&&Date.now()-hit.t<25000)return hit.v.slice(-n);
  const j=await LIVE.get('/v2/candles/'+encodeURIComponent(sym.toLowerCase())+'/'+tf);if(!Array.isArray(j))throw new Error('no candle data');
  const v=j.slice().reverse().map(([t,o,h,l,c,vol])=>({t,o:+o,h:+h,l:+l,c:+c,v:+vol||0}));candleCache.set(k,{t:Date.now(),v});return v.slice(-n);} // cache the full list; callers take what they need
function tLabel(t,long){const d=new Date(t);return long?d.toLocaleDateString([], {month:'short',day:'numeric'})+' '+d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}):d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});}
const ptLabel=(d,long)=>d.t!=null?tLabel(d.t,long):fmtAgo(d.ago);
function makeSeries(mk,tf){
  if(MARKETS[mk]&&MARKETS[mk].live)return term.series;
  const m=MARKETS[mk],cfg=TF[tf],r=rng(mk+tf),n=cfg.n;const v=new Array(n);v[n-1]=m.mid;
  for(let i=n-2;i>=0;i--){const pull=(0.5-v[i+1])*0.015;v[i]=Math.min(.97,Math.max(.03,v[i+1]-pull+(r()-.5)*cfg.vol*2));}
  return v.map((p,i)=>({p,ago:(n-1-i)*cfg.step}));
}
function fmtAgo(ms){if(ms===0)return 'snapshot';const m=Math.round(ms/60e3);if(m<60)return '−'+m+'m';const h=Math.floor(m/60),mm=m%60;if(h<48)return '−'+h+'h'+(mm?' '+mm+'m':'');return '−'+Math.round(h/24)+'d';}
const probC=$('#probChart'),probW=$('#probWrap'),tip=$('#probTip');
function drawProb(){
  const {x,w,h}=fitCanvas(probC);const pad={l:44,r:56,t:16,b:28};const s=term.series,m=MARKETS[term.market];
  x.clearRect(0,0,w,h);
  if(s.length<2){x.fillStyle='#8B9BB4';x.font='13px "Space Grotesk",sans-serif';x.textAlign='center';x.textBaseline='middle';x.fillText(term.msg||'No price history yet.',w/2,h/2);probC._X=null;tip.classList.remove('on');return;}
  let lo=Math.min(...s.map(d=>d.p),m.bid),hi=Math.max(...s.map(d=>d.p),m.ask);const span=Math.max(.08,hi-lo);lo=Math.max(0,lo-span*.25);hi=Math.min(1,hi+span*.25);
  const X=i=>pad.l+(w-pad.l-pad.r)*i/(s.length-1),Y=p=>pad.t+(h-pad.t-pad.b)*(1-(p-lo)/(hi-lo));
  x.font='11px "JetBrains Mono",monospace';x.textBaseline='middle';
  const step=span>.3?.1:span>.12?.05:.02;
  for(let g=Math.ceil(lo/step)*step;g<=hi+1e-9;g+=step){const y=Y(g);x.strokeStyle='#1E2738';x.lineWidth=1;x.beginPath();x.moveTo(pad.l,Math.round(y)+.5);x.lineTo(w-pad.r,Math.round(y)+.5);x.stroke();x.fillStyle='#8B9BB4';x.textAlign='right';x.fillText((g*100).toFixed(0)+'¢',pad.l-8,y);}
  const ticks=w<480?3:6;x.textAlign='center';x.textBaseline='top';
  for(let k=0;k<=ticks;k++){const i=Math.round((s.length-1)*k/ticks);x.fillStyle='#8B9BB4';x.fillText(ptLabel(s[i],s.length>1&&s[0].t!=null?(s[s.length-1].t-s[0].t>72e6):(term.tf!=='1H'&&term.tf!=='24H')),Math.min(w-pad.r-16,Math.max(pad.l+16,X(i))),h-pad.b+8);}
  // bid/ask band at snapshot
  x.fillStyle='rgba(46,92,255,.12)';x.fillRect(pad.l,Y(m.ask),w-pad.l-pad.r,Y(m.bid)-Y(m.ask));
  if(m.live&&typeof FC!=='undefined'){const f=FC.byContract.get(m.c.id);if(f){const fy=Y(Math.min(hi,Math.max(lo,f.p)));x.strokeStyle='#00C853';x.setLineDash([6,4]);x.lineWidth=1.5;x.beginPath();x.moveTo(pad.l,fy);x.lineTo(w-pad.r,fy);x.stroke();x.setLineDash([]);x.fillStyle='#00C853';x.textAlign='left';x.textBaseline='bottom';x.fillText('AI estimate '+(f.p*100).toFixed(1)+'%',pad.l+6,fy-3);x.textBaseline='middle';}}
  // area + line
  x.beginPath();x.moveTo(X(0),Y(s[0].p));for(let i=1;i<s.length;i++){const xm=(X(i-1)+X(i))/2,ym=(Y(s[i-1].p)+Y(s[i].p))/2;x.quadraticCurveTo(X(i-1),Y(s[i-1].p),xm,ym);}x.lineTo(X(s.length-1),Y(s[s.length-1].p));
  const path=new Path2D();// reuse for fill
  x.strokeStyle='#2E5CFF';x.lineWidth=2;x.stroke();
  x.lineTo(X(s.length-1),h-pad.b);x.lineTo(X(0),h-pad.b);x.closePath();const gr=x.createLinearGradient(0,pad.t,0,h-pad.b);gr.addColorStop(0,'rgba(46,92,255,.18)');gr.addColorStop(1,'rgba(46,92,255,0)');x.fillStyle=gr;x.fill();
  // last price marker
  const ly=Y(m.mid);x.fillStyle='#2E5CFF';x.fillRect(w-pad.r+4,ly-9,pad.r-6,18);x.fillStyle='#fff';x.textAlign='center';x.textBaseline='middle';x.fillText((m.mid*100).toFixed(1),w-pad.r+4+(pad.r-6)/2,ly);
  x.textAlign='left';x.fillStyle='#8B9BB4';x.fillText('ask '+Math.round(m.ask*100),w-pad.r+6,Y(m.ask)-12<pad.t?Y(m.ask)+12:Y(m.ask)-12);
  // crosshair
  if(term.cursor!=null){const i=term.cursor,cx=X(i),cy=Y(s[i].p);x.strokeStyle='#8B9BB4';x.setLineDash([3,3]);x.beginPath();x.moveTo(cx+.5,pad.t);x.lineTo(cx+.5,h-pad.b);x.moveTo(pad.l,cy+.5);x.lineTo(w-pad.r,cy+.5);x.stroke();x.setLineDash([]);x.fillStyle='#F1F5F9';x.beginPath();x.arc(cx,cy,3.5,0,7);x.fill();
    tip.innerHTML=`${ptLabel(s[i],true)} &nbsp; <b>${(s[i].p*100).toFixed(1)}¢</b> ${m.live?'<span style="color:#00C853">Gemini</span>':'<span style="color:#F59E0B">fixture</span>'}`;tip.classList.add('on');const tw=tip.offsetWidth;tip.style.left=Math.min(w-tw-4,Math.max(4,cx+10))+'px';tip.style.top=Math.max(4,cy-34)+'px';
    $('#qCur').textContent=(s[i].p*100).toFixed(1)+'¢ '+ptLabel(s[i]);}
  else{tip.classList.remove('on');$('#qCur').textContent='—';}
  probC._X={pad,w,n:s.length};
}
function idxFromX(clientX){const r=probC.getBoundingClientRect(),g=probC._X;if(!g)return null;const t=(clientX-r.left-g.pad.l)/(g.w-g.pad.l-g.pad.r);return Math.max(0,Math.min(g.n-1,Math.round(t*(g.n-1))));}
probC.tabIndex=0;
probC.addEventListener('pointermove',e=>{term.cursor=idxFromX(e.clientX);drawProb();});
probC.addEventListener('pointerdown',e=>{term.cursor=idxFromX(e.clientX);drawProb();});
probC.addEventListener('pointerleave',e=>{if(e.pointerType!=='touch'){term.cursor=null;drawProb();}});
probC.addEventListener('keydown',e=>{const n=term.series.length;if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();term.cursor=term.cursor==null?n-1:Math.max(0,Math.min(n-1,term.cursor+(e.key==='ArrowLeft'?-1:1)));drawProb();}else if(e.key==='Escape'){term.cursor=null;drawProb();}});
probC.addEventListener('blur',()=>{term.cursor=null;drawProb();});
probC.setAttribute('aria-describedby','probFoot');
function probTable(){const m=MARKETS[term.market];$('#probTable').innerHTML=term.series.slice().reverse().map(d=>`<tr><td class="mono">${ptLabel(d,true)}</td><td class="num">${(d.p*100).toFixed(1)}¢${m.live?' (Gemini Exchange close)':d.ago===0?' (captured)':' (fixture)'}</td></tr>`).join('');}
const TFMS={'1m':6e4,'5m':3e5,'15m':9e5,'1hr':36e5,'6hr':216e5,'1day':864e5};
const HIST={state:'demo',fetched:0,newest:0,url:'',err:'',timer:0,vis:false};
function histUrl(sym,tf){return 'https://api.gemini.com/v2/candles/'+encodeURIComponent(sym.toLowerCase())+'/'+tf;}
function probMeta(){const el=$('#probMeta');if(!el)return;const m=MARKETS[term.market];
  if(!m.live){el.innerHTML='<span class="tick-status stale">Demo fixture path</span><span>Earlier points are a labelled fixture. Only the last point is the real Nov 18 capture.</span>';return;}
  const st={live:['live','<span class="dot" aria-hidden="true"></span>Live history'],stale:['stale','Stale history'],empty:['stale','No history'],loading:['','Loading history…']}[HIST.state]||['','—'];
  const when=t=>new Date(t).toLocaleString([], {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',timeZoneName:'short'});
  const bits=[];if(HIST.fetched)bits.push('Fetched '+when(HIST.fetched));if(HIST.newest)bits.push('newest candle '+when(HIST.newest));
  if(HIST.first)bits.push('oldest candle starts '+when(HIST.first)+(HIST.short?', so this view shows the whole history':''));
  if(HIST.state==='stale')bits.push(HIST.err?'last refresh failed, showing the previous fetch':'no new candle for several periods');
  if(HIST.state==='empty')bits.push(HIST.err||'no candles for this timeframe');
  el.innerHTML=`<span class="tick-status ${st[0]}" role="status">${st[1]}</span><span>${esc(bits.join(' · '))}</span><span>Source: <a href="${esc(HIST.url)}" target="_blank" rel="noopener noreferrer">Gemini Exchange public API, ${esc(m.symbol||'')} candles</a>. Market-implied probability only; the resolution-risk rating beside it is scored separately from the rules.</span>`;}
function histSchedule(){clearInterval(HIST.timer);HIST.timer=0;const m=MARKETS[term.market];if(HIST.vis&&m&&m.live&&m.symbol)HIST.timer=setInterval(()=>loadHist(true),60000);}
/* Longest, most detailed history Gemini Exchange has for one contract. Candles only exist from the contract's
   first trade, so most prediction markets have hours of history, not days. Fetch every resolution and stitch:
   1-minute candles for the recent part, then 5m, 15m, 1hr, 6hr and 1day only for stretches older than the finer data. */
const WINMS={'1H':36e5,'24H':864e5,'7D':6048e5,'30D':2592e6,'ALL':Infinity};
const HIST_RES=['1m','5m','15m','1hr','6hr','1day']; // a coarser candle is used only if it ends before the finer data starts
async function gxHistory(sym){const parts=await Promise.all(HIST_RES.map(tf=>gxCandles(sym,tf,5000).then(v=>({tf,v})).catch(e=>({tf,v:[],err:e.message}))));
  const errs=parts.filter(p=>p.err);if(errs.length===parts.length)throw new Error(errs[0].err);
  let out=[],cut=Infinity;const used=[];
  parts.forEach(p=>{const span=TFMS[p.tf]||0,older=p.v.filter(d=>cut===Infinity||d.t+span<=cut).map(d=>Object.assign({},d,{tf:p.tf}));if(older.length){out=older.concat(out);used.push(p.tf);cut=older[0].t;}});
  return {v:out,used,first:out.length?out[0].t:0,fine:used[0]||'1m'};}
function bucket(v,max){if(v.length<=max)return v;const t0=v[0].t,t1=v[v.length-1].t,w=(t1-t0)/max,out=[];let cur=null,k=-1;
  v.forEach(d=>{const i=Math.min(max-1,Math.floor((d.t-t0)/w));if(i!==k){if(cur)out.push(cur);cur={t:d.t,o:d.o,h:d.h,l:d.l,c:d.c,v:d.v};k=i;}else{cur.c=d.c;cur.h=Math.max(cur.h,d.h);cur.l=Math.min(cur.l,d.l);cur.v+=d.v;cur.t=d.t;}});
  if(cur)out.push(cur);return out;}
function loadHist(refresh){const m=MARKETS[term.market];const key=m.symbol+term.tf;const win=WINMS[term.tf]||Infinity;HIST.url=histUrl(m.symbol,'1m');
  if(refresh)HIST_RES.forEach(tf=>candleCache.delete(m.symbol+'|'+tf));
  gxHistory(m.symbol).then(h=>{const mm=MARKETS[term.market];if(!mm.live||mm.symbol+term.tf!==key)return;
    const all=h.v,since=Date.now()-win,inWin=all.filter(d=>d.t>=since),v=bucket(inWin,480);
    HIST.fetched=Date.now();HIST.err='';HIST.newest=all.length?all[all.length-1].t:0;HIST.first=h.first;HIST.used=h.used;HIST.points=inWin.length;HIST.short=all.length&&h.first>since;
    term.series=v.map(d=>({p:d.c,t:d.t,ago:0}));term.msg=v.length<2?(all.length?'No trades in this window yet. Try a longer view.':'Not enough trading history yet.'):'';
    HIST.state=v.length<2?'empty':(Date.now()-HIST.newest>Math.max(9e5,3*TFMS[h.fine])?'stale':'live');
    const traded=inWin.filter(d=>d.v>0).length;
    term.foot=v.length?`${inWin.length} Gemini Exchange candles (${[...new Set(inWin.map(d=>d.tf))].reverse().join(', ')}), finest for the most recent stretch${v.length<inWin.length?', drawn as '+v.length+' points':''}. Trades in ${traded} of ${inWin.length} periods; flat stretches carry the last price forward. The band is the live bid–ask.`:'';
    if(term.foot)$('#probFoot').textContent=term.foot;drawProb();probTable();probMeta();})
   .catch(e=>{const mm=MARKETS[term.market];if(!mm.live||mm.symbol+term.tf!==key)return;
    if(refresh&&term.series.length>1){HIST.state='stale';HIST.err=e.message;probMeta();return;}
    HIST.state='empty';HIST.err=e.message==='NoDataFound'?'no trades on this contract yet':'history unavailable ('+e.message+')';
    term.series=[];$('#probFoot').textContent='';term.msg=e.message==='NoDataFound'?'No trades on this contract yet, so Gemini Exchange has no price history for it. The quote above is live.':'Candles unavailable right now ('+e.message+'). Retrying every minute.';drawProb();probMeta();});}
function renderProb(){const m=MARKETS[term.market];term.cursor=null;
  if(!m.live){HIST.state='demo';term.series=makeSeries(term.market,term.tf);drawProb();probTable();probMeta();histSchedule();return;}
  term.series=[];term.foot='';term.msg='Loading Gemini Exchange candles…';HIST.state='loading';HIST.fetched=0;HIST.newest=0;drawProb();probTable();
  if(!m.symbol){term.msg='This contract has no instrument symbol, so no candles.';HIST.state='empty';HIST.err='no instrument symbol';HIST.url='https://api.gemini.com/v1/prediction-markets/events';drawProb();probMeta();return;}
  probMeta();loadHist(false);histSchedule();}
onVisible(probW,v=>{HIST.vis=v;histSchedule();});
$$('#tfSeg button').forEach(b=>b.addEventListener('click',()=>{term.tf=b.dataset.tf;$$('#tfSeg button').forEach(x=>x.setAttribute('aria-pressed',x===b));renderProb();}));
if('ResizeObserver'in window)new ResizeObserver(()=>drawProb()).observe(probW);

/* ---------- Terminal: candles + depth ---------- */
const cand={list:[],paused:false,vis:false,timer:0,ticks:0,dirty:true,cursor:null};
async function liveCandles(){const m=MARKETS[term.market];if(!m.live||!m.symbol)return;const key=m.symbol;
  try{const v=await gxCandles(m.symbol,'5m',48);if(MARKETS[term.market].symbol!==key)return;cand.list=v;cand.msg=v.length<2?'Not enough 5-minute history yet.':'';
    $('#candleStamp').textContent='Gemini 5m candles · '+new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});}
  catch(e){cand.msg=e.message==='NoDataFound'?'No trades yet, so no candles. Top of book is live.':'Candles unavailable ('+e.message+').';}
  requestAnimationFrame(drawCandles);}
function seedCandles(){if(MARKETS[term.market].live){cand.list=[];cand.msg='Loading Gemini Exchange candles…';liveCandles();candleSchedule();return;}cand.msg='';
  const m=MARKETS[term.market],r=rng('c'+term.market);let p=m.mid;const L=[];
  for(let i=0;i<40;i++){const o=p,c=Math.min(.97,Math.max(.03,o+(r()-.5)*.025));const hi=Math.max(o,c)+r()*.01,lo=Math.min(o,c)-r()*.01;L.push({o,h:hi,l:lo,c,v:Math.round(r()*(m.vol>100?60:3)+1)});p=c;}
  const k=m.mid-L[39].c;L.forEach(d=>{d.o+=k;d.c+=k;d.h+=k;d.l+=k;});cand.list=L;cand.r=rng('live'+term.market);cand.dirty=true;}
const cc=$('#candleChart'),ctip=$('#candleTip');
function drawCandles(){cand.dirty=false;const {x,w,h}=fitCanvas(cc),m=MARKETS[term.market],L=cand.list;x.clearRect(0,0,w,h);
  if(L.length<2){x.fillStyle='#8B9BB4';x.font='12px "Space Grotesk",sans-serif';x.textAlign='center';x.textBaseline='middle';x.fillText(cand.msg||'No data',w/2,h/2);cc._bw=1;cc._pw=0;return;}
  const depthW=Math.max(64,w*.26),pw=w-depthW-8,top=10,ph=(h-34)*.74,vh=(h-34)*.22,vy=top+ph+6;
  let lo=Math.min(...L.map(d=>d.l),m.bid-.03),hi=Math.max(...L.map(d=>d.h),m.ask+.03);const Y=p=>top+ph*(1-(p-lo)/(hi-lo));
  const bw=pw/L.length;const vmax=Math.max(1e-9,...L.map(d=>d.v));
  x.strokeStyle='#1E2738';for(let k=0;k<=3;k++){const y=Math.round(top+ph*k/3)+.5;x.beginPath();x.moveTo(0,y);x.lineTo(pw,y);x.stroke();}
  L.forEach((d,i)=>{const cx=i*bw+bw/2,up=d.c>=d.o;const col=up?'#00C853':'#FF3B30';x.strokeStyle=col;x.beginPath();x.moveTo(Math.round(cx)+.5,Y(d.h));x.lineTo(Math.round(cx)+.5,Y(d.l));x.stroke();
    const y1=Y(Math.max(d.o,d.c)),y2=Y(Math.min(d.o,d.c));x.fillStyle=up?col:'#10151E';x.fillRect(cx-bw*.32,y1,bw*.64,Math.max(1,y2-y1));if(!up)x.strokeRect(cx-bw*.32+.5,y1+.5,bw*.64-1,Math.max(1,y2-y1)-1);
    x.fillStyle=up?'rgba(0,200,83,.35)':'rgba(255,59,48,.35)';const vhh=vh*d.v/vmax;x.fillRect(cx-bw*.32,vy+vh-vhh,bw*.64,vhh);});
  const last=L[L.length-1].c,ly=Y(last);x.strokeStyle='#2E5CFF';x.setLineDash([4,3]);x.beginPath();x.moveTo(0,ly+.5);x.lineTo(pw,ly+.5);x.stroke();x.setLineDash([]);
  // depth: top of book real; deeper levels fixture
  const dx=pw+8;x.fillStyle='#8B9BB4';x.font='10px "JetBrains Mono",monospace';x.textBaseline='middle';x.textAlign='left';
  if(!m.live){const r=rng('d'+term.market);let cumA=0,cumB=0;const lv=[];for(let k=0;k<6;k++){cumA+=Math.round(r()*40+8);cumB+=Math.round(r()*40+8);lv.push([m.ask+k*.01,cumA],[m.bid-k*.01,-cumB]);}
  const mx=Math.max(cumA,cumB);lv.forEach(([p,q])=>{const y=Y(p);if(y<top||y>top+ph)return;const len=(depthW-34)*Math.abs(q)/mx;x.fillStyle=q>0?'rgba(255,59,48,.35)':'rgba(0,200,83,.35)';x.fillRect(dx,y-3,len,6);});}
  else{[[m.ask,'rgba(255,59,48,.5)'],[m.bid,'rgba(0,200,83,.5)']].forEach(([p,col])=>{const y=Y(p);x.fillStyle=col;x.fillRect(dx,y-1,depthW-34,2);});x.fillStyle='#8B9BB4';x.fillText('top of book',dx,top+ph/2);}
  x.fillStyle='#FF6B62';x.fillText('ask '+Math.round(m.ask*100)+'¢',dx,Math.max(top+6,Y(m.ask)-9));x.fillStyle='#00C853';x.fillText('bid '+Math.round(m.bid*100)+'¢',dx,Math.min(top+ph-6,Y(m.bid)+9));
  x.fillStyle='#8B9BB4';x.fillText('last '+(last*100).toFixed(1),4,h-10);x.textAlign='right';x.fillText('vol',pw-4,h-10);
  if(cand.cursor!=null&&L[cand.cursor]){const d=L[cand.cursor],cx=cand.cursor*bw+bw/2;x.strokeStyle='#8B9BB4';x.setLineDash([3,3]);x.beginPath();x.moveTo(cx+.5,top);x.lineTo(cx+.5,vy+vh);x.stroke();x.setLineDash([]);
    ctip.innerHTML=`${d.t?tLabel(d.t)+' · ':''}O ${(d.o*100).toFixed(1)} H ${(d.h*100).toFixed(1)} L ${(d.l*100).toFixed(1)} C ${(d.c*100).toFixed(1)} · v ${d.v}`;ctip.classList.add('on');ctip.style.left=Math.max(4,Math.min(w-ctip.offsetWidth-4,cx-ctip.offsetWidth/2))+'px';ctip.style.top='4px';}else ctip.classList.remove('on');
  cc._bw=bw;cc._pw=pw;
}
function candleTick(){const L=cand.list,d=L[L.length-1],r=cand.r;cand.ticks++;
  if(cand.ticks%5===0){L.shift();const o=d.c;L.push({o,h:o,l:o,c:o,v:1});}
  const z=L[L.length-1],m=MARKETS[term.market];z.c=Math.min(m.ask+.03,Math.max(m.bid-.03,z.c+(r()-.5)*.008));z.h=Math.max(z.h,z.c);z.l=Math.min(z.l,z.c);z.v+=Math.round(r()*2);
  $('#candleStamp').textContent='simulated tick '+new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
  requestAnimationFrame(drawCandles);}
function candleSchedule(){clearInterval(cand.timer);cand.timer=0;const live=MARKETS[term.market]&&MARKETS[term.market].live;if(cand.vis&&!cand.paused&&(live||!RM.matches))cand.timer=setInterval(live?liveCandles:candleTick,live?30000:1200);}
onVisible($('#candleWrap'),v=>{cand.vis=v;candleSchedule();});
$('#candlePause').addEventListener('click',e=>{cand.paused=!cand.paused;e.currentTarget.setAttribute('aria-pressed',cand.paused);e.currentTarget.textContent=cand.paused?'Resume':'Pause';candleSchedule();});
if(RM.matches){$('#candlePause').textContent='Static';$('#candlePause').disabled=true;}
cc.addEventListener('pointermove',e=>{const r=cc.getBoundingClientRect(),xx=e.clientX-r.left;cand.cursor=xx<cc._pw?Math.floor(xx/cc._bw):null;drawCandles();});
cc.addEventListener('pointerleave',()=>{cand.cursor=null;drawCandles();});
if('ResizeObserver'in window)new ResizeObserver(()=>drawCandles()).observe($('#candleWrap'));
