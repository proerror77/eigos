import {parseArgs} from 'node:util';
import {readHarnessLogin,refreshHarnessLogin} from '../dist/packages/deployment/harness-login.js';
const {values}=parseArgs({options:{config:{type:'string'},force:{type:'boolean'}}});
if(!values.config)throw new Error('Provide the private cloud-owned --config; never point it at the original Mac login');
console.log(JSON.stringify(await refreshHarnessLogin(readHarnessLogin(values.config),{force:values.force===true})));
