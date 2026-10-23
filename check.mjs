// Checks OBRPC new-member orientation slots and sends a notification when one opens up.
// The Wix page at obrpc.org/select-membership-meeting just iframes this Salesforce page.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const SLOTS_URL = 'https://obrpc-membership-dev-ed.my.site.com/orientation/s/';
const SIGNUP_URL = 'https://www.obrpc.org/select-membership-meeting';
const STATE_FILE = new URL('./state.json', import.meta.url);
const NTFY_TOPIC = process.env.NTFY_TOPIC; // optional: also push to phone via https://ntfy.sh/<topic>
const FAIL_ALERT_AFTER = 3; // consecutive failed checks before alerting that the bot may be blocked/broken
const IS_MAC = process.platform === 'darwin';
const DATE_RE = /^[A-Z][a-z]+ \d{1,2}(st|nd|rd|th), \d{4}/;

const log = (...a) => console.log(new Date().toISOString(), ...a);

async function fetchSlots() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(SLOTS_URL, { waitUntil: 'load', timeout: 60000 });
    await page.getByText(DATE_RE).first().waitFor({ timeout: 45000 });
    await page.waitForTimeout(2000);
    const lines = (await page.evaluate(() => document.body.innerText))
      .split('\n').map(l => l.trim()).filter(Boolean);
    const slots = [];
    lines.forEach((line, i) => {
      if (DATE_RE.test(line)) slots.push({ date: line, status: lines[i + 1] ?? '' });
    });
    return slots;
  } finally {
    await browser.close();
  }
}

async function notify(title, message, priority = 'urgent') {
  if (IS_MAC) {
    const esc = s => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    try {
      execFileSync('osascript', ['-e',
        `display notification "${esc(message)}" with title "${esc(title)}" sound name "Glass"`]);
    } catch (e) { log('macOS notification failed:', e.message); }
  }
  if (NTFY_TOPIC) {
    try {
      const res = await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
        method: 'POST', body: message,
        headers: { Title: title, Priority: priority, Click: SIGNUP_URL, Tags: 'rotating_light' },
      });
      if (!res.ok) log('ntfy failed: HTTP', res.status);
    } catch (e) { log('ntfy failed:', e.message); }
  }
}

function loadState() {
  try { return { statuses: {}, failures: 0, ...JSON.parse(readFileSync(STATE_FILE, 'utf8')) }; }
  catch { return { statuses: {}, failures: 0 }; }
}

const saveState = state => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

async function main() {
  const state = loadState();
  let slots;
  try {
    slots = await fetchSlots();
  } catch (e) {
    state.failures += 1;
    log(`Check failed (${state.failures} in a row):`, e.message);
    if (state.failures === FAIL_ALERT_AFTER) {
      await notify('OBRPC bot failing', `Last ${FAIL_ALERT_AFTER} checks failed (${e.message.slice(0, 120)}). The site may be blocking the bot or has changed.`);
    }
    saveState(state);
    process.exitCode = 1;
    return;
  }
  log('Slots:', slots.map(s => `${s.date} [${s.status}]`).join(' | ') || '(none found)');

  if (slots.length === 0) {
    if (!state.warnedEmpty) await notify('OBRPC bot', 'No meeting dates found on the page — check the site or the bot.');
    saveState({ ...state, failures: 0, warnedEmpty: true });
    return;
  }

  // Old state format only listed dates already alerted on; treat their current status as already seen.
  if (state.open) for (const { date, status } of slots) if (state.open.includes(date)) state.statuses[date] = status;

  // Alert whenever a date's status changes to anything other than "Filled" (e.g. someone drops out,
  // or an "opening soon" date actually opens), so Filled -> open -> Filled -> open alerts each time.
  const changed = slots.filter(s => !/filled/i.test(s.status) && state.statuses[s.date] !== s.status);
  const isSoon = s => /soon/i.test(s.status);
  const opened = changed.filter(s => !isSoon(s));
  const announced = changed.filter(isSoon);
  const describe = list => list.map(s => `${s.date}: ${s.status}`).join('\n');

  if (opened.length) {
    log('OPEN SLOT(S):', describe(opened));
    await notify('OBRPC slot open!', `${describe(opened)}\nRegister at ${SIGNUP_URL}`);
    if (IS_MAC) execFileSync('open', [SIGNUP_URL]);
  }
  if (announced.length) {
    log('NEW DATE(S) ANNOUNCED:', describe(announced));
    await notify('OBRPC new date announced', `${describe(announced)}\nYou'll get another alert when it opens.`, 'default');
  }
  const statuses = Object.fromEntries(slots.map(s => [s.date, s.status]));
  saveState({ statuses, failures: 0, warnedEmpty: false, lastCheck: new Date().toISOString() });
}

main();
