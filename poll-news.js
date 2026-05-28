const fs = require('fs/promises');

const API_BASE = process.env.API_BASE || 'https://sumthing-api.com/v2/news';
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const SITE_BASE = process.env.SITE_BASE || 'https://www.sumthing.org';
const STATE_FILE = './posted-ids.json';
const PAGE_SIZE = 25;
const SEED = process.env.SEED === 'true';   // record IDs without posting
const POST_DELAY_MS = 1200;                  // stay under Slack's ~1/sec limit

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadPosted() {
  try { return new Set(JSON.parse(await fs.readFile(STATE_FILE, 'utf8'))); }
  catch { return new Set(); }
}
const savePosted = (set) => fs.writeFile(STATE_FILE, JSON.stringify([...set]));

const isPublished = (item) => new Date(item.publishedAt).getTime() <= Date.now();

// Platform link: {SITE_BASE}/impact/{impactId}/updates/{slug}
function newsUrl(item) {
  const impactId = item.impactId ?? item.impact?.id;   // <-- field TBC, see note
  if (!impactId || !item.slug) return null;
  return `${SITE_BASE}/impact/${impactId}/updates/${item.slug}`;
}

// First gallery image, else a video thumbnail
function imageFor(item) {
  if (item.imageUrlGallery?.length) return item.imageUrlGallery[0];
  if (item.video?.playbackRef) {               // assumes Mux-hosted video
    const t = item.video.thumbnailTime ?? 0;
    return `https://image.mux.com/${item.video.playbackRef}/thumbnail.jpg?time=${t}`;
  }
  return null;
}

function buildPayload(item) {
  const url = newsUrl(item);
  // YouTube links unfurl into a playable preview on their own
  const yt = item.youtubeEmbedId
    ? `\nhttps://www.youtube.com/watch?v=${item.youtubeEmbedId}` : '';

  const blocks = [{
    type: 'section',
    text: { type: 'mrkdwn',
      text: `*${item.author?.username ?? 'Unknown'}*\n${item.text}${yt}` },
  }];

  const img = item.youtubeEmbedId ? null : imageFor(item);
  if (img) blocks.push({ type: 'image', image_url: img, alt_text: 'update media' });
  if (url) blocks.push({ type: 'context',
    elements: [{ type: 'mrkdwn', text: `<${url}|View on Sumthing →>` }] });

  return { text: `New update from ${item.author?.username ?? 'the field'}`, blocks };
}

async function postToSlack(item) {
  const body = JSON.stringify(buildPayload(item));
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    if (res.ok) return;
    if (res.status === 429) {                  // honor Slack's retry-after
      const wait = (Number(res.headers.get('retry-after')) || 1) * 1000;
      await sleep(wait + 250);
      continue;
    }
    throw new Error(`Slack ${res.status}: ${await res.text()}`);
  }
  throw new Error('Slack: still rate-limited after retries');
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
      if (!isPublished(item)) continue;
      if (posted.has(item.id)) continue;
      if (!SEED) {
        await postToSlack(item);
        await sleep(POST_DELAY_MS);
      }
      posted.add(item.id);
      await savePosted(posted);   // save after each one — survives a crash
    }
    page++;
  }
  await savePosted(posted);
}

run().catch((e) => { console.error(e); process.exit(1); });
