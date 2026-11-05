import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {relayNodeMigrationFixture} from './fixtures/relay-node-migration.js';
import {digest} from '../packages/core/delegation.js';
import {repointRelayNodeSnapshot,postgresMigrationWrappingKey} from '../packages/deployment/postgres-node-migration.js';
import {relayNodeSnapshotSchema} from '../packages/agent-transport/store.js';
import {openEnvelope} from '../packages/agent-transport/crypto.js';
import {importPostgresRelayNodeInAdminContext,postgresRelayNodeDigestInAdminContext,type OfflineRelayNodeContext} from '../packages/postgres/relay-node-store.js';

test('offline v2 origin repoint preserves original keys, TEXT receipts, expired ciphertext/state and cursors without current authorization',async()=>{
  const f=await relayNodeMigrationFixture();try{
    const sourceDigest=digest(f.snapshot),changed=await repointRelayNodeSnapshot(f.snapshot,{nodeId:'gateway',agentId:f.keys.identity.card.agentId,sourceBaseUrl:f.sourceBaseUrl,targetBaseUrl:f.targetBaseUrl,sourceSnapshotDigest:sourceDigest,sourceFiles:f.sourceFiles});
    assert.notEqual(changed.receipt.targetSnapshotDigest,sourceDigest);assert.equal(changed.receipt.serverAcceptance,'not-observed');assert.equal(changed.receipt.receiptText,'preserved');
    assert.deepEqual(changed.snapshot,{...f.snapshot,credentials:{...f.snapshot.credentials,baseUrl:f.targetBaseUrl}});
    assert.equal(changed.snapshot.outbox[0]!.receiptText,f.receiptText);assert.equal(changed.snapshot.inbox[0]!.reason,'');assert.deepEqual(changed.receipt.counts,{outbox:1,inbox:1,retained:1});
    await assert.rejects(openEnvelope(changed.snapshot.inbox[0]!.envelope!,f.peer.identity,f.keys),/MESSAGE_EXPIRED_OR_INVALID/);
    assert.equal(createHash('sha256').update(readFileSync(f.credentialPath)).digest('hex'),f.sourceFiles.credentialFileDigest);assert.equal(createHash('sha256').update(readFileSync(f.statePath)).digest('hex'),f.sourceFiles.stateFileDigest);
  }finally{f.close();}
});

test('offline migration rejects altered private keys, receipt TEXT, signatures and unknown v1 raw receipt bytes',async()=>{
  const f=await relayNodeMigrationFixture();try{
    const options={nodeId:'gateway',agentId:f.keys.identity.card.agentId,sourceBaseUrl:f.sourceBaseUrl,targetBaseUrl:f.targetBaseUrl,sourceSnapshotDigest:digest(f.snapshot),sourceFiles:f.sourceFiles};
    const wrong=structuredClone(f.snapshot);wrong.credentials.signingKey.d=f.peer.signingKey.d!;
    await assert.rejects(repointRelayNodeSnapshot(wrong,{...options,sourceSnapshotDigest:digest(wrong)}),/private key/);
    const raw=structuredClone(f.snapshot);if(raw.format!=='eigos.relay-node.snapshot.v2')throw new Error('Expected actual v2 export');raw.outbox[0]!.receiptText='{}';assert.equal(relayNodeSnapshotSchema.safeParse(raw).success,false);
    const corrupt=structuredClone(f.snapshot);corrupt.outbox[0]!.envelope+='x';await assert.rejects(repointRelayNodeSnapshot(corrupt,{...options,sourceSnapshotDigest:digest(corrupt)}));
    const legacy={...f.snapshot,format:'eigos.relay-node.snapshot.v1',outbox:f.snapshot.outbox.map(row=>{const {receiptText:_text,...rest}=row;return rest;})};
    assert(relayNodeSnapshotSchema.safeParse(legacy).success);await assert.rejects(repointRelayNodeSnapshot(legacy,{...options,sourceSnapshotDigest:digest(legacy)}),/v1 raw serialization is unknown/);
  }finally{f.close();}
});

test('offline administrator capability cannot be forged by a typed object or host key mismatch',async()=>{
  const f=await relayNodeMigrationFixture();try{
    const bytes=Buffer.alloc(32,7),pin={env:'EIGOS_RELAY_WRAPPING_KEY' as const,sha256:createHash('sha256').update(bytes).digest('hex')},key=await postgresMigrationWrappingKey(pin,{EIGOS_RELAY_WRAPPING_KEY:bytes.toString('base64url')});assert.equal(key.extractable,false);
    const forged:OfflineRelayNodeContext={kind:'eigos.offline-relay-node-context'},input={nodeId:'gateway',baseUrl:f.targetBaseUrl,wrappingKey:key,expectedAgentId:f.keys.identity.card.agentId,expectedSnapshotDigest:digest(f.snapshot)};
    await assert.rejects(importPostgresRelayNodeInAdminContext(forged,{...input,snapshot:f.snapshot}),/live verified offline migration-admin context/);await assert.rejects(postgresRelayNodeDigestInAdminContext(forged,input),/live verified offline migration-admin context/);
    await assert.rejects(postgresMigrationWrappingKey(pin,{EIGOS_RELAY_WRAPPING_KEY:Buffer.alloc(32,8).toString('base64url')}),/differs/);
  }finally{f.close();}
});

test('offline node CLI defaults to preview and refuses implicit apply or source-stopped assertions',()=>{
  const help=spawnSync(process.execPath,['scripts/postgres-node-migrate.mjs','--help'],{encoding:'utf8'});assert.equal(help.status,0);assert.match(help.stdout,/Preview reads frozen private artifacts/);
  const refused=spawnSync(process.execPath,['scripts/postgres-node-migrate.mjs','--source-stopped'],{encoding:'utf8'});assert.equal(refused.status,2);
});
