import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

/** A separate multi-page app. There are no ReflexRun selectors, stable IDs or contract files. */
export async function unmappedApp() {
  const saves: Record<string, string>[] = [];
  const state = { renamed: false, reject: false, prefix: false };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (url.pathname === '/submit' && req.method === 'POST') {
      let body = '';
      for await (const c of req) body += c;
      const data = Object.fromEntries(new URLSearchParams(body));
      if (state.reject || data.name === 'Reject fixture') {
        res.end('<h1>Request rejected</h1>');
        return;
      }
      saves.push(data);
      res.writeHead(303, { location: '/done' });
      res.end();
      return;
    }
    if (url.pathname === '/done') {
      res.end('<h1>Request received</h1><p>The fixture accepted this submission.</p>');
      return;
    }
    if (url.pathname === '/help') {
      res.end('<h1>Help and directions</h1><a href="/intake">Back</a>');
      return;
    }
    if (url.pathname === '/frame') {
      res.end('<label>Frame note <input name="frame-note"></label>');
      return;
    }
    const id = randomUUID();
    res.end(`<!doctype html><html><head><title>Independent intake portal</title></head><body>
      <h1>Community workshop request</h1><a href="/help">Help</a>${state.prefix ? '<button>Unrelated new control</button>' : ''}
      <form action="/submit" method="post">
        <label for="${id}">Full name</label><input id="${id}" name="name" required>
        <label>Contact email <input type="email" name="email" required></label>
        <label>Topic <select name="topic"><option value="music">Music</option><option value="sport">Sport</option></select></label>
        <label>Access code <input type="password" name="access"></label>
        <label>Extra instructions <input type="checkbox" name="extra" onchange="document.getElementById('extra').hidden=!this.checked;document.querySelector('textarea').required=this.checked"></label>
        <div id="extra" hidden><label>Instructions <textarea name="instructions"></textarea></label></div>
        <label>Receive updates <input type="checkbox" name="updates"></label>
        <label>Attachment <input type="file" name="attachment"></label>
        <button type="submit">${state.renamed ? 'Send request' : 'Submit request'}</button>
      </form><iframe title="Additional notes" src="/frame"></iframe>
    </body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No server address');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    saves,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
