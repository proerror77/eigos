import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setupDidi } from "./fixtures/didi.js";
import { owner } from "./backend-fixture.js";

test("committed candidate publication is inspected without activating it, with idempotent reports and retry", () => {
  const root = mkdtempSync(join(tmpdir(), "eigos-shadow-test-"));
  const db = join(root, "published.sqlite"),
    out = join(root, "reports");
  const fixture = setupDidi();
  const run = (real: boolean, retry = false) => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/ontology-shadow.mts",
        "--db",
        db,
        "--out",
        out,
        ...(retry ? ["--retry"] : []),
      ],
      {
        encoding: "utf8",
        env: real ? process.env : { ...process.env, PATH: root },
        timeout: 210000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  try {
    const store = fixture.store.definitions,
      active = store.active("eigos.business").ref;
    const draft = store.createDraft(
      owner,
      "eigos.business",
      "Synthetic candidate",
      true,
    );
    const { release } = store.publish(owner, draft.id, draft.revision, true);
    assert.notDeepEqual(active, release);
    (fixture.store as unknown as { db: DatabaseSync }).db
      .prepare("VACUUM INTO ?")
      .run(db);
    assert.match(run(false), /UNKNOWN/);
    const files = readdirSync(out);
    assert.equal(files.length, 1);
    const report = () => JSON.parse(readFileSync(join(out, files[0]!), "utf8"));
    assert.deepEqual(report().release, release);
    assert.equal(report().draftId, draft.id);
    assert.equal(run(false), "");
    if (process.env.EIGOS_TEST_SHADOW_ENGINES === "1") {
      assert.match(run(true, true), /PASS/);
      assert.equal(report().cases.length, 15);
      assert.equal(
        report().cases.every((c: { status: string }) => c.status === "PASS"),
        true,
      );
      assert.equal(report().bindings.estimateEndpoints, true);
    }
    const copy = new DatabaseSync(db, { readOnly: true });
    try {
      assert.equal(
        copy
          .prepare(
            "SELECT active_release_id AS id FROM ontology_namespaces WHERE id=?",
          )
          .get(release.ontologyId)?.id,
        active.releaseId,
      );
    } finally {
      copy.close();
    }
  } finally {
    fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});
