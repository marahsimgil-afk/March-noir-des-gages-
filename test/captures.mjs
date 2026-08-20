import { chromium } from 'playwright';
const OUT='/tmp/claude-0/-home-user-March-noir-des-gages-/d32349e5-5d1d-5861-9d99-08291c7efc99/scratchpad';
const BASE='http://127.0.0.1:8787/', BROKER='ws://127.0.0.1:9001';
const url=h=>`${BASE}?broker=${encodeURIComponent(BROKER)}#${h}`;
const PHONE={viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:2};
const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium',args:['--no-sandbox']});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

const tv=await (await b.newContext({viewport:{width:1400,height:800}})).newPage();
await tv.goto(url(''),{waitUntil:'domcontentloaded'});
await sleep(400); await tv.screenshot({path:OUT+'/01-accueil.png'});

await tv.goto(url('setup'),{waitUntil:'domcontentloaded'});
const N=['Marah','Léo','Chloé','Yanis','Emma','Tom','Inès','Hugo','Jade'];
for(let i=0;i<9;i++) await tv.locator('#names-list .name-input').nth(i).fill(N[i]);
await sleep(200); await tv.screenshot({path:OUT+'/02-config.png'});
await tv.click('#btn-open-room'); await tv.waitForSelector('#screen-tv.is-active');
const code=(await tv.textContent('#tv-code')).trim();
await tv.waitForSelector('#modal-qr:not([hidden])'); await sleep(600);
await tv.screenshot({path:OUT+'/03-qr.png'});
await tv.click('#btn-qr-close');

const phones=[];
for(let i=1;i<9;i++){const p=await (await b.newContext(PHONE)).newPage();
  await p.goto(url('j/'+code),{waitUntil:'domcontentloaded'});
  await p.waitForSelector(`#who-list button:text-is("${N[i]}")`,{timeout:15000});
  if(i===1){await sleep(300); await p.screenshot({path:OUT+'/04-quiestu.png'});}
  await p.locator(`#who-list button:text-is("${N[i]}")`).click(); phones.push({p,n:N[i]});}

await tv.selectOption('#lot-select',{index:2});
await tv.click('#duration-group .chip[data-dur="45"]');
await tv.click('#btn-open-lot'); await sleep(600);
for(const{p,n}of phones){const k=({'Léo':7,'Chloé':12,'Yanis':3,'Emma':9,'Tom':1,'Inès':5,'Hugo':2,'Jade':6})[n];
  for(let i=0;i<k;i++){await p.click('#btn-bid1',{delay:0}); await sleep(15);} }
await sleep(1200);
await tv.screenshot({path:OUT+'/05-tv-enchere.png'});
await phones[1].p.screenshot({path:OUT+'/06-tel-enchere.png'});
await sleep(1000);
await tv.click('#btn-close-lot');
await tv.waitForSelector('#btn-adjuge:not([hidden])',{timeout:10000}); await sleep(700);
await tv.screenshot({path:OUT+'/07-tv-adjuge.png'});
await phones[1].p.screenshot({path:OUT+'/08-tel-gagne.png'});
await tv.click('#btn-adjuge'); await sleep(800);
await tv.screenshot({path:OUT+'/09-tv-ardoises.png'});
// vue tablette portrait
const tab=await (await b.newContext({viewport:{width:820,height:1180}})).newPage();
await tab.goto(url('tv'),{waitUntil:'domcontentloaded'}); await sleep(1200);
await tab.evaluate(()=>{const m=document.querySelector('#modal-qr'); if(m) m.hidden=true;});
await tab.screenshot({path:OUT+'/10-tablette.png',fullPage:true});
await b.close(); console.log('captures ok, code',code);
