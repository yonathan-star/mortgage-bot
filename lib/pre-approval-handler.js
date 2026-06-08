require('dotenv').config();
const { createPage } = require('./notion-client');
const { sendToBothInboxes } = require('./send-email');

const CONDITIONS_DB = process.env.NOTION_CONDITIONS_DB_ID;

function log(action, detail) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), handler: 'pre-approval', action, ...detail }));
}

function extractBorrowerName(subject, body) {
  // Try subject line patterns: "Pre-Approval for John Smith", "John Smith Pre-Approval"
  const subjectPatterns = [
    /pre[- ]?approval\s+(?:for\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/i,
    /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\s+pre[- ]?approval/i,
    /prequal(?:ification)?\s+(?:for\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/i,
    /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\s+prequal/i,
  ];

  for (const re of subjectPatterns) {
    const m = subject.match(re);
    if (m) return m[1].trim();
  }

  // Try body — look for "Borrower: Name" or "Applicant: Name"
  const bodyPatterns = [
    /borrower[:\s]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/i,
    /applicant[:\s]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/i,
    /client[:\s]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/i,
  ];

  for (const re of bodyPatterns) {
    const m = body.match(re);
    if (m) return m[1].trim();
  }

  return null;
}

async function sendNotification(borrowerName) {
  const subject  = `[Mortgage Bot] Pre-Approval Documents Received${borrowerName ? ` — ${borrowerName}` : ''}`;
  const bodyText = `A pre-approval email was received and a task has been created in Notion.\n\n` +
    `Borrower: ${borrowerName ?? 'Unknown (check email)'}\n` +
    `Task: Pre-Approval Documents Received\n` +
    `Status: Open\n` +
    `Source: Lender\n\n` +
    `Please review the documents and update the status in Notion when complete.`;
  await sendToBothInboxes(subject, bodyText);
}

async function handle({ subject, from, body }) {
  log('start', { subject, from });

  const borrowerName = extractBorrowerName(subject, body);
  log('borrower-extracted', { borrowerName });

  const conditionTitle = borrowerName
    ? `Pre-Approval Documents Received — ${borrowerName}`
    : 'Pre-Approval Documents Received';

  await createPage(CONDITIONS_DB, {
    'Condition':  { title:  [{ text: { content: conditionTitle } }] },
    'Status':     { select: { name: 'Open' } },
    'Source':     { select: { name: 'Lender' } },
    'Date Added': { date:   { start: new Date().toISOString().split('T')[0] } }
  });

  log('notion-task-created', { title: conditionTitle });

  await sendNotification(borrowerName);

  log('done', { borrowerName });
}

module.exports = { process: handle };
