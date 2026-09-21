import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import worker, {
  parseHTML, queryAll, queryOne, textOf, cleanText, absoluteURL, parseDate,
  pickField, guessFields, detectCandidates, existingFeeds, buildItems, renderRSS,
  normalizeTarget, pageMeta, compileSelector,
} from '../worker.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, 'fixtures', name), 'utf8');

/* ---------- parser ---------- */

test('parses nesting, attributes and entities', () => {
  const root = parseHTML('<div id="a" class="x y"><p>Hello &amp; welcome &#8212; today</p></div>');
  const div = queryOne(root, '#a');
  assert.equal(div.tag, 'div');
  assert.equal(div.attrs.class, 'x y');
  assert.equal(cleanText(textOf(div)), 'Hello & welcome — today');
});

test('closes implied end tags', () => {
  const root = parseHTML('<ul><li>one<li>two<li>three</ul>');
  const items = queryAll(root, 'li');
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((li) => cleanText(textOf(li))), ['one', 'two', 'three']);
  assert.equal(items[1].parent.tag, 'ul');
});

test('ignores script contents and stray end tags', () => {
  const root = parseHTML('<div><script>if (1 < 2) { var s = "<div class=fake>"; }</script><b>real</b></div></span>');
  assert.equal(queryAll(root, '.fake').length, 0);
  assert.equal(cleanText(textOf(queryOne(root, 'div'))), 'real');
});

test('handles unquoted attributes, uppercase tags and > inside attribute values', () => {
  const root = parseHTML('<A HREF=/x TITLE="a > b">Link</A>');
  const a = queryOne(root, 'a');
  assert.equal(a.attrs.href, '/x');
  assert.equal(a.attrs.title, 'a > b');
});

test('void elements do not swallow their siblings', () => {
  const root = parseHTML('<div><img src="a.png"><br><span>after</span></div>');
  assert.equal(queryOne(root, 'span').parent.tag, 'div');
});

/* ---------- selectors ---------- */

test('supports descendant, child, class, id and attribute selectors', () => {
  const root = parseHTML(fixture('blog.html'));
  assert.equal(queryAll(root, 'article.post').length, 4);
  assert.equal(queryAll(root, '#content article').length, 4);
  assert.equal(queryAll(root, '.post-list > article').length, 4);
  assert.equal(queryAll(root, 'article.post.featured').length, 1);
  assert.equal(queryAll(root, 'a[href^="/posts/"]').length, 4);
  assert.equal(queryAll(root, 'time[datetime]').length, 4);
  assert.equal(queryAll(root, 'h2 a, time').length, 8);
});

test('rejects selectors it cannot read', () => {
  assert.throws(() => compileSelector('div:hover'), /Cannot read selector/);
});

/* ---------- field helpers ---------- */

test('resolves relative links against the page, including <base>', () => {
  assert.equal(absoluteURL('/a', 'https://x.com/b/c'), 'https://x.com/a');
  assert.equal(absoluteURL('javascript:void(0)', 'https://x.com'), '');
  assert.equal(absoluteURL('#section', 'https://x.com'), '');
  const root = parseHTML(fixture('cards.html'));
  const meta = pageMeta(root, 'https://press.example.com/', 'https://press.example.com/');
  assert.equal(meta.base, 'https://press.example.com/en/');
});

test('reads dates in the shapes pages actually use', () => {
  const now = new Date('2026-09-21T00:00:00Z');
  assert.equal(parseDate('2026-09-18T10:00:00Z').toISOString(), '2026-09-18T10:00:00.000Z');
  assert.equal(parseDate('September 18, 2026').getUTCFullYear(), 2026);
  assert.equal(parseDate('09/14/2026').toISOString().slice(0, 10), '2026-09-14');
  assert.equal(parseDate('Posted 3 days ago', now).toISOString().slice(0, 10), '2026-09-18');
  assert.equal(parseDate('2 hours ago', now).toISOString(), '2026-09-20T22:00:00.000Z');
  assert.equal(parseDate('no date here'), null);
  assert.equal(parseDate('1823-04-01'), null, 'implausible years are rejected');
});

test('pickField reads text or an attribute', () => {
  const item = queryOne(parseHTML(fixture('blog.html')), 'article.post');
  assert.equal(pickField(item, 'h2 a', 'https://ex.com/'), 'New hours at the Moanalua store');
  assert.equal(pickField(item, 'h2 a@href', 'https://ex.com/'), 'https://ex.com/posts/new-hours');
  assert.equal(pickField(item, 'time@datetime', 'https://ex.com/'), '2026-09-18T10:00:00Z');
  assert.equal(pickField(item, '.missing', 'https://ex.com/'), '');
});

test('guessFields finds the title, link and date without being told', () => {
  const item = queryOne(parseHTML(fixture('blog.html')), 'article.post');
  const guessed = guessFields(item, 'https://ex.com/');
  assert.equal(guessed.title, 'New hours at the Moanalua store');
  assert.equal(guessed.link, 'https://ex.com/posts/new-hours');
  assert.ok(parseDate(guessed.dateText));
  assert.match(guessed.description, /open until 9pm/);
});

/* ---------- detection ---------- */

test('picks the post list over the nav bar and the tag sidebar', () => {
  const root = parseHTML(fixture('blog.html'));
  const [best] = detectCandidates(root, 'https://ex.com/');
  assert.equal(best.count, 4);
  assert.equal(queryAll(root, best.selector).length, 4);
  assert.ok(best.selector.includes('article'), 'expected the article list, got ' + best.selector);
});

test('the generated selector is specific enough to match only the items', () => {
  for (const name of ['blog.html', 'cards.html', 'messy.html']) {
    const root = parseHTML(fixture(name));
    const [best] = detectCandidates(root, 'https://ex.com/');
    assert.ok(best, name + ': nothing detected');
    assert.equal(queryAll(root, best.selector).length, best.count, name + ': selector drifted');
  }
});

test('finds a feed the page already links to, ignoring oEmbed endpoints', () => {
  const root = parseHTML(fixture('messy.html'));
  const feeds = existingFeeds(root, 'https://gov.example.org/notices');
  assert.equal(feeds.length, 1);
  assert.equal(feeds[0].href, 'https://gov.example.org/notices.xml');

  const wp = parseHTML('<link rel="alternate" type="text/xml+oembed" href="/wp-json/oembed/1.0/embed?format=xml">' +
    '<link rel="alternate" type="application/json+oembed" href="/wp-json/oembed/1.0/embed">');
  assert.equal(existingFeeds(wp, 'https://blog.example/').length, 0);
});

test('the same list found two ways is offered once', () => {
  const row = (n, word) => '<tr class="a row"><td><a href="/' + n + '">' + word +
    ' permit notice filed with the county</a><span> posted last week by the clerk</span></td></tr>';
  const root = parseHTML('<table>' + row(1, 'First') + row(2, 'Second') + row(3, 'Third') + row(4, 'Fourth') + '</table>');
  const candidates = detectCandidates(root, 'https://ex.com/');
  assert.equal(candidates.length, 1, 'expected one choice, got ' + candidates.map((c) => c.selector).join(', '));
});

/* ---------- items ---------- */

test('builds items from messy markup', () => {
  const root = parseHTML(fixture('messy.html'));
  const { items } = buildItems(root, 'https://gov.example.org/notices');
  assert.equal(items.length, 4);
  assert.equal(items[0].title, 'Permit 1001 & parking variance');
  assert.equal(items[0].link, 'https://gov.example.org/n/1001');
  assert.equal(items[0].date.toISOString().slice(0, 10), '2026-09-14');
  assert.match(items[2].title, /hearing set/);
});

test('honours explicit selectors and the item limit', () => {
  const root = parseHTML(fixture('blog.html'));
  const { items, autoDetected } = buildItems(root, 'https://ex.com/', {
    item: 'article.post', title: 'h2 a', link: 'h2 a@href', date: 'time@datetime', desc: '.excerpt', limit: 2,
  });
  assert.equal(autoDetected, false);
  assert.equal(items.length, 2);
  assert.equal(items[1].title, 'Why the garlic rice changed');
  assert.equal(items[1].description, 'A different supplier, and a better grain for the teppan.');
});

test('filters, de-duplicates and can drop undated items', () => {
  const root = parseHTML(fixture('blog.html'));
  const filtered = buildItems(root, 'https://ex.com/', { item: 'article.post', include: 'garlic' });
  assert.equal(filtered.items.length, 1);

  const excluded = buildItems(root, 'https://ex.com/', { item: 'article.post', exclude: 'hiring' });
  assert.equal(excluded.items.length, 3);

  const doubled = buildItems(parseHTML('<div class=p><a href="/x">A</a></div>'.repeat(3) + '<div class=p><a href="/y">B</a></div>'),
    'https://ex.com/', { item: '.p' });
  assert.equal(doubled.items.length, 2, 'same link twice is one item');

  const undated = buildItems(parseHTML('<div class=p><a href="/x">A</a></div><div class=p><a href="/y">B</a></div>'),
    'https://ex.com/', { item: '.p', dropUndated: true });
  assert.equal(undated.items.length, 0);
});

test('relative dates in cards resolve against now', () => {
  const root = parseHTML(fixture('cards.html'));
  const now = new Date('2026-09-21T12:00:00Z');
  const { items } = buildItems(root, 'https://press.example.com/en/', { item: '.card' }, now);
  assert.equal(items.length, 4);
  assert.equal(items[0].link, 'https://press.example.com/en/r/1');
  assert.equal(items[0].date.toISOString(), '2026-09-21T10:00:00.000Z');
  assert.equal(items[1].date.toISOString().slice(0, 10), '2026-09-18');
});

/* ---------- RSS ---------- */

test('renders valid, escaped RSS', () => {
  const xml = renderRSS({
    title: 'Fish & Chips <News>',
    link: 'https://ex.com/news?a=1&b=2',
    description: 'Feed',
    selfUrl: 'https://feed.example/feed?url=https%3A%2F%2Fex.com',
    items: [{
      title: 'A "quoted" & <tagged> title',
      link: 'https://ex.com/1?x=1&y=2',
      description: 'Body & more',
      date: new Date('2026-09-18T10:00:00Z'),
      guid: 'https://ex.com/1?x=1&y=2',
    }, {
      title: 'No link', link: '', description: '', date: null, guid: 'pagefeed:abc',
    }],
    now: new Date('2026-09-21T00:00:00Z'),
  });

  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(xml.includes('<title>Fish &amp; Chips &lt;News&gt;</title>'));
  assert.ok(xml.includes('<link>https://ex.com/news?a=1&amp;b=2</link>'));
  assert.ok(xml.includes('<pubDate>Fri, 18 Sep 2026 10:00:00 GMT</pubDate>'));
  assert.ok(xml.includes('isPermaLink="true"'));
  assert.ok(xml.includes('isPermaLink="false"'));
  assert.equal((xml.match(/<item>/g) || []).length, 2);
  assert.ok(!/[<>&](?![a-z#]+;)/.test(xml.split('<title>')[2].split('</title>')[0]));
});

/* ---------- guards ---------- */

test('blocks private and non-web addresses', () => {
  assert.equal(normalizeTarget('example.com/news'), 'https://example.com/news');
  assert.equal(normalizeTarget('https://a.com/x#frag'), 'https://a.com/x');
  for (const bad of ['http://localhost/x', 'http://127.0.0.1/', 'http://192.168.1.1/', 'http://10.0.0.5/',
    'http://172.20.0.1/', 'http://box.local/', 'file:///etc/passwd', 'https://example.com:22/']) {
    assert.throws(() => normalizeTarget(bad), /blocked|http and https|address/, bad + ' should be refused');
  }
});

/* ---------- end to end through the worker ---------- */

function stubFetch(body, headers = { 'content-type': 'text/html' }) {
  globalThis.fetch = async () => new Response(body, { headers });
}

test('GET / serves the builder page', async () => {
  const res = await worker.fetch(new Request('https://feeds.example/'), {}, {});
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(html, /PageFeed/);
});

test('GET /detect reports candidates and existing feeds', async () => {
  stubFetch(fixture('messy.html'));
  const res = await worker.fetch(new Request('https://feeds.example/detect?url=https%3A%2F%2Fgov.example.org%2Fnotices'), {}, {});
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.feeds.length, 1);
  assert.ok(data.candidates.length >= 1);
  assert.equal(data.candidates[0].items.length, 4);
});

test('GET /feed returns RSS with the right content type', async () => {
  stubFetch(fixture('blog.html'));
  const res = await worker.fetch(new Request('https://feeds.example/feed?url=https%3A%2F%2Fex.com%2Fblog&item=article.post'), {}, {});
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/rss\+xml/);
  assert.match(res.headers.get('cache-control'), /max-age=900/);
  const xml = await res.text();
  assert.equal((xml.match(/<item>/g) || []).length, 4);
  assert.ok(xml.includes('https://ex.com/posts/new-hours'));
  assert.ok(xml.includes('<title>Island Eats</title>'));
});

test('a selector that matches nothing explains itself', async () => {
  stubFetch(fixture('blog.html'));
  const res = await worker.fetch(new Request('https://feeds.example/feed?url=https%3A%2F%2Fex.com&item=.nope'), {}, {});
  assert.equal(res.status, 422);
  assert.match(await res.text(), /matched nothing/);
});

test('an address that is already a feed is not re-wrapped', async () => {
  stubFetch('<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>',
    { 'content-type': 'application/rss+xml' });
  const res = await worker.fetch(new Request('https://feeds.example/preview?url=https%3A%2F%2Fex.com%2Frss'), {}, {});
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /already a feed/);
});

test('unreachable pages come back as a plain message, not a stack trace', async () => {
  globalThis.fetch = async () => { throw new Error('boom'); };
  const res = await worker.fetch(new Request('https://feeds.example/detect?url=https%3A%2F%2Fex.com'), {}, {});
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /could not be reached/);
});
