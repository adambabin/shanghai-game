// Shanghai feedback relay: a Google Apps Script web app that the game's "Send feedback" form posts to.
// It files each message as a ticket in the Shanghai Game Backlog (Status and Theme: User feedback) with any photos
// shown right on the ticket, and emails the owner a link. A photo Notion won't take is kept in a Drive folder only
// the owner can open and linked from the ticket instead. The Notion key and the email
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

// photos arrive as { type: 'image/jpeg', data: <base64> }, already shrunk by the game. Each becomes either
// { upload: <Notion file upload id> } to show on the ticket, or { link: <Drive URL> } if Notion wouldn't take it.
function savePhotos(photos, name) {
  const saved = [];
  photos.slice(0, MAX_PHOTOS).forEach((p, i) => {
    if (!p || typeof p.data !== 'string' || !/^image\/(jpeg|png|webp)$/.test(p.type)) return;
    const bytes = Utilities.base64Decode(p.data);
    if (bytes.length > MAX_PHOTO_BYTES) return;
    const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HHmm');
    const ext = p.type.split('/')[1].replace('jpeg', 'jpg');
    const blob = Utilities.newBlob(bytes, p.type, `${stamp} ${name} ${i + 1}.${ext}`);
    try {
      saved.push({ upload: uploadToNotion(blob) });
    } catch (err) {
      console.error(err);
      saved.push({ link: photoFolder().createFile(blob).getUrl() });
    }
  });
  return saved;
}

// Notion's file uploads: create an upload, then send the file to it. The id goes in an image block on the ticket.
function uploadToNotion(blob) {
  const headers = { Authorization: 'Bearer ' + settings().token, 'Notion-Version': NOTION_VERSION };
  const created = UrlFetchApp.fetch('https://api.notion.com/v1/file_uploads', {
    method: 'post',
    contentType: 'application/json',
    headers,
    payload: JSON.stringify({ filename: blob.getName(), content_type: blob.getContentType() }),
    muteHttpExceptions: true,
  });
  if (created.getResponseCode() >= 300) throw new Error('Notion upload: ' + created.getContentText());
  const id = JSON.parse(created.getContentText()).id;
  // a payload object holding a blob is sent as multipart/form-data, which is what Notion expects here
  const sent = UrlFetchApp.fetch(`https://api.notion.com/v1/file_uploads/${id}/send`, {
    method: 'post',
    headers,
    payload: { file: blob },
    muteHttpExceptions: true,
  });
  if (sent.getResponseCode() >= 300) throw new Error('Notion upload: ' + sent.getContentText());
  return id;
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
  photos.forEach((photo, i) =>
    children.push(
      photo.upload
        ? { object: 'block', type: 'image', image: { type: 'file_upload', file_upload: { id: photo.upload } } }
        : paragraph(`Photo ${i + 1}`, photo.link)
    )
  );

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

// Run this from the editor (select it, then Run): it asks for permission, then files a test ticket with a small
// test picture and emails you, so you can see the whole thing works before the game uses it. Delete the test
// ticket afterwards.
function testSetup() {
  // a tiny green square, sent the same way the game sends photos
  const square = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR42mPQWxBFEmIY1TCqYfhqAAAxmygQxiQWKgAAAABJRU5ErkJggg==';
  const photos = savePhotos([{ type: 'image/png', data: square }], 'Setup test');
  console.log(photos[0].upload ? 'The picture went to Notion.' : 'Notion did not take the picture; it went to Drive: ' + photos[0].link);
  const url = createTicket('Setup test', 'This is a test from the feedback relay. You can delete it.', 'Apps Script editor', photos);
  notify('Setup test', 'This is a test from the feedback relay.', url);
  console.log('Test ticket: ' + url);
}
