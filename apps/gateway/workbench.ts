import express from 'express';
import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {Config} from '../../packages/core/config.js';
import type {VerifyToken} from './auth.js';
import {mountOntologyWorkbench} from './ontology-workbench.js';

export function mountWorkbench(app: express.Express, config: Config, verify: VerifyToken) {
  const directory = fileURLToPath(new URL('../workbench/', import.meta.url));
  const three = join(dirname(createRequire(import.meta.url).resolve('three')), '..');
  mountOntologyWorkbench(app, config, verify, 'Eigos', {
    brand: 'EIGOS', geolocation: true, stylesheet:'/workbench/solution.css',
    pages: [{id:'schedule',label:'排程'},{id:'map',label:'地图'},{id:'geometry',label:'三维模型'}],
    imports: {three:'/workbench/vendor/three/build/three.module.js','three/addons/':'/workbench/vendor/three/examples/jsm/'},
    mountAssets(app) {
      app.use('/workbench/vendor/three', express.static(three, {dotfiles:'deny',index:false}));
      app.use('/workbench', express.static(directory, {dotfiles:'deny',index:false}));
    },
  });
}
