# PageFeed

Turn any web page into an RSS feed.

Paste a page address into the builder, it finds the repeating list of posts on that
page, and hands you a feed link you can drop into Feedly, Inoreader, NetNewsWire,
Reeder, Slack, or anything else that reads RSS. The feed is built fresh every time a
reader checks it, so new posts show up on their own.

It is one file, `worker.js`, with no dependencies and no build step. That file holds the
HTML parser, the CSS selector engine, the detector, the RSS writer, and the builder page.

## Put it online

Both hosts below run the same `worker.js` with no changes.

### Cloudflare Workers (fastest to set up)

1. Sign in at dash.cloudflare.com and go to **Workers & Pages**.
2. Click **Create** then **Create Worker**, name it `pagefeed`, and click **Deploy**.
3. Click **Edit code**, select everything in the editor, and paste in the contents of
   `worker.js`.
4. Click **Deploy**. Your site is live at `https://pagefeed.<your-subdomain>.workers.dev`.

One thing to know about the free plan: it stops a request after 10 milliseconds of
processing time. Reading a small page fits in that. A big news page does not, and you
will see a Cloudflare error instead of a feed. The Workers Paid plan is $5 a month and
raises that ceiling to 30 seconds, which is far more than this needs. If you would rather
not pay, use Deno Deploy below.

With the CLI instead of the dashboard: `npx wrangler deploy` (the included
`wrangler.toml` covers the settings).

### Deno Deploy (free, no per-request time limit)

1. Push this folder to GitHub.
2. At dash.deno.com, create a project, connect the repository, and set the entry point to
   `web-to-rss/worker.js`.
3. Deploy. The free plan covers 1 million requests and 10 hours of processing a month,
   which is thousands of feeds checked every hour.

## Using the builder

Open your site, paste a page address, and press **Check page**.

If the page already publishes its own RSS feed, PageFeed says so and shows you that link.
Use it. A publisher's own feed is always cleaner than one scraped off the page.

Otherwise you get the lists PageFeed found on the page, best guess first, each showing how
many items it holds and the first few headlines. Pick the one that looks right, check the
preview underneath, and copy the feed link.

**Fine-tune it** opens the manual controls for the cases where the guess is close but not
right. Each box takes a CSS selector, the same thing you get from "Copy selector" in a
browser's inspector:

- **Each item** is the block that repeats, for example `article.post` or `li.listing-item`.
- **Title**, **Link**, **Date**, **Summary** are read inside each item. Add `@href` or
  `@datetime` to read an attribute instead of the visible text, for example `h2 a@href`.
- Leave any of them empty and PageFeed works it out from the item.
- **Only items containing** drops anything that does not mention that word, which is handy
  for watching one topic on a busy page.

Supported selector pieces are tags, `.class`, `#id`, `[attribute]`, `[attribute="value"]`
(with `^=`, `$=`, `*=`, `~=`), descendants, and `>`. Things like `:nth-child` are not
supported, and PageFeed tells you when it cannot read a selector.

## The feed link

Everything lives in the address, so you can also write one by hand:

```
https://your-site/feed?url=https://example.com/news&item=article.post&limit=25
```

| Setting | What it does |
| --- | --- |
| `url` | The page to read. Required. |
| `item` | Selector for each item. Left out, PageFeed detects it on every fetch. |
| `title`, `link`, `date`, `desc` | Selectors read inside each item. |
| `limit` | How many items, up to 100. Default 25. |
| `q` | Keep only items mentioning this word. |
| `not` | Drop items mentioning this word. |
| `name` | Feed title in the reader. Defaults to the page title. |
| `dated=1` | Drop items with no readable date. |
| `ttl` | Seconds to cache, between 300 and 21600. Default 900. |

`/preview` and `/detect` take the same settings and answer with JSON, which is what the
builder page uses.

## What it cannot do

Pages that build their content in the browser with JavaScript arrive here empty, so there
is nothing to find. React and Vue sites often work this way. Sites that block automated
readers answer with a refusal, and PageFeed passes that message along rather than
pretending. Anything behind a login is out of reach.

Dates are the weak spot on scraped feeds. If a page shows no date, items carry no
publication date, and readers fall back to when they first saw the item. That still works
for following a page.

Addresses on private networks are refused, as are ports other than the normal web ones.

## Working on it

```
node server.mjs     # http://localhost:8787
npm test            # 27 tests, no dependencies
```

The tests cover the parser against deliberately broken markup, the selector engine, date
reading, the detector against three fixture pages, RSS escaping, the address guards, and
every endpoint end to end.

| File | What is in it |
| --- | --- |
| `worker.js` | Everything: parser, selectors, detection, RSS, and the builder page. |
| `server.mjs` | Runs the same worker on Node for local use. |
| `test/` | Tests and the fixture pages they read. |
| `wrangler.toml` | Settings for deploying with the Cloudflare CLI. |
