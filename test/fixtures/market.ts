import { createServer } from 'node:http';

/** Independent server state is the outcome oracle; UI toasts can deliberately lie. */
export async function marketApp() {
  const writes: { id: string; price: number }[] = [];
  const state = {
    renamed: false,
    optimistic: false,
    wrongIdentity: false,
    price: 0,
    reversed: false,
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (url.pathname.startsWith('/apply/') && req.method === 'POST') {
      const id = url.pathname.split('/').at(-1)!;
      if (!state.optimistic) writes.push({ id, price: state.price });
      res.end('<h1>Application received</h1><a href="/list">Return</a>');
      return;
    }
    if (url.pathname === '/list') {
      const ids = state.reversed ? ['item-b', 'item-a'] : ['item-a', 'item-b'];
      res.end(
        '<ul>' +
          ids
            .map(
              (id) =>
                `<li data-id="${id}"><strong>${id}</strong><form action="/apply/${id}" method="post"><button type="submit">Apply</button></form></li>`,
            )
            .join('') +
          '</ul>',
      );
      return;
    }
    const id = state.wrongIdentity ? 'wrong-item' : url.pathname.split('/').at(-1)!;
    res.end(
      `<h1>Trial detail</h1><p>Item ID: ${id}</p><p>Price: ¥${state.price}</p><form action="/apply/${id}" method="post"><button type="submit">${state.renamed ? 'Join trial' : 'Apply'}</button></form>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture address');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    state,
    writes,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
