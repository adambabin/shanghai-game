// Shanghai feedback relay: a Google Apps Script web app that the game's "Send feedback" form posts to.
// It files each message as a ticket in the Shanghai Game Backlog (Status and Theme: User feedback), saves any
// photos to a Drive folder only the owner can open, and emails the owner a link. The Notion key and the email
// address live in this project's Script properties, never in the game. Setup steps: relay/README.md.

const NOTION_DATABASE_ID = 'acdc8b80-41f7-46ab-88d5-dde918f7cdb4'; // Shanghai Game Backlog
const NOTION_VERSION = '2022-06-28';
const FEEDBACK = 'User feedback'; // the Status column and the Theme the tickets get
const PHOTO_FOLDER = 'Shanghai feedback photos';

// limits that keep a stranger who finds this address from flooding the backlog
const MAX_TEXT = 4000;
const MAX_PHOTOS = 3;
const MAX_PHOTO_BYTES = 3 * 1024 * 1024;
const MAX_PER_HOUR = 20;

// Opening the web app address in a browser shows this, so you can check it's live.
function doGet() {
  return ContentService.createTextOutput('The Shanghai feedback relay is running.');
}

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    // a hidden field people never see; simple bots fill it in
    if (data.website) return reply({ ok: true });
    const message = String(data.message || '').trim().slice(0, MAX_TEXT);
    if (!message) return reply({ ok: false, error: 'Write a message first.' });
    if (!underHourlyLimit()) return reply({ ok: false, error: 'Lots of feedback right now. Try again in a bit.' });
    const name = String(data.name || '').trim().slice(0, 40) || 'Someone';
    const device = String(data.device || '').slice(0, 300);
    const photos = savePhotos(Array.isArray(data.photos) ? data.photos : [], name);
    const pageUrl = createTicket(name, message, device, photos);
    notify(name, message, pageUrl);
    return reply({ ok: true });
  } catch (err) {
    console.error(err);
    return reply({ ok: false, error: "Couldn't send that. Try again later." });
  }
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function settings() {
  const p = PropertiesService.getScriptProperties();
  const token = p.getProperty('NOTION_TOKEN');
  const email = p.getProperty('NOTIFY_EMAIL');
  if (!token || !email) throw new Error('Add NOTION_TOKEN and NOTIFY_EMAIL under Project Settings → Script properties.');
  return { token, email };
}

function underHourlyLimit() {
  const cache = CacheService.getScriptCache();
  const key = 'count-' + Math.floor(Date.now() / 3600000);
  const n = Number(cache.get(key) || 0);
  if (n >= MAX_PER_HOUR) return false;
  cache.put(key, String(n + 1), 3700);
  return true;
}

function photoFolder() {
  const found = DriveApp.getFoldersByName(PHOTO_FOLDER);
  return found.hasNext() ? found.next() : DriveApp.createFolder(PHOTO_FOLDER);
}

// photos arrive as { type: 'image/jpeg', data: <base64> }, already shrunk by the game
function savePhotos(photos, name) {
  const saved = [];
  photos.slice(0, MAX_PHOTOS).forEach((p, i) => {
    if (!p || typeof p.data !== 'string' || !/^image\/(jpeg|png|webp)$/.test(p.type)) return;
    const bytes = Utilities.base64Decode(p.data);
    if (bytes.length > MAX_PHOTO_BYTES) return;
    const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HHmm');
    const file = photoFolder().createFile(Utilities.newBlob(bytes, p.type, `${stamp} ${name} ${i + 1}`));
    saved.push(file.getUrl());
  });
  return saved;
}

function paragraph(text, link) {
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: [{ type: 'text', text: { content: text, link: link ? { url: link } : null } }] },
  };
}

function createTicket(name, message, device, photos) {
  const firstLine = message.split('\n')[0];
  const title = `${name}: ${firstLine.length > 60 ? firstLine.slice(0, 57) + '…' : firstLine}`;
  const children = [];
  // Notion caps each block's text at 2000 characters
  for (let i = 0; i < message.length; i += 1900) children.push(paragraph(message.slice(i, i + 1900)));
  children.push(paragraph(`From ${name}${device ? ' · ' + device : ''}`));
  photos.forEach((url, i) => children.push(paragraph(`Photo ${i + 1}`, url)));

  const res = UrlFetchApp.fetch('https://api.notion.com/v1/pages', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + settings().token, 'Notion-Version': NOTION_VERSION },
    payload: JSON.stringify({
      parent: { database_id: NOTION_DATABASE_ID },
      properties: {
        Name: { title: [{ text: { content: title } }] },
        Status: { status: { name: FEEDBACK } },
        Theme: { multi_select: [{ name: FEEDBACK }] },
      },
      children,
    }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) throw new Error('Notion said: ' + res.getContentText());
  return JSON.parse(res.getContentText()).url;
}

function notify(name, message, pageUrl) {
  const preview = message.length > 300 ? message.slice(0, 297) + '…' : message;
  MailApp.sendEmail(settings().email, `Shanghai feedback from ${name}`, `${name} wrote:\n\n${preview}\n\nOpen it in Notion: ${pageUrl}`);
}

// Run this once from the editor (select it, then Run): it asks for permission, then files a test ticket and emails
// you, so you can see the whole thing works before the game uses it. Delete the test ticket afterwards.
function testSetup() {
  const url = createTicket('Setup test', 'This is a test from the feedback relay. You can delete it.', 'Apps Script editor', []);
  notify('Setup test', 'This is a test from the feedback relay.', url);
  console.log('Test ticket: ' + url);
}
