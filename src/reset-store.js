import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Single-process journal. Store no management key, OAuth token, email or raw response.
// A pending write found after restart is uncertain, never automatically replayed.
export class ResetStore {
  constructor(directory, now = Date.now) {
    this.directory = directory; this.now = now;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = path.join(directory, 'reset-operations.json');
    this.records = [];
    if (fs.existsSync(this.file)) {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.operations) || data.operations.length > 5000) throw new Error('Invalid reset journal; inspect DATA_DIR');
      for (const r of data.operations) {
        if (!r || typeof r.id !== 'string' || !/^[a-f0-9-]{36}$/.test(r.id) ||
          !/^[a-f0-9]{24}$/.test(r.accountId) || !['full', 'five'].includes(r.kind) ||
          !['pending', 'unknown', 'settled', 'reviewed'].includes(r.state) ||
          typeof r.requestId !== 'string' || !Number.isFinite(r.createdAt)) throw new Error('Invalid reset journal; inspect DATA_DIR');
        if (r.scopeId !== undefined && !/^[a-f0-9]{24}$/.test(r.scopeId)) throw new Error('Invalid reset journal; inspect DATA_DIR');
        this.records.push({ ...r, scopeId: r.scopeId || r.accountId, state: r.state === 'pending' ? 'unknown' : r.state });
      }
      this.save();
    }
  }
  save() {
    const temporary = path.join(this.directory, `.${randomUUID()}.tmp`);
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({ version: 1, operations: this.records }));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, this.file);
    const dir = fs.openSync(this.directory, 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  }
  get(id) { return this.records.find(r => r.id === id); }
  latest(accountId, scopeId = accountId) { return this.records.findLast(r => r.accountId === accountId || r.scopeId === scopeId); }
  blocked(accountId, scopeId = accountId) { return this.records.find(r => (r.accountId === accountId || r.scopeId === scopeId) && ['pending', 'unknown'].includes(r.state)); }
  begin({ id, accountId, scopeId = accountId, kind, requestId }) {
    if (this.get(id) || this.blocked(accountId, scopeId)) throw new Error('Reset already pending');
    if (this.records.length >= 5000) throw new Error('Reset journal full; archive reviewed history first');
    const row = { id, accountId, scopeId, kind, requestId, state: 'pending', outcome: null, createdAt: this.now(), updatedAt: this.now() };
    this.records.push(row);
    try { this.save(); } catch (error) { this.records.pop(); throw error; }
    return row;
  }
  finish(id, outcome) {
    const row = this.get(id);
    if (!row) throw new Error('Unknown reset operation');
    row.outcome = outcome; row.state = outcome === 'unknown' ? 'unknown' : 'settled'; row.updatedAt = this.now();
    try { this.save(); } catch (error) {
      // The durable record is still pending; preserve the same block in memory.
      row.state = 'unknown'; row.outcome = 'unknown';
      throw error;
    }
    return row;
  }
  review(id, accountId, scopeId = accountId) {
    const row = this.get(id);
    if (!row || row.state !== 'unknown' || (row.scopeId !== scopeId && !(row.scopeId === row.accountId && row.accountId === accountId))) return null;
    row.state = 'reviewed'; row.updatedAt = this.now();
    try { this.save(); } catch (error) { row.state = 'unknown'; throw error; }
    return row;
  }
  public(row) {
    return row ? { id: row.id, accountId: row.accountId, kind: row.kind, state: row.state, outcome: row.outcome, createdAt: row.createdAt } : null;
  }
}
