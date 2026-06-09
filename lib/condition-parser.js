require('dotenv').config();
const pdfParse = require('pdf-parse');
const Anthropic = require('@anthropic-ai/sdk');
const { queryDatabase, createPage, updatePage } = require('./notion-client');
const { sendSyncNotification } = require('./send-email');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const LOANS_DB      = process.env.NOTION_LOANS_DB_ID;
const CONDITIONS_DB = process.env.NOTION_CONDITIONS_DB_ID;

function log(action, detail) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), handler: 'condition-parser', action, ...detail }));
}

async function extractPdfText(pdfBuffer) {
  const result = await pdfParse(pdfBuffer);
  return result.text;
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

const PTF_SECTION_RE = /prior\s+to\s+funding(\s+conditions)?|\(ptf\)|\bptf\b/i;

// AmWest PRIOR TO FUNDING CONDITIONS page — known PTF-only condition codes
const AMWEST_PTF_CODES = new Set(['99', '71', '74', '1202', '1387']);

function isPtfSection(section) {
  return !!(section && PTF_SECTION_RE.test(section));
}

function stripPtfBlockFromText(text) {
  const normalized = normalizePdfText(text);
  const startMatch = normalized.match(/prior\s+to\s+funding\s+conditions/i);
  if (!startMatch) return normalized;

  const startIdx = startMatch.index;
  const afterStart = startIdx + startMatch[0].length;
  const rest = normalized.slice(afterStart);
  const endMatch = rest.match(
    /(?:post\s+funding\s+conditions|prior\s+to\s+disbursement\s+conditions|prior\s+to\s+documentation)/i
  );
  const endIdx = endMatch ? afterStart + endMatch.index : normalized.length;
  log('ptf-block-stripped', { chars: endIdx - startIdx });
  return normalized.slice(0, startIdx) + normalized.slice(endIdx);
}

function isPtfCondition(cond) {
  const section  = cond.section  || '';
  const category = cond.category || '';
  const text     = cond.text     || '';
  const code     = cond.code ? String(cond.code) : '';

  if (code && AMWEST_PTF_CODES.has(code)) return true;
  if (isPtfSection(section)) return true;
  if (/\b(ptf|prior to funding)\b/i.test(category)) return true;
  if (/\b(ptf|prior to funding)\b/i.test(text)) return true;

  const PTF_TEXT_PATTERNS = [
    /^final urla\b/i,
    /^final cd\b/i,
    /^send original note/i,
    /\bcpl and wire instructions\b/i,
    /settlement agent to provide fee sheet/i,
    /^borrowers own funds/i,
    /\*{2,}\s*fyi\s*\*{2,}/i,
    /^fyi\s*[-–]/i,
    /lock exp.*rescission exp/i
  ];
  return PTF_TEXT_PATTERNS.some(re => re.test(text));
}

function excludePtfConditions(conditions) {
  const kept = conditions.filter(c => !isPtfCondition(c));
  const excluded = conditions.length - kept.length;
  if (excluded > 0) log('ptf-excluded', { count: excluded });
  return kept;
}

const CONDITION_CATEGORIES = [
  'Property (FL)', 'Property', 'Closing Disclosure', 'Appraisal',
  'Income', 'Invoice', 'CREDIT', 'Credit', 'Title', 'TC'
];

function normalizePdfText(text) {
  return text.replace(/\u00ad/g, '').replace(/­/g, '').replace(/\u00a0/g, ' ');
}

function findConditionsSection(text) {
  const normalized = normalizePdfText(text);
  const match = normalized.match(/(?:locked\.\s*|Note rate is subject[^\n]*\n)\s*CONDITIONS\s*\n/i);
  if (match) {
    const idx = normalized.indexOf(match[0]);
    return normalized.slice(idx + match[0].length);
  }
  const needle = '\nCONDITIONS\n';
  const idx = normalized.lastIndexOf(needle);
  if (idx !== -1) return normalized.slice(idx + needle.length);
  return null;
}

function parseConditionLine(line) {
  const clean = line.replace(/\u00a0/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
  const spaced = clean.match(/^(\d{4})\s+(\S+)\s+(.+)$/);
  if (spaced) {
    return { code: spaced[1], category: spaced[2], text: spaced[3].trim() };
  }
  const jammed = clean.match(/^(\d{4})(.+)$/);
  if (!jammed) return null;
  const rest = jammed[2];
  for (const cat of CONDITION_CATEGORIES) {
    if (rest.startsWith(cat)) {
      return { code: jammed[1], category: cat, text: rest.slice(cat.length).trim() };
    }
  }
  return null;
}

function isSectionHeader(line) {
  if (/^\d{4}/.test(line)) return false;
  if (line.length > 100) return false;
  if (/^(provide|if |upon|are |the |and |to |for |negligent)/i.test(line)) return false;
  return /^(master|uw[\s\-]*prior|underwriter|closing\b|prior\s+to\s+funding|broker\/lo|closing agent|note to all)/i.test(line)
    || (line.length < 70 && /^[A-Z]/.test(line) && !/Provide|TC:/.test(line));
}

// Structured parser for UWM conditional approval PDFs
function parseUwmApprovalLetter(text) {
  const normalized = normalizePdfText(text);
  if (!/LOAN APPROVAL CONDITIONS/i.test(normalized)) return null;

  const borrowerMatch = normalized.match(/Borrower\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
  const headerMatch   = normalized.match(/LOAN APPROVAL CONDITIONS\s*-\s*\S+\s*-\s*(\d+)/i);

  const sectionBody = findConditionsSection(normalized);
  if (!sectionBody) return null;

  let section = sectionBody;
  for (const marker of ['EXPIRATION DATES', 'Mortgagee Clause']) {
    const idx = section.indexOf(marker);
    if (idx !== -1) section = section.slice(0, idx);
  }

  const lines = section.split('\n').map(l => l.trim()).filter(Boolean);
  const conditions = [];
  let currentSection = '';
  let current = null;

  for (const line of lines) {
    const parsed = parseConditionLine(line);
    if (parsed) {
      if (current) conditions.push(current);
      current = { ...parsed, section: currentSection };
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

  const nonPtf = conditions.filter(c => !isPtfCondition({ section: c.section, category: c.category, text: c.text }));
  if (!nonPtf.length) return null;

  return {
    borrower_name: borrowerMatch?.[1]?.trim() ?? null,
    loan_number:   headerMatch?.[1] ?? null,
    conditions: nonPtf.map(c => ({
      code:         c.code,
      category:     c.category,
      section:      c.section,
      text:         formatConditionTitle(c),
      needs_review: false
    }))
  };
}

function buildPrompt(text) {
  return `You are a mortgage processor assistant. Extract loan conditions from the text below.

Rules:
- Return ONLY a valid JSON object, no markdown, no explanation
- Each condition must be a clear, actionable item
- Include condition code if present (e.g. UWM codes like 3308, 1085)
- Include section name when visible (e.g. "UW Prior To Final Approval (PTD)", "Closing (PTF)")
- NEVER include Prior to Funding (PTF) or Closing (PTF) conditions — skip that entire section
- Only include Prior to Docs/Documentation (PTD) and underwriting conditions, not funding/closing table items
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
    { "code": "string or null", "category": "string or null", "section": "string or null", "text": "condition text", "needs_review": false }
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

async function addConditionToNotion(loanPageId, conditionText, needsReview, { skipDuplicateCheck = false } = {}) {
  if (!skipDuplicateCheck && await conditionExists(loanPageId, conditionText)) {
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
      const wasAdded = await addConditionToNotion(
        loanPageId, pdfCond.text, pdfCond.needs_review ?? false, { skipDuplicateCheck: true }
      );
      if (wasAdded) {
        added++;
        addedList.push(pdfCond.text);
      }
    }
  }

  const toClear = existing.filter(n => !matchedNotionIds.has(n.id));
  await Promise.all(toClear.map(async (notionCond) => {
    const title = notionCond.properties?.['Condition']?.title?.[0]?.plain_text ?? '';
    await clearCondition(notionCond.id, title);
    clearedList.push(title);
  }));
  cleared = toClear.length;

  return { added, cleared, unchanged, total: pdfConditions.length, addedList, clearedList };
}

async function handle({ subject, from, body, pdfBuffer, msgId, gmail, threadId, inboxLabel }) {
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
      const stripped = stripPtfBlockFromText(text);
      parsed = await extractWithClaude(stripped);
      log('claude-parsed', { borrower: parsed.borrower_name, loan: parsed.loan_number, count: parsed.conditions?.length });
    } catch (err) {
      log('claude-error', { error: err.message });
      return;
    }
  }

  const borrowerName = parsed.borrower_name ?? subjectHints.borrower_name;
  const loanNumber   = parsed.loan_number   ?? subjectHints.loan_number;
  const conditions   = excludePtfConditions((parsed.conditions ?? []).map(c => ({
    code:         c.code ?? null,
    category:     c.category ?? null,
    section:      c.section ?? null,
    text:         c.text,
    needs_review: c.needs_review ?? false
  })));

  if (!conditions.length) {
    log('skip', { reason: 'no conditions found' });
    return;
  }

  const loan = await findLoanByBorrowerOrNumber(borrowerName, loanNumber);

  if (!loan) {
    log('loan-not-found', { borrower: borrowerName, loan: loanNumber, from, subject });
    return;
  }

  const loanName = loan.properties?.['Borrower Name']?.title?.[0]?.plain_text ?? borrowerName;

  if (pdfBuffer) {
    const result = await syncConditionsToNotion(loan.id, conditions);
    log('sync-done', { loan: loanName, ...result });

    await sendSyncNotification({
      gmail, msgId, threadId, inboxLabel,
      origSubject: subject,
      loanName,
      result
    });
    return;
  }

  // Email body only — add new conditions without clearing existing ones
  let added = 0;
  const addedList = [];
  for (const cond of conditions) {
    const wasAdded = await addConditionToNotion(loan.id, cond.text, cond.needs_review);
    if (wasAdded) {
      added++;
      addedList.push(cond.text);
    }
  }

  log('done', { loan: loanName, added, total: conditions.length });

  await sendSyncNotification({
    gmail, msgId, threadId, inboxLabel,
    origSubject: subject,
    loanName,
    result: { added, cleared: 0, addedList, clearedList: [] }
  });
}

async function clearPtfConditionsForLoan(borrowerRef, loanNumber) {
  const loan = await findLoanByBorrowerOrNumber(borrowerRef, loanNumber ?? null);
  if (!loan) throw new Error(`Loan not found for: ${borrowerRef}${loanNumber ? ` / ${loanNumber}` : ''}`);

  const existing = await getOpenConditionsForLoan(loan.id);
  const clearedList = [];

  for (const notionCond of existing) {
    const title = notionCond.properties?.['Condition']?.title?.[0]?.plain_text ?? '';
    if (!isPtfCondition({ text: title })) continue;
    await updatePage(notionCond.id, { 'Status': { select: { name: 'Cleared' } } });
    clearedList.push(title);
    log('ptf-cleared', { title: title.slice(0, 80) });
  }

  const loanName = loan.properties?.['Borrower Name']?.title?.[0]?.plain_text ?? borrowerRef;
  return { loan: loanName, cleared: clearedList.length, clearedList, remaining: existing.length - clearedList.length };
}

module.exports = {
  process: handle,
  parseUwmApprovalLetter,
  isPtfCondition,
  excludePtfConditions,
  clearPtfConditionsForLoan
};
