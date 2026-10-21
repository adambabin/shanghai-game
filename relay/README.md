# Feedback relay

The game is a static site with no server, so it can't hold the Notion key or send email itself. `feedback-relay.gs`
is a small Google Apps Script web app that does both, running under the owner's Google account. The game's
"Send feedback" form posts to it. Each message becomes a ticket in the Shanghai Game Backlog, in the **User feedback**
column (Status) with the **User feedback** theme, and any photos show right on the ticket. The owner gets an email with
a link to the ticket. (If Notion ever won't take a photo, it's kept in a Drive folder only the owner can open and
linked from the ticket instead.)

This folder isn't published with the site; it's only kept here so the script is versioned.

## Setup (about 10 minutes)

### 1. Let the relay into your Notion backlog

Notion calls these "connections" now (they used to be "integrations"). Only a workspace owner can make one.

1. In Notion's **Developer tools** (Settings → Connections → Develop your own connections), open the **Connections**
   tab and choose **New connection**.
2. Name it "Shanghai feedback" and pick **API token** as the authentication method (not OAuth), then **Create
   connection**.
3. Copy the connection's token. That's the Notion key for step 2. (Skip "Personal access tokens": those act as you,
   with access to everything you can see.)
4. Give the connection the backlog and nothing else: open the **Shanghai Game Backlog** database, click **•••** at the
   top right, then **Connections**, find "Shanghai feedback" and confirm. Without this the relay can't add tickets.

### 2. Create the relay

1. Go to <https://script.google.com>, signed in to the Google account that should own the photos and send the
   emails, and choose **New project**.
2. Delete the sample code, paste in all of `feedback-relay.gs`, rename the project "Shanghai feedback relay", and
   save.
3. Open **Project Settings** (the gear on the left). Under **Script properties** add two:
   - `NOTION_TOKEN`: the secret from step 1.3
   - `NOTIFY_EMAIL`: the address the notification emails should go to

### 3. Test it

1. Back in the **Editor**, pick `testSetup` in the function menu at the top and press **Run**.
2. Google asks for permission. Choose your account. It warns that Google hasn't verified the app, which is normal for
   your own script: choose **Advanced**, then **Go to Shanghai feedback relay**, then **Allow**. It needs Drive (for
   photos), email (to notify you) and outside connections (to reach Notion).
3. A "Setup test" ticket should appear in the **User feedback** column and an email should arrive. Delete the test
   ticket.

### 4. Put it online

1. Choose **Deploy** → **New deployment**. Click the gear next to "Select type" and choose **Web app**.
2. Set **Execute as: Me** and **Who has access: Anyone**, then **Deploy**.
3. Copy the **Web app URL** (it ends in `/exec`). Opening it in a private tab should say the relay is running.
4. That URL goes in `FEEDBACK_URL` at the top of `js/main.js`.

If a Google page says "Sorry, unable to open the file at this time" during permission or deploy, the browser is
signed in to more than one Google account and the pop-up picked the wrong one. Check **Manage deployments** in case it
worked anyway; otherwise retry in a private tab signed in to just the account that owns the script.

## Later

- **Updating to a new version of the script** (like the one that puts photos on the ticket): open the project, select
  all the code and paste in the new `feedback-relay.gs`, save, then **Deploy** → **Manage deployments** → edit
  (pencil) → **Version: New version** → **Deploy**. Run `testSetup` once to check: the test ticket should show a small
  green square.
- **Changing the script:** after saving, use **Deploy** → **Manage deployments** → edit (pencil) → **Version: New
  version** → **Deploy**. That keeps the same URL. A *new* deployment gets a new URL.
- **If the address is ever abused** (junk tickets): make a new deployment, put its URL in the game, and archive the
  old one under **Manage deployments**. The relay already caps messages at 4,000 characters, 3 photos of up to 3 MB,
  and 20 messages an hour.
- **Changing the Notion key:** make a new secret on the integration's page and update `NOTION_TOKEN`.
