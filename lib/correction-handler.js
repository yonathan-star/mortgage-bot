require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { queryDatabase, updatePage } = require('./notion-client');
const { sendToBothInboxes } = require('./send-email');

const CONDITIONS_DB    = process.env.NOTION_CONDITIONS_DB_ID;
const CORRECTIONS_FILE = process.env.VERCEL
  ? '/tmp/corrections.json'
  : path.join(__dirname, '..', 'corrections.json');

function log(action, detail) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), handler: 'correction', action, ...detail }));
}

function loadCorrections() {
  try {
    if (fs.existsSync(CORRECTIONS_FILE)) return JSON.parse(fs.readFileSync(CORRECTIONS_FILE, 'utf8'));
  } catch {}
  return [];
}

function saveCorrection(entry) {
  const corrections = loadCorrections();
  corrections.push({ ...entry, ts: new Date().toISOString() });
  fs.writeFileSync(CORRECTIONS_FILE, JSON.stringify(corrections, null, 2));
}

// Parse correction instructions from email body
// Expected format:
//   LOAN: <borrower name or loan id>
//   CONDITION: <exact or partial condition text>
//   ACTION: update_status | update_text | delete
//   NEW_STATUS: Open | In Progress | Cleared   (for update_status)
//   NEW_TEXT: <replacement text>               (for update_text)
function parseInstructions(body) {
  const get = (key) => {
    const m = body.match(new RegExp(`^${key}:\\s*(.+)$`, 'im'));
    return m ? m[1].trim() : null;
  };
  return {
    loan:       get('LOAN'),
    condition:  get('CONDITION'),
    action:     (get('ACTION') ?? 'update_status').toLowerCase(),
    newStatus:  get('NEW_STATUS'),
    newText:    get('NEW_TEXT'),
  };
}

async function findConditionByText(loanPageId, conditionText) {
  const filter = loanPageId
    ? { and: [
        { property: 'Loan',      relation: { contains: loanPageId } },
        { property: 'Condition', title:    { contains: conditionText } }
      ]}
    : { property: 'Condition', title: { contains: conditionText } };

  const r = await queryDatabase(CONDITIONS_DB, filter);
  return r.results;
}

async function findLoanPageId(loanRef) {
  if (!loanRef) return null;
  const { queryDatabase: q } = require('./notion-client');
  const LOANS_DB = process.env.NOTION_LOANS_DB_ID;

  // Try loan ID first
  let r = await q(LOANS_DB, { property: 'Loan ID', rich_text: { equals: loanRef } });
  if (r.results.length) return r.results[0].id;

  // Try borrower name
  r = await q(LOANS_DB, { property: 'Borrower Name', title: { contains: loanRef } });
  if (r.results.length) return r.results[0].id;

  return null;
}

async function sendConfirmationEmail(summary) {
  await sendToBothInboxes('[Mortgage Bot] Correction Applied', `A correction has been applied to Notion.\n\n${summary}`);
}

async function handle({ subject, from, body }) {
  log('start', { subject, from });

  const instructions = parseInstructions(body);
  log('parsed', { instructions });

  if (!instructions.condition) {
    log('skip', { reason: 'no CONDITION field found in email body' });
    return;
  }

  const loanPageId   = await findLoanPageId(instructions.loan);
  const conditions   = await findConditionByText(loanPageId, instructions.condition);

  if (!conditions.length) {
    log('not-found', { condition: instructions.condition, loan: instructions.loan });
    await sendConfirmationEmail(
      `Could not find condition matching: "${instructions.condition}"\nLoan: ${instructions.loan ?? 'any'}\n\nNo changes were made.`
    );
    return;
  }

  const summaryLines = [];

  for (const cond of conditions) {
    const condId    = cond.id;
    const origText  = cond.properties?.['Condition']?.title?.[0]?.plain_text ?? '';
    const origStatus = cond.properties?.['Status']?.select?.name ?? '';

    if (instructions.action === 'update_status' && instructions.newStatus) {
      await updatePage(condId, { 'Status': { select: { name: instructions.newStatus } } });
      summaryLines.push(`✓ Updated status: "${origText}" → ${instructions.newStatus}`);
      saveCorrection({ type: 'update_status', original: origText, corrected: { status: instructions.newStatus }, loan: instructions.loan });

    } else if (instructions.action === 'update_text' && instructions.newText) {
      await updatePage(condId, { 'Condition': { title: [{ text: { content: instructions.newText } }] } });
      summaryLines.push(`✓ Updated text: "${origText}" → "${instructions.newText}"`);
      saveCorrection({ type: 'update_text', original: origText, corrected: { text: instructions.newText }, loan: instructions.loan });

    } else if (instructions.action === 'delete') {
      await updatePage(condId, { 'Status': { select: { name: 'Cleared' } } });
      summaryLines.push(`✓ Marked cleared: "${origText}"`);
      saveCorrection({ type: 'delete', original: origText, corrected: { status: 'Cleared' }, loan: instructions.loan });

    } else {
      summaryLines.push(`⚠️ Unknown action "${instructions.action}" — no change made to "${origText}"`);
    }
  }

  log('done', { updated: summaryLines.length });
  await sendConfirmationEmail(summaryLines.join('\n'));
}

module.exports = { process: handle };
