// W7: Activity feed check, diary re-check (V4), then sign out.
const fs = require('fs');
const path = require('path');
const SHOTS = path.join(__dirname, '.shots');
const LOG = path.join(SHOTS, 'w7-log.json');
const S = 'makerbay-e2e-test';
const log = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(action, args = {}) {
  const res = await fetch('http://127.0.0.1:10086/command', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, args, session: S }),
  });
  return res.json();
}
async function shot(name) {
  const r = await post('screenshot', { format: 'jpeg', quality: 70, path: path.join(SHOTS, name) });
  log.push({ step: name, ok: !!r.ok });
}
async function ev(name, code) {
  const r = await post('evaluate', { code });
  const v = r.data?.value ?? null;
  log.push({ step: name, ok: !!r.ok, value: typeof v === 'string' ? v.slice(0, 900) : v, err: r.error ? JSON.stringify(r.error).slice(0, 200) : null });
  return r.ok ? r.data.value : null;
}
const clickByText = (re) => `(()=>{const b=[...document.querySelectorAll('button,a,li,[role=button]')].find(e=>e.offsetParent&&${re}.test((e.textContent||'').replace(/\\s+/g,' ').trim())); if(!b) return 'notfound'; b.click(); return (b.textContent||'').replace(/\\s+/g,' ').trim().slice(0,60)})()`;
const body = () => `(()=>document.body.innerText.replace(/\\s+/g,' ').slice(0,2600))()`;

(async () => {
  try {
    // 1. Activity feed — try /activity then look for a link on Home
    await post('navigate', { url: 'https://app.makerbay.app/activity' });
    await sleep(5000);
    await ev('act:url', `(()=>location.href)()`);
    await ev('act:text', body());
    await shot('w7-1-activity.jpg');

    // 2. Diary re-check (V4) — fresh load, several minutes after booking
    await post('navigate', { url: 'https://app.makerbay.app/booking/diary' });
    await sleep(5000);
    await ev('diary:recheck', body());
    await shot('w7-2-diary-recheck.jpg');

    // 3. Sign out — open the account menu (the "T Test page" button bottom-left)
    await ev('so:menu', `(()=>{
      const b=[...document.querySelectorAll('button,[role=button]')].find(e=>e.offsetParent&&/Test page/i.test(e.textContent)&&/aatrala/i.test(e.textContent));
      if(!b) return 'notfound'; b.click(); return 'opened';
    })()`);
    await sleep(1500);
    await shot('w7-3-account-menu.jpg');
    await ev('so:click', clickByText('/sign out|log out/i'));
    await sleep(4000);
    await ev('so:url', `(()=>location.href)()`);
    await ev('so:text', body());
    await shot('w7-4-signed-out.jpg');

    fs.writeFileSync(LOG, JSON.stringify(log, null, 2));
  } catch (e) {
    log.push({ step: 'FATAL', err: String(e).slice(0, 400) });
    fs.writeFileSync(LOG, JSON.stringify(log, null, 2));
    process.exit(1);
  }
})();
