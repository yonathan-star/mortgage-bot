// Classify incoming emails into categories the handlers understand

// Lock desk / COC / pricing change notices — not condition approval letters
const IGNORE_KEYWORDS = [
  'lock confirmation', 'lock update', 'lock extension', 'relock', 're-lock',
  'rate lock confirmation', 'successfully locked', 'lock expiration date',
  'change of circumstance', 'change of circumstances', 'changed circumstance',
  'changed circumstances', 'notice of change of circumstance', 'coc notice',
  'coc confirmation', 'coc submitted', 'coc received', 'change in circumstance',
  'change of circumstance has been processed', 'your change of circumstance',
  'loan change request', 'change request has been submitted', 'reason(s) for this change request'
];

const CONDITION_KEYWORDS = [
  'conditions', 'condition list', 'prior to', 'suspense', 'uwm conditions',
  'underwriting conditions', 'loan conditions', 'items needed', 'outstanding items',
  'conditionally approved', 'conditional approval',
  'initial loan approval', 'conditional loan approval'
];

const PRE_APPROVAL_KEYWORDS = [
  'pre-approval', 'pre approval', 'preapproval', 'prequal', 'pre-qual',
  'pre qualification', 'prequalification'
];

const CORRECTION_KEYWORDS = ['notion agent correction'];

const TASK_KEYWORDS = [
  'action required', 'please review', 'follow up', 'follow-up',
  'reminder', 'urgent', 'time sensitive'
];

const LENDER_ROLE_KEYWORDS = [
  'underwriter', 'account manager', 'account executive', 'processor',
  'closer', 'funding manager', 'production partner'
];

const BULK_SENDER_RE = /noreply|no-reply|donotreply|notifications?@/i;

const {
  extractLoanInfo,
  hasActionableLenderRequest
} = require('./lender-request-handler');

function isUwmLoanSubject(subject) {
  return /^\d{6,}\s*[-–]\s*\S+/i.test((subject ?? '').trim());
}

function isIgnorableEmail(subject, body) {
  const text = `${subject} ${body}`.toLowerCase();
  if (IGNORE_KEYWORDS.some(k => text.includes(k))) return true;
  if (/lock confirmation for the/i.test(subject ?? '')) return true;
  if (/\[lock update\]/i.test(subject ?? '')) return true;
  if (/loan change request/i.test(subject ?? '')) return true;
  return false;
}

function isApprovalPdfSubject(subject) {
  return /approval\s*letter|conditional\s+approval|loan\s+approval|initial\s+loan\s+approval/i.test(subject ?? '');
}

function isDirectLenderEmail(from) {
  const value = (from ?? '').trim();
  if (!value || BULK_SENDER_RE.test(value)) return false;
  return /@[a-z0-9.-]+\.[a-z]{2,}/i.test(value);
}

function isLenderUrgentRequest(subject, body, from) {
  if (!isDirectLenderEmail(from)) return false;

  const { loanNumber } = extractLoanInfo(subject, body);
  if (!loanNumber) return false;

  const text = `${subject} ${body}`.toLowerCase();
  const hasRole = LENDER_ROLE_KEYWORDS.some(k => text.includes(k));
  return hasRole || hasActionableLenderRequest(subject, body);
}

function classify(subject, body, { hasPdf = false, from = '' } = {}) {
  const text = `${subject} ${body}`.toLowerCase();

  if (CORRECTION_KEYWORDS.some(k => text.includes(k)))  return 'CORRECTION';
  if (isIgnorableEmail(subject, body))                   return 'IGNORE';
  if (PRE_APPROVAL_KEYWORDS.some(k => text.includes(k))) return 'PRE_APPROVAL';
  if (isLenderUrgentRequest(subject, body, from))        return 'LENDER_REQUEST';
  if (CONDITION_KEYWORDS.some(k => text.includes(k)))    return 'CONDITION_LIST';
  // UWM approval PDFs: subject is often "1226351896 - Bujalski" with keywords only in HTML body
  if (hasPdf && isUwmLoanSubject(subject))               return 'CONDITION_LIST';
  if (hasPdf && isApprovalPdfSubject(subject))           return 'CONDITION_LIST';
  if (TASK_KEYWORDS.some(k => text.includes(k)))         return 'TASK';
  return 'OTHER';
}

module.exports = {
  classify,
  isUwmLoanSubject,
  isIgnorableEmail,
  isLenderUrgentRequest
};
