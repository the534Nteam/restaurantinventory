/*
 * Run PageFeed locally:  node server.mjs   →  http://localhost:8787
 *
 * Cloudflare and Deno Deploy call the worker's fetch() directly; this little
 * adapter does the same thing on top of Node's http server so you can try
 * changes without deploying.
 */
import { createServer } from 'node:http';
import worker from './worker.js';

const port = Number(process.env.PORT) || 8787;

createServer(async (req, res) => {
  const request = new Request(new URL(req.url, `http://${req.headers.host || 'localhost:' + port}`), {
    method: req.method,
    headers: req.headers,
  });

  try {
    const response = await worker.fetch(request, {}, { waitUntil: () => {} });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(String(err && err.stack ? err.stack : err) + '\n');
  }
}).listen(port, () => console.log(`PageFeed on http://localhost:${port}`));
