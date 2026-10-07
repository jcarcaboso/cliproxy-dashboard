import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { harness } from './helpers.js';
import { ResetStore } from '../src/reset-store.js';

test('HTTPS sessions use a Secure host-only cookie prefix', async t => {
  const h = await harness(t, { secureCookie: true });
  const response = await h.login();
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /^__Host-cliproxy_dashboard_session=/);
  assert.match(cookie, /; Secure/); assert.match(cookie, /Path=\//);
  assert.doesNotMatch(cookie, /Domain=/i);
});

test('a pending journal write failure prevents the provider mutation', async t => {
  const h = await harness(t); await h.login();
  const data = (await h.call('GET', '/api/dashboard')).body;
  const a = data.accounts.find(a => a.provider === 'codex' && a.status === 'ok');
  const p = await h.call('POST', `/api/accounts/${a.id}/reset/prepare`, { kind: 'full' });
  const save = h.store.save;
  h.store.save = () => { throw new Error('test storage failure'); };
  const response = await h.call('POST', `/api/accounts/${a.id}/reset`, { operationId: p.body.operationId });
  h.store.save = save;
  assert.equal(response.status, 503);
  assert.equal(h.upstream.state.mutations.length, 0);
});

test('failure to record a returned result leaves the operation blocked as unknown', async t => {
  const h = await harness(t); await h.login();
  const data = (await h.call('GET', '/api/dashboard')).body;
  const a = data.accounts.find(a => a.provider === 'codex' && a.status === 'ok');
  const p = await h.call('POST', `/api/accounts/${a.id}/reset/prepare`, { kind: 'full' });
  const save = h.store.save;
  let calls = 0;
  h.store.save = function () {
    calls += 1;
    if (calls === 2) throw new Error('test result-write failure');
    return save.call(this);
  };
  const result = await h.call('POST', `/api/accounts/${a.id}/reset`, { operationId: p.body.operationId });
  h.store.save = save;
  assert.equal(result.body.state, 'unknown');
  assert.equal(h.upstream.state.mutations.length, 1);
  assert.ok(h.store.blocked(a.id));
  const recovered = new ResetStore(h.dataDir, () => h.upstream.state.now);
  assert.equal(recovered.get(p.body.operationId).state, 'unknown');
});

test('a corrupt journal is not silently erased', async t => {
  const h = await harness(t);
  const file = path.join(h.dataDir, 'reset-operations.json');
  fs.writeFileSync(file, '{"broken":true}');
  assert.throws(() => new ResetStore(h.dataDir), /Invalid reset journal/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"broken":true}');
});

test('unrecognized quota data blocks both preparation and an already-open confirmation', async t => {
  const h = await harness(t); await h.login();
  const data = (await h.call('GET', '/api/dashboard')).body;
  const a = data.accounts.find(a => a.provider === 'codex' && a.status === 'ok');
  const p = await h.call('POST', `/api/accounts/${a.id}/reset/prepare`, { kind: 'full' });
  h.upstream.state.emptyUsage = true;
  const result = await h.call('POST', `/api/accounts/${a.id}/reset`, { operationId: p.body.operationId });
  assert.equal(result.status, 409);
  assert.equal((await h.call('POST', `/api/accounts/${a.id}/reset/prepare`, { kind: 'full' })).status, 409);
  assert.equal(h.upstream.state.mutations.length, 0);
});

test('a read already in flight is refreshed after a reset rather than returning old credits', async t => {
  const h = await harness(t); await h.login();
  const first = (await h.call('GET', '/api/dashboard')).body;
  const a = first.accounts.find(a => a.provider === 'codex' && a.status === 'ok');
  let release, began;
  h.upstream.state.holdNextUsage = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { began = resolve; });
  h.upstream.state.onUsageStart = began;
  h.upstream.state.now += 4000;
  const backgroundRead = h.call('GET', '/api/dashboard');
  await waiting;
  const p = await h.call('POST', `/api/accounts/${a.id}/reset/prepare`, { kind: 'full' });
  const result = await h.call('POST', `/api/accounts/${a.id}/reset`, { operationId: p.body.operationId });
  assert.equal(result.body.outcome, 'accepted');
  release();
  const read = await backgroundRead;
  assert.equal(read.body.accounts.find(x => x.id === a.id).resets.full, 1);
  assert.equal(h.upstream.state.mutations.length, 1);
});

test('duplicate credentials cannot bypass an uncertain provider-account reset', async t => {
  const h = await harness(t); h.upstream.state.duplicateCodex = true;
  await h.login();
  const data = (await h.call('GET', '/api/dashboard')).body;
  const pair = data.accounts.filter(a => a.provider === 'codex' && a.status === 'ok');
  assert.equal(pair.length, 2);
  assert.ok(pair.every(a => a.sharedResetScope));
  const p = await h.call('POST', `/api/accounts/${pair[0].id}/reset/prepare`, { kind: 'full' });
  h.upstream.state.transportDrop = true;
  await h.call('POST', `/api/accounts/${pair[0].id}/reset`, { operationId: p.body.operationId });
  assert.equal((await h.call('POST', `/api/accounts/${pair[1].id}/reset/prepare`, { kind: 'full' })).status, 409);
  const refreshed = (await h.call('GET', '/api/dashboard')).body;
  assert.ok(refreshed.accounts.filter(a => pair.some(p => p.id === a.id)).every(a => a.resets.operation?.state === 'unknown'));
  assert.equal(h.upstream.state.mutations.length, 1);
});
