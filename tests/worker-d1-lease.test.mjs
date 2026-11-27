import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migration = fs.readFileSync(path.join(root, "migrations/0007_worker_leases.sql"), "utf8");
const worker = fs.readFileSync(path.join(root, "worker.js"), "utf8");
const acquireSql = `
  INSERT INTO mam_worker_leases (lease_key, owner_token, acquired_at, expires_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(lease_key) DO UPDATE SET
    owner_token=excluded.owner_token,
    acquired_at=excluded.acquired_at,
    expires_at=excluded.expires_at
  WHERE mam_worker_leases.expires_at <= excluded.acquired_at
`;

test("D1 worker lease migration is add-only and CAS prevents active lease theft", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(migration);
    const acquire = db.prepare(acquireSql);
    const read = db.prepare("SELECT owner_token, expires_at FROM mam_worker_leases WHERE lease_key=?");
    acquire.run("sync", "owner-a", "2026-11-27T10:00:00.000Z", "2026-11-27T10:08:00.000Z");
    acquire.run("sync", "owner-b", "2026-11-27T10:01:00.000Z", "2026-11-27T10:09:00.000Z");
    assert.deepEqual({ ...read.get("sync") }, { owner_token: "owner-a", expires_at: "2026-11-27T10:08:00.000Z" });
    acquire.run("sync", "owner-b", "2026-11-27T10:09:00.000Z", "2026-11-27T10:17:00.000Z");
    assert.deepEqual({ ...read.get("sync") }, { owner_token: "owner-b", expires_at: "2026-11-27T10:17:00.000Z" });
    db.prepare("DELETE FROM mam_worker_leases WHERE lease_key=? AND owner_token=?").run("sync", "owner-a");
    assert.equal(read.get("sync").owner_token, "owner-b");
    db.prepare("DELETE FROM mam_worker_leases WHERE lease_key=? AND owner_token=?").run("sync", "owner-b");
    assert.equal(read.get("sync"), undefined);
  } finally {
    db.close();
  }
});

test("Worker scheduled source fails closed on missing lease migration and releases owner lease", () => {
  assert.match(worker, /const WORKER_SYNC_LEASE_KEY = "mam:worker-lease:espn-sync:v1"/);
  assert.match(worker, /const WORKER_B_LEASE_KEY = "mam:worker-lease:b-daily:v1"/);
  assert.match(worker, /if \(!syncLease\.acquired\)/);
  assert.match(worker, /if \(!bLease\.acquired\)/);
  assert.match(worker, /releaseD1Lease\(env, WORKER_SYNC_LEASE_KEY, syncLease\.ownerToken\)/);
  assert.match(worker, /releaseD1Lease\(env, WORKER_B_LEASE_KEY, bLease\.ownerToken\)/);
});
