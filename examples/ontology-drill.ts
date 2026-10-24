// Optional local blind-drill host. Synthetic data, no Worker, model or provider adapters.
import express from 'express';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { drillCase, DRILL_QUESTIONS } from '../tests/fixtures/ontology-drill.js';
import { OntologyObjectStore } from '../packages/ontology/object-store.js';
import { OntologyPlanningSession, planningToolCatalog } from '../packages/coordinator/planning-session.js';
import type { ServiceRequest } from '../packages/ontology/execution.js';

const answerSchema = z.object({ answer: z.string().min(1).max(20000), evidence: z.array(z.string().min(1).max(500)).max(100), assistanceNeeded: z.boolean(), limitations: z.array(z.string().max(1000)).max(20) }).strict();
export interface DrillDataset { id: string; question: string; asOf: string; datasetVersion: string; datasetDigest: string; request: ServiceRequest; owner?: string; initialize(graph: OntologyObjectStore, owner: string, database?: DatabaseSync): OntologyObjectStore | void; close?: () => void }
export async function createDrillHost(directory: string, datasets: (asOf: number) => DrillDataset[] = asOf => DRILL_QUESTIONS.map(([id]) => {
  const data = drillCase(id, asOf);
  return { ...data, id, initialize: (graph: OntologyObjectStore, owner: string) => graph.ingest(owner, data.batch, data.source) };
})) {
  if (existsSync(join(directory, 'manifest.json'))) throw new Error('This drill run already has a frozen manifest; choose a new directory');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('hex'), asOf = Date.now(), sessions = new Map<string, { session: OntologyPlanningSession; database: DatabaseSync; firstAt?: string; calls: number; close?: () => void }>();
  const cases = datasets(asOf).map(data => {
    const id = data.id, database = new DatabaseSync(':memory:'), caseTime = Date.parse(data.asOf);
    if (!Number.isFinite(caseTime)) throw new Error('Invalid drill asOf time');
    let graph = new OntologyObjectStore(database, undefined, () => caseTime);
    const owner = data.owner ?? id;
    graph = data.initialize(graph, owner, database) ?? graph;
    sessions.set(id, { database, session: new OntologyPlanningSession(graph, owner, data.request), calls: 0, close: data.close });
    return { id, question: data.question, startObject: { type: 'ServiceRequest', id: data.request.id }, asOf: data.asOf, datasetVersion: data.datasetVersion, datasetDigest: data.datasetDigest, model: graph.model.ref };
  });
  const app = express(); app.use(express.json({ limit: '64kb' }));
  app.use((req, res, next) => { if (req.headers.authorization !== `Bearer ${token}`) { res.status(401).json({ error: 'unauthorized' }); return; } next(); });
  app.get('/interface', (_req, res) => res.json({ scope: 'Synthetic business investigation only. All calculations use the dataset asOf time. No external actions. No answer paths are provided.', tools: planningToolCatalog(), cases }));
  app.post('/cases/:id/tools', (req, res) => {
    const item = sessions.get(String(req.params.id)); if (!item) { res.status(404).json({ error: 'unknown_case' }); return; }
    item.firstAt ??= new Date().toISOString();
    try {
      const call = z.object({ tool: z.string().max(80), input: z.unknown() }).strict().parse(req.body);
      const output = item.session.call(call.tool, call.input); item.calls++;
      appendFileSync(join(directory, 'queries.jsonl'), JSON.stringify({ at: new Date().toISOString(), caseId: req.params.id, ...call, output, receipt: item.session.receipts().at(-1) }) + '\n', { mode: 0o600 });
      res.json(output);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid query';
      appendFileSync(join(directory, 'queries.jsonl'), JSON.stringify({ at: new Date().toISOString(), caseId: req.params.id, ...req.body, output: { error: message }, rejected: true }) + '\n', { mode: 0o600 });
      res.status(400).json({ error: message });
    }
  });
  app.post('/cases/:id/answer', (req, res) => {
    const item = sessions.get(String(req.params.id)); if (!item) { res.status(404).json({ error: 'unknown_case' }); return; }
    try {
      if (existsSync(join(directory, `${req.params.id}.json`))) { res.status(409).json({ error: 'The first submitted answer is preserved; a later attempt requires a separately recorded run' }); return; }
      const answer = answerSchema.parse(req.body);
      if (!item.firstAt || !item.session.receipts().some(r => r.tool === 'query_ontology' && r.status === 'ok')) { res.status(409).json({ error: 'Read the case data before answering' }); return; }
      const completedAt = new Date().toISOString();
      writeFileSync(join(directory, `${req.params.id}.json`), JSON.stringify({ caseId: req.params.id, startedAt: item.firstAt, completedAt, elapsedMs: Date.parse(completedAt) - Date.parse(item.firstAt), calls: item.calls, ...answer }, null, 2), { mode: 0o600 });
      res.json({ saved: true, caseId: req.params.id, evaluated: false });
    } catch { res.status(400).json({ error: 'Answer schema: answer, evidence[], assistanceNeeded, limitations[]' }); }
  });
  const server = createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No bound drill address');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  writeFileSync(join(directory, 'access.json'), JSON.stringify({ baseUrl, token }, null, 2), { mode: 0o600 });
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ scope: 'synthetic', cases }, null, 2), { mode: 0o600 });
  return { baseUrl, token, close: async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); for (const item of sessions.values()) { item.database.close(); item.close?.(); } } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = resolve(process.argv[2] ?? 'data/ontology-n2-drill');
  const host = await createDrillHost(directory);
  console.log(JSON.stringify({ ready: true, baseUrl: host.baseUrl, accessFile: join(directory, 'access.json') }));
  const stop = async () => { await host.close(); process.exit(0); };
  process.on('SIGINT', () => { void stop(); }); process.on('SIGTERM', () => { void stop(); });
}
