// Compact keccak-256 (Ethereum variant, 0x01 padding). 32-bit lane halves.
function keccak256(bytes){
  const RC=[1,0,32898,0,32906,2147483648,2147516416,2147483648,32907,0,2147483649,0,2147516545,2147483648,32777,2147483648,138,0,136,0,2147516425,0,2147483658,0,2147516555,0,139,2147483648,32905,2147483648,32771,2147483648,32770,2147483648,128,2147483648,32778,0,2147483658,2147483648,2147516545,2147483648,32896,2147483648,2147483649,0,2147516424,2147483648];
  const ROT=[0,1,62,28,27,36,44,6,55,20,3,10,43,25,39,41,45,15,21,8,18,2,61,56,14];
  const PI=[0,10,20,5,15,16,1,11,21,6,7,17,2,12,22,23,8,18,3,13,14,24,9,19,4];
  const s=new Uint32Array(50), rate=136;
  const msg=new Uint8Array(Math.ceil((bytes.length+1)/rate)*rate);
  msg.set(bytes); msg[bytes.length]^=0x01; msg[msg.length-1]^=0x80;
  const B=new Uint32Array(50), C=new Uint32Array(10);
  function f(){
    for(let r=0;r<24;r++){
      for(let x=0;x<5;x++){C[2*x]=s[2*x]^s[2*x+10]^s[2*x+20]^s[2*x+30]^s[2*x+40];C[2*x+1]=s[2*x+1]^s[2*x+11]^s[2*x+21]^s[2*x+31]^s[2*x+41];}
      for(let x=0;x<5;x++){const a=(x+4)%5,b=(x+1)%5;const lo=C[2*a]^((C[2*b]<<1)|(C[2*b+1]>>>31));const hi=C[2*a+1]^((C[2*b+1]<<1)|(C[2*b]>>>31));for(let y=0;y<25;y+=5){s[2*(x+y)]^=lo;s[2*(x+y)+1]^=hi;}}
      for(let i=0;i<25;i++){const lo=s[2*i],hi=s[2*i+1],n=ROT[i];let rl,rh;
        if(n===0){rl=lo;rh=hi;}else if(n<32){rl=(lo<<n)|(hi>>>(32-n));rh=(hi<<n)|(lo>>>(32-n));}else if(n===32){rl=hi;rh=lo;}else{const m=n-32;rl=(hi<<m)|(lo>>>(32-m));rh=(lo<<m)|(hi>>>(32-m));}
        B[2*PI[i]]=rl;B[2*PI[i]+1]=rh;}
      for(let y=0;y<25;y+=5)for(let x=0;x<5;x++){const i=y+x,j=y+(x+1)%5,k=y+(x+2)%5;s[2*i]=B[2*i]^(~B[2*j]&B[2*k]);s[2*i+1]=B[2*i+1]^(~B[2*j+1]&B[2*k+1]);}
      s[0]^=RC[2*r];s[1]^=RC[2*r+1];
    }
  }
  for(let o=0;o<msg.length;o+=rate){for(let i=0;i<rate/4;i++){const p=o+4*i;s[i]^=msg[p]|(msg[p+1]<<8)|(msg[p+2]<<16)|(msg[p+3]<<24);}f();}
  let h='';for(let i=0;i<8;i++){const w=s[i];for(let k=0;k<4;k++)h+=((w>>>(8*k))&255).toString(16).padStart(2,'0');}
  return '0x'+h;
}
if(typeof module!=='undefined')module.exports=keccak256;
