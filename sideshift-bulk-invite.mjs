// SideShift bulk invite bot (Playwright)
//
// RUN
//   node sideshift-bulk-invite.mjs
//
// Opens a visible Chromium window. Log into SideShift, go to Discover >
// Creators, apply your filters and select the "Visibletrader Creator
// Campaign" job. Then start the bot with:
//   touch go
// It sends CHECKPOINT invites and pauses so you can check them in SideShift.
// To let it finish the rest:
//   touch continue
// To stop at any point: touch stop  (or Ctrl+C)
//
// Progress is saved to invited.json, so re-running resumes instead of
// re-inviting. This sends real messages using real invite credits.

import { chromium } from 'playwright';
import fs from 'node:fs';

const TARGET_INVITES = 193; // how many NEW invites to send this run
const CHECKPOINT = 0; // pause after this many sends until `continue` exists (0 = never pause)
const TEMPLATE_NAME = 'Invite with pay';
// Verify the personalized greeting and terms before every send. Normalize
// editor whitespace and curly apostrophes without accepting different terms.
const templateTextOk = (text, first) => {
  const normalized = text.replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();
  return normalized.startsWith(`Hi ${first}, I'm Tavasya from Visibletrader.`) &&
    normalized.includes('Our Terms:') &&
    normalized.includes('$2.50 CPM for 2 weeks') &&
    normalized.includes('$15 base per vid that exceeds 750 view count') &&
    normalized.includes('https://cal.com/tavasya-ganpati-oba84s/ugc-intro-call');
};
// Never invite creators whose first name is one of these (Vlad also covers
// Vladimir etc., Nate/Nathan also covers Nathaniel).
const EXCLUDED_FIRST_NAMES = /^(warren|ryker|vlad\w*|nate|nathan\w*)$/i;
const DELAY_MS = 0; // no pause between sends
const here = (f) => new URL(`./${f}`, import.meta.url);
const STATE_FILE = here('invited.json');
// Master do-not-contact list: every creator touched across the campaign's
// history (sent, contacted elsewhere, failed, excluded, etc). Always merged
// in on startup so the bot skips them even if invited.json was reset.
const DO_NOT_CONTACT_FILE = here('SideShift Outreach.csv');

// Names already invited manually, so the bot never re-sends to them.
const SEED_INVITED = [
  'Jake Smith',
  'Arish Adhikari',
  'Logan gilser',
  'michael ayala acosta',
  'Jack gu',
  'Ali Sekka',
  'Owen Giordano',
];

function loadDoNotContact() {
  if (!fs.existsSync(DO_NOT_CONTACT_FILE)) return [];
  const raw = fs.readFileSync(DO_NOT_CONTACT_FILE, 'utf8');
  if (DO_NOT_CONTACT_FILE.pathname.endsWith('.csv')) {
    // Single "Name" column, one name per line (SideShift Outreach sheet export).
    return raw.split(/\r?\n/).slice(1).map(l => l.trim()).filter(Boolean);
  }
  const data = JSON.parse(raw);
  // Flat array of names, e.g. ["Jake Smith", "Arish Adhikari", ...].
  if (Array.isArray(data)) return data.filter(Boolean);
  return (data.creators || []).map(c => c.name).filter(Boolean);
}

function loadInvited() {
  const base = fs.existsSync(STATE_FILE)
    ? new Set(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')))
    : new Set(SEED_INVITED);
  for (const name of loadDoNotContact()) base.add(name);
  return base;
}

function saveInvited(set) {
  fs.writeFileSync(STATE_FILE, JSON.stringify([...set], null, 2));
}

const flag = (f) => fs.existsSync(here(f));

// Every creator the bot touches, one row each: time, name, status.
// status: sent | unconfirmed (clicked Send, no confirmation seen) | failed
//         | skipped-already-messaged
const LOG_FILE = here('invites.csv');
function logInvite(name, status, note = '') {
  if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, 'time,name,status,note\n');
  const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
  fs.appendFileSync(LOG_FILE, [new Date().toISOString(), q(name), status, q(note)].join(',') + '\n');
}

async function waitForFlag(page, f, message) {
  console.log(message);
  while (!flag(f)) {
    if (flag('stop')) return false;
    await page.waitForTimeout(1000);
  }
  return true;
}

// Each creator card has a "View <name>" button and a bare "Invite" button;
// creators already messaged also show "Message <name>". Walk up from each
// Invite button to its card and read the name from the card's View button.
const INVITE = { name: 'Invite', exact: true };

// Cache normalized membership once, and update it whenever a name is added.
const norm = (n) => n.toLowerCase().replace(/\s+/g, ' ').trim();
const normalizedInvites = new WeakMap();
function invitedNorm(invited) {
  if (!normalizedInvites.has(invited)) {
    normalizedInvites.set(invited, new Set([...invited].map(norm)));
  }
  return normalizedInvites.get(invited);
}
function rememberInvited(invited, name) {
  const normalized = invitedNorm(invited);
  invited.add(name);
  normalized.add(norm(name));
}

async function findNextUninvited(page, invited) {
  const buttons = page.getByRole('button', INVITE);
  // One browser round trip for the whole grid, rather than two per card.
  // Return locator indexes so clicks still use Playwright's actionability checks.
  const cards = await buttons.evaluateAll(elements => elements.flatMap((el, index) => {
    const style = getComputedStyle(el);
    if (!el.getClientRects().length || style.visibility === 'hidden' || style.visibility === 'collapse') return [];
    let node = el.parentElement;
    while (node && node !== document.body) {
      const labels = [...node.querySelectorAll('button, [role="button"], a')]
        .map(b => (b.getAttribute('aria-label') || b.textContent || '').trim());
      const view = labels.find(l => l.startsWith('View '));
      if (view) {
        if (labels.filter(l => l === 'Invite').length !== 1) return [];
        const name = view.slice(5).trim();
        return name ? [{ index, name, messaged: labels.includes(`Message ${name}`) }] : [];
      }
      node = node.parentElement;
    }
    return [];
  }));
  const known = invitedNorm(invited);
  for (const info of cards) {
    // Processed cards need no further browser calls or repeated name-set builds.
    if (known.has(norm(info.name))) continue;
    if (info.messaged) {
      logInvite(info.name, 'skipped-already-messaged');
      rememberInvited(invited, info.name);
      continue;
    }
    if (EXCLUDED_FIRST_NAMES.test(info.name.split(/\s+/)[0])) {
      logInvite(info.name, 'skipped-excluded-name');
      console.log(`SKIPPED ${info.name} (excluded name)`);
      rememberInvited(invited, info.name);
      saveInvited(invited);
      continue;
    }
    return { button: buttons.nth(info.index), name: info.name };
  }
  return null;
}

// The dialog opens with SideShift's stock message, then swaps in a template
// once the template list loads. With multiple saved templates, we
// have to actively pick TEMPLATE_NAME from the picker before sending —
// SideShift's default selection is not guaranteed to be the right one.
async function selectTemplateFromPicker(page, dialog) {
  // Native <select>.
  const select = dialog.locator('select').first();
  if (await select.count()) {
    const opts = await select.locator('option').allTextContents();
    if (opts.some(o => o.trim() === TEMPLATE_NAME)) {
      await select.selectOption({ label: TEMPLATE_NAME });
      return true;
    }
  }
  // Combobox / dropdown button that opens a list of template options.
  const opener = dialog.getByRole('combobox').first().or(dialog.getByRole('button', { name: /template/i }).first());
  if (await opener.count() && await opener.isVisible().catch(() => false)) {
    await opener.click();
    const option = page.getByRole('option', { name: TEMPLATE_NAME, exact: true })
      .or(page.getByRole('menuitem', { name: TEMPLATE_NAME, exact: true }))
      .or(page.getByText(TEMPLATE_NAME, { exact: true }));
    if (await option.first().count()) {
      await option.first().click({ timeout: 5000 });
      return true;
    }
  }
  return false;
}

async function ensureTemplateSelected(page, name) {
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Invite Creator' }) }).first();
  await dialog.locator('[aria-label="Loading templates"]').waitFor({ state: 'hidden', timeout: 15000 });

  const body = dialog.locator('[contenteditable=true], textarea').first();
  const first = name.trim().split(/\s+/)[0];
  const readMessage = () => body.evaluate(el =>
    el.matches('textarea') ? el.value : el.innerText
  );

  // First check if the right template is already loaded.
  let text = (await readMessage().catch(() => '')).trim();
  if (templateTextOk(text, first)) return text;

  // Otherwise, explicitly pick TEMPLATE_NAME from the picker.
  await selectTemplateFromPicker(page, dialog);

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    text = (await readMessage().catch(() => '')).trim();
    if (templateTextOk(text, first)) return text;
    await page.waitForTimeout(250);
  }
  throw new Error(`"${TEMPLATE_NAME}" text never loaded: "${text.slice(0, 80)}"`);
}

async function handleNamePromptIfPresent(page) {
  const nameDialog = page.getByRole('heading', { name: 'Add your name' });
  if (await nameDialog.count() && await nameDialog.isVisible().catch(() => false)) {
    await page.getByPlaceholder('Your personal name').fill('Rex');
    await page.getByRole('button', { name: 'Save & continue' }).click();
    await page.waitForTimeout(1000);
  }
}

// Returns once no dialog (or its fading backdrop) is left covering the page,
// so the next Invite click lands on the card instead of the old overlay.
async function waitForNoDialog(page) {
  // Only count things actually on screen: SideShift can leave a closed,
  // invisible dialog in the page, which made this wait out its full timeout.
  await page.waitForFunction(() => {
    const shown = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05; };
    return ![...document.querySelectorAll('[role="dialog"]')].some(shown) &&
      ![...document.querySelectorAll('div.fixed.inset-0[aria-hidden="true"]')].some(e => e.className.includes('bg-black') && shown(e));
  }, null, { timeout: 10000, polling: 100 }).catch(() => {});
}

async function inviteCreator(page, inviteButton, name) {
  await waitForNoDialog(page);
  await inviteButton.click({ timeout: 8000 });

  const dialogHeading = page.getByRole('heading', { name: 'Invite Creator' });
  await dialogHeading.waitFor({ state: 'visible', timeout: 10000 });

  await ensureTemplateSelected(page, name);
  await page.getByRole('button', { name: 'Send message' }).click();

  // The first send of a session can trigger a one-time "Add your name"
  // dialog that swallows the send.
  await handleNamePromptIfPresent(page);

  // Success = "Invite Sent" toast or the dialog closing. The dialog fades
  // out, so give it time before deciding it didn't go.
  const toast = page.getByText('Invite Sent', { exact: false });
  const ok = await Promise.race([
    toast.first().waitFor({ state: 'visible', timeout: 15000 }).then(() => true, () => false),
    dialogHeading.waitFor({ state: 'hidden', timeout: 15000 }).then(() => true, () => false),
  ]);
  await dialogHeading.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  if (!ok && await dialogHeading.isVisible().catch(() => false)) {
    await page.keyboard.press('Escape');
    await dialogHeading.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
    return 'unconfirmed';
  }
  return 'sent';
}

// New creators only appear a few seconds after you scroll to the end of the
// grid, so scroll the last card into view, nudge past it, and keep checking
// for up to LOAD_WAIT_MS before calling it a miss.
const LOAD_WAIT_MS = 10000;
async function scrollToLoadMore(page) {
  const viewButtons = page.getByRole('button', { name: /^View / });
  const names = async () => new Set(await viewButtons.evaluateAll(els => els.map(e => (e.getAttribute('aria-label') || e.textContent || '').trim())));
  const before = await names();
  await viewButtons.last().scrollIntoViewIfNeeded().catch(() => {});
  await page.mouse.move(700, 500);
  await page.mouse.wheel(0, 3000);
  const deadline = Date.now() + LOAD_WAIT_MS;
  while (Date.now() < deadline) {
    await page.waitForTimeout(500);
    const after = await names();
    if ([...after].some(n => !before.has(n))) {
      await page.waitForTimeout(800); // let the new cards finish rendering
      return true;
    }
  }
  return false;
}

async function main() {
  for (const f of ['go', 'continue', 'stop']) fs.rmSync(here(f), { force: true });

  // Persistent profile so the SideShift login survives between runs.
  const browser = await chromium.launchPersistentContext(new URL('./browser-profile', import.meta.url).pathname, { headless: false, viewport: null });
  const page = browser.pages()[0] ?? await browser.newPage();
  await page.goto('https://app.sideshift.app/discover');

  // Wait for `go`. If the Invite buttons aren't labeled the way we expect,
  // print what is there and wait for another `go` (browser stays open).
  for (;;) {
    if (!(await waitForFlag(page, 'go', 'Waiting: log in, open Discover > Creators, set filters + job, then `touch go`.'))) {
      return browser.close();
    }
    fs.rmSync(here('go'), { force: true });
    if (await page.getByRole('button', INVITE).count() > 0) break;
    const names = await page.getByRole('button').evaluateAll(els => els.map(e => (e.getAttribute('aria-label') || e.innerText || '').trim().replace(/\s+/g, ' ')).filter(Boolean));
    console.log('NO_INVITE_BUTTONS. url=' + page.url() + '\nButtons on page:\n' + [...new Set(names)].slice(0, 80).join('\n'));
    const inviteish = await page.locator('text=/invite/i').evaluateAll(els => els.slice(0, 15).map(e => e.outerHTML.slice(0, 300)));
    console.log('Elements mentioning "invite":\n' + inviteish.join('\n') + '\nEND_DUMP');
  }

  const invited = loadInvited();
  let sentThisRun = 0;
  let noNewCreatorStreak = 0;
  let failStreak = 0;

  while (sentThisRun < TARGET_INVITES) {
    if (flag('stop')) { console.log('Stop requested.'); break; }

    const next = await findNextUninvited(page, invited);
    if (!next) {
      if (!(await scrollToLoadMore(page))) {
        if (++noNewCreatorStreak >= 3) { console.log('No new creators after several scrolls. Stopping.'); break; }
        console.log(`No new creators yet (${noNewCreatorStreak}/3), scrolling again...`);
      } else {
        noNewCreatorStreak = 0;
      }
      continue;
    }

    try {
      const status = await inviteCreator(page, next.button, next.name);
      rememberInvited(invited, next.name);
      saveInvited(invited);
      logInvite(next.name, status);
      if (status === 'sent') {
        sentThisRun++;
        failStreak = 0;
        console.log(`[${sentThisRun}/${TARGET_INVITES}] Invited ${next.name}`);
      } else {
        console.log(`UNCONFIRMED ${next.name} (clicked Send, no confirmation; check manually)`);
        if (++failStreak >= 3) { console.log('3 problems in a row. Stopping so you can check.'); break; }
      }
    } catch (err) {
      console.error(`FAILED ${next.name}: ${err.message.split('\n')[0]}`);
      rememberInvited(invited, next.name); // don't get stuck retrying a broken card forever
      saveInvited(invited);
      logInvite(next.name, 'failed', err.message.split('\n')[0]);
      await page.keyboard.press('Escape').catch(() => {});
      if (++failStreak >= 3) { console.log('3 failures in a row. Stopping so you can check.'); break; }
    }

    if (CHECKPOINT > 0 && sentThisRun === CHECKPOINT && !flag('continue')) {
      if (!(await waitForFlag(page, 'continue', `CHECKPOINT: sent ${CHECKPOINT}. Check them in SideShift, then \`touch continue\` (or \`touch stop\`).`))) break;
    }

    await page.waitForTimeout(DELAY_MS);
  }

  console.log(`\nDone. Sent ${sentThisRun} invites this run. Total invited (all-time): ${invited.size}.`);
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
