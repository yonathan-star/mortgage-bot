require('dotenv').config();
const { queryDatabase, createPage, updatePage, archivePage } = require('../lib/notion-client');

const LOANS_DB      = process.env.NOTION_LOANS_DB_ID;
const CONDITIONS_DB = process.env.NOTION_CONDITIONS_DB_ID;
const HEADER_KEY    = process.env.ZAPIER_STATIC_HEADER_KEY;

const FUNDED_STATUSES = new Set([
  'LOAN_FUNDED', 'BROKER_CHECK_RECEIVED', 'COMMISSION_PAID'
]);

// Map Arive milestone field names → our Notion status values
// Order matters: most advanced status first
const MILESTONE_MAP = [
  { field: 'Re Submittal',           status: 'RE_SUBMITTAL' },
  { field: 'Clear To Close',         status: 'CLEAR_TO_CLOSE' },
  { field: 'Docs Out',               status: 'DOCS_OUT' },
  { field: 'Docs Signed',            status: 'DOCS_SIGNED' },
  { field: 'Suspended',              status: 'SUSPENDED' },
  { field: 'Approved w/ Conditions', status: 'APPROVED_WITH_CONDITIONS' },
  { field: 'Submitted To UW',        status: 'UNDERWRITING_SUBMITTED' },
  { field: 'Disclosed',              status: 'DISCLOSURE_SENT' },
  { field: 'Loan Setup',             status: 'LOAN_SETUP' },
  { field: 'Pre-Approved',           status: 'LOAN_SETUP' },
];

function log(loanId, status, action) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), loanId, status, action }));
}

function normalizeLoanId(raw) {
  return (raw ?? '').toString().trim().replace(/\s+/g, ' ');
}

// Derive the most advanced status from Arive's milestone date fields
function deriveStatus(body) {
  for (const { field, status } of MILESTONE_MAP) {
    const val = body[field];
    if (val && val.toString().trim() !== '') return status;
  }
  return null;
}

// Extract loan ID from any of the known Arive field names
function extractLoanId(body) {
  const raw = body['Lender Loan Number']
    ?? body['lender_loan_number']
    ?? body['loan_id']
    ?? body['loanId']
    ?? body['Loan ID']
    ?? body['Loan Number']
    ?? body['loan_number']
    ?? '';
  return normalizeLoanId(raw);
}

// Extract borrower name from any of the known Arive field names
function extractBorrowerName(body) {
  return (
    body['Borrower Name']
    ?? body['borrower_name']
    ?? body['Borrower First Name'] && body['Borrower Last Name']
      ? `${body['Borrower First Name']} ${body['Borrower Last Name']}`.trim()
      : null
    ?? body['borrower_first_name'] && body['borrower_last_name']
      ? `${body['borrower_first_name']} ${body['borrower_last_name']}`.trim()
      : null
    ?? body['Primary Borrower Name']
    ?? body['Borrower']
    ?? ''
  );
}

function extractLoName(body) {
  return (
    body['Loan Officer Name']
    ?? body['LO Name']
    ?? body['lo_name']
    ?? body['Loan Officer']
    ?? ''
  ).toString().trim();
}

async function findExistingLoan(loanId, borrowerName) {
  if (loanId) {
    const r = await queryDatabase(LOANS_DB, {
      property: 'Loan ID', rich_text: { equals: loanId }
    });
    if (r.results.length) return r.results[0];

    const r2 = await queryDatabase(LOANS_DB, {
      property: 'Loan ID', rich_text: { contains: loanId }
    });
    if (r2.results.length) return r2.results[0];
  }

  if (borrowerName) {
    const firstName = borrowerName.trim().split(/\s+/)[0];
    if (firstName) {
      const r3 = await queryDatabase(LOANS_DB, {
        property: 'Borrower Name', title: { contains: firstName }
      });
      if (r3.results.length) return r3.results[0];
    }
  }
  return null;
}

async function findConditionsByLoan(loanPageId) {
  const res = await queryDatabase(CONDITIONS_DB, {
    property: 'Loan', relation: { contains: loanPageId }
  });
  return res.results;
}

async function createLoan({ loanId, borrowerName, loName, status }) {
  await createPage(LOANS_DB, {
    'Borrower Name': { title:     [{ text: { content: borrowerName || 'Unknown' } }] },
    'Loan ID':       { rich_text: [{ text: { content: loanId } }] },
    'LO Name':       { rich_text: [{ text: { content: loName ?? '' } }] },
    'Status':        { select:    { name: status } },
    'Date Added':    { date:      { start: new Date().toISOString().split('T')[0] } }
  });
  log(loanId, status, 'created');
}

async function updateLoanStatus(pageId, loanId, status) {
  await updatePage(pageId, { 'Status': { select: { name: status } } });
  log(loanId, status, 'updated');
}

async function deleteLoanAndConditions(page, loanId) {
  const conditions = await findConditionsByLoan(page.id);
  for (const cond of conditions) await archivePage(cond.id);
  await archivePage(page.id);
  log(loanId, 'FUNDED', `deleted loan + ${conditions.length} condition(s)`);
}

module.exports = async (req, res) => {
  const incomingKey = req.headers['x-zapier-key']
    ?? req.headers['authorization']
    ?? req.query?.key;
  if (!incomingKey || incomingKey !== HEADER_KEY) {
    log('unknown', 'AUTH', 'rejected — bad header key');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const body         = req.body ?? {};
  const loanId       = extractLoanId(body);
  const borrowerName = extractBorrowerName(body).toString().trim();
  const loName       = extractLoName(body);

  // Accept explicit status OR derive from Arive milestone dates
  const explicitStatus = (body.status ?? body.Status ?? '').toString().trim().toUpperCase().replace(/[\s\-]+/g, '_');
  const status = explicitStatus || deriveStatus(body);

  // Log raw body for debugging
  console.log(JSON.stringify({ ts: new Date().toISOString(), raw_body: body }));
  log(loanId || 'unknown', status || 'none', `received — borrower: "${borrowerName}"`);

  if (!loanId) {
    return res.status(400).json({ error: 'Missing loan ID (expected: Lender Loan Number)' });
  }
  if (!status) {
    return res.status(400).json({ error: 'Could not determine status from payload' });
  }

  try {
    if (FUNDED_STATUSES.has(status)) {
      const existing = await findExistingLoan(loanId, borrowerName);
      if (existing) await deleteLoanAndConditions(existing, loanId);
      else log(loanId, status, 'loan not found — nothing to delete');
      return res.status(200).json({ ok: true, action: 'deleted', loanId, status });
    }

    // All other statuses → upsert
    const existing = await findExistingLoan(loanId, borrowerName);
    if (existing) {
      await updateLoanStatus(existing.id, loanId, status);
    } else {
      await createLoan({ loanId, borrowerName, loName, status });
    }
    return res.status(200).json({ ok: true, action: 'upserted', loanId, status, borrowerName });

  } catch (err) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), error: err.message, loanId, status }));
    return res.status(500).json({ error: 'Internal server error' });
  }
};
