require('dotenv').config();
const { queryDatabase, createPage } = require('./notion-client');
const { sendToBothInboxes } = require('./send-email');

const LOANS_DB      = process.env.NOTION_LOANS_DB_ID;
const CONDITIONS_DB = process.env.NOTION_CONDITIONS_DB_ID;

const BODY_LOAN_PATTERNS = [
  /file\s*name:\s*(\d{6,})/i,
  /loan\s*(?:no\.?|number|#)?\s*:?\s*(\d{6,})/i,
  /\bloan\s+(\d{6,})\b/i
];

function log(action, detail) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), handler: 'lender-request', action, ...detail }));
}

function cleanSubject(subject) {
  return (subject ?? '').trim().replace(/^(?:re|fw|fwd):\s*/i, '').trim();
}

function normalizeBorrowerName(name) {
  const trimmed = (name ?? '')
    .trim()
    .replace(/\/+\s*missing\s+docs.*$/i, '')
    .replace(/\s*\/\/\/.*$/, '')
    .trim();
  if (!trimmed) return null;

  const comma = trimmed.match(/^([^,]+),\s*(.+)$/);
  if (comma) return `${comma[2].trim()} ${comma[1].trim()}`;

  return trimmed;
}

function extractBorrowerFromSubject(subject) {
  const trimmed = cleanSubject(subject);

  const lastFirst = trimmed.match(/^([^;]+);/);
  if (lastFirst) return { borrower: normalizeBorrowerName(lastFirst[1].trim()) };

  const nameFirst = trimmed.match(/^(.+?)\s*[-–]\s*(\d{6,})\s*$/);
  if (nameFirst) return { borrower: normalizeBorrowerName(nameFirst[1].trim()) };

  const loanFirst = trimmed.match(/^(\d{6,})\s*[-–]\s*(.+)$/);
  if (loanFirst) return { borrower: normalizeBorrowerName(loanFirst[2].trim()) };

  const embedded = trimmed.match(/\b(\d{6,})\b/);
  if (embedded) {
    const borrower = trimmed.replace(embedded[0], '').replace(/[-–;]/g, ' ').trim();
    return { borrower: normalizeBorrowerName(borrower) || null };
  }

  return { borrower: null };
}

function extractLoanFromSubject(subject) {
  const trimmed = cleanSubject(subject);
  const borrowerHint = extractBorrowerFromSubject(subject);

  const nameFirst = trimmed.match(/^(.+?)\s*[-–]\s*(\d{6,})\s*$/);
  if (nameFirst) return { borrower: borrowerHint.borrower, loanNumber: nameFirst[2] };

  const loanFirst = trimmed.match(/^(\d{6,})\s*[-–]\s*(.+)$/);
  if (loanFirst) {
    return {
      borrower: normalizeBorrowerName(loanFirst[2].trim()),
      loanNumber: loanFirst[1]
    };
  }

  const loanInSubject = trimmed.match(/\b(\d{6,})\b/);
  if (loanInSubject) {
    return { borrower: borrowerHint.borrower, loanNumber: loanInSubject[1] };
  }

  return { borrower: borrowerHint.borrower, loanNumber: null };
}

function extractLoanInfo(subject, body) {
  const fromSubject = extractLoanFromSubject(subject);
  if (fromSubject.loanNumber) return fromSubject;

  for (const re of BODY_LOAN_PATTERNS) {
    const m = (body ?? '').match(re);
    if (m) {
      return { borrower: fromSubject.borrower, loanNumber: m[1] };
    }
  }

  return fromSubject;
}

function hasActionableLenderRequest(subject, body) {
  const text = `${subject} ${body}`.toLowerCase();
  const requestKeywords = [
    'only item we need', 'item we need', 'items we need', 'can you furnish',
    'please provide', 'need from you', 'hold the file', 'furnish this',
    'please send', 'please upload', 'missing documentation', 'need the following',
    'as soon as possible', 'by end of day', 'by eod', 'provide a renewal',
    'provide a', 'provide the', 'please note',
    'missing docs', 'missing other items', 'missing items', 'submission review',
    'please run aus', 'run aus', 'pushed the loan back', 'hold pattern',
    're-run the loanscorecard', 'loan scorecard'
  ];

  if (/missing\s+docs/i.test(subject ?? '')) return true;
  if (requestKeywords.some(k => text.includes(k))) return true;
  if (/\b(today|asap|expired|renewal|needed|missing|required|upload|submit)\b/i.test(text)) return true;
  if (/please note.+(provide|expired|renewal|update|submit|send)/i.test(text)) return true;

  const isReviewNotification = /condition review completion notification/i.test(subject ?? '');
  return isReviewNotification && /\b(provide|expired|renewal|please note|upload|submit|send)\b/i.test(text);
}

function isDocRequestLine(line) {
  return /^(credit report|tax return|w-?2|paystub|bank statement|aus\b)/i.test(line)
    || /\d{4}.*tax returns?/i.test(line);
}

function condenseSubmissionRequest(requestText, subject) {
  const isMissingDocs = /missing\s+docs/i.test(subject ?? '')
    || /missing (other )?items|submission review/i.test(requestText);

  if (!isMissingDocs) return requestText;

  const items = [];
  if (/run aus/i.test(requestText)) items.push('Run AUS');
  if (/credit report/i.test(requestText)) items.push('Credit Report');
  const taxMatch = requestText.match(/\d{4}[^;]*tax returns?/i);
  if (taxMatch) items.push(taxMatch[0].replace(/\s+/g, ' ').trim());
  else if (/tax returns?/i.test(requestText)) items.push('Tax returns');

  if (items.length) return `Missing docs for submission - ${items.join('; ')}`;
  if (/missing (other )?items/i.test(requestText)) return 'Missing docs for submission review';
  return requestText.slice(0, 150);
}

function extractSenderName(from) {
  const m = (from ?? '').match(/^([^<]+)</);
  return m ? m[1].trim().replace(/"/g, '') : (from ?? '').split('@')[0];
}

function detectSource(body, from) {
  const text = `${body} ${from}`.toLowerCase();
  if (text.includes('registration analyst') || text.includes('wholesale ops') || text.includes('loan setup')) {
    return 'Lender';
  }
  if (text.includes('underwriter')) return 'Underwriter';
  if (text.includes('account manager') || text.includes('account executive')) return 'Lender';
  return 'Underwriter';
}

function extractRequestText(body) {
  const lines = (body ?? '').split('\n').map(l => l.trim()).filter(Boolean);
  const content = [];

  for (const line of lines) {
    if (/^(hello|hi|good morning|good afternoon|dear)\b/i.test(line)) continue;
    if (/^thank you for\b/i.test(line)) continue;
    if (/^file\s*name:/i.test(line)) continue;
    if (/^(thanks|regards|sincerely|best|have a great|description automatically|thank you in advance)/i.test(line)) break;
    if (/underwriter|account manager|account executive|processor|production partner|registration analyst|wholesale ops/i.test(line) && line.length < 80) break;
    if (/^thank you\.?$/i.test(line)) break;
    if (/@[a-z0-9.-]+\.[a-z]{2,}/i.test(line)) break;
    if (/^www\./i.test(line)) break;
    if (/^\d{3}[)\s.-]?\s*\d{3}[)\s.-]?\d{4}/.test(line)) break;
    if (/nmls|equal housing|intended only for|mimecast|automatically archived|unauthorized use/i.test(line)) break;
    if (line.length > 8 || (content.length > 0 && isDocRequestLine(line))) content.push(line);
  }

  const text = content.join(' ').replace(/\s+/g, ' ').trim();
  return text.slice(0, 500) || 'Lender request — see email';
}

function buildConditionTitle(borrower, requestText, subject = '') {
  const condensed = condenseSubmissionRequest(requestText, subject);
  const cleaned = condensed
    .replace(/^please note (that )?/i, '')
    .replace(/^the only item we need is (the )?/i, '')
    .replace(/\.\s*can you.*/i, '')
    .replace(/,\s*provide a renewal\.?$/i, ' - provide renewal')
    .trim();

  const title = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  if (borrower) return `${borrower} - ${title}`;
  return title;
}

async function findLoan(borrowerName, loanNumber) {
  if (loanNumber) {
    const r = await queryDatabase(LOANS_DB, {
      property: 'Loan ID', rich_text: { equals: loanNumber }
    });
    if (r.results.length) return r.results[0];
  }

  if (borrowerName) {
    const r = await queryDatabase(LOANS_DB, {
      property: 'Borrower Name', title: { contains: borrowerName }
    });
    if (r.results.length) return r.results[0];

    const parts = borrowerName.trim().split(/\s+/);
    if (parts.length >= 2) {
      const byLast = await queryDatabase(LOANS_DB, {
        property: 'Borrower Name', title: { contains: parts[parts.length - 1] }
      });
      if (byLast.results.length === 1) return byLast.results[0];
    }
  }

  return null;
}

async function conditionExists(loanPageId, conditionText) {
  const filter = loanPageId
    ? { and: [
        { property: 'Loan', relation: { contains: loanPageId } },
        { property: 'Condition', title: { equals: conditionText } }
      ]}
    : { property: 'Condition', title: { equals: conditionText } };

  const r = await queryDatabase(CONDITIONS_DB, filter);
  return r.results.length > 0;
}

const PRIORITY_OPTION_NAMES = ['High', 'HIGH', 'Urgent', 'urgent'];

async function createConditionWithPriority(properties) {
  for (const priorityName of PRIORITY_OPTION_NAMES) {
    try {
      await createPage(CONDITIONS_DB, {
        ...properties,
        Priority: { select: { name: priorityName } }
      });
      return priorityName;
    } catch (err) {
      if (!/priority|select|option|invalid/i.test(err.message)) throw err;
      log('priority-try-failed', { priorityName, error: err.message });
    }
  }

  const { Priority, ...withoutPriority } = properties;
  await createPage(CONDITIONS_DB, withoutPriority);
  log('priority-not-set', { reason: 'no matching Priority option in Notion' });
  return null;
}

async function sendNotification({ borrower, loanNumber, conditionTitle, senderName }) {
  const subject = `[Mortgage Bot] URGENT - ${conditionTitle}`;
  const bodyText = [
    'A lender employee emailed a direct urgent request. A task was created in Notion.',
    '',
    `Borrower: ${borrower ?? 'Unknown'}`,
    `Loan: ${loanNumber ?? 'Unknown'}`,
    `From: ${senderName ?? 'Unknown'}`,
    `Request: ${conditionTitle}`,
    'Priority: High',
    'Status: Open'
  ].join('\n');
  await sendToBothInboxes(subject, bodyText);
}

async function handle({ subject, from, body }) {
  log('start', { subject, from });

  const { borrower, loanNumber } = extractLoanInfo(subject, body);
  const requestText = extractRequestText(body);
  const conditionTitle = buildConditionTitle(borrower, requestText, subject);
  const source = detectSource(body, from);
  const senderName = extractSenderName(from);

  log('parsed', { borrower, loanNumber, conditionTitle, source, senderName });

  const loan = await findLoan(borrower, loanNumber);
  if (!loan) log('loan-not-found', { borrower, loanNumber });

  if (loan && await conditionExists(loan.id, conditionTitle)) {
    log('skipped-duplicate', { conditionTitle });
    return;
  }

  const properties = {
    'Condition':  { title:    [{ text: { content: conditionTitle } }] },
    'Status':     { select:   { name: 'Open' } },
    'Source':     { select:   { name: source } },
    'Date Added': { date:     { start: new Date().toISOString().split('T')[0] } }
  };
  if (loan) properties['Loan'] = { relation: [{ id: loan.id }] };

  const prioritySet = await createConditionWithPriority(properties);
  log('notion-created', { conditionTitle, loanLinked: !!loan, priority: prioritySet ?? 'none' });

  await sendNotification({ borrower, loanNumber, conditionTitle, senderName });
  log('done', { conditionTitle });
}

module.exports = {
  process: handle,
  extractLoanFromSubject,
  extractLoanInfo,
  extractBorrowerFromSubject,
  extractRequestText,
  buildConditionTitle,
  hasActionableLenderRequest
};
