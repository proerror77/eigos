import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

test('the SQLite deployment entry rejects PostgreSQL before opening stores or changing a host',()=>{
  const directory=mkdtempSync(join(tmpdir(),'eigos-pg-deploy-guard-')),config=join(directory,'primary.env');
  try{
    // Intentionally lacks SQLite paths and a host service configuration. The
    // backend refusal must precede config validation and storage inspection.
    writeFileSync(config,'EIGOS_STORAGE_BACKEND=postgres\n',{mode:0o600});
    const child=spawnSync(process.execPath,[resolve('scripts/deploy-primary.mjs'),'--config',config,'--apply'],{cwd:resolve('.'),encoding:'utf8',timeout:15000});
    assert.equal(child.status,1);assert.match(child.stderr,/PostgreSQL deployment requires its reviewed migration handoff/);
    assert.doesNotMatch(child.stderr,/SQLITE|DatabaseSync|Missing required|Invalid configuration/);
    assert.deepEqual(readdirSync(directory),['primary.env']);
  }finally{rmSync(directory,{recursive:true,force:true});}
});
