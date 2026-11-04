import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { authorizationScope } from '../packages/security/context.js';
import { combineEnvelopes, type SecurityEnvelope } from '../packages/security/envelope.js';
import { readDependencyFixture as fixture } from './fixtures/read-dependencies.js';
import { Worker } from '../apps/worker/worker.js';

test('cumulative evidence checks database versions in proportion to distinct inputs', t => {
  const f = fixture(48), original = DatabaseSync.prototype.prepare;
  let versionReads = 0, contentReads = 0, statements = 0;
  try {
    t.mock.method(DatabaseSync.prototype, 'prepare', function(this: DatabaseSync, sql: string) {
      const statement = original.call(this, sql);
      for (const method of ['get', 'all', 'run'] as const) {
        const execute = statement[method].bind(statement);
        t.mock.method(statement, method, (...args: Parameters<typeof execute>) => {
          statements++;
          if (/pragma_data_version|PRAGMA data_version/i.test(sql)) versionReads++;
          if (sql === 'SELECT body,revision FROM ontology_objects WHERE owner=? AND type=? AND id=?') contentReads++;
          return Reflect.apply(execute, statement, args);
        });
      }
      return statement;
    });
    assert.equal(f.read().properties.name, 'dependency-47');
    t.diagnostic(JSON.stringify({ inputs: f.inputs.length, versionReads, contentReads, statements }));
    assert.equal(contentReads, 47, 'Each source content is checked once');
    assert(versionReads <= f.inputs.length * 8 + 40,
      `Shared dependencies caused ${versionReads} version queries for ${f.inputs.length} inputs`);
  } finally { f.close(); }
});

for (const difference of ['digest', 'revision', 'fields'] as const) test(`a repeated dependency with different ${difference} is independently checked`, () => {
  const f = fixture(12);
  try {
    const last = f.inputs.at(-1)!;
    const bad: SecurityEnvelope = structuredClone(combineEnvelopes(f.envelopes.slice(0, -1)));
    const dependency = structuredClone(bad.lineage[0]!);
    if (difference === 'digest') dependency.contentDigest = '0'.repeat(64);
    if (difference === 'revision') dependency.revision++;
    if (difference === 'fields') dependency.fields!.push('address');
    bad.lineage.push(dependency);
    f.policy.bind(f.grant, last.object, last.fields, 'member_asset', bad);
    assert.throws(f.read, /not available|OUTPUT_NOT_ALLOWED/);
  } finally { f.close(); }
});

test('shared dependency proofs do not survive a later content change', () => {
  const f = fixture(12);
  try {
    f.within(() => {
      const scope = authorizationScope()!, last = f.inputs.at(-1)!;
      assert(f.policy.binding(scope, last.object));
      f.db.prepare("UPDATE ontology_objects SET body=json_set(body,'$.properties.name','changed') WHERE owner=? AND type='Place' AND id=?")
        .run(f.owner, f.inputs[0]!.object.id);
      assert.equal(f.policy.binding(scope, last.object), undefined);
    });
  } finally { f.close(); }
});

test('shared dependency proofs cannot conceal a newly restricted ancestor', () => {
  const f = fixture(12);
  try {
    assert.equal(f.read().properties.name, 'dependency-11');
    f.policy.restrictObject({ ownerKey: f.owner, object: f.inputs[0]!.object, expectedObjectRevision: 1,
      field: 'name', classification: 'sensitive', requiredMarkings: ['health'], channels: ['agent_response'] }, f.policy.revision());
    assert.throws(f.read, /not available|INSUFFICIENT_ACCESS|OUTPUT_NOT_ALLOWED/);
  } finally { f.close(); }
});

for (const connection of ['current', 'separate'] as const) test(`a ${connection}-connection write during a dependency read rejects the mixed result`, t => {
  const f = fixture(2), original = DatabaseSync.prototype.prepare;
  let changed = false;
  try {
    t.mock.method(DatabaseSync.prototype, 'prepare', function(this: DatabaseSync, sql: string) {
      const statement = original.call(this, sql);
      if (sql === 'SELECT body,revision FROM ontology_objects WHERE owner=? AND type=? AND id=?') {
        const get = statement.get.bind(statement), writer = connection === 'current' ? this : f.db;
        t.mock.method(statement, 'get', (...args: Parameters<typeof get>) => {
          const row = Reflect.apply(get, statement, args);
          if (!changed) {
            changed = true;
            original.call(writer, "UPDATE ontology_objects SET body=json_set(body,'$.properties.name','changed during read') WHERE owner=? AND type='Place' AND id=?")
              .run(f.owner, f.inputs[0]!.object.id);
          }
          return row;
        });
      }
      return statement;
    });
    assert.throws(() => f.within(() => { f.policy.binding(authorizationScope()!, f.inputs.at(-1)!.object); }), /POLICY_CHANGED/);
    assert(changed, 'The source changed after its content was read');
    assert.throws(f.read, /not available|OUTPUT_NOT_ALLOWED/, 'A new read must inspect the changed dependency');
  } finally { f.close(); }
});

for (const connection of ['current', 'separate'] as const) test(`a ${connection}-connection heartbeat during a dependency read ${connection === 'separate' ? 'rechecks the same proof' : 'still invalidates the traversal'}`, t => {
  const f = fixture(2), original = DatabaseSync.prototype.prepare;
  let writes = 0, traversals = 0, callers = 0;
  try {
    t.mock.method(DatabaseSync.prototype, 'prepare', function(this: DatabaseSync, sql: string) {
      const statement = original.call(this, sql);
      if (sql === 'SELECT body,revision FROM ontology_objects WHERE owner=? AND type=? AND id=?') {
        const get = statement.get.bind(statement), writer = connection === 'current' ? this : f.db;
        t.mock.method(statement, 'get', (...args: Parameters<typeof get>) => {
          const row = Reflect.apply(get, statement, args); traversals++;
          if (!writes++) original.call(writer, 'UPDATE security_manager SET expires_at=expires_at+1 WHERE slot=1').run();
          return row;
        });
      }
      return statement;
    });
    const read = () => f.within(() => { callers++; assert(f.policy.binding(authorizationScope()!, f.inputs.at(-1)!.object)); });
    if (connection === 'separate') { read(); assert.equal(traversals, 2, 'The whole binding proof is read again after an external commit'); }
    else { assert.throws(read, /POLICY_CHANGED/); assert.equal(traversals, 1); }
    assert.equal(callers, 1, 'Retrying a binding never repeats its caller or a business operation');
  } finally { f.close(); }
});

test('continuous external commits exhaust the bounded binding recheck', t => {
  const f = fixture(2), original = DatabaseSync.prototype.prepare;
  let traversals = 0;
  try {
    t.mock.method(DatabaseSync.prototype, 'prepare', function(this: DatabaseSync, sql: string) {
      const statement = original.call(this, sql);
      if (sql === 'SELECT body,revision FROM ontology_objects WHERE owner=? AND type=? AND id=?') {
        const get = statement.get.bind(statement);
        t.mock.method(statement, 'get', (...args: Parameters<typeof get>) => {
          const row = Reflect.apply(get, statement, args); traversals++;
          original.call(f.db, 'UPDATE security_manager SET expires_at=expires_at+1 WHERE slot=1').run();
          return row;
        });
      }
      return statement;
    });
    assert.throws(() => f.within(() => f.policy.binding(authorizationScope()!, f.inputs.at(-1)!.object)), /POLICY_CHANGED/);
    assert.equal(traversals, 3, 'Initial traversal plus at most two rechecks');
  } finally { f.close(); }
});

for (const mutation of ['none', 'content', 'trigger'] as const)
test(`a checked Worker renewal during a dependency read ${mutation === 'none' ? 'preserves the proof' : `does not hide a ${mutation} write`}`, async t => {
  let clock = Date.now(); t.mock.method(Date, 'now', () => clock);
  const f = fixture(2, () => clock), original = DatabaseSync.prototype.prepare;
  f.jobs.security.attachTaskAuthority({ ...f.taskAuthority, id: randomUUID(), dataGrant: { id: f.grant.id, revision: f.grant.revision }, submittedScopes: ['tasks:read', 'tasks:write'] });
  if (mutation === 'trigger') f.db.exec(`CREATE TRIGGER renewal_business_write AFTER UPDATE ON work_claims BEGIN
    UPDATE ontology_objects SET body=json_set(body,'$.properties.name','changed by trigger') WHERE type='Place'; END`);
  let injected = false, renewals = 0, callers = 0, value: unknown, error: unknown;
  const renew = f.jobs.renew.bind(f.jobs);
  t.mock.method(f.jobs, 'renew', (...args: Parameters<typeof renew>) => {
    const result = renew(...args); if (result) renewals++; return result;
  });
  t.mock.method(DatabaseSync.prototype, 'prepare', function(this: DatabaseSync, sql: string) {
    const statement = original.call(this, sql);
    if (sql === 'SELECT body,revision FROM ontology_objects WHERE owner=? AND type=? AND id=?') {
      const get = statement.get.bind(statement);
      t.mock.method(statement, 'get', (...args: Parameters<typeof get>) => {
        const row = Reflect.apply(get, statement, args), scope = authorizationScope();
        if (!injected && scope?.synchronousRead && scope.actor.actorKind === 'worker') {
          injected = true; clock += 6000;
          scope.assertCurrent(); // Real Worker progress renews its original, still-valid claim.
          if (mutation === 'content') original.call(this, "UPDATE ontology_objects SET body=json_set(body,'$.properties.name','changed during renewal') WHERE owner=? AND type='Place' AND id=?")
            .run(f.owner, f.inputs[0]!.object.id);
        }
        return row;
      });
    }
    return statement;
  });
  const worker = new Worker(f.jobs, { leaseMs: 15000, pollMs: 60000, coordinator: { run: async () => {
    callers++;
    try { value = f.jobs.ontology.read(f.owner, f.inputs.at(-1)!.object).properties.name; } catch (failure) { error = failure; }
  } } });
  try {
    worker.tick(); await new Promise<void>(resolve => setImmediate(resolve));
    assert(injected, 'The dependency must be read before the renewal');
    assert.equal(renewals, 1, 'The actual Worker must renew the current claim once');
    assert.equal(callers, 1, 'The Worker must execute the selected work once');
    if (mutation === 'none') { assert.ifError(error); assert.equal(value, 'dependency-1'); }
    else { assert.equal(value, undefined); assert.match(String(error), /POLICY_CHANGED/); }
  } finally { await worker.close(); f.close(); }
});


for (const cursorTrigger of [false,true]) test(`cursor bookkeeping ${cursorTrigger ? 'cannot hide graph mutations' : 'preserves a fenced read'}`,()=>{
  const f=fixture(2);
  try {
    if(cursorTrigger)f.db.exec("CREATE TRIGGER cursor_business_change AFTER INSERT ON security_cursors BEGIN UPDATE ontology_objects SET body=json_set(body,'$.properties.name','changed by cursor trigger') WHERE type='Place'; END");
    const read=()=>f.within(()=>f.jobs.ontology.withReadMemo(f.owner,()=>{
      const before=f.jobs.ontology.read(f.owner,f.inputs[0]!.object);
      const token=f.policy.cursor(f.owner,'cursor-memo-test',undefined,f.inputs[0]!.object);
      assert.equal(typeof token,'string');
      assert.deepEqual(f.policy.cursor(f.owner,'cursor-memo-test',token as string),f.inputs[0]!.object);
      assert.equal(f.jobs.ontology.read(f.owner,f.inputs[0]!.object).properties.name,before.properties.name);
    }));
    if(cursorTrigger)assert.throws(read,/POLICY_CHANGED|Facts or authority changed|OUTPUT_NOT_ALLOWED|not available/);
    else read();
  } finally {f.close();}
});

test('a fenced graph read never reuses an object after its grant is revoked',()=>{
  const f=fixture(2);
  try {
    assert.throws(()=>f.within(()=>f.jobs.ontology.withReadMemo(f.owner,()=>{
      f.jobs.ontology.read(f.owner,f.inputs[0]!.object);
      f.jobs.security.revokeGrant(f.owner,f.grant.id,f.grant.revision);
      f.jobs.ontology.read(f.owner,f.inputs[0]!.object);
    })),/POLICY_CHANGED|AUTHORIZATION_REQUIRED|INSUFFICIENT_ACCESS/);
  } finally {f.close();}
});
