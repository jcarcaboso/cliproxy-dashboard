// An integration fixture, never a production mode. It cannot contact real providers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDashboard } from '../src/server.js';
import { mockProxy, close } from './helpers.js';

const upstream = await mockProxy();
upstream.state.labelPrefix = 'Fixture / ';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-preview-'));
const port = Number(process.env.PORT || 8788);
const config = {
  upstream: upstream.origin, publicOrigin: process.env.PUBLIC_ORIGIN || `http://127.0.0.1:${port}`,
  secureCookie: false, enableResets: true, dataDir
};
const { server } = createDashboard(config);
server.listen(port, process.env.HOST || '127.0.0.1', () => {
  console.log(`FIXTURE-ONLY dashboard on port ${port}. Test key: test-management-key-not-a-real-secret`);
});
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  await close(server); await close(upstream.server);
  fs.rmSync(dataDir, { recursive: true, force: true });
}
process.on('SIGTERM', stop); process.on('SIGINT', stop);
