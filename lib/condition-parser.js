require('dotenv').config();
const { PDFParse } = require('pdf-parse');
const Anthropic = require('@anthropic-ai/sdk');
const { queryDatabase, createPage, updatePage } = require('./notion-client');
const { sendToBothInboxes } = require('./send-email');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const LOANS_DB      = process.env.NOTION_LOANS_DB_ID;
const CONDITIONS_DB = process.env.NOTION_CONDITIONS_DB_ID;

function log(action, detail) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), handler: 'condition-parser', action, ...detail }));
}

async function extractPdfText(pdfBuffer) {
  const parser = new PDFParse({ data: pdfBuffer });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
}

function loadCorrections() {
  try {
    const fs   = require('fs');
    const path = require('path');
    const p = process.env.VERCEL
      ? '/tmp/corrections.json'
      : path.join(__dirname, '..', 'corrections.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {}
  return [];
}

function extractFromSubject(subject) {
  const m = subject.match(/^(\d{6,})\s*[-–]\s*(.+)$/);
  if (m) return { loan_number: m[1], borrower_name: m[2].trim() };
  return {};
}

function formatConditionTitle({ code, category, text }) {
  const desc = (category && !text.startsWith(category))
    ? `${category}: ${text}`
    : text;
  return code ? `${code} | ${desc}` : desc;
}

function isSectionHeader(line) {
  if (/^\d{4}\s/.test(line)) return false;
  if (line.length > 100) return false;
  if (/^(provide|if |upon|are |the |and |to |for |negligent)/i.test(line)) return false;
  return /^(master|uw prior|underwriter|closing|expiration)/i.test(line)
    || (line.length < 65 && !/[:.]\s*$/.test(line) && /^[A-Z]/.test(line));
}

// Structured parser for UWM conditional approval PDFs
function parseUwmApprovalLetter(text) {
  if (!/LOAN APPROVAL CONDITIONS/i.test(text)) return null;

  const borrowerMatch = text.match(/Borrower\s+(.+)/i);
  const headerMatch   = text.match(/LOAN APPROVAL CONDITIONS\s*-\s*\S+\s*-\s*(\d+)/i);

  const start = text.indexOf('CONDITIONS');
  if (start === -1) return null;

  let section = text.slice(start);
  for (const marker of ['EXPIRATION DATES', 'Mortgagee Clause']) {
    const idx = section.indexOf(marker);
    if (idx !== -1) section = section.slice(0, idx);
  }

  const lines = section.split('\n').map(l => l.trim()).filter(Boolean);
  const conditions = [];
  let currentSection = '';
  let current = null;

  for (const line of lines.slice(1)) {
    const codeMatch = line.match(/^(\d{4})\s+(\S+)\s+(.+)$/);
    if (codeMatch) {
      if (current) conditions.push(current);
      current = {
        code:     codeMatch[1],
        category: codeMatch[2],
        section:  currentSection,
        text:     codeMatch[3].trim()
      };
      continue;
    }

    if (isSectionHeader(line)) {
      if (current) { conditions.push(current); current = null; }
      currentSection = line;
      continue;
    }

    if (current) current.text += ' ' + line;
  }
  if (current) conditions.push(current);

  if (!conditions.length) return null;

  return {
    borrower_name: borrowerMatch?.[1]?.trim() ?? null,
    loan_number:   headerMatch?.[1] ?? null,
    conditions: conditions.map(c => ({
      code:         c.code,
      category:     c.category,
      section:      c.section,
      text:         formatConditionTitle(c),
      needs_review: false
    }))
  };
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
- Include condition code if present (e.g. UWM codes like 3308, 1085)
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
    { "code": "string or null", "category": "string or null", "text": "condition text", "needs_review": false }
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

function normalizeText(text) {
  return text.toLowerCase().replace(/\s+/g, ' ').replace(/[^\w\s]/g, '').trim();
}

function extractCode(title) {
  const m = title.match(/^(\d{4})\b|\[(\d{4})\]|^(\d{4})\s*\|/);
  return m ? (m[1] || m[2] || m[3]) : null;
}

function conditionsMatch(pdfCond, notionTitle) {
  const notionCode = extractCode(notionTitle);
  if (pdfCond.code && notionCode && pdfCond.code === notionCode) return true;

  const normPdf    = normalizeText(pdfCond.text);
  const normNotion = normalizeText(notionTitle);
  if (!normPdf || !normNotion) return false;

  const snippet = normPdf.slice(0, 50);
  if (snippet.length >= 20 && (normNotion.includes(snippet) || normPdf.includes(normNotion.slice(0, 50)))) {
    return true;
  }

  // Match informal titles like "ACE PDR" against PDF text or category labels
  if (normNotion.length <= 30 && normPdf.includes(normNotion)) return true;

  return false;
}

async function findLoanByBorrowerOrNumber(borrowerName, loanNumber) {
  if (loanNumber) {
    const r = await queryDatabase(LOANS_DB, {
      property: 'Loan ID', rich_text: { equals: loanNumber }
    });
    if (r.results.length) return r.results[0];
  }
  if (borrowerName) {
    const full = await queryDatabase(LOANS_DB, {
      property: 'Borrower Name', title: { contains: borrowerName }
    });
    if (full.results.length) return full.results[0];

    const parts = borrowerName.trim().split(/\s+/);
    if (parts.length >= 2) {
      const byLast = await queryDatabase(LOANS_DB, {
        property: 'Borrower Name', title: { contains: parts[parts.length - 1] }
      });
      if (byLast.results.length === 1) return byLast.results[0];
    }
    const byFirst = await queryDatabase(LOANS_DB, {
      property: 'Borrower Name', title: { contains: parts[0] }
    });
    if (byFirst.results.length === 1) return byFirst.results[0];
  }
  return null;
}

async function getOpenConditionsForLoan(loanPageId) {
  const r = await queryDatabase(CONDITIONS_DB, {
    and: [
      { property: 'Loan', relation: { contains: loanPageId } },
      { or: [
        { property: 'Status', select: { equals: 'Open' } },
        { property: 'Status', select: { equals: 'In Progress' } }
      ]}
    ]
  });
  return r.results;
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

async function clearCondition(pageId, title) {
  await updatePage(pageId, { 'Status': { select: { name: 'Cleared' } } });
  log('cleared', { condition: title.slice(0, 80) });
}

async function syncConditionsToNotion(loanPageId, pdfConditions) {
  const existing = await getOpenConditionsForLoan(loanPageId);
  const matchedNotionIds = new Set();

  let added = 0;
  let cleared = 0;
  let unchanged = 0;
  const addedList   = [];
  const clearedList = [];

  for (const pdfCond of pdfConditions) {
    const match = existing.find(n => {
      const title = n.properties?.['Condition']?.title?.[0]?.plain_text ?? '';
      return conditionsMatch(pdfCond, title);
    });

    if (match) {
      matchedNotionIds.add(match.id);
      unchanged++;
    } else {
      const wasAdded = await addConditionToNotion(loanPageId, pdfCond.text, pdfCond.needs_review ?? false);
      if (wasAdded) {
        added++;
        addedList.push(pdfCond.text);
      }
    }
  }

  for (const notionCond of existing) {
    if (matchedNotionIds.has(notionCond.id)) continue;
    const title = notionCond.properties?.['Condition']?.title?.[0]?.plain_text ?? '';
    await clearCondition(notionCond.id, title);
    cleared++;
    clearedList.push(title);
  }

  return { added, cleared, unchanged, total: pdfConditions.length, addedList, clearedList };
}

async function sendSummaryEmail(subject, bodyText) {
  await sendToBothInboxes(subject, bodyText);
}

function buildSyncEmailBody(loanName, result, source) {
  const lines = [
    `Loan: ${loanName}`,
    `Source: ${source}`,
    `Outstanding on PDF: ${result.total}`,
    `Added: ${result.added} | Cleared: ${result.cleared} | Unchanged: ${result.unchanged}`,
    ''
  ];

  if (result.clearedList.length) {
    lines.push('Cleared (no longer on approval letter):');
    result.clearedList.forEach((c, i) => lines.push(`  ${i + 1}. ${c}`));
    lines.push('');
  }

  if (result.addedList.length) {
    lines.push('Added (new on approval letter):');
    result.addedList.forEach((c, i) => lines.push(`  ${i + 1}. ${c}`));
    lines.push('');
  }

  return lines.join('\n');
}

async function handle({ subject, from, body, pdfBuffer, msgId }) {
  log('start', { subject, msgId, hasPdf: !!pdfBuffer });

  let text = body;
  if (pdfBuffer) {
    try {
      text = await extractPdfText(pdfBuffer);
      log('pdf-extracted', { chars: text.length });
    } catch (err) {
      log('pdf-error', { error: err.message });
    }
  }

  if (!text || text.trim().length < 20) {
    log('skip', { reason: 'insufficient text' });
    return;
  }

  const subjectHints = extractFromSubject(subject);
  let parsed = parseUwmApprovalLetter(text);

  if (parsed) {
    log('uwm-parsed', { borrower: parsed.borrower_name, loan: parsed.loan_number, count: parsed.conditions.length });
  } else {
    try {
      parsed = await extractWithClaude(text);
      log('claude-parsed', { borrower: parsed.borrower_name, loan: parsed.loan_number, count: parsed.conditions?.length });
    } catch (err) {
      log('claude-error', { error: err.message });
      return;
    }
  }

  const borrowerName = parsed.borrower_name ?? subjectHints.borrower_name;
  const loanNumber   = parsed.loan_number   ?? subjectHints.loan_number;
  const conditions   = (parsed.conditions ?? []).map(c => ({
    code:         c.code ?? null,
    category:     c.category ?? null,
    text:         c.text,
    needs_review: c.needs_review ?? false
  }));

  if (!conditions.length) {
    log('skip', { reason: 'no conditions found' });
    return;
  }

  const loan = await findLoanByBorrowerOrNumber(borrowerName, loanNumber);

  if (!loan) {
    log('loan-not-found', { borrower: borrowerName, loan: loanNumber });
    await sendSummaryEmail(
      `[Mortgage Bot] Loan not found — update Arive status`,
      `Conditions were parsed but no matching loan found in Notion.\n\nBorrower: ${borrowerName ?? 'unknown'}\nLoan #: ${loanNumber ?? 'unknown'}\nFrom: ${from}\nSubject: ${subject}\n\nPlease update this loan to Processing status in Arive.`
    );
    return;
  }

  const loanName = loan.properties?.['Borrower Name']?.title?.[0]?.plain_text ?? borrowerName;

  if (pdfBuffer) {
    const result = await syncConditionsToNotion(loan.id, conditions);
    log('sync-done', { loan: loanName, ...result });

    await sendSummaryEmail(
      `[Mortgage Bot] Conditions synced — ${loanName}`,
      buildSyncEmailBody(loanName, result, 'PDF (conditional approval)')
    );
    return;
  }

  // Email body only — add new conditions without clearing existing ones
  let added = 0;
  for (const cond of conditions) {
    const wasAdded = await addConditionToNotion(loan.id, cond.text, cond.needs_review);
    if (wasAdded) added++;
  }

  log('done', { loan: loanName, added, total: conditions.length });

  await sendSummaryEmail(
    `[Mortgage Bot] ${added} condition(s) added — ${loanName}`,
    `Loan: ${loanName}\nConditions added: ${added} of ${conditions.length}\nSource: Email body\n\n` +
    conditions.map((c, i) => `${i + 1}. ${c.text}${c.needs_review ? ' ⚠️ needs review' : ''}`).join('\n')
  );
}

module.exports = { process: handle, parseUwmApprovalLetter };
