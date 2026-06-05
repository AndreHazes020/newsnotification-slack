const fs = require('fs/promises');

const API_BASE = process.env.API_BASE || 'https://sumthing-api.com/v2/news';
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const SITE_BASE = process.env.SITE_BASE || 'https://www.sumthing.org';
const STATE_FILE = './posted-ids.json';
const PAGE_SIZE = 100;   // API maximum — the endpoint has no sort, so every run
                         // must sweep all items; fewer requests means less chance
                         // the order shifts mid-sweep and an item is missed.
const SEED = process.env.SEED === 'true';    // record IDs without posting
// One-off maintenance: re-send the N most recently created items even if they're
// already in posted-ids.json (e.g. to surface updates that were only seeded).
const REPOST_RECENT = Math.max(0, Number(process.env.REPOST_RECENT) || 0);
const POST_DELAY_MS = 1200;                   // stay under Slack's ~1/sec limit

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadPosted() {
  try { return new Set(JSON.parse(await fs.readFile(STATE_FILE, 'utf8'))); }
  catch { return new Set(); }
}
const savePosted = (set) => fs.writeFile(STATE_FILE, JSON.stringify([...set]));

// API timestamps are ISO 8601 (e.g. "2026-03-01T00:00:00.000Z").
const toEpoch = (value) => new Date(value).getTime();

// publishedAt is the item's editorial date and is often backdated, so it only
// tells us whether an item should be live yet — not how recently it was added.
const isPublished = (item) => {
  const t = toEpoch(item.publishedAt);
  // Unparseable/absent date: treat as live so a new update is never dropped.
  return Number.isNaN(t) ? true : t <= Date.now();
};

// "Recency" for ordering: when the item actually appeared on the platform.
// createdAt — not the backdated publishedAt — is what makes an update "latest".
const recencyOf = (item) => {
  const t = toEpoch(item.createdAt ?? item.publishedAt);
  return Number.isNaN(t) ? 0 : t;
};

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
  const published = [];
  let page = 1, total = Infinity;

  // Gather every already-published item across all pages first.
  while ((page - 1) * PAGE_SIZE < total) {
    const res = await fetch(`${API_BASE}?pageNumber=${page}&pageSize=${PAGE_SIZE}`);
    if (!res.ok) throw new Error(`API ${res.status}`);
    const { data, metaData } = await res.json();
    total = metaData.total;
    if (!data?.length) break;

    for (const item of data) {
      if (!isPublished(item)) continue;   // scheduled for later — skip until it's live
      published.push(item);
    }
    page++;
  }

  // Normally: post items we haven't sent yet. In REPOST_RECENT mode: ignore the
  // sent-list and re-send the N most recently created items (used to surface
  // updates that were only seeded and never actually posted).
  const pending = REPOST_RECENT
    ? [...published].sort((a, b) => recencyOf(b) - recencyOf(a)).slice(0, REPOST_RECENT)
    : published.filter((item) => !posted.has(item.id));

  // Post oldest → newest by when each item was added to the platform (createdAt),
  // so the most recently created update lands as the latest Slack message —
  // regardless of the order the API returns pages in, or how publishedAt is
  // backdated to an editorial date.
  pending.sort((a, b) => recencyOf(a) - recencyOf(b));

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
