import {mkdirSync,rmSync} from 'node:fs';
import {materialize} from './materialize-foundry.mjs';
rmSync('dist/engine',{recursive:true,force:true});
mkdirSync('dist/engine',{recursive:true});
materialize('dist/engine',{engineOnly:true});
