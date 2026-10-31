import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, passwordHash, passwordCheck } from "../src/server/store.ts";
test("secrets survive reopen without plaintext in SQLite; tampering rejected", () => {
  const dir = mkdtempSync(join(tmpdir(), "shorts-store-"));
  let s = new Store(dir);
  try {
    const secret = "secret-only-in-memory-987654";
    s.set("oauth", { secret });
    assert.deepEqual(s.get("oauth"), { secret });
    const ciphertext = s.encrypt(secret);
    assert.throws(() => s.decrypt(ciphertext.slice(0, -8) + "AAAAAAAA"));
    s.db.close();
    assert.ok(
      !readFileSync(join(dir, "panel.sqlite")).includes(Buffer.from(secret)),
    );
    s = new Store(dir);
    assert.deepEqual(s.get("oauth"), { secret });
  } finally {
    s.db.close();
    rmSync(dir, { recursive: true });
  }
});
test("passwords are salted and incorrect passwords rejected", () => {
  const h = passwordHash("a sufficiently long password");
  assert.notEqual(h, passwordHash("a sufficiently long password"));
  assert.ok(passwordCheck("a sufficiently long password", h));
  assert.ok(!passwordCheck("wrong", h));
});

test("transaction failure rolls back all writes and remains usable", () => {
  const dir = mkdtempSync(join(tmpdir(), "shorts-rollback-"));
  const s = new Store(dir);
  try {
    assert.throws(() =>
      s.transaction(() => {
        s.set("first", { value: 1 });
        throw new Error("abort");
      }),
    );
    assert.equal(s.get("first"), null);
    assert.equal(
      s.transaction(() => {
        s.set("second", { value: 2 });
        return 42;
      }),
      42,
    );
    assert.deepEqual(s.get("second"), { value: 2 });
    assert.equal(passwordCheck("test", "bad-format"), false);
    assert.equal(passwordCheck("test", "salt:00"), false);
  } finally {
    s.db.close();
    rmSync(dir, { recursive: true });
  }
});
