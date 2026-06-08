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
// Covers both raw Arive field names and Zapier's "X Tracker Date/Status" naming
const MILESTONE_MAP = [
  // Zapier "Tracker Date" field names (e.g. "SIGNED_DOCS_WITH_LENDER Tracker Date")
  { field: 'SIGNED_DOCS_WITH_LENDER Tracker Date', status: 'DOCS_SIGNED' },
  { field: 'DOCS_OUT Tracker Date',                status: 'DOCS_OUT' },
  { field: 'CLEAR_TO_CLOSE Tracker Date',          status: 'CLEAR_TO_CLOSE' },
  { field: 'RE_SUBMITTAL Tracker Date',            status: 'RE_SUBMITTAL' },
  { field: 'SUSPENDED Tracker Date',               status: 'SUSPENDED' },
  { field: 'APPROVED_W_CONDITIONS Tracker Date',   status: 'APPROVED_WITH_CONDITIONS' },
  { field: 'SUBMITTED_TO_UW Tracker Date',         status: 'UNDERWRITING_SUBMITTED' },
  { field: 'DISCLOSED Tracker Date',               status: 'DISCLOSURE_SENT' },
  { field: 'LOAN_SETUP Tracker Date',              status: 'LOAN_SETUP' },
  // Raw Arive milestone date field names
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
// Case-insensitive and space-insensitive matching
function deriveStatus(body) {
  const normalized = {};
  for (const k of Object.keys(body)) {
    normalized[k.toLowerCase().replace(/[\s_\-]+/g, '')] = body[k];
  }
  for (const { field, status } of MILESTONE_MAP) {
    const key = field.toLowerCase().replace(/[\s_\-]+/g, '');
    const val = normalized[key];
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
  if (body['Borrower Name'])          return body['Borrower Name'];
  if (body['borrower_name'])          return body['borrower_name'];
  if (body['Primary Borrower Name'])  return body['Primary Borrower Name'];
  if (body['Borrower'])               return body['Borrower'];
  const first = body['Borrower First Name'] || body['borrower_first_name'] || '';
  const last  = body['Borrower Last Name']  || body['borrower_last_name']  || '';
  if (first || last) return `${first} ${last}`.trim();
  return '';
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
  // Auth temporarily open while debugging Zapier data flow
  // TODO: re-enable once confirmed working

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
  // Default to LOAN_SETUP if no milestone date found — loan is at least active
  const resolvedStatus = status || 'LOAN_SETUP';
  log(loanId, resolvedStatus, status ? 'status-derived' : 'status-defaulted-to-LOAN_SETUP');

  try {
    if (FUNDED_STATUSES.has(resolvedStatus)) {
      const existing = await findExistingLoan(loanId, borrowerName);
      if (existing) await deleteLoanAndConditions(existing, loanId);
      else log(loanId, resolvedStatus, 'loan not found — nothing to delete');
      return res.status(200).json({ ok: true, action: 'deleted', loanId, status: resolvedStatus });
    }

    // All other statuses → upsert
    const existing = await findExistingLoan(loanId, borrowerName);
    if (existing) {
      await updateLoanStatus(existing.id, loanId, resolvedStatus);
    } else {
      await createLoan({ loanId, borrowerName, loName, status: resolvedStatus });
    }
    return res.status(200).json({ ok: true, action: 'upserted', loanId, status: resolvedStatus, borrowerName });

  } catch (err) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), error: err.message, loanId, status }));
    return res.status(500).json({ error: 'Internal server error' });
  }
};
