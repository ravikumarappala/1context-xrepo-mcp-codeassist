// orders-api: GET /orders/{id}. Runs on Cloud Run (PORT env), or locally with `npm start`.
import http from 'node:http';
// Reusable library. In separate repos this is the npm package @acme/auth-lib.
import { userFromRequest } from '../../../reusable/auth-lib/src/index.js';
import { getOrderForUser } from './orders.js';

const SECRET = process.env.AUTH_SECRET || 'dev-only-secret';

export function handle(req, res) {
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const m = /^\/orders\/([\w-]+)$/.exec(req.url);
  if (req.method !== 'GET' || !m) return send(404, { error: 'not found' });
  const user = userFromRequest(req.headers, SECRET);
  if (!user) return send(401, { error: 'sign in required' });
  const order = getOrderForUser(m[1], user);
  return order ? send(200, order) : send(404, { error: 'not found' });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const port = Number(process.env.PORT || 8080);
  http.createServer(handle).listen(port, () => console.log(`orders-api on :${port}`));
}
