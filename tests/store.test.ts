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
