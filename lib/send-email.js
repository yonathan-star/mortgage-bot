require('dotenv').config();
const { getClients } = require('./gmail-client');

const DRY_RUN = process.env.DRY_RUN === 'true';

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
  for (const account of Object.values(clients)) {
    try {
      const raw = Buffer.from(
        `To: ${account.email}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${bodyText}`
      ).toString('base64url');
      await account.gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
      console.log(JSON.stringify({ ts: new Date().toISOString(), action: 'email-sent', inbox: account.label, subject }));
    } catch (err) {
      console.log(JSON.stringify({ ts: new Date().toISOString(), action: 'email-error', inbox: account.label, error: err.message }));
    }
  }
}

module.exports = { sendToBothInboxes };
