const fs = require('fs/promises');

const API_BASE = process.env.API_BASE || 'https://sumthing-api.com/v2/news';
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const SITE_BASE = process.env.SITE_BASE || 'https://www.sumthing.org';
const STATE_FILE = './posted-ids.json';
const PAGE_SIZE = 25;
const SEED = process.env.SEED === 'true';    // record IDs without posting
const POST_DELAY_MS = 1200;                   // stay under Slack's ~1/sec limit

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadPosted() {
  try { return new Set(JSON.parse(await fs.readFile(STATE_FILE, 'utf8'))); }
  catch { return new Set(); }
}
const savePosted = (set) => fs.writeFile(STATE_FILE, JSON.stringify([...set]));

const isPublished = (item) => new Date(item.publishedAt).getTime() <= Date.now();

// Platform link: {SITE_BASE}/impact/related/{storyRef}
function newsUrl(item) {
  const story = item.storyRefs?.[0];
  if (!story) return null;
  return `${SITE_BASE}/impact/related/${story}`;
}

// First gallery image, else a Mux video thumbnail
function imageFor(item) {
  if (item.imageUrlGallery?.length) return item.imageUrlGallery[0];
  if (item.video?.playbackRef) {
    const t = item.video.thumbnailTime ?? 0;
    return `https://image.mux.com/${item.video.playbackRef}/thumbnail.jpg?time=${t}`;
  }
  return null;
}

// Plain escape for fields without Markdown (e.g. author name)
const escapeMrkdwn = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Convert Markdown links [label](url) to Slack <url|label>, escape the rest.
function formatText(raw) {
  if (!raw) return '';
  const links = [];
  const placeheld = raw.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
    links.push({ label, url });
    return `\u0000L${links.length - 1}\u0000`;
  });
  const escaped = placeheld
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped.replace(/\u0000L(\d+)\u0000/g, (_, i) => {
    const { label, url } = links[Number(i)];
    const safeLabel = label
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<${url}|${safeLabel}>`;
  });
}

function buildPayload(item) {
  const url = newsUrl(item);
  const author = escapeMrkdwn(item.author?.username ?? 'Unknown');
  const text = formatText(item.text);
  const blocks = [{
    type: 'section',
    text: { type: 'mrkdwn', text: `*${author}*\n${text}` },
  }];

  const img = imageFor(item);
  if (img) blocks.push({ type: 'image', image_url: img, alt_text: 'update media' });
  if (url) blocks.push({ type: 'context',
    elements: [{ type: 'mrkdwn', text: `<${url}|View on Sumthing →>` }] });

  return { text: `New update from ${author}`, blocks };
}

async function sendPayload(payload) {
  const body = JSON.stringify(payload);
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    if (res.ok) return { ok: true };
    if (res.status === 429) {
      const wait = (Number(res.headers.get('retry-after')) || 1) * 1000;
      await sleep(wait + 250);
      continue;
    }
    return { ok: false, status: res.status, text: await res.text() };
  }
  return { ok: false, status: 429, text: 'rate-limited after retries' };
}

async function postToSlack(item) {
  const payload = buildPayload(item);
  let r = await sendPayload(payload);

  // Slack rejected the blocks — almost always a bad image URL. Retry without images.
  if (!r.ok && r.status === 400 && /invalid_blocks/.test(r.text)) {
    console.warn(`Image rejected for item ${item.id}; retrying without image.`);
    const stripped = { ...payload, blocks: payload.blocks.filter((b) => b.type !== 'image') };
    r = await sendPayload(stripped);
  }

  if (!r.ok) throw new Error(`Slack ${r.status}: ${r.text}`);
}

async function run() {
  const posted = await loadPosted();
  const pending = [];
  let page = 1, total = Infinity;

  // Gather every new, already-published item across all pages first.
  while ((page - 1) * PAGE_SIZE < total) {
    const res = await fetch(`${API_BASE}?pageNumber=${page}&pageSize=${PAGE_SIZE}`);
    if (!res.ok) throw new Error(`API ${res.status}`);
    const { data, metaData } = await res.json();
    total = metaData.total;
    if (!data?.length) break;

    for (const item of data) {
      if (!isPublished(item)) continue;   // scheduled for later — skip until it's live
      if (posted.has(item.id)) continue;  // already sent
      pending.push(item);
    }
    page++;
  }

  // Post oldest → newest so the most recent update lands as the latest Slack
  // message, no matter what order the API returns pages in.
  pending.sort((a, b) => new Date(a.publishedAt) - new Date(b.publishedAt));

  for (const item of pending) {
    if (!SEED) {
      await postToSlack(item);
      await sleep(POST_DELAY_MS);
    }
    posted.add(item.id);
    await savePosted(posted);   // survives a crash
  }
  await savePosted(posted);
}

run().catch((e) => { console.error(e); process.exit(1); });
