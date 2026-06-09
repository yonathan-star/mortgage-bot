require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { getClients }  = require('../lib/gmail-client');
const { classify, isUwmLoanSubject } = require('../lib/email-classifier');

const DRY_RUN = process.env.DRY_RUN === 'true';
const MAX_MESSAGES_PER_INBOX = 2;
const SCAN_TIMEZONE = process.env.GMAIL_SCAN_TIMEZONE || 'America/New_York';
const PROCESSED_LABEL = process.env.GMAIL_PROCESSED_LABEL || 'mortgage-bot-processed';
const labelIdCache = {};

// Vercel serverless: only /tmp is writable; fall back to local path for dev
const STATE_FILE = process.env.VERCEL
  ? '/tmp/.gmail-state.json'
  : path.join(__dirname, '..', '.gmail-state.json');

function log(inbox, msgId, classification, action) {
  console.log(JSON.stringify({
    ts: new Date().toISOString(), inbox, msgId, classification, action
  }));
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return {}; }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function formatGmailAfterDate(epochMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SCAN_TIMEZONE,
    year:  'numeric',
    month: '2-digit',
    day:   '2-digit'
  }).formatToParts(new Date(epochMs));
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const d = parts.find(p => p.type === 'day').value;
  return `${y}/${m}/${d}`;
}

function getStartOfTodayMs() {
  const now = new Date();
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: SCAN_TIMEZONE,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).formatToParts(now).map(p => [p.type, p.value])
  );
  const msToday = (+parts.hour * 3600 + +parts.minute * 60 + +parts.second) * 1000;
  return now.getTime() - msToday;
}

function ensureScanCutoff(state) {
  if (process.env.GMAIL_SCAN_AFTER) {
    state.scanCutoffMs = Date.parse(process.env.GMAIL_SCAN_AFTER);
    return state;
  }
  // Default: start of today (Eastern) — not "right now", so earlier-today emails aren't skipped
  state.scanCutoffMs = getStartOfTodayMs();
  return state;
}

function buildInboxQuery(cutoffMs) {
  return `in:inbox after:${formatGmailAfterDate(cutoffMs)} -label:${PROCESSED_LABEL}`;
}

async function getProcessedLabelId(gmail, inboxLabel) {
  if (labelIdCache[inboxLabel]) return labelIdCache[inboxLabel];

  const { data } = await gmail.users.labels.list({ userId: 'me' });
  const existing = (data.labels ?? []).find(l => l.name === PROCESSED_LABEL);
  if (existing) {
    labelIdCache[inboxLabel] = existing.id;
    return existing.id;
  }

  const created = await gmail.users.labels.create({
    userId: 'me',
    requestBody: {
      name: PROCESSED_LABEL,
      labelListVisibility: 'labelHide',
      messageListVisibility: 'show'
    }
  });
  labelIdCache[inboxLabel] = created.data.id;
  return created.data.id;
}

async function markMessageProcessed(gmail, inboxLabel, msgId) {
  const labelId = await getProcessedLabelId(gmail, inboxLabel);
  await gmail.users.messages.modify({
    userId: 'me',
    id: msgId,
    requestBody: { addLabelIds: [labelId] }
  });
}

function extractPart(payload, mimeType) {
  function search(part) {
    if (part.mimeType === mimeType && part.body?.data) {
      return Buffer.from(part.body.data, 'base64').toString('utf8');
    }
    for (const child of part.parts ?? []) {
      const result = search(child);
      if (result) return result;
    }
    return null;
  }
  return search(payload);
}

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractBody(payload) {
  const plain = extractPart(payload, 'text/plain');
  if (plain) return plain;
  const html = extractPart(payload, 'text/html');
  if (html) return stripHtml(html);
  return '';
}

function getHeader(headers, name) {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

function hasPdf(payload) {
  // Recursively search all parts for a PDF attachment
  function search(part) {
    if (
      part.mimeType === 'application/pdf' ||
      (part.filename ?? '').toLowerCase().endsWith('.pdf')
    ) return true;
    return (part.parts ?? []).some(search);
  }
  return search(payload);
}

function findPdfPart(payload) {
  function search(part) {
    if (
      part.mimeType === 'application/pdf' ||
      (part.filename ?? '').toLowerCase().endsWith('.pdf')
    ) return part;
    for (const child of part.parts ?? []) {
      const found = search(child);
      if (found) return found;
    }
    return null;
  }
  return search(payload);
}

async function getAttachmentData(gmail, msgId, attachmentId) {
  const res = await gmail.users.messages.attachments.get({
    userId: 'me', messageId: msgId, id: attachmentId
  });
  return Buffer.from(res.data.data, 'base64');
}

async function processMessage(gmail, inboxLabel, msg, cutoffMs, stats) {
  const full = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' });
  const { payload } = full.data;
  const headers = payload.headers ?? [];
  const subject = getHeader(headers, 'subject');
  const from    = getHeader(headers, 'from');
  const body    = extractBody(payload);
  const hasPDF  = hasPdf(payload);
  const internalDate = Number(full.data.internalDate);

  // PDF approval letters with UWM subject pattern: always process if in today's inbox
  const bypassCutoff = hasPDF && isUwmLoanSubject(subject);
  if (internalDate < cutoffMs && !bypassCutoff) {
    log(inboxLabel, msg.id, null, 'skipped-before-cutoff');
    stats.skippedCutoff++;
    return 'skipped-cutoff';
  }

  const classification = classify(subject, body, { hasPdf: hasPDF, from });
  log(inboxLabel, msg.id, classification, 'classified');
  stats.messages.push({ inbox: inboxLabel, msgId: msg.id, subject, classification, hasPdf: hasPDF });

  // Dry run — log only, no handler dispatch
  if (DRY_RUN) {
    log(inboxLabel, msg.id, classification, 'dry-run-skipped');
    stats.dryRun++;
    return 'dry-run';
  }

  if (classification === 'CONDITION_LIST') {
    const conditionParser = require('../lib/condition-parser');
    let pdfBuffer = null;
    if (hasPDF) {
      const pdfPart = findPdfPart(payload);
      if (pdfPart?.body?.attachmentId) {
        pdfBuffer = await getAttachmentData(gmail, msg.id, pdfPart.body.attachmentId);
      }
    }
    await conditionParser.process({
      subject, from, body, pdfBuffer, msgId: msg.id,
      gmail, threadId: full.data.threadId, inboxLabel
    });
    log(inboxLabel, msg.id, classification, 'dispatched to condition-parser');
    stats.dispatched++;
    return 'dispatched';

  } else if (classification === 'PRE_APPROVAL') {
    const preApproval = require('../lib/pre-approval-handler');
    await preApproval.process({ subject, from, body });
    log(inboxLabel, msg.id, classification, 'dispatched to pre-approval-handler');
    stats.dispatched++;
    return 'dispatched';

  } else if (classification === 'CORRECTION') {
    const correction = require('../lib/correction-handler');
    await correction.process({ subject, from, body });
    log(inboxLabel, msg.id, classification, 'dispatched to correction-handler');
    stats.dispatched++;
    return 'dispatched';

  } else if (classification === 'LENDER_REQUEST') {
    const lenderRequest = require('../lib/lender-request-handler');
    await lenderRequest.process({ subject, from, body });
    log(inboxLabel, msg.id, classification, 'dispatched to lender-request-handler');
    stats.dispatched++;
    return 'dispatched';

  } else {
    log(inboxLabel, msg.id, classification, 'skipped');
    stats.skippedOther++;
    return 'skipped-other';
  }
}

async function watchInbox(account, state, cutoffMs, stats) {
  const { label, gmail } = account;

  const listRes = await gmail.users.messages.list({
    userId:   'me',
    maxResults: MAX_MESSAGES_PER_INBOX,
    q: buildInboxQuery(cutoffMs)
  });

  const messages = listRes.data.messages ?? [];
  if (!messages.length) {
    log(label, null, null, 'no new messages');
    return state;
  }

  // Gmail returns newest first — process only the 2 most recent unlabeled emails
  const toProcess = messages.slice(0, MAX_MESSAGES_PER_INBOX);

  for (const msg of toProcess) {
    const result = await processMessage(gmail, label, msg, cutoffMs, stats);
    // Gmail label persists across Vercel restarts; skipped-cutoff emails retry next scan
    if (result && result !== 'skipped-cutoff') {
      await markMessageProcessed(gmail, label, msg.id);
    }
  }

  return state;
}

async function runScan(req) {
  const clients = getClients();
  let state = loadState();

  if (req.query?.reset === 'true') {
    state = {};
    saveState(state);
    log('system', null, null, 'state-reset-local-only');
  }

  state = ensureScanCutoff(state);
  saveState(state);

  const cutoffMs = state.scanCutoffMs;
  const results = {};
  const stats = { messages: [], dispatched: 0, skippedCutoff: 0, skippedOther: 0, dryRun: 0 };

  log('system', null, null, `scan-cutoff:${new Date(cutoffMs).toISOString()}`);

  for (const [, account] of Object.entries(clients)) {
    try {
      state = await watchInbox(account, state, cutoffMs, stats);
      results[account.label] = 'ok';
    } catch (err) {
      console.error(JSON.stringify({ ts: new Date().toISOString(), inbox: account.label, error: err.message }));
      results[account.label] = `error: ${err.message}`;
    }
  }

  saveState(state);
  const payload = {
    ok: true,
    ts: new Date().toISOString(),
    scanCutoff: new Date(cutoffMs).toISOString(),
    scanQuery: buildInboxQuery(cutoffMs),
    results,
    stats
  };
  console.log(JSON.stringify({ action: 'scan-complete', ...payload }));
  return payload;
}

module.exports = async (req, res) => {
  // cron-job.org times out at 30s; scans can take ~60s. Reply immediately on Vercel
  // and finish the scan in the background so cron reports success.
  if (process.env.VERCEL) {
    const { waitUntil } = require('@vercel/functions');
    waitUntil(
      runScan(req).catch(err => {
        console.error(JSON.stringify({ ts: new Date().toISOString(), action: 'scan-error', error: err.message }));
      })
    );
    return res.status(202).json({
      ok: true,
      message: 'Scan started — check Vercel logs for results',
      ts: new Date().toISOString()
    });
  }

  const payload = await runScan(req);
  return res.status(200).json(payload);
};
