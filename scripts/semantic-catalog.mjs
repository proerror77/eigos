import { parseArgs } from 'node:util';
import { isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
const usage = 'Use model|init|index|search --model-dir /absolute/directory [--binding /private/binding.json --schema eigos_semantic --reader-role runtime_role --ontology ID --release digest --watch]';
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    help: { type: 'boolean' },
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
if (values.help) { console.log(usage); process.exit(0); }
const command = positionals[0],
  directory = values['model-dir'];
if (
  !directory ||
  !isAbsolute(directory) ||
  positionals.length !== 1 ||
  !['model', 'init', 'index', 'search'].includes(command ?? '')
)
  throw Error(usage);
// Immutable packages contain dist/, while source commands use the existing
// tsx entrypoint. Help and argument validation never load a model or database.
const runtimeModule = path => {
  const source = new URL(`../${path.replace(/\.js$/, '.ts')}`, import.meta.url);
  const built = new URL(`../dist/${path}`, import.meta.url);
  return import(existsSync(source) ? source.href : built.href);
};
const [
  { default: pg },
  { prepareLocalEmbedding, loadLocalEmbedding },
  { SemanticCatalog, catalogDocuments, sqlIdentifier },
  { readPostgresBinding, postgresConnectionOptions },
  { supabaseProxyOptions }, { digest }, { parseOntologyDocument }, { assertSemanticIndexReader },
] = await Promise.all([
  import('pg'), runtimeModule('packages/semantic/local-embedding.js'), runtimeModule('packages/semantic/catalog.js'),
  runtimeModule('packages/deployment/postgres-binding.js'), runtimeModule('packages/postgres/supabase-proxy.js'),
  runtimeModule('packages/core/delegation.js'), runtimeModule('packages/ontology/definition-contracts.js'), runtimeModule('packages/semantic/runtime.js'),
]);
if (command === 'model') {
  console.log(JSON.stringify(await prepareLocalEmbedding(directory)));
} else {
  let business = values['business-schema'],
    connection, boundBinding;
  if (values.binding) {
    const { binding } = readPostgresBinding(values.binding);
    boundBinding = binding;
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
  let indexClient;
  try {
    await client.connect();
    if (command === 'init') {
      if(boundBinding&&(!values['reader-role']||values['reader-role']===boundBinding.connection.role))
        throw Error('Initialize with an independent existing semantic reader role');
      await client.query('BEGIN');
      try {
        await catalog.initialize(client, values['reader-role']);
        if(boundBinding){
          await client.query(`SET LOCAL ROLE ${sqlIdentifier(values['reader-role'])}`);
          await assertSemanticIndexReader(client,catalog,{role:boundBinding.connection.role,business:boundBinding.business.schema,membership:boundBinding.membership.schema});
          await client.query('SET LOCAL ROLE NONE');
        }
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
        if(boundBinding){
          const user=process.env.EIGOS_SEMANTIC_READER_USER,password=process.env.EIGOS_SEMANTIC_READER_PASSWORD;
          if(!user||!password||user===boundBinding.connection.user||user===boundBinding.connection.role)throw Error('Search requires the independent semantic index reader');
          indexClient=new pg.Client({...connection,user,password});await indexClient.connect();await indexClient.query('BEGIN READ ONLY');
          await assertSemanticIndexReader(indexClient,catalog,{role:boundBinding.connection.role,business:boundBinding.business.schema,membership:boundBinding.membership.schema});
        }
        console.log(
          JSON.stringify({
            release: ref,
            modelId: embedding.modelId,
            candidates: (
              await catalog.search(indexClient??client, ref, docs, values.query)
            ).slice(0, 5),
          }),
        );
        if(indexClient)await indexClient.query('COMMIT');
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
    try{await client.end();}finally{try{await indexClient?.end();}finally{await embedding.close();}}
  }
}
