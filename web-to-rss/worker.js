/*
 * PageFeed — turn any web page into an RSS feed.
 *
 * One file, no dependencies. Deploy it as a Cloudflare Worker (paste it into the
 * dashboard editor) and it serves both the builder UI and the live feeds:
 *
 *   GET /                 the builder page
 *   GET /detect?url=...   JSON: what the auto-detector found on that page
 *   GET /preview?...      JSON: the items a given set of selectors produces
 *   GET /feed?...         the RSS 2.0 feed itself (this is the URL you subscribe to)
 *
 * Everything below the parser is plain JavaScript, so the same file also runs
 * under Node for the tests in test/.
 */

/* ------------------------------------------------------------------ *
 * 1. HTML parser
 *
 * A small forgiving tokenizer. Real pages leave tags unclosed, so the
 * open-element stack applies the usual implied-end-tag rules instead of
 * trusting the markup.
 * ------------------------------------------------------------------ */

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr']);

// Content of these is text, not markup.
const RAW_TAGS = new Set(['script', 'style', 'textarea', 'title']);
// ...and of these we throw the text away.
const DROP_TEXT_TAGS = new Set(['script', 'style', 'noscript', 'svg', 'template']);

const BLOCK_TAGS = new Set(['address', 'article', 'aside', 'blockquote', 'br', 'div', 'dl',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'tbody', 'td',
  'tfoot', 'th', 'thead', 'tr', 'ul']);

function impliesEnd(open, next) {
  if (open === 'p') return BLOCK_TAGS.has(next);
  if (open === 'li') return next === 'li';
  if (open === 'dt' || open === 'dd') return next === 'dt' || next === 'dd';
  if (open === 'option') return next === 'option' || next === 'optgroup';
  if (open === 'td' || open === 'th') return next === 'td' || next === 'th' || next === 'tr';
  if (open === 'tr') return next === 'tr';
  if (open === 'thead' || open === 'tbody') return next === 'tbody' || next === 'tfoot';
  return false;
}

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '', ensp: ' ', emsp: ' ',
  thinsp: ' ', ndash: '–', mdash: '—', hellip: '…', lsquo: '‘',
  rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  middot: '·', bull: '•', copy: '©', reg: '®', trade: '™',
  deg: '°', euro: '€', pound: '£', yen: '¥', cent: '¢',
  sect: '§', para: '¶', dagger: '†', prime: '′', times: '×',
};

function decodeEntities(str) {
  if (str.indexOf('&') === -1) return str;
  return str.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return m;
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    const hit = NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()];
    return hit === undefined ? m : hit;
  });
}

function makeElement(tag, attrs, parent) {
  return { type: 'element', tag, attrs, children: [], parent };
}

function parseAttrs(src) {
  const attrs = {};
  const re = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g;
  let m;
  while ((m = re.exec(src))) {
    const name = m[1].toLowerCase();
    if (!name || name === '/') continue;
    const raw = m[2] ?? m[3] ?? m[4] ?? '';
    attrs[name] = decodeEntities(raw);
  }
  return attrs;
}

/** Scan for </tag ...> from `from`, without copying the rest of the document. */
function findClosingTag(html, from, tag) {
  let pos = from;
  while (pos < html.length) {
    const lt = html.indexOf('</', pos);
    if (lt === -1) break;
    const name = html.slice(lt + 2, lt + 2 + tag.length).toLowerCase();
    if (name === tag) {
      const gt = html.indexOf('>', lt + 2 + tag.length);
      if (gt === -1) break;
      if (!html.slice(lt + 2 + tag.length, gt).trim()) return { start: lt, end: gt + 1 };
    }
    pos = lt + 2;
  }
  return { start: html.length, end: html.length };
}

/** Parse an HTML string into a lightweight tree. */
export function parseHTML(html) {
  const root = makeElement('#document', {}, null);
  let current = root;
  const stack = [root];
  let i = 0;
  const len = html.length;

  const pushText = (raw, drop) => {
    if (drop) return;
    const text = decodeEntities(raw);
    if (!text) return;
    current.children.push({ type: 'text', text, parent: current });
  };

  const closeTo = (tag) => {
    for (let s = stack.length - 1; s > 0; s--) {
      if (stack[s].tag === tag) {
        stack.length = s;
        current = stack[s - 1];
        return true;
      }
    }
    return false; // stray end tag
  };

  while (i < len) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      pushText(html.slice(i), DROP_TEXT_TAGS.has(current.tag));
      break;
    }
    if (lt > i) pushText(html.slice(i, lt), DROP_TEXT_TAGS.has(current.tag));

    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end === -1 ? len : end + 3;
      continue;
    }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const end = html.indexOf('>', lt + 2);
      i = end === -1 ? len : end + 1;
      continue;
    }

    if (html.startsWith('</', lt)) {
      const end = html.indexOf('>', lt + 2);
      if (end === -1) { i = len; break; }
      const tag = html.slice(lt + 2, end).trim().toLowerCase().split(/[\s/]/)[0];
      if (tag) closeTo(tag);
      i = end + 1;
      continue;
    }

    const nameMatch = /^<([a-zA-Z][^\s/>]*)/.exec(html.slice(lt, lt + 80));
    if (!nameMatch) { pushText('<', DROP_TEXT_TAGS.has(current.tag)); i = lt + 1; continue; }
    const tag = nameMatch[1].toLowerCase();

    // Find the end of the open tag, ignoring > inside quoted attribute values.
    let p = lt + nameMatch[0].length;
    let quote = null;
    while (p < len) {
      const ch = html[p];
      if (quote) { if (ch === quote) quote = null; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '>') break;
      p++;
    }
    if (p >= len) { i = len; break; }
    const attrSrc = html.slice(lt + nameMatch[0].length, p);
    const selfClosing = attrSrc.trimEnd().endsWith('/');
    const attrs = parseAttrs(attrSrc);

    while (stack.length > 1 && impliesEnd(current.tag, tag)) {
      stack.pop();
      current = stack[stack.length - 1];
    }

    const el = makeElement(tag, attrs, current);
    current.children.push(el);
    i = p + 1;

    if (VOID_TAGS.has(tag) || selfClosing) continue;

    if (RAW_TAGS.has(tag)) {
      const close = findClosingTag(html, i, tag);
      if (!DROP_TEXT_TAGS.has(tag) && close.start > i) {
        el.children.push({ type: 'text', text: decodeEntities(html.slice(i, close.start)), parent: el });
      }
      i = close.end;
      continue;
    }

    stack.push(el);
    current = el;
  }

  return root;
}

/* ------------------------------------------------------------------ *
 * 2. Selector engine — tag, #id, .class, [attr op val], descendant,
 *    child (>) and comma groups. Enough for the selectors people
 *    actually copy out of devtools.
 * ------------------------------------------------------------------ */

function unescapeIdent(value) {
  return value.replace(/\\(.)/g, '$1');
}

function parseCompound(src) {
  const part = { tag: null, id: null, classes: [], attrs: [] };
  const re = /([a-zA-Z][\w-]*|\*)|#((?:[\w-]|\\.)+)|\.((?:[\w-]|\\.)+)|\[([^\]]+)\]/g;
  let m, consumed = 0;
  while ((m = re.exec(src))) {
    if (m.index !== consumed) throw new Error('Cannot read selector near "' + src.slice(consumed) + '"');
    consumed = m.index + m[0].length;
    if (m[1]) part.tag = m[1] === '*' ? null : m[1].toLowerCase();
    else if (m[2]) part.id = unescapeIdent(m[2]);
    else if (m[3]) part.classes.push(unescapeIdent(m[3]));
    else if (m[4]) {
      const am = /^\s*([\w-]+)\s*(?:([~^$*|]?=)\s*("([^"]*)"|'([^']*)'|[^\s\]]*)\s*)?$/.exec(m[4]);
      if (!am) throw new Error('Cannot read attribute selector "[' + m[4] + ']"');
      const value = am[4] ?? am[5] ?? am[3] ?? null;
      part.attrs.push({ name: am[1].toLowerCase(), op: am[2] || null, value });
    }
  }
  if (consumed !== src.length) throw new Error('Cannot read selector near "' + src.slice(consumed) + '"');
  return part;
}

/** Compile "a, .b > c d" into groups of {part, combinator} run right-to-left. */
export function compileSelector(selector) {
  const groups = [];
  for (const raw of String(selector).split(',')) {
    const text = raw.trim();
    if (!text) continue;
    const tokens = text.replace(/\s*>\s*/g, ' > ').split(/\s+/).filter(Boolean);
    const seq = [];
    let combinator = null;
    for (const token of tokens) {
      if (token === '>') { combinator = 'child'; continue; }
      seq.push({ part: parseCompound(token), combinator: combinator || (seq.length ? 'descendant' : null) });
      combinator = null;
    }
    if (seq.length) groups.push(seq);
  }
  if (!groups.length) throw new Error('Empty selector');
  return groups;
}

function matchesPart(node, part) {
  if (node.type !== 'element') return false;
  if (part.tag && node.tag !== part.tag) return false;
  if (part.id && node.attrs.id !== part.id) return false;
  if (part.classes.length) {
    const classes = node.attrs.class;
    if (!classes) return false;
    for (const c of part.classes) {
      if (classes === c) continue;
      const at = classes.indexOf(c);
      if (at === -1) return false;
      const before = at === 0 || /\s/.test(classes[at - 1]);
      const afterAt = at + c.length;
      const after = afterAt === classes.length || /\s/.test(classes[afterAt]);
      if (!before || !after) {
        if (!(' ' + classes + ' ').includes(' ' + c + ' ')) return false;
      }
    }
  }
  for (const a of part.attrs) {
    const actual = node.attrs[a.name];
    if (actual === undefined) return false;
    if (!a.op) continue;
    const want = a.value ?? '';
    if (a.op === '=' && actual !== want) return false;
    if (a.op === '*=' && !actual.includes(want)) return false;
    if (a.op === '^=' && !actual.startsWith(want)) return false;
    if (a.op === '$=' && !actual.endsWith(want)) return false;
    if (a.op === '~=' && !actual.split(/\s+/).includes(want)) return false;
    if (a.op === '|=' && actual !== want && !actual.startsWith(want + '-')) return false;
  }
  return true;
}

function matchesGroup(node, seq) {
  let index = seq.length - 1;
  if (!matchesPart(node, seq[index].part)) return false;
  let cursor = node;
  index--;
  while (index >= 0) {
    const step = seq[index + 1].combinator;
    if (step === 'child') {
      cursor = cursor.parent;
      if (!cursor || cursor.type !== 'element' || !matchesPart(cursor, seq[index].part)) return false;
    } else {
      let ancestor = cursor.parent;
      let found = null;
      while (ancestor && ancestor.type === 'element') {
        if (matchesPart(ancestor, seq[index].part)) { found = ancestor; break; }
        ancestor = ancestor.parent;
      }
      if (!found) return false;
      cursor = found;
    }
    index--;
  }
  return true;
}

export function walk(node, visit) {
  for (const child of node.children || []) {
    if (child.type === 'element') {
      if (visit(child) === false) return false;
      if (walk(child, visit) === false) return false;
    }
  }
  return true;
}

const SELECTOR_CACHE = new Map();

function compiled(selector) {
  if (typeof selector !== 'string') return selector;
  let groups = SELECTOR_CACHE.get(selector);
  if (!groups) {
    groups = compileSelector(selector);
    if (SELECTOR_CACHE.size > 500) SELECTOR_CACHE.clear();
    SELECTOR_CACHE.set(selector, groups);
  }
  return groups;
}

/** All elements under `root` matching a compiled or string selector. */
export function queryAll(root, selector, limit = 5000) {
  const groups = compiled(selector);
  const out = [];
  walk(root, (el) => {
    for (const seq of groups) {
      if (matchesGroup(el, seq)) {
        out.push(el);
        break;
      }
    }
    return out.length < limit;
  });
  return out;
}

export function queryOne(root, selector) {
  return queryAll(root, selector, 1)[0] || null;
}

/* ------------------------------------------------------------------ *
 * 3. Reading values out of the tree
 * ------------------------------------------------------------------ */

const SPACING_TAGS = new Set(['p', 'div', 'br', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'section', 'article', 'header', 'footer', 'blockquote', 'td', 'th']);

export function textOf(node) {
  if (!node) return '';
  if (node.type === 'text') return node.text;
  if (DROP_TEXT_TAGS.has(node.tag)) return '';
  let out = '';
  for (const child of node.children) {
    if (child.type === 'text') out += child.text;
    else {
      if (SPACING_TAGS.has(child.tag)) out += ' ';
      out += textOf(child);
      if (SPACING_TAGS.has(child.tag)) out += ' ';
    }
  }
  return out;
}

export function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function absoluteURL(href, base) {
  const value = cleanText(href);
  if (!value) return '';
  if (/^(javascript|mailto|tel|data):/i.test(value)) return '';
  if (value === '#' || value.startsWith('#')) return '';
  try { return new URL(value, base).toString(); } catch { return ''; }
}

const RELATIVE_UNITS = {
  second: 1e3, minute: 6e4, hour: 36e5, day: 864e5,
  week: 6048e5, month: 2592e6, year: 31536e6,
};

/** Best-effort date parsing: ISO, common written forms, and "3 hours ago". */
export function parseDate(value, now = new Date()) {
  const text = cleanText(value);
  if (!text) return null;

  const rel = /(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*(ago|old)/i.exec(text);
  if (rel) return new Date(now.getTime() - Number(rel[1]) * RELATIVE_UNITS[rel[2].toLowerCase()]);
  if (/^(just now|moments ago|now)$/i.test(text)) return new Date(now.getTime());
  if (/^(today|yesterday)$/i.test(text)) {
    const days = /yesterday/i.test(text) ? 1 : 0;
    return new Date(now.getTime() - days * RELATIVE_UNITS.day);
  }

  const candidates = [text];
  const iso = /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?/.exec(text);
  if (iso) candidates.push(iso[0]);
  const written = /(?:\d{1,2}\s+)?(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}|\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}/i.exec(text);
  if (written) candidates.push(written[0].replace(/(\d)(st|nd|rd|th)/i, '$1'));
  const slashed = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(text);
  if (slashed) candidates.push(`${slashed[3]}-${String(slashed[1]).padStart(2, '0')}-${String(slashed[2]).padStart(2, '0')}`);

  for (const candidate of candidates) {
    const ms = Date.parse(candidate);
    if (!Number.isFinite(ms)) continue;
    const date = new Date(ms);
    const year = date.getUTCFullYear();
    if (year < 1995 || year > now.getUTCFullYear() + 5) continue;
    return date;
  }
  return null;
}

/** Split "h2 a@href" into selector + attribute. */
function splitSpec(spec) {
  const text = cleanText(spec);
  if (!text) return null;
  const at = text.lastIndexOf('@');
  if (at > 0 && !text.slice(at).includes(']')) {
    return { selector: text.slice(0, at).trim() || '.', attr: text.slice(at + 1).trim() };
  }
  return { selector: text, attr: null };
}

/** Resolve a user-supplied field spec against one item element. */
export function pickField(item, spec, base) {
  const parsed = splitSpec(spec);
  if (!parsed) return '';
  const node = parsed.selector === '.' ? item : queryOne(item, parsed.selector);
  if (!node) return '';
  if (parsed.attr) {
    const raw = node.attrs[parsed.attr.toLowerCase()] || '';
    return parsed.attr.toLowerCase() === 'href' || parsed.attr.toLowerCase() === 'src'
      ? absoluteURL(raw, base) : cleanText(raw);
  }
  return cleanText(textOf(node));
}

const DATE_HINT = /(date|time|published|posted|meta|byline|timestamp|when)/i;

function itemLinks(item) {
  return queryAll(item, 'a').filter((a) => a.attrs.href);
}

/** Title / link / date / description when the user has not named selectors. */
export function guessFields(item, base) {
  const links = itemLinks(item);
  const fullText = cleanText(textOf(item));

  let title = '';
  for (const h of queryAll(item, 'h1, h2, h3, h4, h5, h6')) {
    const text = cleanText(textOf(h));
    if (text.length >= 3) { title = text; break; }
  }
  let titleNode = null;
  if (!title) {
    let best = '';
    for (const a of links) {
      const text = cleanText(textOf(a));
      if (text.length > best.length) { best = text; titleNode = a; }
    }
    title = best;
  }
  if (!title) title = fullText.slice(0, 120);

  let link = '';
  for (const a of links) {
    const href = absoluteURL(a.attrs.href, base);
    if (!href) continue;
    const text = cleanText(textOf(a));
    if (text && title && (text === title || title.startsWith(text) || text.startsWith(title))) { link = href; break; }
    if (!link) link = href;
  }
  if (!link && titleNode) link = absoluteURL(titleNode.attrs.href, base);

  let dateText = '';
  const timeEl = queryOne(item, 'time');
  if (timeEl) dateText = cleanText(timeEl.attrs.datetime || textOf(timeEl));
  if (!parseDate(dateText)) {
    dateText = '';
    const metaEl = queryOne(item, '[datetime], [data-date], [pubdate]');
    if (metaEl) dateText = cleanText(metaEl.attrs.datetime || metaEl.attrs['data-date'] || textOf(metaEl));
  }
  if (!parseDate(dateText)) {
    dateText = '';
    walk(item, (el) => {
      if (dateText) return;
      const hint = `${el.attrs.class || ''} ${el.attrs.id || ''}`;
      if (!DATE_HINT.test(hint)) return;
      const text = cleanText(textOf(el));
      if (text.length <= 60 && parseDate(text)) dateText = text;
    });
  }
  if (!parseDate(dateText)) {
    const scan = /\b(?:\d{4}-\d{2}-\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{4}|\d+\s+(?:minute|hour|day|week|month)s?\s+ago)\b/i.exec(fullText);
    dateText = scan ? scan[0] : '';
  }

  let description = fullText;
  if (title && description.startsWith(title)) description = description.slice(title.length).trim();
  if (dateText && description.startsWith(dateText)) description = description.slice(dateText.length).trim();

  return { title, link, dateText, description };
}

/* ------------------------------------------------------------------ *
 * 4. Auto-detection — find the repeating block that holds the posts
 * ------------------------------------------------------------------ */

const BAD_HINT = /(nav|menu|footer|header|sidebar|breadcrumb|pagination|pager|comment|social|share|tag-cloud|cookie|banner|advert|promo|subscribe|related|widget)/i;
const GOOD_HINT = /(post|article|entry|item|story|card|result|news|feed|list|blog|release|update|headline|teaser)/i;

function classList(el) {
  return (el.attrs.class || '').split(/\s+/).filter(Boolean);
}

/** Everything the scorer needs about one item, gathered in a single pass. */
const ITEM_STATS = new WeakMap();

function scanItem(node) {
  const cached = ITEM_STATS.get(node);
  if (cached) return cached;

  const stats = { len: 0, snippet: '', firstLink: null, hasHeading: false, hasTime: false };
  const parts = [];

  (function visit(el) {
    for (const child of el.children) {
      if (child.type === 'text') {
        const text = child.text;
        if (text.trim()) { parts.push(text); stats.len += cleanText(text).length + 1; }
        continue;
      }
      if (DROP_TEXT_TAGS.has(child.tag)) continue;
      if (!stats.firstLink && child.tag === 'a' && child.attrs.href) stats.firstLink = child;
      if (!stats.hasHeading && /^h[1-6]$/.test(child.tag)) stats.hasHeading = true;
      if (!stats.hasTime && child.tag === 'time') stats.hasTime = true;
      visit(child);
    }
  })(node);

  stats.snippet = cleanText(parts.join(' ')).slice(0, 220);
  stats.firstLinkTextLen = stats.firstLink ? cleanText(textOf(stats.firstLink)).length : 0;
  ITEM_STATS.set(node, stats);
  return stats;
}

/** A class is only usable in a selector if we can write it safely. */
function classToken(name) {
  if (/^[A-Za-z_-][\w-]*$/.test(name)) return '.' + name;
  if (/["\\\]]/.test(name)) return null;
  return '[class~="' + name + '"]';
}

function candidateSelector(root, parent, signature, count) {
  const tries = [];
  if (parent.attrs.id) tries.push('#' + parent.attrs.id + ' > ' + signature);
  for (const c of classList(parent).slice(0, 2)) {
    const token = classToken(c);
    if (token) tries.push(parent.tag + token + ' > ' + signature);
  }
  if (signature.length > 4) tries.push(signature);
  const grand = parent.parent;
  if (grand && grand.type === 'element' && grand.attrs.id) tries.push('#' + grand.attrs.id + ' ' + signature);
  tries.push(parent.tag + ' > ' + signature);

  let best = null;
  let bestCost = Infinity;
  const ceiling = count * 3 + 5;
  for (const selector of tries) {
    let matches;
    try { matches = queryAll(root, selector, ceiling).length; } catch { continue; }
    if (matches === count) return selector;
    if (matches >= ceiling) continue;          // far too broad to be this list
    if (!matches) continue;
    // Matching a few extra siblings elsewhere on the page beats missing some.
    const cost = matches > count ? matches - count : (count - matches) * 3;
    if (cost < bestCost) { bestCost = cost; best = selector; }
  }
  return best || signature;
}

/**
 * Score every group of same-shaped sibling elements and return the most
 * feed-like ones, best first.
 */
export function detectCandidates(root, base, { max = 5 } = {}) {
  const groups = [];

  const score = (parent, members) => {
    let withLink = 0, textTotal = 0, headings = 0, dated = 0, linkTextTotal = 0, thin = 0;
    const hrefs = new Set();
    const samples = [];

    for (const member of members) {
      const stats = scanItem(member);
      textTotal += stats.len;
      if (stats.len < 20) thin++;
      if (stats.firstLink) {
        withLink++;
        const href = absoluteURL(stats.firstLink.attrs.href, base);
        if (href) hrefs.add(href);
        linkTextTotal += stats.firstLinkTextLen;
      }
      if (stats.hasHeading) headings++;
      if (stats.hasTime || parseDate(stats.snippet)) dated++;
      if (samples.length < 3 && stats.snippet) samples.push(stats.snippet.slice(0, 90));
    }

    const n = members.length;
    const avgText = textTotal / n;
    if (withLink / n < 0.6 || hrefs.size < 3 || avgText < 25) return null;

    const avgLinkText = withLink ? linkTextTotal / withLink : 0;
    const hint = `${parent.attrs.class || ''} ${parent.attrs.id || ''} ${members[0].attrs.class || ''} ${members[0].attrs.id || ''}`;

    let value = Math.min(n, 20);                             // long lists beat short ones
    value += Math.min(avgText, 600) / 60;
    value += (headings / n) * 10;
    value += (dated / n) * 8;
    value += (hrefs.size / n) * 6;
    if (GOOD_HINT.test(hint)) value += 10;
    if (BAD_HINT.test(hint)) value -= 18;
    value -= (thin / n) * 14;                                // spacer rows padding the group
    if (avgLinkText < 12) value -= 8;                        // reads like a nav bar
    if (avgText > 1500) value -= 8;                          // blocks this big are layout, not items
    if (avgText > 3000) value -= 10;
    if (n < 5 && avgText > 600) value -= 10;                 // a handful of huge boxes is a page shell
    if (members[0].tag === 'article') value += 6;
    if (members[0].tag === 'li' && avgText < 60) value -= 4;

    return { score: Math.round(value * 10) / 10, samples };
  };

  walk(root, (parent) => {
    const children = parent.children.filter((c) => c.type === 'element');
    if (children.length < 3) return;

    const byTag = new Map();
    for (const child of children) {
      if (!byTag.has(child.tag)) byTag.set(child.tag, []);
      byTag.get(child.tag).push(child);
    }

    for (const [tag, members] of byTag) {
      if (members.length < 3) continue;
      if (['option', 'br', 'script', 'style', 'th', 'col', 'input', 'img'].includes(tag)) continue;

      const freq = new Map();
      for (const member of members) {
        for (const c of new Set(classList(member))) freq.set(c, (freq.get(c) || 0) + 1);
      }

      // The whole group of same-tag siblings, named by the classes they share.
      const shared = [...freq.entries()]
        .filter(([name, n]) => n >= members.length * 0.8 && classToken(name))
        .map(([name]) => name)
        .sort()
        .slice(0, 2);
      const whole = score(parent, members);
      if (whole) groups.push({ ...whole, parent, members, signature: tag + shared.map(classToken).join('') });

      // Rows of one flavour mixed in with others — a table of stories padded
      // with spacer rows, say. Try each common class on its own.
      const distinguishing = [...freq.entries()]
        .filter(([name, n]) => n >= 3 && n < members.length * 0.8 && classToken(name))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3);
      for (const [name] of distinguishing) {
        const subset = members.filter((m) => classList(m).includes(name));
        const scored = score(parent, subset);
        if (scored) groups.push({ ...scored, parent, members: subset, signature: tag + classToken(name) });
      }
    }
  });

  groups.sort((a, b) => b.score - a.score);

  // Writing a selector means counting matches across the whole document, so
  // only the leaders pay for it.
  const seen = new Set();
  const out = [];
  for (const group of groups) {
    const first = group.members[0];
    const stats = scanItem(first);
    const key = group.members.length + '|' + (stats.firstLink ? stats.firstLink.attrs.href : stats.snippet.slice(0, 40));
    if (seen.has(key)) continue;
    seen.add(key);

    const selector = candidateSelector(root, group.parent, group.signature, group.members.length);
    if (seen.has(selector)) continue;
    seen.add(selector);

    out.push({
      selector,
      count: group.members.length,
      score: group.score,
      samples: group.samples,
      members: group.members,
    });
    if (out.length >= max) break;
  }
  return out;
}

/** RSS/Atom feeds the page already advertises. */
export function existingFeeds(root, base) {
  const out = [];
  for (const link of queryAll(root, 'link[rel]')) {
    const rel = (link.attrs.rel || '').toLowerCase();
    const type = (link.attrs.type || '').toLowerCase();
    if (!rel.includes('alternate')) continue;
    if (!/^(application\/(rss|atom)\+xml|text\/xml)$/.test(type.trim())) continue;
    const href = absoluteURL(link.attrs.href, base);
    if (!href || /oembed/i.test(href)) continue;
    out.push({ href, title: cleanText(link.attrs.title) || type });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 5. Turning a page into feed items
 * ------------------------------------------------------------------ */

export const MAX_ITEMS = 100;
export const DEFAULT_ITEMS = 25;

function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * config: { item, title, link, desc, date, limit, include, exclude, dropUndated }
 * Returns { items, selector, autoDetected, candidates }
 */
export function buildItems(root, base, config = {}, now = new Date()) {
  let selector = cleanText(config.item);
  let candidates = [];
  let autoDetected = false;

  if (!selector) {
    candidates = detectCandidates(root, base);
    if (!candidates.length) return { items: [], selector: '', autoDetected: true, candidates };
    selector = candidates[0].selector;
    autoDetected = true;
  }

  const elements = queryAll(root, selector, MAX_ITEMS * 4);
  const limit = Math.min(Math.max(Number(config.limit) || DEFAULT_ITEMS, 1), MAX_ITEMS);
  const include = cleanText(config.include).toLowerCase();
  const exclude = cleanText(config.exclude).toLowerCase();

  const items = [];
  const seen = new Set();

  for (const el of elements) {
    const guessed = guessFields(el, base);
    const title = cleanText(config.title ? pickField(el, config.title, base) : guessed.title);
    const link = config.link ? pickField(el, config.link, base) : guessed.link;
    const rawDate = config.date ? pickField(el, config.date, base) : guessed.dateText;
    const descSource = config.desc ? pickField(el, config.desc, base) : guessed.description;

    if (!title && !link) continue;

    const key = link || 'title:' + title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const haystack = (title + ' ' + descSource).toLowerCase();
    if (include && !haystack.includes(include)) continue;
    if (exclude && haystack.includes(exclude)) continue;

    const date = parseDate(rawDate, now);
    if (config.dropUndated && !date) continue;

    items.push({
      title: title || 'Untitled',
      link,
      description: descSource.slice(0, 1200),
      date,
      guid: link || 'pagefeed:' + hash(title + '|' + (rawDate || '')),
    });

    if (items.length >= limit) break;
  }

  return { items, selector, autoDetected, candidates };
}

/* ------------------------------------------------------------------ *
 * 6. RSS output
 * ------------------------------------------------------------------ */

function xmlEscape(value) {
  return String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function rfc822(date) {
  return date.toUTCString();
}

export function renderRSS({ title, link, description, selfUrl, items, now = new Date() }) {
  const parts = [];
  parts.push('<?xml version="1.0" encoding="UTF-8"?>');
  parts.push('<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">');
  parts.push('<channel>');
  parts.push(`<title>${xmlEscape(title || 'PageFeed')}</title>`);
  if (link) parts.push(`<link>${xmlEscape(link)}</link>`);
  parts.push(`<description>${xmlEscape(description || 'Generated from ' + (link || 'a web page'))}</description>`);
  if (selfUrl) parts.push(`<atom:link href="${xmlEscape(selfUrl)}" rel="self" type="application/rss+xml"/>`);
  parts.push(`<lastBuildDate>${rfc822(now)}</lastBuildDate>`);
  parts.push('<generator>PageFeed</generator>');
  parts.push('<ttl>60</ttl>');

  for (const item of items) {
    parts.push('<item>');
    parts.push(`<title>${xmlEscape(item.title)}</title>`);
    if (item.link) parts.push(`<link>${xmlEscape(item.link)}</link>`);
    parts.push(`<guid isPermaLink="${item.link && item.guid === item.link ? 'true' : 'false'}">${xmlEscape(item.guid)}</guid>`);
    if (item.date) parts.push(`<pubDate>${rfc822(item.date)}</pubDate>`);
    if (item.description) parts.push(`<description>${xmlEscape(item.description)}</description>`);
    parts.push('</item>');
  }

  parts.push('</channel>');
  parts.push('</rss>');
  return parts.join('\n');
}

/* ------------------------------------------------------------------ *
 * 7. Fetching the page (with the usual guards)
 * ------------------------------------------------------------------ */

const USER_AGENT = 'Mozilla/5.0 (compatible; PageFeed/1.0; +https://github.com/) AppleWebKit/537.36';
const MAX_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15000;

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|\[?::1\]?|\[?f[cd][0-9a-f]{2}:.*)$/i;

export function normalizeTarget(input) {
  const raw = cleanText(input);
  if (!raw) throw new HttpError(400, 'Give me a page address to read.');
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw);
  } catch {
    throw new HttpError(400, `"${raw}" does not look like a web address.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpError(400, 'Only http and https addresses work here.');
  }
  if (PRIVATE_HOST.test(url.hostname)) {
    throw new HttpError(400, 'That address points at a private network, so it is blocked.');
  }
  if (url.port && !['80', '443', '8080', '8443'].includes(url.port)) {
    throw new HttpError(400, 'That port is blocked. Use a normal web address.');
  }
  url.hash = '';
  return url.toString();
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readCapped(response) {
  const charset = /charset=([\w-]+)/i.exec(response.headers.get('content-type') || '');
  const decode = (buffer) => {
    if (charset && !/utf-?8/i.test(charset[1])) {
      try { return new TextDecoder(charset[1]).decode(buffer); } catch { /* fall through */ }
    }
    return new TextDecoder('utf-8').decode(buffer);
  };

  if (!response.body) return (await response.text()).slice(0, MAX_BYTES);

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (total < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  try { await reader.cancel(); } catch { /* already done */ }

  const merged = new Uint8Array(Math.min(total, MAX_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= merged.length) break;
    merged.set(chunk.subarray(0, merged.length - offset), offset);
    offset += chunk.length;
  }
  return decode(merged);
}

export async function fetchPage(url) {
  const target = normalizeTarget(url);
  let response;
  try {
    response = await fetch(target, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
      },
    });
  } catch (err) {
    const reason = err && err.name === 'TimeoutError' ? 'took too long to answer' : 'could not be reached';
    throw new HttpError(502, `That page ${reason}.`);
  }

  if (response.status === 403 || response.status === 401) {
    throw new HttpError(502, 'That site refused the request. Some sites block automated readers.');
  }
  if (!response.ok) {
    throw new HttpError(502, `That page answered with an error (${response.status}).`);
  }

  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (contentType && !/html|xml|text|json/.test(contentType)) {
    throw new HttpError(415, `That address is a ${contentType.split(';')[0]} file, not a web page.`);
  }

  const body = await readCapped(response);
  const head = body.slice(0, 600).trimStart().toLowerCase();
  const isFeed = /rss|atom|xml/.test(contentType.split(';')[0])
    || head.startsWith('<?xml')
    || head.startsWith('<rss')
    || head.startsWith('<feed');

  return { url: response.url || target, html: body, isFeed };
}

export function pageMeta(root, base, fallbackUrl) {
  const titleEl = queryOne(root, 'title');
  const ogTitle = queryOne(root, 'meta[property="og:title"], meta[name="og:title"]');
  const siteName = queryOne(root, 'meta[property="og:site_name"]');
  const descEl = queryOne(root, 'meta[name="description"], meta[property="og:description"]');
  const baseEl = queryOne(root, 'base[href]');
  const title = cleanText(siteName && siteName.attrs.content)
    || cleanText(titleEl && textOf(titleEl))
    || cleanText(ogTitle && ogTitle.attrs.content)
    || new URL(fallbackUrl).hostname;
  return {
    title,
    description: cleanText(descEl && descEl.attrs.content),
    base: baseEl ? absoluteURL(baseEl.attrs.href, base) || base : base,
  };
}

/* ------------------------------------------------------------------ *
 * 8. HTTP layer
 * ------------------------------------------------------------------ */

const FEED_PARAMS = ['url', 'item', 'title', 'link', 'desc', 'date', 'limit', 'q', 'not', 'name', 'dated'];

export function configFromParams(params) {
  return {
    url: params.get('url') || '',
    item: params.get('item') || '',
    title: params.get('title') || '',
    link: params.get('link') || '',
    desc: params.get('desc') || '',
    date: params.get('date') || '',
    limit: params.get('limit') || '',
    include: params.get('q') || '',
    exclude: params.get('not') || '',
    name: params.get('name') || '',
    dropUndated: params.get('dated') === '1',
  };
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  });
}

function errorResponse(err, asJSON = true) {
  const status = err instanceof HttpError ? err.status : 500;
  const message = err instanceof HttpError ? err.message : 'Something went wrong reading that page.';
  if (asJSON) return json({ error: message }, status);
  return new Response(message + '\n', { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

async function loadPage(rawUrl) {
  const page = await fetchPage(rawUrl);
  const root = parseHTML(page.html);
  const meta = pageMeta(root, page.url, page.url);
  return { page, root, meta };
}

function serializeItem(item) {
  return {
    title: item.title,
    link: item.link,
    date: item.date ? item.date.toISOString() : null,
    description: item.description.slice(0, 280),
  };
}

async function handleDetect(url) {
  const { page, root, meta } = await loadPage(url.searchParams.get('url'));
  if (page.isFeed) {
    return json({
      page: { url: page.url, title: meta.title },
      alreadyFeed: true,
      feeds: [{ href: page.url, title: 'This address is already a feed' }],
      candidates: [],
    });
  }

  const candidates = detectCandidates(root, meta.base).map((candidate) => {
    const { items } = buildItems(root, meta.base, { item: candidate.selector, limit: 5 });
    return {
      selector: candidate.selector,
      count: queryAll(root, candidate.selector).length,
      score: candidate.score,
      items: items.map(serializeItem),
    };
  }).filter((candidate) => candidate.items.length > 0);

  return json({
    page: { url: page.url, title: meta.title, description: meta.description },
    feeds: existingFeeds(root, meta.base),
    candidates,
  });
}

async function handlePreview(url) {
  const config = configFromParams(url.searchParams);
  const { page, root, meta } = await loadPage(config.url);
  if (page.isFeed) throw new HttpError(400, 'That address is already a feed — subscribe to it directly.');

  const built = buildItems(root, meta.base, config);
  return json({
    page: { url: page.url, title: meta.title },
    selector: built.selector,
    autoDetected: built.autoDetected,
    count: built.items.length,
    items: built.items.map(serializeItem),
  });
}

async function handleFeed(url, request, ctx) {
  const config = configFromParams(url.searchParams);
  const ttl = Math.min(Math.max(Number(url.searchParams.get('ttl')) || 900, 300), 21600);

  const cache = typeof caches !== 'undefined' && caches.default ? caches.default : null;
  const cacheKey = new Request(url.toString(), { method: 'GET' });
  if (cache && request.method === 'GET') {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  const { page, root, meta } = await loadPage(config.url);
  if (page.isFeed) throw new HttpError(400, 'That address is already a feed — subscribe to it directly.');

  const built = buildItems(root, meta.base, config);
  if (!built.items.length) {
    throw new HttpError(422, built.autoDetected
      ? 'Could not find a repeating list of posts on that page. Open the builder and set the item selector yourself.'
      : 'That item selector matched nothing on the page.');
  }

  const xml = renderRSS({
    title: cleanText(config.name) || meta.title,
    link: page.url,
    description: meta.description || `Items from ${page.url}`,
    selfUrl: url.toString(),
    items: built.items,
  });

  const response = new Response(xml, {
    headers: {
      'content-type': 'application/rss+xml; charset=utf-8',
      'cache-control': `public, max-age=${ttl}`,
      'x-pagefeed-selector': built.selector,
      'access-control-allow-origin': '*',
    },
  });

  if (cache && request.method === 'GET') {
    const stash = response.clone();
    if (ctx && ctx.waitUntil) ctx.waitUntil(cache.put(cacheKey, stash));
    else await cache.put(cacheKey, stash);
  }
  return response;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, OPTIONS',
        },
      });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed\n', { status: 405 });
    }

    try {
      if (url.pathname === '/' || url.pathname === '/index.html') {
        return new Response(PAGE_HTML, {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' },
        });
      }
      if (url.pathname === '/detect') return await handleDetect(url);
      if (url.pathname === '/preview') return await handlePreview(url);
      if (url.pathname === '/feed' || url.pathname === '/rss') return await handleFeed(url, request, ctx);
      if (url.pathname === '/robots.txt') {
        return new Response('User-agent: *\nDisallow: /feed\nDisallow: /preview\nDisallow: /detect\n', {
          headers: { 'content-type': 'text/plain' },
        });
      }
      return new Response('Not found\n', { status: 404, headers: { 'content-type': 'text/plain' } });
    } catch (err) {
      return errorResponse(err, url.pathname !== '/feed' && url.pathname !== '/rss');
    }
  },
};

export { FEED_PARAMS };

/* ------------------------------------------------------------------ *
 * 9. The builder page
 * ------------------------------------------------------------------ */

const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PageFeed — turn a web page into RSS</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%231f6feb'/%3E%3Cg fill='%23fff'%3E%3Ccircle cx='10' cy='22' r='3'/%3E%3Cpath d='M7 14a11 11 0 0 1 11 11h4A15 15 0 0 0 7 10z'/%3E%3Cpath d='M7 7a18 18 0 0 1 18 18h4A22 22 0 0 0 7 3z'/%3E%3C/g%3E%3C/svg%3E">
<style>
  :root{
    --bg:#f6f7f9; --card:#fff; --ink:#15181d; --muted:#697084; --line:#e2e5ec;
    --accent:#1f6feb; --accent-ink:#fff; --good:#0f7b4f; --warn:#8a5300; --code:#f2f4f8;
  }
  @media (prefers-color-scheme: dark){
    :root{
      --bg:#0f1319; --card:#171c24; --ink:#e8eaee; --muted:#9aa3b5; --line:#29313d;
      --accent:#4d8dfb; --accent-ink:#0b0e13; --good:#4ade9a; --warn:#f0c26b; --code:#111720;
    }
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
  .wrap{max-width:760px;margin:0 auto;padding:32px 18px 80px}
  h1{font-size:26px;margin:0 0 6px;letter-spacing:-.4px}
  .lede{color:var(--muted);margin:0 0 26px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;margin-bottom:16px}
  label{display:block;font-size:13px;font-weight:600;color:var(--muted);margin-bottom:6px}
  input,select{width:100%;padding:12px;border:1px solid var(--line);border-radius:10px;font-size:16px;background:var(--bg);color:var(--ink)}
  input:focus,select:focus{outline:2px solid var(--accent);outline-offset:-1px;border-color:transparent}
  .row{display:flex;gap:10px;flex-wrap:wrap}
  .row > *{flex:1;min-width:180px}
  button{font:inherit;font-weight:600;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--ink);padding:12px 16px;cursor:pointer}
  button:hover{border-color:var(--accent)}
  button.primary{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
  button.primary:disabled{opacity:.6;cursor:wait}
  button.small{padding:8px 12px;font-size:14px}
  a.btn{display:inline-block;text-decoration:none;font-weight:600;border:1px solid var(--line);background:var(--card);color:var(--ink);padding:8px 12px;font-size:14px;border-radius:10px}
  a.btn:hover{border-color:var(--accent)}
  .form-row{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap}
  .form-row .grow{flex:1 1 320px}
  code{background:var(--code);padding:2px 6px;border-radius:6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;word-break:break-all}
  .muted{color:var(--muted)}
  .small{font-size:13px}
  .hit{border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:10px}
  .hit.picked{border-color:var(--accent);box-shadow:0 0 0 2px rgba(31,111,235,.18)}
  .hit h3{margin:0 0 4px;font-size:15px}
  .hit ul{margin:8px 0 12px;padding-left:18px;color:var(--muted);font-size:14px}
  .hit li{margin-bottom:3px}
  .feedbox{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .feedbox input{flex:1 1 320px;font-size:14px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  .note{border-left:3px solid var(--warn);padding:8px 12px;background:var(--code);border-radius:0 8px 8px 0;margin-bottom:14px}
  .ok{border-left-color:var(--good)}
  .err{border-left-color:#d6455d;color:var(--ink)}
  details{margin-top:14px}
  summary{cursor:pointer;font-weight:600;font-size:14px;color:var(--muted)}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:12px}
  @media (max-width:560px){.grid2{grid-template-columns:1fr}}
  .item{padding:10px 0;border-bottom:1px solid var(--line)}
  .item:last-child{border-bottom:0}
  .item a{color:var(--accent);text-decoration:none;font-weight:600}
  .item a:hover{text-decoration:underline}
  .spin{display:inline-block;width:14px;height:14px;border:2px solid var(--line);border-top-color:var(--accent);border-radius:50%;animation:s .7s linear infinite;vertical-align:-2px;margin-right:6px}
  @keyframes s{to{transform:rotate(360deg)}}
  footer{color:var(--muted);font-size:13px;margin-top:30px}
</style>
</head>
<body>
<div class="wrap">
  <h1>PageFeed</h1>
  <p class="lede">Paste a web page. Get an RSS link you can drop into any reader.</p>

  <div class="card">
    <div class="form-row">
      <div class="grow">
        <label for="url">Page address</label>
        <input id="url" type="url" placeholder="https://example.com/news" autocomplete="url" spellcheck="false">
      </div>
      <button id="go" class="primary">Check page</button>
    </div>
  </div>

  <div id="out"></div>

  <footer>
    Feeds are read live and cached for 15 minutes. If a page changes its layout, come back and rebuild the link.
  </footer>
</div>

<script>
(function(){
  var out = document.getElementById('out');
  var urlInput = document.getElementById('url');
  var goBtn = document.getElementById('go');
  var state = { url:'', selector:'', fields:{}, limit:'25', q:'', name:'' };

  function esc(s){
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
      return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
    });
  }
  function el(html){ var d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild; }
  function busy(on, label){
    goBtn.disabled = on;
    goBtn.innerHTML = on ? '<span class="spin"></span>' + esc(label || 'Reading') : 'Check page';
  }
  function fail(message){
    out.innerHTML = '<div class="card"><div class="note err"><b>Could not do that.</b><br>' + esc(message) + '</div></div>';
  }

  function feedURL(){
    var p = new URLSearchParams();
    p.set('url', state.url);
    if (state.selector) p.set('item', state.selector);
    ['title','link','date','desc'].forEach(function(k){
      if (state.fields[k]) p.set(k, state.fields[k]);
    });
    if (state.limit && state.limit !== '25') p.set('limit', state.limit);
    if (state.q) p.set('q', state.q);
    if (state.name) p.set('name', state.name);
    return location.origin + '/feed?' + p.toString();
  }

  function get(path, params){
    var p = new URLSearchParams(params);
    return fetch(path + '?' + p.toString()).then(function(r){
      return r.json().then(function(data){
        if (!r.ok) throw new Error(data.error || 'Request failed');
        return data;
      });
    });
  }

  function check(){
    var value = urlInput.value.trim();
    if (!value) { urlInput.focus(); return; }
    state.url = value;
    state.selector = '';
    state.fields = {};
    busy(true, 'Reading page');
    out.innerHTML = '';
    get('/detect', { url: value }).then(function(data){
      state.url = data.page.url;
      urlInput.value = data.page.url;
      if (!state.name) state.name = data.page.title || '';
      renderDetect(data);
    }).catch(function(err){
      fail(err.message);
    }).then(function(){ busy(false); });
  }

  function renderDetect(data){
    var html = '';

    if (data.feeds && data.feeds.length) {
      html += '<div class="card"><div class="note ok"><b>This page already publishes a feed.</b><br>';
      data.feeds.forEach(function(f){
        html += '<a href="' + esc(f.href) + '">' + esc(f.href) + '</a><br>';
      });
      html += '<span class="small muted">Use that link in your reader. It will be cleaner than anything built from the page.</span></div>';
      if (!data.candidates.length) html += '</div>';
    }

    if (!data.candidates.length) {
      if (!data.feeds || !data.feeds.length) {
        html += '<div class="card"><div class="note"><b>No repeating list of posts found.</b><br>' +
          'Some pages build their content with JavaScript, which this cannot see. You can still name the ' +
          'item selector yourself below.</div></div>';
      }
      out.innerHTML = html;
      renderTune();
      return;
    }

    if (data.feeds && data.feeds.length) html += '</div>';

    html += '<div class="card"><h2 style="font-size:17px;margin:0 0 4px">What is on the page</h2>' +
      '<p class="small muted" style="margin:0 0 14px">Pick the list that looks right. Most of the time it is the first one.</p>';
    data.candidates.forEach(function(c, i){
      html += '<div class="hit' + (i === 0 ? ' picked' : '') + '" data-sel="' + esc(c.selector) + '">' +
        '<h3>' + c.count + ' items · <code>' + esc(c.selector) + '</code></h3><ul>';
      c.items.slice(0, 3).forEach(function(item){
        html += '<li>' + esc(item.title.slice(0, 90)) + '</li>';
      });
      html += '</ul><button class="small use" data-sel="' + esc(c.selector) + '">' +
        (i === 0 ? 'Use this list' : 'Use this one instead') + '</button></div>';
    });
    html += '</div>';

    out.innerHTML = html;
    Array.prototype.forEach.call(out.querySelectorAll('.use'), function(btn){
      btn.addEventListener('click', function(){
        Array.prototype.forEach.call(out.querySelectorAll('.hit'), function(h){ h.classList.remove('picked'); });
        btn.closest('.hit').classList.add('picked');
        state.selector = btn.getAttribute('data-sel');
        preview();
      });
    });
    state.selector = data.candidates[0].selector;
    preview();
  }

  function card(id){
    var node = document.getElementById(id);
    if (!node) { node = el('<div class="card" id="' + id + '"></div>'); out.appendChild(node); }
    return node;
  }

  function renderTune(){
    var node = card('tune-card');
    node.innerHTML = advancedHTML();
    var rebuild = document.getElementById('rebuild');
    rebuild.addEventListener('click', function(){
      var v = function(id){ var n = document.getElementById(id); return n ? n.value.trim() : ''; };
      state.selector = v('sel-item');
      state.fields = { title: v('sel-title'), link: v('sel-link'), date: v('sel-date'), desc: v('sel-desc') };
      state.q = v('opt-q');
      state.name = v('opt-name');
      var limitNode = document.getElementById('opt-limit');
      state.limit = limitNode ? limitNode.value : '25';
      preview();
    });
  }

  function advancedHTML(){
    return '<details' + (state.selector ? '' : ' open') + '><summary>Fine-tune it</summary>' +
      '<div class="grid2">' +
      field('sel-item', 'Each item (CSS selector)', state.selector, 'article.post') +
      field('sel-title', 'Title inside an item', state.fields.title || '', 'h2 a') +
      field('sel-link', 'Link inside an item', state.fields.link || '', 'h2 a@href') +
      field('sel-date', 'Date inside an item', state.fields.date || '', 'time@datetime') +
      field('sel-desc', 'Summary inside an item', state.fields.desc || '', 'p.excerpt') +
      field('opt-q', 'Only items containing', state.q || '', 'hawaii') +
      field('opt-name', 'Feed name', state.name || '', 'Example News') +
      '<div><label for="opt-limit">How many items</label><select id="opt-limit">' +
        ['10','25','50','100'].map(function(n){
          return '<option' + (n === state.limit ? ' selected' : '') + '>' + n + '</option>';
        }).join('') +
      '</select></div>' +
      '</div>' +
      '<p class="small muted" style="margin:12px 0 0">Leave a box empty and PageFeed works it out from the page. ' +
      'Add <code>@href</code> or <code>@datetime</code> to read an attribute instead of the text.</p>' +
      '<button class="primary small" id="rebuild" style="margin-top:12px">Update preview</button>' +
      '</details>';
  }

  function field(id, label, value, placeholder){
    return '<div><label for="' + id + '">' + esc(label) + '</label>' +
      '<input id="' + id + '" value="' + esc(value) + '" placeholder="' + esc(placeholder) + '" spellcheck="false"></div>';
  }

  function preview(){
    var params = { url: state.url };
    if (state.selector) params.item = state.selector;
    ['title','link','date','desc'].forEach(function(k){ if (state.fields[k]) params[k] = state.fields[k]; });
    if (state.q) params.q = state.q;
    if (state.limit) params.limit = state.limit;

    var node = card('preview-card');
    node.innerHTML = '<p class="muted"><span class="spin"></span>Building the feed...</p>';

    get('/preview', params).then(function(data){
      if (!state.selector) state.selector = data.selector;
      renderPreview(node, data);
    }).catch(function(err){
      node.innerHTML = '<div class="note err"><b>That did not work.</b><br>' + esc(err.message) + '</div>';
      renderTune();
    });
  }

  function renderPreview(node, data){
    if (!data.items.length) {
      node.innerHTML = '<div class="note"><b>No items came back.</b><br>Try a different list, or name the selectors yourself.</div>';
      renderTune();
      return;
    }

    var url = feedURL();
    var html = '<h2 style="font-size:17px;margin:0 0 10px">Your feed link</h2>' +
      '<div class="feedbox"><input id="feed-url" readonly value="' + esc(url) + '">' +
      '<button class="primary small" id="copy">Copy</button>' +
      '<a class="btn" href="' + esc(url) + '" target="_blank" rel="noopener">Open</a></div>' +
      '<p class="small muted" style="margin:10px 0 0">Paste that into Feedly, Inoreader, NetNewsWire, Reeder, Slack ' +
      '(<code>/feed subscribe</code>) or any other reader.</p>' +
      '<h3 style="font-size:15px;margin:20px 0 4px">Preview · ' + data.count + ' items</h3>' +
      '<p class="small muted" style="margin:0 0 6px">Reading <code>' + esc(data.selector) + '</code>' +
      (data.autoDetected ? ' (found automatically)' : '') + '</p>';

    data.items.slice(0, 10).forEach(function(item){
      html += '<div class="item">' +
        (item.link ? '<a href="' + esc(item.link) + '" target="_blank" rel="noopener">' + esc(item.title) + '</a>'
                   : '<b>' + esc(item.title) + '</b>') +
        (item.date ? '<div class="small muted">' + esc(new Date(item.date).toLocaleString()) + '</div>' : '') +
        (item.description ? '<div class="small muted">' + esc(item.description.slice(0, 160)) + '</div>' : '') +
        '</div>';
    });

    node.innerHTML = html;
    renderTune();

    var copy = document.getElementById('copy');
    copy.addEventListener('click', function(){
      var box = document.getElementById('feed-url');
      box.select();
      var done = function(){ copy.textContent = 'Copied'; setTimeout(function(){ copy.textContent = 'Copy'; }, 1600); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(box.value).then(done, function(){ document.execCommand('copy'); done(); });
      } else {
        document.execCommand('copy');
        done();
      }
    });
  }

  goBtn.addEventListener('click', check);
  urlInput.addEventListener('keydown', function(e){ if (e.key === 'Enter') check(); });

  var preset = new URLSearchParams(location.search).get('url');
  if (preset) { urlInput.value = preset; check(); }
})();
</script>
</body>
</html>`;
