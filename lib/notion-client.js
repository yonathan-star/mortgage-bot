require('dotenv').config();

const TOKEN = process.env.NOTION_TOKEN;
const BASE  = 'https://api.notion.com/v1';
const HEADERS = {
  'Authorization':  `Bearer ${TOKEN}`,
  'Notion-Version': '2022-06-28',
  'Content-Type':   'application/json'
};

async function notionFetch(method, path, body) {
  const opts = { method, headers: HEADERS };
  if (body) opts.body = JSON.stringify(body);
  const res  = await fetch(`${BASE}${path}`, opts);
  const json = await res.json();
  if (!res.ok) throw new Error(json.message ?? JSON.stringify(json));
  return json;
}

// Query a database with a filter
async function queryDatabase(databaseId, filter) {
  return notionFetch('POST', `/databases/${databaseId}/query`, filter ? { filter } : {});
}

// Create a page in a database
async function createPage(databaseId, properties) {
  return notionFetch('POST', '/pages', {
    parent: { database_id: databaseId },
    properties
  });
}

// Update a page's properties
async function updatePage(pageId, properties) {
  return notionFetch('PATCH', `/pages/${pageId}`, { properties });
}

// Archive (delete) a page
async function archivePage(pageId) {
  return notionFetch('PATCH', `/pages/${pageId}`, { archived: true });
}

module.exports = { queryDatabase, createPage, updatePage, archivePage };
