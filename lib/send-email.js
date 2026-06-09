require('dotenv').config();
const { getClients } = require('./gmail-client');

const DRY_RUN = process.env.DRY_RUN === 'true';

function getHeader(headers, name) {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
}

function buildSyncSubject(origSubject, { added, cleared }) {
  const base = (origSubject || 'Approval email').replace(/^re:\s*/i, '').trim();
  const parts = [];
  if (added)   parts.push(`${added} added`);
  if (cleared) parts.push(`${cleared} cleared`);
  return `${base} — ${parts.join(', ')}`;
}

function buildSyncBody(origSubject, loanName, { added, cleared, addedList, clearedList }) {
  const lines = [
    `Original email: ${origSubject || '(unknown)'}`,
    `Loan: ${loanName}`,
    '',
    'Synced to Notion.'
  ];

  if (added) {
    lines.push('', `Added (${added}):`);
    addedList.forEach((c, i) => lines.push(`  ${i + 1}. ${c}`));
  }
  if (cleared) {
    lines.push('', `Cleared (${cleared}):`);
    clearedList.forEach((c, i) => lines.push(`  ${i + 1}. ${c}`));
  }

  return lines.join('\n');
}

async function sendToBothInboxes(subject, bodyText) {
  if (DRY_RUN) {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      action: 'email-suppressed-dry-run',
      subject,
      preview: bodyText.slice(0, 120)
    }));
    return;
  }

  const clients = getClients();
  await Promise.all(Object.values(clients).map(async (account) => {
    try {
      const raw = Buffer.from(
        `To: ${account.email}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${bodyText}`
      ).toString('base64url');
      await account.gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
      console.log(JSON.stringify({ ts: new Date().toISOString(), action: 'email-sent', inbox: account.label, subject }));
    } catch (err) {
      console.log(JSON.stringify({ ts: new Date().toISOString(), action: 'email-error', inbox: account.label, error: err.message }));
    }
  }));
}

// One email to John + Christy when Notion was updated. Subject = original email subject + action summary.
async function sendSyncNotification({ gmail, msgId, threadId, origSubject, loanName, result, inboxLabel }) {
  if (!result?.added && !result?.cleared) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), action: 'sync-email-skipped', reason: 'no-changes', loan: loanName }));
    return;
  }

  if (!gmail) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), action: 'sync-email-skipped', reason: 'missing-gmail-context' }));
    return;
  }

  const subject = buildSyncSubject(origSubject, result);
  const bodyText = buildSyncBody(origSubject, loanName, result);

  if (DRY_RUN) {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      action: 'sync-email-suppressed-dry-run',
      inbox: inboxLabel,
      subject,
      body: bodyText.slice(0, 200)
    }));
    return;
  }

  const clients = getClients();
  const to = [clients.primary.email, clients.christy.email].filter(Boolean).join(', ');

  let messageId = '';
  let replyThreadId = threadId;
  if (msgId) {
    const meta = await gmail.users.messages.get({
      userId: 'me',
      id: msgId,
      format: 'metadata',
      metadataHeaders: ['Message-ID', 'Subject']
    });
    const headers = meta.data.payload?.headers ?? [];
    messageId = getHeader(headers, 'Message-ID');
    replyThreadId = replyThreadId || meta.data.threadId;
  }

  const lines = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8'
  ];
  if (messageId) {
    lines.push(`In-Reply-To: ${messageId}`);
    lines.push(`References: ${messageId}`);
  }
  lines.push('', bodyText);

  const raw = Buffer.from(lines.join('\r\n')).toString('base64url');
  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw, threadId: replyThreadId }
  });
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    action: 'sync-email-sent',
    inbox: inboxLabel,
    to,
    subject,
    added: result.added,
    cleared: result.cleared
  }));
}

module.exports = { sendToBothInboxes, sendSyncNotification, buildSyncSubject, buildSyncBody };
