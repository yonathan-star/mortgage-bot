require('dotenv').config();
const fs = require('fs');
const pdfParse = require('pdf-parse');
const { parseUwmApprovalLetter } = require('../lib/condition-parser');

const pdfPath = process.argv[2];
if (!pdfPath) {
  console.error('Usage: node scripts/test-uwm-parser.js <path-to-pdf>');
  process.exit(1);
}

(async () => {
  const buf = fs.readFileSync(pdfPath);
  const text = (await pdfParse(buf)).text;
  const parsed = parseUwmApprovalLetter(text);

  if (!parsed) {
    console.error('UWM parser returned null — not a recognized approval letter format.');
    process.exit(1);
  }

  console.log(`Borrower: ${parsed.borrower_name}`);
  console.log(`Loan #:   ${parsed.loan_number}`);
  console.log(`Conditions (${parsed.conditions.length}):\n`);
  parsed.conditions.forEach((c, i) => {
    console.log(`${i + 1}. [${c.code}] ${c.text.slice(0, 90)}${c.text.length > 90 ? '...' : ''}`);
  });
})().catch(err => {
  console.error('[ERROR]', err.message);
  process.exit(1);
});
