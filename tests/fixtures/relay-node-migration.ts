import {mkdtempSync,writeFileSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createNodeKeys,signEnvelope} from '../../packages/agent-transport/crypto.js';
import {readRelayNodeMigrationSource} from '../../packages/agent-transport/client.js';
import {sha256} from '../../packages/relay/contracts.js';

/** Real cryptography and private SQLite files, entirely synthetic, with no
 * Relay server, member authorization, provider, network request or Worker. */
export async function relayNodeMigrationFixture(){
  const directory=mkdtempSync(join(tmpdir(),'eigos-offline-node-synthetic-'));
  try{
    const keys=await createNodeKeys('Synthetic expired-history node'),peer=await createNodeKeys('Synthetic history peer'),sourceBaseUrl='http://127.0.0.1:8448',targetBaseUrl='https://synthetic-relay.example',connectionId=randomUUID();
    const outgoing=await signEnvelope(keys,peer.identity,connectionId,{synthetic:'expired, non-bookable history'},{now:1000,expiresAt:2000}),incoming=await signEnvelope(peer,keys.identity,connectionId,{synthetic:'retained history only'},{now:1000,expiresAt:2000});
    const decode=(signed:string)=>JSON.parse(Buffer.from(signed.split('.')[1]!,'base64url').toString('utf8'));
    const sent=decode(outgoing),received=decode(incoming),receipt={id:sent.id,senderId:keys.identity.card.agentId,recipientId:peer.identity.card.agentId,digest:sha256(outgoing),status:'revoked',expiresAt:2000},receiptText=' \n'+JSON.stringify(receipt,null,3)+'\n';
    const credentialPath=join(directory,'source-node.json'),statePath=credentialPath+'.sqlite';
    writeFileSync(credentialPath,JSON.stringify({version:'eigos.relay.v1',baseUrl:sourceBaseUrl,secret:randomBytes(32).toString('base64url'),registrationId:randomUUID(),signingKey:keys.signingKey,encryptionKey:keys.encryptionKey,signedCard:keys.identity.signedCard},null,2),{mode:0o600});
    const db=new DatabaseSync(statePath);try{
      db.exec(`PRAGMA application_id=0x45474e31; CREATE TABLE node_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE node_outbox(id TEXT PRIMARY KEY,recipient TEXT NOT NULL,connection_id TEXT NOT NULL,content_digest TEXT NOT NULL,envelope TEXT NOT NULL,receipt TEXT); CREATE TABLE node_inbox(sender TEXT NOT NULL,id TEXT NOT NULL,digest TEXT NOT NULL,envelope TEXT,sender_card TEXT NOT NULL,state TEXT NOT NULL,reason TEXT,expires_at INTEGER NOT NULL,PRIMARY KEY(sender,id)); CREATE INDEX node_pending ON node_inbox(state,expires_at); CREATE TABLE node_retained(sender TEXT NOT NULL,id TEXT NOT NULL,digest TEXT NOT NULL,envelope TEXT NOT NULL,sender_card TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(sender,id));`);
      db.prepare('INSERT INTO node_meta VALUES(?,?)').run('identity',JSON.stringify([sourceBaseUrl,keys.identity.card.agentId]));
      db.prepare('INSERT INTO node_outbox(rowid,id,recipient,connection_id,content_digest,envelope,receipt) VALUES(3,?,?,?,?,?,?)').run(sent.id,peer.identity.card.agentId,connectionId,sha256(JSON.stringify({synthetic:'expired, non-bookable history'})),outgoing,receiptText);
      db.prepare('INSERT INTO node_inbox(rowid,sender,id,digest,envelope,sender_card,state,reason,expires_at) VALUES(7,?,?,?,?,?,?,?,?)').run(peer.identity.card.agentId,received.id,sha256(incoming),incoming,peer.identity.signedCard,'pending','',2000);
      db.prepare('INSERT INTO node_retained(rowid,sender,id,digest,envelope,sender_card,expires_at) VALUES(11,?,?,?,?,?,?)').run(peer.identity.card.agentId,received.id,sha256(incoming),incoming,peer.identity.signedCard,2000);
    }finally{db.close();}chmodSync(statePath,0o600);
    const exported=await readRelayNodeMigrationSource({credentialPath,statePath,expectedAgentId:keys.identity.card.agentId});
    const write=(name:string,value:unknown)=>{const path=join(directory,name),bytes=JSON.stringify(value);writeFileSync(path,bytes,{mode:0o600});return {path,sha256:createHash('sha256').update(bytes).digest('hex')};};
    return {directory,keys,peer,sourceBaseUrl,targetBaseUrl,credentialPath,statePath,receiptText,...exported,write,close:()=>rmSync(directory,{recursive:true,force:true})};
  }catch(error){rmSync(directory,{recursive:true,force:true});throw error;}
}
