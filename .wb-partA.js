// MakerBay visual E2E — Part A: marketing + demo site, unattended.
// Talks to the local WebBridge daemon (127.0.0.1:10086). No npm deps.
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const SHOTS = path.join(DIR, '.shots');
const LOG = path.join(DIR, '.shots', 'partA-log.json');
const S = 'makerbay-e2e-test';
const log = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(action, args = {}) {
  const res = await fetch('http://127.0.0.1:10086/command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, args, session: S }),
  });
  return res.json();
}

async function shot(name) {
  const r = await post('screenshot', {
    format: 'jpeg', quality: 70,
    path: path.join(SHOTS, name),
  });
  log.push({ step: name, ok: !!r.ok, bytes: r.data ? r.data.sizeBytes : null, err: r.error || null });
}

async function ev(name, code) {
  const r = await post('evaluate', { code });
  log.push({ step: name, ok: !!r.ok, value: r.data ? r.data.value : null, err: r.error || null });
  return r.ok ? r.data.value : null;
}

async function nav(name, url, waitMs = 3500) {
  const r = await post('navigate', { url });
  log.push({ step: 'nav:' + name, ok: !!r.ok, url, err: r.error || null });
  await sleep(waitMs);
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  try {
    // 1. Homepage pricing cards (tab already on makerbay.app)
    await post('find_tab', { url: 'https://makerbay.app' });
    await sleep(1000);
    await ev('home:scroll-cards', "(()=>{const els=[...document.querySelectorAll('*')].filter(e=>e.children.length===0&&/\\$29/.test(e.textContent)); if(!els.length) return 'notfound'; const r=els[0].getBoundingClientRect(); window.scrollTo(0, r.top+scrollY-innerHeight*0.55); return els[0].textContent.slice(0,30)})()");
    await sleep(1200);
    await shot('home-11-cards.jpg');

    // 2. Pricing page
    await nav('pricing', 'https://makerbay.app/pricing');
    await shot('pricing-1-top.jpg');
    await ev('pricing:scroll1', 'window.scrollTo(0,1400),"ok"');
    await sleep(800);
    await shot('pricing-2-plans.jpg');
    await ev('pricing:scroll2', 'window.scrollTo(0,2800),"ok"');
    await sleep(800);
    await shot('pricing-3-compare.jpg');
    await ev('pricing:bottom', 'window.scrollTo(0,document.body.scrollHeight),"ok"');
    await sleep(800);
    await shot('pricing-4-bottom.jpg');

    // 3. Roadmap
    await nav('roadmap', 'https://makerbay.app/roadmap');
    await shot('roadmap-1-top.jpg');
    await ev('roadmap:scroll', 'window.scrollTo(0,1600),"ok"');
    await sleep(800);
    await shot('roadmap-2-mid.jpg');

    // 4. Demo workspace page
    await nav('demo', 'https://demo.makerbay.app');
    await shot('demo-1-top.jpg');
    // open booking panel
    await ev('demo:book-click', "(()=>{const b=[...document.querySelectorAll('button,a')].find(e=>/book a time/i.test(e.textContent)); if(!b) return 'notfound'; b.click(); return 'clicked'})()");
    await sleep(2000);
    await shot('demo-2-booking.jpg');
    // pick first service if listed
    await ev('demo:service-click', "(()=>{const b=[...document.querySelectorAll('button,a,li,div[role=button]')].find(e=>/leak inspection/i.test(e.textContent)); if(!b) return 'notfound'; b.click(); return 'clicked'})()");
    await sleep(1500);
    await shot('demo-3-service.jpg');
    // pick first available day/time chip if present
    await ev('demo:day-click', "(()=>{const b=[...document.querySelectorAll('button')].filter(e=>e.offsetParent&&e.textContent.trim().length<24); const day=b.find(e=>/\\d/.test(e.textContent)); if(!day) return 'notfound:'+b.length; day.click(); return day.textContent.trim()})()");
    await sleep(1500);
    await shot('demo-4-day.jpg');
    // close booking (Escape), then open chat widget
    await ev('demo:esc', "document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})),'ok'");
    await sleep(800);
    await ev('demo:ask-click', "(()=>{const b=[...document.querySelectorAll('button,a')].find(e=>/ask a question/i.test(e.textContent)); if(!b) return 'notfound'; b.click(); return 'clicked'})()");
    await sleep(2500);
    await shot('demo-5-chat.jpg');

    // 5. Module page sample (visual): assistant + booking FAQ region
    await nav('mod-assistant', 'https://makerbay.app/modules/assistant');
    await shot('mod-assistant-1.jpg');
    await nav('mod-booking', 'https://makerbay.app/modules/booking');
    await ev('mod-booking:faq', "(()=>{const els=[...document.querySelectorAll('*')].filter(e=>e.children.length===0&&/deposit/i.test(e.textContent)); if(!els.length) return 'notfound'; window.scrollTo(0, els[0].getBoundingClientRect().top+scrollY-300); return 'ok'})()");
    await sleep(800);
    await shot('mod-booking-faq.jpg');

    log.push({ step: 'DONE', ok: true });
  } catch (e) {
    log.push({ step: 'FATAL', ok: false, err: String(e) });
  }
  fs.writeFileSync(LOG, JSON.stringify(log, null, 1));
  console.log(JSON.stringify(log));
})();
