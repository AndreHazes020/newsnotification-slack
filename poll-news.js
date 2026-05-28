const fs = require('fs/promises');

const API_BASE = 'https://sumthing-api.com/v2/news';
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const STATE_FILE = './posted-ids.json';
const PAGE_SIZE = 25;

async function loadPosted() {
  try { return new Set(JSON.parse(await fs.readFile(STATE_FILE, 'utf8'))); }
  catch { return new Set(); }
}
const savePosted = (set) => fs.writeFile(STATE_FILE, JSON.stringify([...set]));

const isPublished = (item) => new Date(item.publishedAt).getTime() <= Date.now();

async function postToSlack(item) {
  const payload = {
    text: `:newspaper: *${item.author?.username ?? 'Unknown'}*\n${item.text}`,
  };
  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Slack ${res.status}: ${await res.text()}`);
}

async function run() {
  const posted = await loadPosted();
  let page = 1, total = Infinity;

  while ((page - 1) * PAGE_SIZE < total) {
    const res = await fetch(`${API_BASE}?pageNumber=${page}&pageSize=${PAGE_SIZE}`);
    if (!res.ok) throw new Error(`API ${res.status}`);
    const { data, metaData } = await res.json();
    total = metaData.total;
    if (!data?.length) break;

    for (const item of data) {
      if (!isPublished(item)) continue;   // not verstreken yet
      if (posted.has(item.id)) continue;  // already announced
      await postToSlack(item);
      posted.add(item.id);
    }
    page++;
  }
  await savePosted(posted);
}

run().catch((e) => { console.error(e); process.exit(1); });
