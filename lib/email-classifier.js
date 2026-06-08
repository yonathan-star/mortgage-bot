// Classify incoming emails into categories the handlers understand
const CONDITION_KEYWORDS = [
  'conditions', 'condition list', 'prior to', 'suspense', 'uwm conditions',
  'underwriting conditions', 'loan conditions', 'items needed', 'outstanding items',
  'conditionally approved', 'conditional approval', 'approved with conditions',
  'approved w/ conditions', 'initial approval', 'loan approval', 'conditional loan'
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

function classify(subject, body) {
  const text = `${subject} ${body}`.toLowerCase();

  if (CORRECTION_KEYWORDS.some(k => text.includes(k)))  return 'CORRECTION';
  if (PRE_APPROVAL_KEYWORDS.some(k => text.includes(k))) return 'PRE_APPROVAL';
  if (CONDITION_KEYWORDS.some(k => text.includes(k)))    return 'CONDITION_LIST';
  if (TASK_KEYWORDS.some(k => text.includes(k)))         return 'TASK';
  return 'OTHER';
}

module.exports = { classify };
