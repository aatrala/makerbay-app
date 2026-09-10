// MakerBay visual E2E — Part C2: submit code, sweep dashboard screens.
const fs = require('fs');
const path = require('path');
const DIR = __dirname;
const SHOTS = path.join(DIR, '.shots');
const LOG = path.join(SHOTS, 'partC2-log.json');
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
  const r = await post('screenshot', { format: 'jpeg', quality: 70, path: path.join(SHOTS, name) });
  log.push({ step: name, ok: !!r.ok, bytes: r.data?.sizeBytes ?? null, err: r.error || null });
}
async function ev(name, code) {
  const r = await post('evaluate', { code });
  log.push({ step: name, ok: !!r.ok, value: r.data?.value ?? null, err: r.error || null });
  return r.ok ? r.data.value : null;
}

(async () => {
  try {
    // Submit the code
    await post('fill', { selector: 'input', value: '989113' });
    await sleep(400);
    await ev('code:submit', "(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.offsetParent&&/sign in/i.test(e.textContent)); if(!b) return 'notfound'; b.click(); return 'clicked'})()");
    await sleep(8000);
    await shot('dash-00-after-login.jpg');
    await ev('dash:url', 'location.href');
    await ev('dash:text', 'document.body.innerText.slice(0,300)');

    // Discover nav links
    const linksJson = await ev('dash:links', "(()=>{const as=[...document.querySelectorAll('a[href]')].map(a=>({h:a.getAttribute('href'),t:a.textContent.trim().slice(0,30)})).filter(x=>x.h&&x.h.startsWith('/')&&!x.t.match(/sign out/i)); const seen=new Set(); const out=[]; for(const x of as){ if(!seen.has(x.h)){seen.add(x.h); out.push(x)} } return JSON.stringify(out.slice(0,30))})()");
    let links = [];
    try { links = JSON.parse(linksJson || '[]'); } catch {}

    // Visit each nav destination
    let i = 0;
    for (const l of links) {
      i++;
      const name = 'dash-' + String(i).padStart(2, '0') + '-' + l.h.replace(/[^a-z0-9]+/gi, '_').slice(0, 40) + '.jpg';
      await post('navigate', { url: 'https://app.makerbay.app' + l.h });
      await sleep(3500);
      await shot(name);
      await ev('text:' + l.h, 'document.body.innerText.slice(0,200)');
    }

    log.push({ step: 'DONE', ok: true, value: links.length + ' screens' });
  } catch (e) {
    log.push({ step: 'FATAL', ok: false, err: String(e) });
  }
  fs.writeFileSync(LOG, JSON.stringify(log, null, 1));
  console.log(JSON.stringify(log));
})();
