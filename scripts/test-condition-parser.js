require('dotenv').config();
const { process } = require('../lib/condition-parser');

const sampleEmail = `
From: underwriter@lender.com
Subject: Conditions for Smith, John - Loan #2024-789

Dear Processor,

Please provide the following conditions prior to closing for borrower John Smith, Loan Number 2024-789:

1. Provide signed and dated 4506-C form
2. Letter of explanation for large deposit dated 03/15/2024 ($4,500)
3. Copy of fully executed purchase agreement with all addenda
4. Verification of employment - verbal VOE required within 10 days of closing
5. Homeowner's insurance declaration page showing coverage equal to or greater than loan amount
6. Title commitment showing no outstanding liens
7. ??? unclear item from underwriter notes

Thank you,
Jane Underwriter
ABC Lending
`;

process({
  subject:   'Conditions for Smith, John - Loan #2024-789',
  from:      'underwriter@lender.com',
  body:      sampleEmail,
  pdfBuffer: null,
  msgId:     'test-001'
}).then(() => {
  console.log('\nTest complete — check Notion Conditions database.');
}).catch(err => {
  console.error('[ERROR]', err.message);
});
