# Feedback relay

The game is a static site with no server, so it can't hold the Notion key or send email itself. `feedback-relay.gs`
is a small Google Apps Script web app that does both, running under the owner's Google account. The game's
"Send feedback" form posts to it. Each message becomes a ticket in the Shanghai Game Backlog, in the **User feedback**
column (Status) with the **User feedback** theme. Photos go to a Drive folder only the owner can open, and the owner
gets an email with a link to the ticket.

This folder isn't published with the site; it's only kept here so the script is versioned.

## Setup (about 10 minutes)

### 1. Let the relay into your Notion backlog

1. Go to <https://www.notion.so/profile/integrations> and choose **New integration**.
2. Name it "Shanghai feedback", pick your workspace, leave the type as **Internal**, and save.
3. On the integration's page, copy the **Internal Integration Secret**. That's the Notion key for step 2.
4. Open the **Shanghai Game Backlog** database in Notion, click **•••** at the top right, then **Connections**, find
   "Shanghai feedback" and confirm. Without this the relay can't add tickets.

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
3. Copy the **Web app URL** (it ends in `/exec`). Opening it in a browser should say the relay is running.
4. That URL goes in `FEEDBACK_URL` at the top of `js/main.js`.

## Later

- **Changing the script:** after saving, use **Deploy** → **Manage deployments** → edit (pencil) → **Version: New
  version** → **Deploy**. That keeps the same URL. A *new* deployment gets a new URL.
- **If the address is ever abused** (junk tickets): make a new deployment, put its URL in the game, and archive the
  old one under **Manage deployments**. The relay already caps messages at 4,000 characters, 3 photos of up to 3 MB,
  and 20 messages an hour.
- **Changing the Notion key:** make a new secret on the integration's page and update `NOTION_TOKEN`.
