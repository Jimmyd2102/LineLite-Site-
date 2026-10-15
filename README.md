# LineLite-Site

The linelite.net website. It runs on a Cloudflare Worker (`billowing-tooth-cf1a`) with static files and a D1 database for form submissions.

## What's in here

```
public/                 The website (plain HTML/CSS/JS, served as static files)
  index.html            Home page
  apply/                Job application form
  request-a-bid/        Client intake / bid request form
  privacy-policy/       Privacy policy
  css/site.css          All styles
  js/site.js            Menu, animations
  js/forms.js           Sends both forms to the API
  img/                  Photos + logo (already compressed for the web)
src/worker.js           Saves form submissions to D1, admin page, old-URL redirects
wrangler.jsonc          Cloudflare config (Worker name, D1 binding)
```

## Where submissions go

- Both forms save to the D1 database `linelite-forms` (tables `applications` and `bid_requests`). The tables are created automatically on the first submission.
- View them at **https://linelite.net/admin**. Any username works; the password is the `ADMIN_PASSWORD` secret. There's a **Download CSV** button on each tab.
- Optional email alerts: add a `RESEND_API_KEY` secret (free account at resend.com) and every submission is emailed to `NOTIFY_TO` (set in `wrangler.jsonc`, currently info@linelite.net). To send from an @linelite.net address, verify the domain in Resend and add a `NOTIFY_FROM` variable such as `LineLite Website <forms@linelite.net>`.

## One-time setup in Cloudflare

1. **Create the database:** Storage & Databases → D1 SQL Database → Create → name it `linelite-forms`. Copy its **Database ID** into `wrangler.jsonc` where it says `PASTE_D1_DATABASE_ID_HERE`, and commit.
2. **Connect this repo:** Workers & Pages → `billowing-tooth-cf1a` → Settings → Build → Connect to Git → pick `Jimmyd2102/LineLite-Site-`, branch `main`. Leave the build command empty; deploy command is `npx wrangler deploy`.
3. **Set the admin password:** same Worker → Settings → Variables and Secrets → Add → type **Secret**, name `ADMIN_PASSWORD`.
4. Push to `main` (or retry the build). Every push to `main` now deploys the site automatically.

## Editing

- Change text or photos in `public/`, commit, push. Cloudflare redeploys in about a minute.
- Run it locally: `npm install`, then `npx wrangler dev` (uses a local copy of the database). Put `ADMIN_PASSWORD="anything"` in a `.dev.vars` file to try `/admin` locally.
