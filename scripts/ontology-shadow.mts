// Operator-side consumer of committed publication events. No gateway or activation writes.
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { digest } from "../packages/core/delegation.js";

const { values } = parseArgs({
  options: {
    db: { type: "string" },
    out: { type: "string" },
    watch: { type: "boolean" },
    retry: { type: "boolean" },
  },
});
if (!values.db || !values.out)
  throw Error(
    "Specify --db <business.sqlite> --out <private report directory> [--watch] [--retry]",
  );
const home = fileURLToPath(
  new URL("../packages/ontology/shadow/", import.meta.url),
);
const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const suiteDigest = digest(
  Object.fromEntries(
    [
      "mapping.py",
      "check.py",
      "check.py.lock",
      "cases.py",
      "jars.json",
      "fixtures/didi.ttl",
      "fixtures/didi-shapes.ttl",
    ].map((file) => [file, sha(readFileSync(join(home, file)))]),
  ),
);
const db = new DatabaseSync(resolve(values.db), { readOnly: true });
const out = resolve(values.out);
mkdirSync(out, { recursive: true, mode: 0o700 });
const next = db.prepare(
  "SELECT rowid,body FROM ontology_definition_events WHERE rowid>? AND ontology_id='eigos.business' AND kind='published' ORDER BY rowid LIMIT 1",
);
const lookup = db.prepare(
  "SELECT body,model_digest FROM ontology_definition_releases WHERE ontology_id=? AND id=? AND digest=?",
);
let cursor = 0;
try {
  for (;;) {
    const event = next.get(cursor);
    if (!event) {
      if (!values.watch) break;
      await sleep(10000);
      continue;
    }
    const { release, draftId } = JSON.parse(String(event.body));
    if (
      release.ontologyId !== "eigos.business" ||
      !/^[a-f0-9]{64}$/.test(release.digest)
    )
      throw Error("Invalid committed publication reference");
    const target = join(out, release.digest + "-" + suiteDigest + ".json");
    if (!existsSync(target) || values.retry) {
      const row = lookup.get(
        release.ontologyId,
        release.releaseId,
        release.digest,
      );
      let result;
      try {
        if (!row) throw Error("Release unavailable");
        const document = JSON.parse(String(row.body));
        if (digest(document) !== release.digest)
          throw Error("Release document digest mismatch");
        const run = spawnSync(
          "uv",
          ["run", "--locked", "--python", "3.12", join(home, "check.py")],
          {
            input: JSON.stringify({ document, digest: release.digest }),
            env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
            encoding: "utf8",
            timeout: 180000,
            killSignal: "SIGKILL",
            maxBuffer: 1024 * 1024,
          },
        );
        if (run.error || run.status !== 0)
          throw Error(
            run.error?.message ??
              "Checker exited " +
                run.status +
                ": " +
                run.stderr.trim().split("\n").at(-1)?.slice(0, 220),
          );
        result = JSON.parse(run.stdout);
        if (
          !["PASS", "FAIL", "UNKNOWN"].includes(result.status) ||
          !Array.isArray(result.cases) ||
          result.cases.length !== 15
        )
          throw Error("Incomplete checker result");
      } catch (error) {
        result = {
          status: "UNKNOWN",
          reason:
            error instanceof Error ? error.message : "Checker unavailable",
        };
      }
      const report = {
        scope: "didi-estimate-synthetic",
        mode: "shadow",
        release,
        draftId,
        modelDigest: row?.model_digest,
        suiteDigest,
        checkedAt: new Date().toISOString(),
        ...result,
      };
      const tmp = target + "." + randomUUID() + ".tmp";
      try {
        writeFileSync(tmp, JSON.stringify(report, null, 2) + "\n", {
          flag: "wx",
          mode: 0o600,
        });
        renameSync(tmp, target);
      } finally {
        rmSync(tmp, { force: true });
      }
      console.log(result.status, target);
    }
    cursor = Number(event.rowid);
  }
} finally {
  db.close();
}
