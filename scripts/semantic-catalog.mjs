import { parseArgs } from 'node:util';
import { isAbsolute } from 'node:path';
import pg from 'pg';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  prepareLocalEmbedding,
  loadLocalEmbedding,
} from '../packages/semantic/local-embedding.js';
import {
  SemanticCatalog,
  catalogDocuments,
  sqlIdentifier,
} from '../packages/semantic/catalog.js';
import {
  readPostgresBinding,
  postgresConnectionOptions,
} from '../packages/deployment/postgres-binding.js';
import { supabaseProxyOptions } from '../packages/postgres/supabase-proxy.js';
import { digest } from '../packages/core/delegation.js';
import { parseOntologyDocument } from '../packages/ontology/definition-contracts.js';
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'model-dir': { type: 'string' },
    binding: { type: 'string' },
    'business-schema': { type: 'string' },
    schema: { type: 'string', default: 'eigos_semantic' },
    'reader-role': { type: 'string' },
    ontology: { type: 'string', default: 'eigos.business' },
    release: { type: 'string' },
    query: { type: 'string' },
    kind: { type: 'string' },
    watch: { type: 'boolean' },
  },
});
const command = positionals[0],
  directory = values['model-dir'];
if (
  !directory ||
  !isAbsolute(directory) ||
  positionals.length !== 1 ||
  !['model', 'init', 'index', 'search'].includes(command ?? '')
)
  throw Error(
    'Use model|init|index|search --model-dir /absolute/directory [--binding /private/binding.json --schema eigos_semantic --reader-role runtime_role --ontology ID --release digest --watch]',
  );
if (command === 'model') {
  console.log(JSON.stringify(await prepareLocalEmbedding(directory)));
} else {
  let business = values['business-schema'],
    connection;
  if (values.binding) {
    const { binding } = readPostgresBinding(values.binding);
    business = binding.business.schema;
    const admin = command === 'init' || command === 'index',
      user = admin
        ? process.env.EIGOS_POSTGRES_ADMIN_USER
        : binding.connection.user;
    const password = admin
      ? process.env.EIGOS_POSTGRES_ADMIN_PASSWORD
      : process.env.EIGOS_POSTGRES_PASSWORD;
    if (!user || !password)
      throw Error(
        'The existing operator/runtime database identity is required',
      );
    connection = {
      ...postgresConnectionOptions(binding, {
        ...process.env,
        EIGOS_POSTGRES_PASSWORD: password,
      }),
      ...supabaseProxyOptions(
        binding.connection.host,
        binding.connection.port,
        binding.connection.proxyUrl,
      ),
      user,
    };
  } else {
    if (
      process.env.PGHOST !== '127.0.0.1' ||
      !process.env.PGDATABASE ||
      !process.env.PGUSER
    )
      throw Error(
        'Remote indexing requires the existing reviewed PostgreSQL binding; local tests require explicit PGHOST/PGDATABASE/PGUSER',
      );
    connection = {
      host: '127.0.0.1',
      port: Number(process.env.PGPORT ?? 5432),
      database: process.env.PGDATABASE,
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      ssl: false,
    };
  }
  const embedding = await loadLocalEmbedding(directory),
    catalog = new SemanticCatalog(embedding, values.schema),
    client = new pg.Client(connection);
  try {
    await client.connect();
    if (command === 'init') {
      await client.query('BEGIN');
      try {
        await catalog.initialize(client, values['reader-role']);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
      console.log(
        JSON.stringify({
          status: 'initialized',
          schema: values.schema,
          modelId: embedding.modelId,
        }),
      );
    } else {
      if (!business || !/^eigos_business_[a-z0-9_]{1,40}$/.test(business))
        throw Error('The exact existing business schema is required');
      const q = sqlIdentifier(business),
        ontology = values.ontology;
      const loadRelease = async (releaseDigest) => {
        const row = releaseDigest
          ? (
              await client.query(
                `SELECT id,body,digest FROM ${q}.ontology_definition_releases WHERE ontology_id=$1 AND digest=$2`,
                [ontology, releaseDigest],
              )
            ).rows[0]
          : (
              await client.query(
                `SELECT r.id,r.body,r.digest FROM ${q}.ontology_definition_releases r JOIN ${q}.ontology_namespaces n ON n.active_release_id=r.id WHERE n.id=$1`,
                [ontology],
              )
            ).rows[0];
        if (!row) throw Error('The exact published release is unavailable');
        const document = parseOntologyDocument(JSON.parse(row.body));
        if (digest(document) !== row.digest)
          throw Error('Published release content digest differs');
        const ref = {
          ontologyId: ontology,
          releaseId: row.id,
          digest: row.digest,
        };
        return { document, ref };
      };
      const index = async (releaseDigest) => {
        const { document, ref } = await loadRelease(releaseDigest);
        const docs = catalogDocuments(document),
          vectors = await catalog.encode(docs);
        await client.query('BEGIN');
        try {
          const current = await client.query(
            `SELECT body FROM ${q}.ontology_definition_releases WHERE ontology_id=$1 AND id=$2 AND digest=$3`,
            [ontology, ref.releaseId, ref.digest],
          );
          if (
            current.rowCount !== 1 ||
            digest(JSON.parse(current.rows[0].body)) !== ref.digest
          )
            throw Error('Published release changed during indexing');
          await catalog.replace(client, ref, vectors);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
        console.log(
          JSON.stringify({
            status: 'indexed',
            release: ref,
            modelId: embedding.modelId,
            documents: docs.length,
          }),
        );
      };
      if (command === 'search') {
        if (
          !values.query ||
          !['action', 'object', 'function'].includes(values.kind ?? 'action') ||
          values.watch
        )
          throw Error(
            'Search requires --query and --kind action|object|function',
          );
        const { document, ref } = await loadRelease(values.release),
          docs = catalogDocuments(document).filter(
            (d) => d.kind === (values.kind ?? 'action'),
          );
        console.log(
          JSON.stringify({
            release: ref,
            modelId: embedding.modelId,
            candidates: (
              await catalog.search(client, ref, docs, values.query)
            ).slice(0, 5),
          }),
        );
      } else await index(values.release);
      if (values.watch) {
        let cursor = 0;
        for (;;) {
          const events = await client.query(
            `SELECT __eigos_rowid AS sequence,body FROM ${q}.ontology_definition_events WHERE ontology_id=$1 AND kind='published' AND __eigos_rowid>$2 ORDER BY __eigos_rowid LIMIT 1`,
            [ontology, cursor],
          );
          if (!events.rowCount) {
            await sleep(1e4);
            continue;
          }
          const event = events.rows[0];
          await index(JSON.parse(event.body).release.digest);
          cursor = Number(event.sequence);
        }
      }
    }
  } finally {
    await client.end();
    await embedding.close();
  }
}
