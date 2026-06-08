// Full implementation in Step 6
async function handle({ subject, from, body }) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), handler: 'pre-approval', subject, from }));
}
module.exports = { process: handle };
