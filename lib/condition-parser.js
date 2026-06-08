require('dotenv').config();
const pdfParse  = require('pdf-parse');
const Anthropic = require('@anthropic-ai/sdk');
const { queryDatabase, createPage } = require('./notion-client');
const { getClients } = require('./gmail-client');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const LOANS_DB      = process.env.NOTION_LOANS_DB_ID;
const CONDITIONS_DB = process.env.NOTION_CONDITIONS_DB_ID;

function log(action, detail) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), handler: 'condition-parser', action, ...detail }));
}

function loadCorrections() {
  try {
    const fs   = require('fs');
    const path = require('path');
    const p    = path.join(__dirname, '..', 'corrections.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {}
  return [];
}

function buildPrompt(text) {
  const corrections = loadCorrections();
  let fewShot = '';
  if (corrections.length > 0) {
    const examples = corrections.slice(-3).map(c =>
      `Example correction:\nOriginal: ${c.original}\nCorrected: ${JSON.stringify(c.corrected)}`
    ).join('\n\n');
    fewShot = `\n\nLearn from these past corrections:\n${examples}\n`;
  }

  return `You are a mortgage processor assistant. Extract loan conditions from the text below.${fewShot}

Rules:
- Return ONLY a valid JSON object, no markdown, no explanation
- Each condition must be a clear, actionable item
- Ignore boilerplate: headers, footers, greetings, legal disclaimers, contact info
- If an item is ambiguous or unclear, include it with needs_review: true
- Try to identify the borrower name and loan number from context

Text to parse:
${text.slice(0, 12000)}

Return this exact JSON shape:
{
  "borrower_name": "string or null",
  "loan_number": "string or null",
  "conditions": [
    { "text": "condition text", "needs_review": false }
  ]
}`;
}

async function extractWithClaude(text) {
  const message = await anthropic.messages.create({
    model:      'claude-sonnet-4-5',
    max_tokens: 2048,
    messages:   [{ role: 'user', content: buildPrompt(text) }]
  });
  const raw = message.content[0].text.trim();
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Claude returned non-JSON: ' + raw.slice(0, 200));
  }
}

async function findLoanByBorrowerOrNumber(borrowerName, loanNumber) {
  if (loanNumber) {
    const r = await queryDatabase(LOANS_DB, {
      property: 'Loan ID', rich_text: { equals: loanNumber }
    });
    if (r.results.length) return r.results[0];
  }
  if (borrowerName) {
    const r = await queryDatabase(LOANS_DB, {
      property: 'Borrower Name', title: { contains: borrowerName.split(' ')[0] }
    });
    if (r.results.length) return r.results[0];
  }
  return null;
}

async function conditionExists(loanPageId, conditionText) {
  const r = await queryDatabase(CONDITIONS_DB, {
    and: [
      { property: 'Loan',      relation: { contains: loanPageId } },
      { property: 'Condition', title:    { equals: conditionText } }
    ]
  });
  return r.results.length > 0;
}

async function addConditionToNotion(loanPageId, conditionText, needsReview) {
  if (await conditionExists(loanPageId, conditionText)) {
    log('skipped-duplicate', { conditionText: conditionText.slice(0, 60) });
    return false;
  }
  await createPage(CONDITIONS_DB, {
    'Condition':  { title:    [{ text: { content: conditionText } }] },
    'Status':     { select:   { name: needsReview ? 'In Progress' : 'Open' } },
    'Loan':       { relation: [{ id: loanPageId }] },
    'Source':     { select:   { name: 'Underwriter' } },
    'Date Added': { date:     { start: new Date().toISOString().split('T')[0] } }
  });
  return true;
}

async function sendSummaryEmail(subject, bodyText) {
  const clients = getClients();
  for (const account of Object.values(clients)) {
    try {
      const raw = Buffer.from(
        `To: ${account.email}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${bodyText}`
      ).toString('base64url');
      await account.gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
    } catch (err) {
      log('email-send-error', { inbox: account.label, error: err.message });
    }
  }
}

async function handle({ subject, from, body, pdfBuffer, msgId }) {
  log('start', { subject, msgId, hasPdf: !!pdfBuffer });

  let text = body;
  if (pdfBuffer) {
    try {
      const parsed = await pdfParse(pdfBuffer);
      text = parsed.text;
      log('pdf-extracted', { chars: text.length });
    } catch (err) {
      log('pdf-error', { error: err.message });
    }
  }

  if (!text || text.trim().length < 20) {
    log('skip', { reason: 'insufficient text' });
    return;
  }

  let parsed;
  try {
    parsed = await extractWithClaude(text);
    log('claude-parsed', { borrower: parsed.borrower_name, loan: parsed.loan_number, count: parsed.conditions?.length });
  } catch (err) {
    log('claude-error', { error: err.message });
    return;
  }

  const conditions = parsed.conditions ?? [];
  if (!conditions.length) {
    log('skip', { reason: 'no conditions found' });
    return;
  }

  const loan = await findLoanByBorrowerOrNumber(parsed.borrower_name, parsed.loan_number);

  if (!loan) {
    log('loan-not-found', { borrower: parsed.borrower_name, loan: parsed.loan_number });
    await sendSummaryEmail(
      `[Mortgage Bot] Loan not found — update Arive status`,
      `Conditions were parsed but no matching loan found in Notion.\n\nBorrower: ${parsed.borrower_name ?? 'unknown'}\nLoan #: ${parsed.loan_number ?? 'unknown'}\nFrom: ${from}\nSubject: ${subject}\n\nPlease update this loan to Processing status in Arive.`
    );
    return;
  }

  const loanName = loan.properties?.['Borrower Name']?.title?.[0]?.plain_text ?? parsed.borrower_name;
  let added = 0;
  for (const cond of conditions) {
    const wasAdded = await addConditionToNotion(loan.id, cond.text, cond.needs_review ?? false);
    if (wasAdded) added++;
  }

  log('done', { loan: loanName, added, total: conditions.length });

  await sendSummaryEmail(
    `[Mortgage Bot] ${added} condition(s) added — ${loanName}`,
    `Loan: ${loanName}\nConditions added: ${added} of ${conditions.length}\nSource: ${pdfBuffer ? 'PDF' : 'Email body'}\n\n` +
    conditions.map((c, i) => `${i + 1}. ${c.text}${c.needs_review ? ' ⚠️ needs review' : ''}`).join('\n')
  );
}

module.exports = { process: handle };
