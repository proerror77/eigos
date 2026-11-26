// Vector ranking in pgvector, for the C5c decision on where semantic vectors live. For each size N it stores N random
// unit vectors and measures:
// - exact: the ranking semantic search runs, which joins the authorized, current candidates as a JSON list and scores
//   every one of them (`WITH eligible AS MATERIALIZED … ORDER BY distance LIMIT 10`);
// - hnsw: an HNSW index's top 10, with its recall against the exact top 10.
// It also reports the table and index sizes, and what the vectors would take in the query kernel's memory.
//
// Usage, with a PostgreSQL that has pgvector (for example the pgvector/pgvector image the vector test suite uses):
//   node scripts/benchmarks/vectors.mjs postgres://postgres:synthetic-only@127.0.0.1:5432/postgres --sizes=10000,100000 --queries=20
import pg from 'pg';

const url = process.argv[2];
const flag = (name, fallback) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const sizes = flag('sizes', '10000,100000').split(',').map(Number), dims = Number(flag('dims', 384)), queries = Number(flag('queries', 20));
if (!url) throw new Error('Give a PostgreSQL URL with pgvector');
const client = new pg.Client({ connectionString: url });
await client.connect();
const percentiles = values => {
  const sorted = [...values].sort((a, b) => a - b), at = q => Math.round(sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] * 10) / 10;
  return { p50: at(0.5), p95: at(0.95) };
};
const random = () => {
  const vector = Array.from({ length: dims }, () => Math.random() - 0.5), norm = Math.hypot(...vector);
  return vector.map(value => value / norm);
};
const time = async run => { const started = performance.now(); const value = await run(); return { ms: performance.now() - started, value }; };
try {
  await client.query('CREATE EXTENSION IF NOT EXISTS vector');
  await client.query('SET statement_timeout = 0');
  const report = [];
  for (const n of sizes) {
    await client.query('DROP TABLE IF EXISTS vector_bench');
    await client.query(`CREATE TABLE vector_bench (type text NOT NULL, id text NOT NULL, revision bigint NOT NULL, text_digest text NOT NULL,
      embedding vector(${dims}) NOT NULL)`);
    // Random unit vectors; the inner query's filter refers to the row, so that each row gets its own vector.
    await client.query(`INSERT INTO vector_bench SELECT 'Doc', 'd' || g, 1, md5(g::text),
      (SELECT array_agg(random() - 0.5) FROM generate_series(1, ${dims}) WHERE g IS NOT NULL)::vector FROM generate_series(1, $1::int) g`, [n]);
    await client.query(`UPDATE vector_bench SET embedding = l2_normalize(embedding)`);
    await client.query('CREATE UNIQUE INDEX vector_bench_identity ON vector_bench (type, id, revision, text_digest)');
    await client.query('ANALYZE vector_bench');
    const accepted = JSON.stringify(Array.from({ length: n }, (_, i) => ({ type: 'Doc', id: 'd' + (i + 1), revision: 1, text_digest: null, ordinal: i })));
    const digests = (await client.query('SELECT id, text_digest FROM vector_bench')).rows;
    const byId = new Map(digests.map(row => [row.id, row.text_digest]));
    const candidates = JSON.stringify(JSON.parse(accepted).map(item => ({ ...item, text_digest: byId.get(item.id) })));
    const exact = [], hnsw = [], recall = [];
    const top = [];
    for (let q = 0; q < queries; q++) {
      const vector = JSON.stringify(random());
      const result = await time(() => client.query(`WITH eligible AS MATERIALIZED (
          SELECT accepted.ordinal, v.embedding FROM vector_bench v
          JOIN jsonb_to_recordset($1::jsonb) AS accepted(type text, id text, revision bigint, text_digest text, ordinal integer)
            ON (v.type, v.id, v.revision, v.text_digest) = (accepted.type, accepted.id, accepted.revision, accepted.text_digest)
        ), scored AS (SELECT ordinal, embedding <=> $2::vector AS distance FROM eligible)
        SELECT ordinal FROM scored ORDER BY distance, ordinal LIMIT 10`, [candidates, vector]));
      exact.push(result.ms);
      top.push({ vector, ids: result.value.rows.map(row => 'd' + (row.ordinal + 1)) });
    }
    const built = await time(() => client.query('CREATE INDEX vector_bench_hnsw ON vector_bench USING hnsw (embedding vector_cosine_ops)'));
    for (const { vector, ids } of top) {
      const result = await time(() => client.query('SELECT id FROM vector_bench ORDER BY embedding <=> $1::vector LIMIT 10', [vector]));
      hnsw.push(result.ms);
      const found = new Set(result.value.rows.map(row => row.id));
      recall.push(ids.filter(id => found.has(id)).length / ids.length);
    }
    const sizes = (await client.query(`SELECT pg_size_pretty(pg_table_size('vector_bench')) AS "tableSize",
      pg_size_pretty(pg_relation_size('vector_bench_hnsw')) AS "hnswSize"`)).rows[0];
    const row = { n, dims, exact: percentiles(exact), hnsw: { ...percentiles(hnsw), buildMs: Math.round(built.ms),
      recallAt10: Math.round(recall.reduce((a, b) => a + b, 0) / recall.length * 1000) / 1000 }, ...sizes,
      kernelFloat32Mb: Math.round(n * dims * 4 / 1048576) };
    console.log(JSON.stringify(row));
    report.push(row);
  }
  await client.query('DROP TABLE IF EXISTS vector_bench');
} finally { await client.end(); }
