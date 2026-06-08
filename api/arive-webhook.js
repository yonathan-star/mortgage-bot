require('dotenv').config();
const { queryDatabase, createPage, updatePage, archivePage } = require('../lib/notion-client');

const LOANS_DB      = process.env.NOTION_LOANS_DB_ID;
const CONDITIONS_DB = process.env.NOTION_CONDITIONS_DB_ID;
const HEADER_KEY    = process.env.ZAPIER_STATIC_HEADER_KEY;

const PROCESSING_STATUSES = new Set([
  'LOAN_SETUP', 'DISCLOSURE_SENT', 'UNDERWRITING_SUBMITTED',
  'APPROVED_WITH_CONDITIONS', 'RE_SUBMITTAL', 'CLEAR_TO_CLOSE',
  'DOCS_OUT', 'DOCS_SIGNED', 'SUSPENDED'
]);

const FUNDED_STATUSES = new Set([
  'LOAN_FUNDED', 'BROKER_CHECK_RECEIVED', 'COMMISSION_PAID'
]);

function log(loanId, status, action) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), loanId, status, action }));
}

async function findLoanByLoanId(loanId) {
  const res = await queryDatabase(LOANS_DB, {
    property: 'Loan ID', rich_text: { equals: loanId }
  });
  return res.results[0] ?? null;
}

async function findConditionsByLoan(loanPageId) {
  const res = await queryDatabase(CONDITIONS_DB, {
    property: 'Loan', relation: { contains: loanPageId }
  });
  return res.results;
}

async function createLoan({ loanId, borrowerName, loName, status }) {
  await createPage(LOANS_DB, {
    'Borrower Name': { title:     [{ text: { content: borrowerName } }] },
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

async function handleProcessing({ loanId, borrowerName, loName, status }) {
  const existing = await findLoanByLoanId(loanId);
  if (existing) {
    await updateLoanStatus(existing.id, loanId, status);
  } else {
    await createLoan({ loanId, borrowerName, loName, status });
  }
}

async function handleFunded({ loanId }) {
  const existing = await findLoanByLoanId(loanId);
  if (existing) {
    await deleteLoanAndConditions(existing, loanId);
  } else {
    log(loanId, 'FUNDED', 'loan not found — nothing to delete');
  }
}

module.exports = async (req, res) => {
  // Accept key via header OR query param (?key=...) for Zapier compatibility
  const incomingKey = req.headers['x-zapier-key']
    ?? req.headers['authorization']
    ?? req.query?.key;
  if (!incomingKey || incomingKey !== HEADER_KEY) {
    log('unknown', 'AUTH', 'rejected — bad header key');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const body        = req.body ?? {};
  const loanId      = body.loan_id ?? body.loanId ?? body['Loan ID'];
  const borrowerName = body.borrower_name ?? body.borrowerName ?? body['Borrower Name'] ?? '';
  const loName      = body.lo_name ?? body.loName ?? body['LO Name'] ?? '';
  const status      = (body.status ?? body.Status ?? '').toUpperCase().replace(/\s+/g, '_');

  if (!loanId || !status) {
    log('unknown', status, 'rejected — missing loanId or status');
    return res.status(400).json({ error: 'Missing loan_id or status' });
  }

  try {
    if (PROCESSING_STATUSES.has(status)) {
      await handleProcessing({ loanId, borrowerName, loName, status });
      return res.status(200).json({ ok: true, action: 'upserted', loanId, status });
    }
    if (FUNDED_STATUSES.has(status)) {
      await handleFunded({ loanId });
      return res.status(200).json({ ok: true, action: 'deleted', loanId, status });
    }
    log(loanId, status, 'ignored — unrecognized status');
    return res.status(200).json({ ok: true, action: 'ignored', loanId, status });
  } catch (err) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), error: err.message, loanId, status }));
    return res.status(500).json({ error: 'Internal server error' });
  }
};
