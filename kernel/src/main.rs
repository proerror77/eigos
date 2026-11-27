//! EIGOS Ontology query kernel (prototype, phases C1 to C3).
//!
//! Loads a snapshot of one publication projection from PostgreSQL, or restores it from a Parquet checkpoint, into
//! per-type object tables and per-link edge tables, follows the commit log to keep them current, and executes Object Set plans compiled by the TypeScript
//! planner (`packages/runtime/kernel/`) on Apache DataFusion. Value semantics follow the reference implementation:
//! predicates are two-valued (a missing value is null, `ne` holds for null, `not` never sees an unknown), and sets are
//! ordered by the canonical reference key.

use std::{collections::{BTreeMap, HashMap, HashSet}, net::SocketAddr, path::PathBuf, sync::Arc, time::{Duration, Instant}};

use axum::{extract::State, http::StatusCode, routing::{get, post}, Json, Router};
use datafusion::arrow::array::{Array, ArrayRef, AsArray, BinaryBuilder, BooleanBuilder, Float64Builder, Int64Builder, ListBuilder, RecordBatch, StringBuilder};
use datafusion::arrow::datatypes::{DataType, Field, Schema, SchemaRef};
use datafusion::common::{Column, ScalarValue};
use datafusion::dataframe::DataFrameWriteOptions;
use datafusion::datasource::MemTable;
use datafusion::functions::core::expr_fn::coalesce;
use datafusion::functions::string::expr_fn::concat_ws;
use datafusion::functions::unicode::expr_fn::strpos;
use datafusion::functions_aggregate::expr_fn::{avg, bool_or, count, max, min, sum};
use datafusion::functions_nested::expr_fn::{array_has_all, array_has_any, cardinality, make_array};
use datafusion::logical_expr::{cast, create_udf, lit, when, ColumnarValue, Expr, JoinType, ScalarUDF, Volatility};
use datafusion::prelude::{DataFrame, ParquetReadOptions, SessionConfig, SessionContext};
use futures_util::{pin_mut, TryStreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{Mutex, RwLock};
use tokio_postgres::{Client, IsolationLevel, NoTls};

type Failure = (StatusCode, Json<Value>);
fn failure(status: StatusCode, message: impl ToString) -> Failure { (status, Json(json!({ "error": message.to_string() }))) }
fn internal(error: impl ToString) -> Failure { failure(StatusCode::INTERNAL_SERVER_ERROR, error) }
fn invalid(error: impl ToString) -> Failure { failure(StatusCode::BAD_REQUEST, error) }
/// The kernel cannot answer from what it has applied; the caller evaluates the query with the reference.
fn stale(reason: &str) -> Failure { failure(StatusCode::CONFLICT, format!("stale: {reason}")) }

#[derive(Deserialize, Serialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
enum Kind { String, Integer, Number, Boolean, Strings }

#[derive(Deserialize, Serialize, Clone, PartialEq)]
struct ColumnDef { name: String, kind: Kind }
#[derive(Deserialize, Serialize, Clone, PartialEq)]
struct TypeDef { name: String, columns: Vec<ColumnDef>, classification: Option<String> }
#[derive(Deserialize, Clone)]
struct LoadRequest { database: String, schema: String, projection: String, types: Vec<TypeDef>, links: Vec<String>, ranks: HashMap<String, i64> }

/// One type's rows: the rows loaded or last compacted, and every row changed since, by (owner, id); a changed row of
/// `None` was deleted. Reads see the base rows other than the changed ones, and the changed rows that exist.
#[derive(Clone)]
struct TypeStore {
  def: Arc<TypeDef>, schema: SchemaRef, base: Arc<MemTable>, base_rows: usize,
  changed: Arc<BTreeMap<(String, String), Option<Value>>>,
  /// The changed keys (`$cowner`, `$cid`) and the changed rows that exist; none while nothing has changed.
  overlay: Option<(Arc<MemTable>, Arc<MemTable>)>,
}

/// One link's edges, kept the same way; an edge changed to `false` was removed.
#[derive(Clone)]
struct LinkStore {
  base: Arc<MemTable>, base_rows: usize,
  changed: Arc<BTreeMap<(String, String, String), bool>>,
  /// The changed keys (`$cowner`, `$cfrom`, `$cto`) and the changed edges that exist.
  overlay: Option<(Arc<MemTable>, Arc<MemTable>)>,
}

/// One version of a loaded projection. A query reads the version that is current when it starts; applying commits makes
/// a new version that shares every table the commits do not change.
#[derive(Clone)]
struct Snapshot {
  ctx: SessionContext, request: Arc<LoadRequest>,
  kinds: HashMap<String, HashMap<String, Kind>>, classified: HashSet<String>, links: Vec<String>,
  types: HashMap<String, TypeStore>, edges: HashMap<String, LinkStore>,
  /// The last commit applied for each owner: the rows reflect it and every earlier commit of that owner.
  applied: HashMap<String, i64>,
  objects: usize, edge_count: usize, bytes: usize,
}

/// The current snapshot version; the Funnel, the one writer that applies commits, with its database connection; and the
/// last version written as a checkpoint, whose lock keeps checkpoint writes one at a time.
struct AppState { snapshot: RwLock<Option<Arc<Snapshot>>>, funnel: Mutex<Option<Client>>, checkpointed: Mutex<Option<(Arc<Snapshot>, Value)>>,
  /// How many projections this process has loaded or restored.
  loads: std::sync::atomic::AtomicUsize,
  /// The last overlay read of each owner's Scenario, by projection, owner and Scenario id, with when a query last used it;
  /// at most `OVERLAYS` are kept.
  overlays: Mutex<HashMap<(String, String, String), (Arc<Overlay>, Instant)>> }
const OVERLAYS: usize = 64;
type Shared = Arc<AppState>;

fn column(name: &str) -> Expr { Expr::Column(Column::new_unqualified(name)) }
fn data_type(kind: Kind) -> DataType {
  match kind {
    Kind::String => DataType::Utf8, Kind::Integer => DataType::Int64, Kind::Number => DataType::Float64, Kind::Boolean => DataType::Boolean,
    Kind::Strings => DataType::List(Arc::new(Field::new("item", DataType::Utf8, true))),
  }
}
/// The canonical reference key: `canonical({type,id})` orders by the JSON-encoded id, then the JSON-encoded type.
fn ref_key(kind: &str, id: &str) -> String { format!("{}{}", serde_json::to_string(id).unwrap(), serde_json::to_string(kind).unwrap()) }
fn quote(identifier: &str) -> String { format!("\"{}\"", identifier.replace('"', "\"\"")) }

const BATCH: usize = 65536;
/// Changed rows past which a type's or link's changes are folded into its base rows: at least this many, or a sixteenth of
/// the base rows. EIGOS_KERNEL_COMPACT overrides it.
fn compact_limit() -> usize { std::env::var("EIGOS_KERNEL_COMPACT").ok().and_then(|v| v.parse().ok()).unwrap_or(4096) }

fn partitions() -> usize { std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4) }

/// Spreads batches over the session's partitions so scans run in parallel.
fn spread(batches: Vec<RecordBatch>, parts: usize) -> Vec<Vec<RecordBatch>> {
  let mut out = vec![Vec::new(); parts.max(1)];
  for (i, batch) in batches.into_iter().enumerate() { out[i % parts.max(1)].push(batch); }
  out
}

fn object_schema(def: &TypeDef) -> SchemaRef {
  let mut fields = vec![Field::new("$owner", DataType::Utf8, false), Field::new("$id", DataType::Utf8, false), Field::new("$key", DataType::Utf8, false)];
  for c in &def.columns { fields.push(Field::new(&c.name, data_type(c.kind), true)); }
  if def.classification.is_some() {
    fields.push(Field::new("$rank", DataType::Int64, true));
    fields.push(Field::new("$compartments", data_type(Kind::Strings), true));
  }
  Arc::new(Schema::new(fields))
}
fn strings_schema(names: &[&str]) -> SchemaRef { Arc::new(Schema::new(names.iter().map(|name| Field::new(*name, DataType::Utf8, false)).collect::<Vec<_>>())) }
fn edge_schema() -> SchemaRef { strings_schema(&["$owner", "from_id", "to_id"]) }

/// A table of string columns.
fn strings_table(schema: SchemaRef, columns: Vec<StringBuilder>) -> Result<Arc<MemTable>, Failure> {
  let arrays = columns.into_iter().map(|mut b| Arc::new(b.finish()) as ArrayRef).collect();
  let batch = RecordBatch::try_new(schema.clone(), arrays).map_err(internal)?;
  Ok(Arc::new(MemTable::try_new(schema, vec![vec![batch]]).map_err(internal)?))
}
/// A table over batches, which may be none.
fn table_of(schema: SchemaRef, mut batches: Vec<RecordBatch>) -> Result<Arc<MemTable>, Failure> {
  if batches.is_empty() { batches.push(RecordBatch::new_empty(schema.clone())); }
  Ok(Arc::new(MemTable::try_new(schema, spread(batches, partitions())).map_err(internal)?))
}

async fn connect(database: &str) -> Result<Client, Failure> {
  let (client, connection) = tokio_postgres::connect(database, NoTls).await.map_err(internal)?;
  tokio::spawn(async move { let _ = connection.await; });
  Ok(client)
}

/// Loads a projection, and the commits it reflects, from one snapshot of the database.
async fn load(request: LoadRequest) -> Result<Snapshot, Failure> {
  let mut client = connect(&request.database).await?;
  let tx = client.build_transaction().isolation_level(IsolationLevel::RepeatableRead).read_only(true).start().await.map_err(internal)?;
  let parts = partitions();
  let ctx = SessionContext::new_with_config(SessionConfig::new().with_target_partitions(parts));
  let schema = quote(&request.schema);
  let (mut kinds, mut classified, mut types) = (HashMap::new(), HashSet::new(), HashMap::new());
  let (mut objects, mut edge_count, mut bytes) = (0, 0, 0usize);
  for def in &request.types {
    let table = object_schema(def);
    let sql = format!("SELECT owner, id, properties::text FROM {schema}.objects WHERE projection::text=$1 AND type=$2");
    let params: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = vec![&request.projection, &def.name];
    let rows = tx.query_raw(sql.as_str(), params).await.map_err(internal)?;
    pin_mut!(rows);
    let mut batches = Vec::new();
    let mut builder = ObjectBuilder::new(def);
    while let Some(row) = rows.try_next().await.map_err(internal)? {
      let properties: Value = serde_json::from_str(row.get::<_, &str>(2)).map_err(internal)?;
      builder.push(def, row.get(0), row.get(1), &properties, &request.ranks);
      objects += 1;
      if builder.len == BATCH { batches.push(builder.finish(table.clone())?); builder = ObjectBuilder::new(def); }
    }
    if builder.len > 0 { batches.push(builder.finish(table.clone())?); }
    bytes += batches.iter().map(RecordBatch::get_array_memory_size).sum::<usize>();
    let base_rows = batches.iter().map(RecordBatch::num_rows).sum();
    if def.classification.is_some() { classified.insert(def.name.clone()); }
    kinds.insert(def.name.clone(), def.columns.iter().map(|c| (c.name.clone(), c.kind)).collect());
    types.insert(def.name.clone(), TypeStore { def: Arc::new(def.clone()), schema: table.clone(), base: table_of(table, batches)?, base_rows,
      changed: Arc::default(), overlay: None });
  }
  let mut by_link: HashMap<String, (StringBuilder, StringBuilder, StringBuilder, Vec<RecordBatch>, usize)> = HashMap::new();
  for link in &request.links { by_link.insert(link.clone(), (StringBuilder::new(), StringBuilder::new(), StringBuilder::new(), Vec::new(), 0)); }
  let flush = |entry: &mut (StringBuilder, StringBuilder, StringBuilder, Vec<RecordBatch>, usize)| -> Result<(), Failure> {
    let batch = RecordBatch::try_new(edge_schema(), vec![Arc::new(entry.0.finish()) as ArrayRef, Arc::new(entry.1.finish()), Arc::new(entry.2.finish())]).map_err(internal)?;
    entry.3.push(batch);
    entry.4 = 0;
    Ok(())
  };
  let sql = format!("SELECT owner, type, from_id, to_id FROM {schema}.links WHERE projection::text=$1");
  let params: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = vec![&request.projection];
  let rows = tx.query_raw(sql.as_str(), params).await.map_err(internal)?;
  pin_mut!(rows);
  while let Some(row) = rows.try_next().await.map_err(internal)? {
    let link: String = row.get(1);
    let Some(entry) = by_link.get_mut(&link) else { continue };
    entry.0.append_value(row.get::<_, &str>(0));
    entry.1.append_value(row.get::<_, &str>(2));
    entry.2.append_value(row.get::<_, &str>(3));
    entry.4 += 1;
    edge_count += 1;
    if entry.4 == BATCH { flush(entry)?; }
  }
  let mut edges = HashMap::new();
  for (link, mut entry) in by_link {
    if entry.4 > 0 { flush(&mut entry)?; }
    bytes += entry.3.iter().map(RecordBatch::get_array_memory_size).sum::<usize>();
    let base_rows = entry.3.iter().map(RecordBatch::num_rows).sum();
    edges.insert(link, LinkStore { base: table_of(edge_schema(), entry.3)?, base_rows, changed: Arc::default(), overlay: None });
  }
  // Each owner's commits become visible in commit order, so the latest one this snapshot sees marks every change it holds.
  let positions = tx.query(format!("SELECT owner, max(commit_seq) FROM {schema}.change_commits GROUP BY owner").as_str(), &[]).await.map_err(internal)?;
  let applied = positions.iter().map(|row| (row.get::<_, String>(0), row.get::<_, i64>(1))).collect();
  tx.commit().await.map_err(internal)?;
  let links = request.links.clone();
  Ok(Snapshot { ctx, request: Arc::new(request), kinds, classified, links, types, edges, applied, objects, edge_count, bytes })
}

impl Snapshot {
  /// A type's current rows: its base rows other than the changed ones, and the changed rows that exist.
  fn object_rows(&self, kind: &str) -> Result<DataFrame, Failure> {
    let store = self.types.get(kind).ok_or_else(|| invalid(format!("Type {kind} is not loaded")))?;
    let mut frame = self.ctx.read_table(store.base.clone()).map_err(internal)?;
    if let Some((keys, live)) = &store.overlay {
      frame = frame.join(self.ctx.read_table(keys.clone()).map_err(internal)?, JoinType::LeftAnti, &["$owner", "$id"], &["$cowner", "$cid"], None).map_err(internal)?
        .union(self.ctx.read_table(live.clone()).map_err(internal)?).map_err(internal)?;
    }
    Ok(frame)
  }
  /// A link's current edges, the same way.
  fn edge_rows(&self, link: &str) -> Result<DataFrame, Failure> {
    let store = self.edges.get(link).ok_or_else(|| invalid(format!("Link {link} is not loaded")))?;
    let mut frame = self.ctx.read_table(store.base.clone()).map_err(internal)?;
    if let Some((keys, live)) = &store.overlay {
      frame = frame.join(self.ctx.read_table(keys.clone()).map_err(internal)?, JoinType::LeftAnti,
        &["$owner", "from_id", "to_id"], &["$cowner", "$cfrom", "$cto"], None).map_err(internal)?
        .union(self.ctx.read_table(live.clone()).map_err(internal)?).map_err(internal)?;
    }
    Ok(frame)
  }
  fn position(&self, owner: &str) -> i64 { self.applied.get(owner).copied().unwrap_or(0) }
}

impl TypeStore {
  /// Rebuilds the tables of the changed rows.
  fn refresh(&mut self, ranks: &HashMap<String, i64>) -> Result<(), Failure> {
    if self.changed.is_empty() { self.overlay = None; return Ok(()); }
    let (mut owners, mut ids) = (StringBuilder::new(), StringBuilder::new());
    let mut builder = ObjectBuilder::new(&self.def);
    for ((owner, id), row) in self.changed.iter() {
      owners.append_value(owner);
      ids.append_value(id);
      if let Some(properties) = row { builder.push(&self.def, owner, id, properties, ranks); }
    }
    let live = builder.finish(self.schema.clone())?;
    self.overlay = Some((strings_table(strings_schema(&["$cowner", "$cid"]), vec![owners, ids])?,
      Arc::new(MemTable::try_new(self.schema.clone(), vec![vec![live]]).map_err(internal)?)));
    Ok(())
  }
}

impl LinkStore {
  fn refresh(&mut self) -> Result<(), Failure> {
    if self.changed.is_empty() { self.overlay = None; return Ok(()); }
    let (mut owners, mut froms, mut tos) = (StringBuilder::new(), StringBuilder::new(), StringBuilder::new());
    let (mut live_owners, mut live_froms, mut live_tos) = (StringBuilder::new(), StringBuilder::new(), StringBuilder::new());
    for ((owner, from, to), present) in self.changed.iter() {
      owners.append_value(owner);
      froms.append_value(from);
      tos.append_value(to);
      if *present { live_owners.append_value(owner); live_froms.append_value(from); live_tos.append_value(to); }
    }
    self.overlay = Some((strings_table(strings_schema(&["$cowner", "$cfrom", "$cto"]), vec![owners, froms, tos])?,
      strings_table(edge_schema(), vec![live_owners, live_froms, live_tos])?));
    Ok(())
  }
}

/// Folds a type's changed rows into its base rows once there are many, so reads stop excluding them.
async fn compact_type(snapshot: &mut Snapshot, kind: &str) -> Result<(), Failure> {
  let store = &snapshot.types[kind];
  if store.changed.len() <= compact_limit().max(store.base_rows / 16) { return Ok(()); }
  let batches = snapshot.object_rows(kind)?.collect().await.map_err(internal)?;
  let rows = batches.iter().map(RecordBatch::num_rows).sum();
  let store = snapshot.types.get_mut(kind).unwrap();
  store.base = table_of(store.schema.clone(), batches)?;
  store.base_rows = rows;
  store.changed = Arc::default();
  store.overlay = None;
  Ok(())
}
async fn compact_link(snapshot: &mut Snapshot, link: &str) -> Result<(), Failure> {
  let store = &snapshot.edges[link];
  if store.changed.len() <= compact_limit().max(store.base_rows / 16) { return Ok(()); }
  let batches = snapshot.edge_rows(link)?.collect().await.map_err(internal)?;
  let rows = batches.iter().map(RecordBatch::num_rows).sum();
  let store = snapshot.edges.get_mut(link).unwrap();
  store.base = table_of(edge_schema(), batches)?;
  store.base_rows = rows;
  store.changed = Arc::default();
  store.overlay = None;
  Ok(())
}

/// One owner's commits after `applied`: the latest commit, and in commit order each object's stored value after an edit
/// (none when deleted) and each link change.
struct Commits { latest: i64, edits: Vec<(String, String, Option<String>)>, links: Vec<(String, String, String, String)> }

async fn read_commits(client: &mut Client, snapshot: &Snapshot, owner: &str, applied: i64) -> Result<Commits, Failure> {
  let schema = quote(&snapshot.request.schema);
  let tx = client.build_transaction().isolation_level(IsolationLevel::RepeatableRead).read_only(true).start().await.map_err(internal)?;
  // Owner isolation admits this owner's rows.
  tx.execute("SELECT set_config('eigos.owner', $1, true)", &[&owner]).await.map_err(internal)?;
  let latest: i64 = tx.query_one(format!("SELECT coalesce(max(commit_seq), 0)::bigint FROM {schema}.change_commits WHERE owner=$1").as_str(), &[&owner])
    .await.map_err(internal)?.get(0);
  if latest <= applied {
    tx.commit().await.map_err(internal)?;
    return Ok(Commits { latest, edits: Vec::new(), links: Vec::new() });
  }
  let projection = &snapshot.request.projection;
  let edits = tx.query(format!("SELECT h.type, h.id, h.after_values::text FROM {schema}.change_commits c
      JOIN {schema}.edit_history h ON h.xact=c.xact AND h.owner=c.owner
      WHERE c.owner=$1 AND c.commit_seq>$2 AND c.commit_seq<=$3 AND h.projection::text=$4 ORDER BY c.commit_seq, h.sequence").as_str(),
      &[&owner, &applied, &latest, projection]).await.map_err(internal)?
    .into_iter().map(|row| (row.get(0), row.get(1), row.get(2))).collect();
  let links = tx.query(format!("SELECT l.type, l.from_id, l.to_id, l.operation FROM {schema}.change_commits c
      JOIN {schema}.link_history l ON l.xact=c.xact AND l.owner=c.owner
      WHERE c.owner=$1 AND c.commit_seq>$2 AND c.commit_seq<=$3 AND l.projection::text=$4 ORDER BY c.commit_seq, l.sequence").as_str(),
      &[&owner, &applied, &latest, projection]).await.map_err(internal)?
    .into_iter().map(|row| (row.get(0), row.get(1), row.get(2), row.get(3))).collect();
  tx.commit().await.map_err(internal)?;
  Ok(Commits { latest, edits, links })
}

/// Applies an owner's commits after the last one applied, up to its latest committed one, as a new snapshot version.
async fn catch_up(state: &AppState, owner: &str) -> Result<(), Failure> {
  let mut funnel = state.funnel.lock().await;
  let Some(current) = state.snapshot.read().await.clone() else { return Ok(()) };
  let applied = current.position(owner);
  if funnel.is_none() { *funnel = Some(connect(&current.request.database).await?); }
  let commits = match read_commits(funnel.as_mut().unwrap(), &current, owner, applied).await {
    Ok(commits) => commits,
    Err(error) => { *funnel = None; return Err(error); }
  };
  if commits.latest <= applied { return Ok(()); }
  let mut next = (*current).clone();
  let (mut types, mut links) = (HashSet::new(), HashSet::new());
  for (kind, id, after) in commits.edits {
    let Some(store) = next.types.get_mut(&kind) else { continue };
    let row = match after { Some(text) => Some(serde_json::from_str::<Value>(&text).map_err(internal)?), None => None };
    Arc::make_mut(&mut store.changed).insert((owner.to_string(), id), row);
    types.insert(kind);
  }
  for (link, from, to, operation) in commits.links {
    let Some(store) = next.edges.get_mut(&link) else { continue };
    Arc::make_mut(&mut store.changed).insert((owner.to_string(), from, to), operation == "link");
    links.insert(link);
  }
  let ranks = next.request.ranks.clone();
  for kind in &types { next.types.get_mut(kind).unwrap().refresh(&ranks)?; compact_type(&mut next, kind).await?; }
  for link in &links { next.edges.get_mut(link).unwrap().refresh()?; compact_link(&mut next, link).await?; }
  next.applied.insert(owner.to_string(), commits.latest);
  *state.snapshot.write().await = Some(Arc::new(next));
  Ok(())
}

/// The latest commit of every owner that committed after `floor`.
async fn latest_commits(funnel: &mut Option<Client>, snapshot: &Snapshot, floor: i64) -> Result<Vec<(String, i64)>, Failure> {
  if funnel.is_none() { *funnel = Some(connect(&snapshot.request.database).await?); }
  let schema = quote(&snapshot.request.schema);
  let rows = funnel.as_ref().unwrap().query(format!("SELECT owner, max(commit_seq) FROM {schema}.change_commits WHERE commit_seq>$1 GROUP BY owner").as_str(), &[&floor])
    .await.map_err(internal)?;
  Ok(rows.iter().map(|row| (row.get(0), row.get(1))).collect())
}

/// Keeps every owner's rows current between queries. Queries do not rely on it: each one first applies its owner's
/// commits up to the version it needs.
async fn follow(state: Shared, every: Duration) {
  let mut floor: Option<i64> = None;
  loop {
    tokio::time::sleep(every).await;
    let Some(snapshot) = state.snapshot.read().await.clone() else { continue };
    let from = floor.unwrap_or_else(|| (snapshot.applied.values().copied().max().unwrap_or(0) - 1000).max(0));
    let found = {
      let mut funnel = state.funnel.lock().await;
      match latest_commits(&mut funnel, &snapshot, from).await { Ok(found) => found, Err(_) => { *funnel = None; continue; } }
    };
    let mut highest = from;
    for (owner, latest) in found {
      highest = highest.max(latest);
      if latest > snapshot.position(&owner) { let _ = catch_up(&state, &owner).await; }
    }
    // Commits of different owners can become visible out of number order, so the next poll looks back over a margin.
    floor = Some((highest - 1000).max(0));
  }
}

/// Where checkpoints are kept, from EIGOS_KERNEL_DATA; without it the kernel keeps none.
fn data_dir() -> Option<PathBuf> { std::env::var_os("EIGOS_KERNEL_DATA").map(PathBuf::from) }
/// The directory of one projection's checkpoints.
fn checkpoint_root(projection: &str) -> Option<PathBuf> {
  data_dir().map(|dir| dir.join(projection.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect::<String>()))
}
fn io(error: impl ToString) -> Failure { internal(error) }

/// An owner's last applied commit and its transaction, which identifies the commit in this database.
#[derive(Serialize, Deserialize, Clone, PartialEq)]
struct Position { owner: String, commit: i64, xact: String }

/// What a checkpoint holds: the definition its files follow, and each owner's last applied commit.
#[derive(Serialize, Deserialize)]
struct Manifest {
  format: u32, schema: String, projection: String, types: Vec<TypeDef>, links: Vec<String>, ranks: HashMap<String, i64>,
  positions: Vec<Position>, objects: usize, edges: usize,
}
const FORMAT: u32 = 1;

/// The transactions of the given positions, as change_commits records them.
async fn positions_of(client: &Client, schema: &str, applied: &HashMap<String, i64>) -> Result<Vec<Position>, Failure> {
  let (owners, commits): (Vec<String>, Vec<i64>) = applied.iter().map(|(owner, commit)| (owner.clone(), *commit)).unzip();
  let rows = client.query(format!("SELECT c.owner, c.commit_seq, c.xact::text FROM {schema}.change_commits c
      JOIN unnest($1::text[], $2::bigint[]) AS p(owner, commit_seq) ON c.owner=p.owner AND c.commit_seq=p.commit_seq").as_str(), &[&owners, &commits])
    .await.map_err(internal)?;
  if rows.len() != owners.len() { return Err(internal("A position has no commit in change_commits")); }
  Ok(rows.iter().map(|row| Position { owner: row.get(0), commit: row.get(1), xact: row.get(2) }).collect())
}

/// Writes a snapshot version as Parquet, one file per type and per link, with a manifest. The files go to a new
/// directory, which replaces the previous checkpoint of the projection only once it is complete.
async fn write_checkpoint(snapshot: &Snapshot) -> Result<Value, Failure> {
  let started = Instant::now();
  let root = checkpoint_root(&snapshot.request.projection).ok_or_else(|| invalid("EIGOS_KERNEL_DATA is not set"))?;
  let client = connect(&snapshot.request.database).await?;
  let positions = positions_of(&client, &quote(&snapshot.request.schema), &snapshot.applied).await?;
  let id = format!("{}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(io)?.as_millis());
  let staging = root.join(format!(".{id}"));
  std::fs::create_dir_all(&staging).map_err(io)?;
  let single = || DataFrameWriteOptions::new().with_single_file_output(true);
  for (i, def) in snapshot.request.types.iter().enumerate() {
    let file = staging.join(format!("t{i}.parquet"));
    snapshot.object_rows(&def.name)?.write_parquet(&file.to_string_lossy(), single(), None).await.map_err(internal)?;
  }
  for (i, link) in snapshot.request.links.iter().enumerate() {
    let file = staging.join(format!("l{i}.parquet"));
    snapshot.edge_rows(link)?.write_parquet(&file.to_string_lossy(), single(), None).await.map_err(internal)?;
  }
  let request = &snapshot.request;
  let manifest = Manifest { format: FORMAT, schema: request.schema.clone(), projection: request.projection.clone(), types: request.types.clone(),
    links: request.links.clone(), ranks: request.ranks.clone(), positions, objects: snapshot.objects, edges: snapshot.edge_count };
  std::fs::write(staging.join("manifest.json"), serde_json::to_vec(&manifest).map_err(internal)?).map_err(io)?;
  std::fs::rename(&staging, root.join(&id)).map_err(io)?;
  std::fs::write(root.join(".current"), &id).map_err(io)?;
  std::fs::rename(root.join(".current"), root.join("current")).map_err(io)?;
  for entry in std::fs::read_dir(&root).map_err(io)?.flatten() {
    let name = entry.file_name().to_string_lossy().to_string();
    if name != id && name != "current" && entry.path().is_dir() { let _ = std::fs::remove_dir_all(entry.path()); }
  }
  Ok(json!({ "checkpoint": id, "elapsedMs": started.elapsed().as_secs_f64() * 1000.0 }))
}

/// Reads a Parquet file into batches of the expected schema; none when the file is missing, unreadable or has other columns.
async fn read_rows(ctx: &SessionContext, file: &std::path::Path, schema: &SchemaRef) -> Result<Option<Vec<RecordBatch>>, Failure> {
  // Read with the expected schema, so strings stay strings rather than the reader's default views.
  let read = async { ctx.read_parquet(file.to_string_lossy().as_ref(), ParquetReadOptions::default().schema(schema.as_ref())).await?.collect().await };
  let Ok(batches) = read.await else { return Ok(None) };
  let same = |found: &Schema| found.fields().len() == schema.fields().len()
    && found.fields().iter().zip(schema.fields().iter()).all(|(a, b)| a.name() == b.name() && a.data_type() == b.data_type());
  if batches.iter().any(|batch| !same(&batch.schema())) { return Ok(None); }
  Ok(Some(batches.into_iter().map(|batch| RecordBatch::try_new(schema.clone(), batch.columns().to_vec())).collect::<Result<_, _>>().map_err(internal)?))
}

/// The projection's last checkpoint, when it follows the same definition and belongs to this database: every position
/// it records is still in change_commits with the same transaction. Otherwise none, and the caller loads from storage.
async fn restore(request: &LoadRequest) -> Result<Option<Snapshot>, Failure> {
  let Some(root) = checkpoint_root(&request.projection) else { return Ok(None) };
  let Ok(id) = std::fs::read_to_string(root.join("current")) else { return Ok(None) };
  let dir = root.join(id.trim());
  let Ok(text) = std::fs::read_to_string(dir.join("manifest.json")) else { return Ok(None) };
  let Ok(manifest) = serde_json::from_str::<Manifest>(&text) else { return Ok(None) };
  if manifest.format != FORMAT || manifest.schema != request.schema || manifest.projection != request.projection || manifest.types != request.types
    || manifest.links != request.links || manifest.ranks != request.ranks { return Ok(None); }
  let client = connect(&request.database).await?;
  let schema = quote(&request.schema);
  let owners: Vec<String> = manifest.positions.iter().map(|p| p.owner.clone()).collect();
  let commits: Vec<i64> = manifest.positions.iter().map(|p| p.commit).collect();
  let xacts: Vec<String> = manifest.positions.iter().map(|p| p.xact.clone()).collect();
  let found: i64 = client.query_one(format!("SELECT count(*) FROM {schema}.change_commits c
      JOIN unnest($1::text[], $2::bigint[], $3::text[]) AS p(owner, commit_seq, xact) ON c.owner=p.owner AND c.commit_seq=p.commit_seq AND c.xact::text=p.xact").as_str(),
      &[&owners, &commits, &xacts]).await.map_err(internal)?.get(0);
  if found as usize != manifest.positions.len() { return Ok(None); }
  let parts = partitions();
  let ctx = SessionContext::new_with_config(SessionConfig::new().with_target_partitions(parts));
  let (mut kinds, mut classified, mut types, mut edges) = (HashMap::new(), HashSet::new(), HashMap::new(), HashMap::new());
  let mut bytes = 0usize;
  for (i, def) in request.types.iter().enumerate() {
    let table = object_schema(def);
    let Some(batches) = read_rows(&ctx, &dir.join(format!("t{i}.parquet")), &table).await? else { return Ok(None) };
    bytes += batches.iter().map(RecordBatch::get_array_memory_size).sum::<usize>();
    let base_rows = batches.iter().map(RecordBatch::num_rows).sum();
    if def.classification.is_some() { classified.insert(def.name.clone()); }
    kinds.insert(def.name.clone(), def.columns.iter().map(|c| (c.name.clone(), c.kind)).collect());
    types.insert(def.name.clone(), TypeStore { def: Arc::new(def.clone()), schema: table.clone(), base: table_of(table, batches)?, base_rows,
      changed: Arc::default(), overlay: None });
  }
  for (i, link) in request.links.iter().enumerate() {
    let Some(batches) = read_rows(&ctx, &dir.join(format!("l{i}.parquet")), &edge_schema()).await? else { return Ok(None) };
    bytes += batches.iter().map(RecordBatch::get_array_memory_size).sum::<usize>();
    let base_rows = batches.iter().map(RecordBatch::num_rows).sum();
    edges.insert(link.clone(), LinkStore { base: table_of(edge_schema(), batches)?, base_rows, changed: Arc::default(), overlay: None });
  }
  let objects = types.values().map(|t: &TypeStore| t.base_rows).sum();
  let edge_count = edges.values().map(|l: &LinkStore| l.base_rows).sum();
  let applied = manifest.positions.into_iter().map(|p| (p.owner, p.commit)).collect();
  Ok(Some(Snapshot { ctx, request: Arc::new(request.clone()), kinds, classified, links: request.links.clone(), types, edges, applied, objects, edge_count, bytes }))
}

/// Writes a checkpoint of each new version every EIGOS_KERNEL_CHECKPOINT_S seconds.
async fn checkpoints(state: Shared, every: Duration) {
  loop {
    tokio::time::sleep(every).await;
    let Some(snapshot) = state.snapshot.read().await.clone() else { continue };
    let _ = checkpoint(&state, &snapshot).await;
  }
}

/// Writes a checkpoint of a version unless the last one already holds it.
async fn checkpoint(state: &AppState, snapshot: &Arc<Snapshot>) -> Result<Value, Failure> {
  let mut last = state.checkpointed.lock().await;
  if let Some((version, written)) = last.as_ref() { if Arc::ptr_eq(version, snapshot) { return Ok(written.clone()); } }
  let written = write_checkpoint(snapshot).await?;
  *last = Some((snapshot.clone(), written.clone()));
  Ok(written)
}

enum ValueBuilder { String(StringBuilder), Integer(Int64Builder), Number(Float64Builder), Boolean(BooleanBuilder), Strings(ListBuilder<StringBuilder>) }

struct ObjectBuilder { owner: StringBuilder, id: StringBuilder, key: StringBuilder, values: Vec<ValueBuilder>,
  label: Option<(Int64Builder, ListBuilder<StringBuilder>)>, len: usize }

impl ObjectBuilder {
  fn new(def: &TypeDef) -> Self {
    let values = def.columns.iter().map(|c| match c.kind {
      Kind::String => ValueBuilder::String(StringBuilder::new()), Kind::Integer => ValueBuilder::Integer(Int64Builder::new()),
      Kind::Number => ValueBuilder::Number(Float64Builder::new()), Kind::Boolean => ValueBuilder::Boolean(BooleanBuilder::new()),
      Kind::Strings => ValueBuilder::Strings(ListBuilder::new(StringBuilder::new())),
    }).collect();
    Self { owner: StringBuilder::new(), id: StringBuilder::new(), key: StringBuilder::new(), values,
      label: def.classification.is_some().then(|| (Int64Builder::new(), ListBuilder::new(StringBuilder::new()))), len: 0 }
  }
  fn push(&mut self, def: &TypeDef, owner: &str, id: &str, properties: &Value, ranks: &HashMap<String, i64>) {
    self.owner.append_value(owner);
    self.id.append_value(id);
    self.key.append_value(ref_key(&def.name, id));
    for (builder, c) in self.values.iter_mut().zip(&def.columns) {
      let value = properties.get(&c.name);
      // The published schema validated stored values, so a value of another kind cannot occur; it reads as null.
      match builder {
        ValueBuilder::String(b) => b.append_option(value.and_then(Value::as_str)),
        ValueBuilder::Integer(b) => b.append_option(value.and_then(Value::as_i64)),
        ValueBuilder::Number(b) => b.append_option(value.and_then(Value::as_f64)),
        ValueBuilder::Boolean(b) => b.append_option(value.and_then(Value::as_bool)),
        ValueBuilder::Strings(b) => match value.and_then(Value::as_array) {
          Some(items) => { for item in items { b.values().append_option(item.as_str()); } b.append(true); }
          None => b.append(false),
        },
      }
    }
    if let (Some((rank, compartments)), Some(name)) = (self.label.as_mut(), def.classification.as_deref()) {
      // A row classification is `{sensitivity, compartments}`; a missing one adds nothing to the observed label.
      let label = properties.get(name).filter(|v| !v.is_null());
      rank.append_option(label.and_then(|l| l.get("sensitivity")).and_then(Value::as_str).and_then(|s| ranks.get(s).copied()));
      match label {
        Some(l) => {
          for tag in l.get("compartments").and_then(Value::as_array).map(|items| items.iter().filter_map(Value::as_str).collect::<Vec<_>>()).unwrap_or_default() {
            compartments.values().append_value(tag);
          }
          compartments.append(true);
        }
        None => compartments.append(false),
      }
    }
    self.len += 1;
  }
  fn finish(mut self, schema: SchemaRef) -> Result<RecordBatch, Failure> {
    let mut arrays: Vec<ArrayRef> = vec![Arc::new(self.owner.finish()), Arc::new(self.id.finish()), Arc::new(self.key.finish())];
    for builder in self.values.iter_mut() {
      arrays.push(match builder {
        ValueBuilder::String(b) => Arc::new(b.finish()), ValueBuilder::Integer(b) => Arc::new(b.finish()),
        ValueBuilder::Number(b) => Arc::new(b.finish()), ValueBuilder::Boolean(b) => Arc::new(b.finish()),
        ValueBuilder::Strings(b) => Arc::new(b.finish()),
      });
    }
    if let Some((rank, compartments)) = self.label.as_mut() {
      arrays.push(Arc::new(rank.finish()));
      arrays.push(Arc::new(compartments.finish()));
    }
    RecordBatch::try_new(schema, arrays).map_err(internal)
  }
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum Predicate {
  All { predicates: Vec<Predicate> },
  Any { predicates: Vec<Predicate> },
  Not { predicate: Box<Predicate> },
  Const { value: bool },
  Eq { column: String, value: Value },
  Ne { column: String, value: Value },
  Gt { column: String, value: f64 },
  Gte { column: String, value: f64 },
  Lt { column: String, value: f64 },
  Lte { column: String, value: f64 },
  In { column: String, values: Vec<Value> },
  Contains { column: String, value: String },
  /// Every element of a string list is one of `values`; a missing list is empty.
  Subset { column: String, values: Vec<String> },
  /// A string list holds at least one of `values`.
  HasAny { column: String, values: Vec<String> },
}

#[derive(Deserialize)]
struct Reference { r#type: String, id: String }

fn yes() -> bool { true }

/// One move of a traversal step. `candidates`: the move's filter reads derived values, so the reference reads every visible
/// target before it filters them.
#[derive(Deserialize)]
struct Move { source: String, link: String, forward: bool, target: String, filter: Option<Predicate>, #[serde(default)] candidates: bool }

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum SetNode {
  Empty,
  /// `candidates`: the filter reads derived values, so the reference reads every readable row of the type.
  Scan { r#type: String, filter: Option<Predicate>, #[serde(default)] candidates: bool },
  /// `enrich` is false for the source of a relationship query, which the reference reads without its derived values.
  Refs { refs: Vec<Reference>, #[serde(default = "yes")] enrich: bool },
  Union { sets: Vec<SetNode> },
  Intersect { sets: Vec<SetNode> },
  Except { left: Box<SetNode>, right: Box<SetNode> },
  /// Each step lists one move per possible source type; a set's objects of other types do not continue.
  Traverse { set: Box<SetNode>, steps: Vec<Vec<Move>> },
  BoundedTraverse { set: Box<SetNode>, steps: Vec<Vec<Move>>, limit: usize },
}

#[derive(Deserialize)]
struct Metric { name: String, op: String, column: Option<String> }

/// A field an aggregation reads on one member type: from the type's own column, hidden for every row or shown only where
/// a cell policy permits, or null where the type does not map the field.
#[derive(Deserialize)]
struct PartField { name: String, column: Option<String>, #[serde(default)] hidden: bool, policy: Option<Predicate> }
/// One member type of an aggregation and the fields it contributes.
#[derive(Deserialize)]
struct Part { r#type: String, fields: Vec<PartField> }

/// One key of a query's order: an output field, descending or not; nulls come last either way.
#[derive(Deserialize)]
struct OrderKey { name: String, #[serde(default)] desc: bool }

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Output {
  Page { offset: usize, limit: usize },
  /// One page of the members in a query's order: each order key, then the JSON-encoded type and id, as the reference
  /// orders a query it evaluates completely. `parts` read the order fields of each member type, as for an aggregation.
  #[serde(rename_all = "camelCase")]
  Query { offset: usize, limit: usize, parts: Vec<Part>, kinds: HashMap<String, Kind>, order: Vec<OrderKey> },
  /// `kinds` holds the kind of each field across the member types.
  #[serde(rename_all = "camelCase")]
  Aggregate { parts: Vec<Part>, kinds: HashMap<String, Kind>, group_by: Vec<String>, metrics: Vec<Metric> },
}

/// How to report one type the evaluation reads: the ids of every row read when its rows are tracked, and the markings
/// property its rows carry.
#[derive(Deserialize)]
struct MemberSpec { r#type: String, #[serde(default)] track: bool, markings: Option<String> }

/// Unknown fields are refused (422, so the client answers from the reference): a field this kernel does not know could
/// change the answer, as a Scenario does.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct QueryRequest { owner: String, set: SetNode, output: Output, #[serde(default)] members: Vec<MemberSpec>,
  #[serde(default)] rows: HashMap<String, Predicate>, #[serde(default)] derived: HashMap<String, Vec<DerivedSpec>>,
  /// The projection the planner compiled for; a kernel holding another one leaves the query to the reference.
  projection: Option<String>,
  /// The owner's latest commit when the query started: the kernel answers only from a version that includes it.
  #[serde(rename = "minCommit")] min_commit: Option<i64>,
  /// How long the query may wait for the kernel to apply that commit.
  #[serde(rename = "waitMs")] wait_ms: Option<u64>,
  /// The Scenario whose edits the query reads over the live data.
  #[serde(default)] scenario: Option<ScenarioRequest> }

/// A Scenario a query reads: its id, the revision the planner saw, and for each link whether its source and its target
/// end are single-valued, which decides the live edges a Scenario edge replaces.
#[derive(Deserialize, Clone)]
struct ScenarioRequest { id: String, revision: i64, #[serde(default)] single: HashMap<String, (bool, bool)> }

/// One owner's Scenario at one revision, as the reference's Scenario view reads it over the live data:
/// - each type's rows the Scenario stages, with `$sid` the ids it changed or deleted, and the staged rows that exist;
/// - each link's staged edges that differ from the live ones, `$sremoved` true for an edge the Scenario removes.
struct Overlay { revision: i64, objects: HashMap<String, (Arc<MemTable>, Arc<MemTable>)>, links: HashMap<String, Arc<MemTable>> }

/// One row set the evaluation reads, as the reference reads it: `ids` has one `$id` column, and `enrich` says whether the
/// reference evaluates the rows' derived properties.
struct Read { kind: String, ids: DataFrame, enrich: bool }

/// One query: the owner it reads, the row predicate of each type (applied to every read of that type's table), the
/// derived columns each type's reads carry, each derived column once computed, and the row sets read so far.
struct Ctx {
  owner: String, rows: HashMap<String, Predicate>, derived: HashMap<String, Vec<DerivedSpec>>,
  columns: tokio::sync::Mutex<HashMap<(String, String), DataFrame>>,
  reads: std::sync::Mutex<Vec<Read>>,
  /// The Scenario the query reads, with the single-valued ends of each link.
  scenario: Option<(Arc<Overlay>, HashMap<String, (bool, bool)>)>,
}

impl Ctx {
  fn read(&self, kind: &str, frame: DataFrame, enrich: bool) -> Result<(), Failure> {
    let ids = frame.select(vec![column("$id")]).map_err(internal)?;
    self.reads.lock().unwrap().push(Read { kind: kind.to_string(), ids, enrich });
    Ok(())
  }
}

/// A derived value over one type's rows: a stored field read through its cell mask, a literal, arithmetic over numbers,
/// another derived column of the same type, or an aggregation over the visible objects a relationship path reaches,
/// whose `value` is evaluated on the path's last type.
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum Derived {
  Literal { value: f64 },
  Field { column: String, #[serde(default)] hidden: bool, policy: Option<Predicate> },
  Derived { column: String },
  Arith { kind: String, left: Box<Derived>, right: Box<Derived> },
  Linked { steps: Vec<LinkStep>, aggregate: String, value: Option<Box<Derived>> },
}
/// One step of a derived relationship path. A step whose link the principal may not see reaches nothing.
#[derive(Deserialize)]
struct LinkStep { link: String, forward: bool, target: String, #[serde(default = "yes")] visible: bool }
/// A derived column and the bounds its property schema puts on its numbers.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DerivedSpec { column: String, kind: Kind, expr: Derived,
  minimum: Option<f64>, maximum: Option<f64>, exclusive_minimum: Option<f64>, exclusive_maximum: Option<f64> }

/// The reference fails these evaluations; the kernel returns `fallback` so the caller runs the reference.
fn fallback(reason: &str) -> Failure { failure(StatusCode::UNPROCESSABLE_ENTITY, format!("fallback: {reason}")) }
/// The most objects one step of a derived relationship may reach from one object, as in the reference.
const DERIVED_REACH: i64 = 10000;
/// Zod's integers are safe integers.
const SAFE_LIMIT: f64 = 9007199254740992.0;

fn literal(kind: Kind, value: &Value) -> Result<Expr, Failure> {
  Ok(match (kind, value) {
    (Kind::String, Value::String(s)) => lit(s.clone()),
    (Kind::Boolean, Value::Bool(b)) => lit(*b),
    (Kind::Integer, Value::Number(n)) if n.is_i64() => lit(n.as_i64().unwrap()),
    (Kind::Integer | Kind::Number, Value::Number(n)) => lit(n.as_f64().ok_or_else(|| invalid("Number out of range"))?),
    _ => return Err(invalid("The planner sent a literal of another kind")),
  })
}

fn string_list(values: &[String]) -> Expr { make_array(values.iter().map(|v| lit(v.clone())).collect()) }

fn predicate(p: &Predicate, kinds: &HashMap<String, Kind>) -> Result<Expr, Failure> {
  // `$rank` and `$compartments` hold a classified type's row classification.
  let kind_of = |name: &str| match name {
    "$rank" => Ok(Kind::Integer), "$compartments" => Ok(Kind::Strings),
    _ => kinds.get(name).copied().ok_or_else(|| invalid(format!("Unknown column {name}"))),
  };
  Ok(match p {
    Predicate::All { predicates } => predicates.iter().map(|q| predicate(q, kinds)).collect::<Result<Vec<_>, _>>()?
      .into_iter().reduce(Expr::and).unwrap_or(lit(true)),
    Predicate::Any { predicates } => predicates.iter().map(|q| predicate(q, kinds)).collect::<Result<Vec<_>, _>>()?
      .into_iter().reduce(Expr::or).unwrap_or(lit(false)),
    Predicate::Not { predicate: q } => !predicate(q, kinds)?,
    Predicate::Const { value } => lit(*value),
    Predicate::Eq { column: name, value } if value.is_null() => { kind_of(name)?; column(name).is_null() }
    Predicate::Eq { column: name, value } => coalesce(vec![column(name).eq(literal(kind_of(name)?, value)?), lit(false)]),
    Predicate::Ne { column: name, value } if value.is_null() => { kind_of(name)?; column(name).is_not_null() }
    Predicate::Ne { column: name, value } => coalesce(vec![column(name).not_eq(literal(kind_of(name)?, value)?), lit(true)]),
    Predicate::Gt { column: name, value } => { kind_of(name)?; coalesce(vec![column(name).gt(lit(*value)), lit(false)]) }
    Predicate::Gte { column: name, value } => { kind_of(name)?; coalesce(vec![column(name).gt_eq(lit(*value)), lit(false)]) }
    Predicate::Lt { column: name, value } => { kind_of(name)?; coalesce(vec![column(name).lt(lit(*value)), lit(false)]) }
    Predicate::Lte { column: name, value } => { kind_of(name)?; coalesce(vec![column(name).lt_eq(lit(*value)), lit(false)]) }
    Predicate::In { column: name, values } => {
      let kind = kind_of(name)?;
      let present = values.iter().filter(|v| !v.is_null()).map(|v| literal(kind, v)).collect::<Result<Vec<_>, _>>()?;
      let matches = if present.is_empty() { lit(false) } else { coalesce(vec![column(name).in_list(present, false), lit(false)]) };
      if values.iter().any(Value::is_null) { matches.or(column(name).is_null()) } else { matches }
    }
    Predicate::Contains { column: name, value } => {
      kind_of(name)?;
      coalesce(vec![strpos(column(name), lit(value.clone())).gt(lit(0i64)), lit(false)])
    }
    Predicate::Subset { column: name, values } => {
      if kind_of(name)? != Kind::Strings { return Err(invalid(format!("{name} is not a string list"))); }
      let empty = column(name).is_null().or(cardinality(column(name)).eq(lit(0u64)));
      if values.is_empty() { empty } else { empty.or(coalesce(vec![array_has_all(string_list(values), column(name)), lit(false)])) }
    }
    Predicate::HasAny { column: name, values } => {
      if kind_of(name)? != Kind::Strings { return Err(invalid(format!("{name} is not a string list"))); }
      if values.is_empty() { lit(false) } else { coalesce(vec![array_has_any(column(name), string_list(values)), lit(false)]) }
    }
  })
}

fn refs_frame(ctx: &SessionContext, refs: &[(String, String)]) -> Result<DataFrame, Failure> {
  let schema: SchemaRef = Arc::new(Schema::new(vec![Field::new("$type", DataType::Utf8, false), Field::new("$id", DataType::Utf8, false), Field::new("$key", DataType::Utf8, false)]));
  let (mut t, mut i, mut k) = (StringBuilder::new(), StringBuilder::new(), StringBuilder::new());
  for (kind, id) in refs { t.append_value(kind); i.append_value(id); k.append_value(ref_key(kind, id)); }
  let batch = RecordBatch::try_new(schema, vec![Arc::new(t.finish()) as ArrayRef, Arc::new(i.finish()), Arc::new(k.finish())]).map_err(internal)?;
  ctx.read_batch(batch).map_err(internal)
}

/// The rows of a type the query may read: the owner's rows under the type's row predicate, without derived columns.
async fn base(snapshot: &Snapshot, owner: &Ctx, kind: &str) -> Result<DataFrame, Failure> {
  let kinds = snapshot.kinds.get(kind).ok_or_else(|| invalid(format!("Type {kind} is not loaded")))?;
  let mut frame = snapshot.object_rows(kind)?.filter(column("$owner").eq(lit(owner.owner.clone()))).map_err(internal)?;
  // In a Scenario, as its view: the live rows it does not stage, then its staged rows that exist.
  if let Some((changed, staged)) = owner.scenario.as_ref().and_then(|(overlay, _)| overlay.objects.get(kind)) {
    frame = frame.join(snapshot.ctx.read_table(changed.clone()).map_err(internal)?, JoinType::LeftAnti, &["$id"], &["$sid"], None).map_err(internal)?
      .union(snapshot.ctx.read_table(staged.clone()).map_err(internal)?).map_err(internal)?;
  }
  if let Some(rows) = owner.rows.get(kind) { frame = frame.filter(predicate(rows, kinds)?).map_err(internal)?; }
  Ok(frame)
}

/// A link's edges of the query's owner. In a Scenario, as its view: the live edges other than those it stages and those
/// a staged edge replaces at a single-valued end, then the staged edges it adds.
fn edges(snapshot: &Snapshot, owner: &Ctx, link: &str) -> Result<DataFrame, Failure> {
  let mut frame = snapshot.edge_rows(link)?.filter(column("$owner").eq(lit(owner.owner.clone()))).map_err(internal)?;
  let Some((overlay, single)) = owner.scenario.as_ref() else { return Ok(frame) };
  let Some(staged) = overlay.links.get(link) else { return Ok(frame) };
  let staged = snapshot.ctx.read_table(staged.clone()).map_err(internal)?;
  let added = staged.clone().filter(!column("$sremoved")).map_err(internal)?;
  frame = frame.join(staged.clone().select(vec![column("from_id").alias("$sfrom"), column("to_id").alias("$sto")]).map_err(internal)?,
    JoinType::LeftAnti, &["from_id", "to_id"], &["$sfrom", "$sto"], None).map_err(internal)?;
  let (single_from, single_to) = single.get(link).copied().unwrap_or((false, false));
  if single_from {
    frame = frame.join(added.clone().select(vec![column("from_id").alias("$sfrom")]).map_err(internal)?, JoinType::LeftAnti, &["from_id"], &["$sfrom"], None).map_err(internal)?;
  }
  if single_to {
    frame = frame.join(added.clone().select(vec![column("to_id").alias("$sto")]).map_err(internal)?, JoinType::LeftAnti, &["to_id"], &["$sto"], None).map_err(internal)?;
  }
  frame.union(added.select(vec![column("$owner"), column("from_id"), column("to_id")]).map_err(internal)?).map_err(internal)
}

/// Reads an owner's Scenario at the revision the query saw, or reuses the last read of that revision: its staged rows
/// in each type's columns and its staged edges that differ from the live ones. A Scenario at another revision leaves the
/// query to the reference.
async fn overlay(state: &Shared, snapshot: &Snapshot, owner: &str, scenario: &ScenarioRequest) -> Result<Arc<Overlay>, Failure> {
  let key = (snapshot.request.projection.clone(), owner.to_string(), scenario.id.clone());
  if let Some((known, used)) = state.overlays.lock().await.get_mut(&key).filter(|(o, _)| o.revision == scenario.revision) {
    *used = Instant::now();
    return Ok(known.clone());
  }
  let mut client = connect(&snapshot.request.database).await?;
  let tx = client.build_transaction().isolation_level(IsolationLevel::RepeatableRead).read_only(true).start().await.map_err(internal)?;
  let schema = quote(&snapshot.request.schema);
  // Bound as text and cast, so the indexes on the uuid columns apply.
  let id = scenario.id.as_str();
  let revision: Option<i64> = tx.query_opt(&format!("SELECT revision FROM {schema}.scenarios WHERE id=($1::text)::uuid AND owner=$2"), &[&id, &owner]).await
    .map_err(internal)?.map(|row| row.get(0));
  if revision != Some(scenario.revision) { return Err(stale("the Scenario changed")); }
  let mut objects = HashMap::new();
  let rows = tx.query(&format!("SELECT type, id, properties::text FROM {schema}.scenario_objects WHERE scenario_id=($1::text)::uuid AND owner=$2 ORDER BY type"),
    &[&id, &owner]).await.map_err(internal)?;
  let mut by_type: BTreeMap<String, Vec<(String, Option<Value>)>> = BTreeMap::new();
  for row in &rows {
    let properties = row.get::<_, Option<&str>>(2).map(serde_json::from_str::<Value>).transpose().map_err(internal)?;
    by_type.entry(row.get(0)).or_default().push((row.get(1), properties));
  }
  for (kind, staged) in by_type {
    let Some(def) = snapshot.request.types.iter().find(|t| t.name == kind) else { continue };
    let mut ids = StringBuilder::new();
    let mut builder = ObjectBuilder::new(def);
    for (object, properties) in &staged {
      ids.append_value(object);
      if let Some(properties) = properties { builder.push(def, owner, object, properties, &snapshot.request.ranks); }
    }
    let changed = RecordBatch::try_new(strings_schema(&["$sid"]), vec![Arc::new(ids.finish())]).map_err(internal)?;
    let schema = object_schema(def);
    let live = builder.finish(schema.clone())?;
    objects.insert(kind, (Arc::new(MemTable::try_new(changed.schema(), vec![vec![changed]]).map_err(internal)?),
      Arc::new(MemTable::try_new(schema, vec![vec![live]]).map_err(internal)?)));
  }
  let mut links = HashMap::new();
  let rows = tx.query(&format!("SELECT type, from_id, to_id, removed FROM {schema}.scenario_links
    WHERE scenario_id=($1::text)::uuid AND owner=$2 AND (NOT removed) IS DISTINCT FROM base_present ORDER BY type"), &[&id, &owner]).await.map_err(internal)?;
  let mut by_link: BTreeMap<String, Vec<(String, String, bool)>> = BTreeMap::new();
  for row in &rows { by_link.entry(row.get(0)).or_default().push((row.get(1), row.get(2), row.get(3))); }
  let link_schema: SchemaRef = Arc::new(Schema::new(vec![Field::new("$owner", DataType::Utf8, false), Field::new("from_id", DataType::Utf8, false),
    Field::new("to_id", DataType::Utf8, false), Field::new("$sremoved", DataType::Boolean, false)]));
  for (link, staged) in by_link {
    if !snapshot.links.contains(&link) { continue; }
    let (mut owners, mut from, mut to, mut removed) = (StringBuilder::new(), StringBuilder::new(), StringBuilder::new(), BooleanBuilder::new());
    for (f, t, r) in &staged { owners.append_value(owner); from.append_value(f); to.append_value(t); removed.append_value(*r); }
    let batch = RecordBatch::try_new(link_schema.clone(), vec![Arc::new(owners.finish()), Arc::new(from.finish()), Arc::new(to.finish()), Arc::new(removed.finish())])
      .map_err(internal)?;
    links.insert(link, Arc::new(MemTable::try_new(link_schema.clone(), vec![vec![batch]]).map_err(internal)?));
  }
  tx.commit().await.map_err(internal)?;
  let read = Arc::new(Overlay { revision: scenario.revision, objects, links });
  let mut overlays = state.overlays.lock().await;
  overlays.insert(key, (read.clone(), Instant::now()));
  while overlays.len() > OVERLAYS {
    let Some(oldest) = overlays.iter().min_by_key(|(_, (_, used))| *used).map(|(key, _)| key.clone()) else { break };
    overlays.remove(&oldest);
  }
  Ok(read)
}

/// The column kinds a type's reads carry: its stored columns and the derived columns the query asked for.
fn kinds_of(snapshot: &Snapshot, owner: &Ctx, kind: &str) -> Result<HashMap<String, Kind>, Failure> {
  let mut kinds = snapshot.kinds.get(kind).ok_or_else(|| invalid(format!("Type {kind} is not loaded")))?.clone();
  for spec in owner.derived.get(kind).into_iter().flatten() { kinds.insert(spec.column.clone(), spec.kind); }
  Ok(kinds)
}

/// The readable rows of a type with its derived columns, under an optional filter.
async fn objects(snapshot: &Snapshot, owner: &Ctx, kind: &str, filter: Option<&Predicate>) -> Result<DataFrame, Failure> {
  let mut frame = base(snapshot, owner, kind).await?;
  for (i, spec) in owner.derived.get(kind).into_iter().flatten().enumerate() {
    let key = format!("$d{i}");
    let values = derived_column(snapshot, owner, kind, &spec.column).await?
      .select(vec![column("$did").alias(key.clone()), column("$value").alias(spec.column.clone())]).map_err(internal)?;
    frame = frame.join(values, JoinType::Left, &["$id"], &[key.as_str()], None).map_err(internal)?;
  }
  if let Some(p) = filter { frame = frame.filter(predicate(p, &kinds_of(snapshot, owner, kind)?)?).map_err(internal)?; }
  Ok(frame)
}

fn flag(value: Expr) -> Expr { coalesce(vec![value, lit(false)]) }

/// True for a value that is not a finite number, false for null.
fn not_finite(value: Expr) -> Expr { flag(!(value.clone().gt_eq(lit(-f64::MAX)).and(value.lt_eq(lit(f64::MAX))))) }

/// A derived column of `kind`, computed once per query over every readable row: `$did`, `$value` of the spec's kind, and
/// `$err`, true where the reference's evaluation of the row's value fails.
fn derived_column<'a>(snapshot: &'a Snapshot, owner: &'a Ctx, kind: &'a str, name: &'a str) -> futures_util::future::BoxFuture<'a, Result<DataFrame, Failure>> {
  Box::pin(async move {
    let key = (kind.to_string(), name.to_string());
    let known = owner.columns.lock().await.get(&key).cloned();
    if let Some(frame) = known { return Ok(frame); }
    let spec = owner.derived.get(kind).into_iter().flatten().find(|s| s.column == name)
      .ok_or_else(|| invalid(format!("Derived column {name} of {kind} is not defined")))?;
    let mut frame = base(snapshot, owner, kind).await?;
    let mut joined = 0usize;
    let (value, failed) = derived_expr(snapshot, owner, kind, &spec.expr, &mut frame, &mut joined).await?;
    let (typed, rejected) = typed_value(spec, value)?;
    let computed = frame.select(vec![column("$id").alias("$did"), typed.alias("$value"), failed.or(rejected).alias("$err")]).map_err(internal)?
      .cache().await.map_err(internal)?;
    owner.columns.lock().await.insert(key, computed.clone());
    Ok(computed)
  })
}

/// The value as its property's kind, and whether the reference's validation against the property schema rejects it:
/// integers must be safe integers, and numbers must respect the schema's bounds.
fn typed_value(spec: &DerivedSpec, value: Expr) -> Result<(Expr, Expr), Failure> {
  let number = cast(value.clone(), DataType::Float64);
  let mut rejected = lit(false);
  let typed = match spec.kind {
    Kind::Integer => {
      let safe = number.clone().gt(lit(-SAFE_LIMIT)).and(number.clone().lt(lit(SAFE_LIMIT)));
      rejected = flag(!safe.clone());
      when(safe, cast(number.clone(), DataType::Int64)).otherwise(lit(ScalarValue::Int64(None))).map_err(internal)?
    }
    Kind::Number => number.clone(),
    other => cast(value, data_type(other)),
  };
  if matches!(spec.kind, Kind::Integer | Kind::Number) {
    if let Some(bound) = spec.minimum { rejected = rejected.or(flag(number.clone().lt(lit(bound)))); }
    if let Some(bound) = spec.maximum { rejected = rejected.or(flag(number.clone().gt(lit(bound)))); }
    if let Some(bound) = spec.exclusive_minimum { rejected = rejected.or(flag(number.clone().lt_eq(lit(bound)))); }
    if let Some(bound) = spec.exclusive_maximum { rejected = rejected.or(flag(number.clone().gt_eq(lit(bound)))); }
  }
  Ok((typed, rejected))
}

/// Builds a derived expression over `frame` as (value, failed), joining the relationship aggregations and other derived
/// columns it uses. `failed` holds where the reference's evaluation throws.
fn derived_expr<'a>(snapshot: &'a Snapshot, owner: &'a Ctx, kind: &'a str, expr: &'a Derived, frame: &'a mut DataFrame, joined: &'a mut usize)
  -> futures_util::future::BoxFuture<'a, Result<(Expr, Expr), Failure>> {
  Box::pin(async move {
    let kinds = snapshot.kinds.get(kind).ok_or_else(|| invalid(format!("Type {kind} is not loaded")))?;
    let number = |e: Expr| cast(e, DataType::Float64);
    Ok(match expr {
      Derived::Literal { value } => (lit(*value), lit(false)),
      Derived::Field { column: name, hidden, policy } => {
        let field_kind = *kinds.get(name).ok_or_else(|| invalid(format!("Unknown column {name}")))?;
        let null = || ScalarValue::try_from(&data_type(field_kind)).map(lit).map_err(internal);
        let value = if *hidden { null()? }
          else if let Some(p) = policy { when(predicate(p, kinds)?, column(name)).otherwise(null()?).map_err(internal)? }
          else { column(name) };
        (value, lit(false))
      }
      Derived::Derived { column: name } => {
        let n = *joined;
        *joined += 1;
        let (key, value, error) = (format!("$r{n}"), format!("$rv{n}"), format!("$re{n}"));
        let values = derived_column(snapshot, owner, kind, name).await?
          .select(vec![column("$did").alias(key.clone()), column("$value").alias(value.clone()), column("$err").alias(error.clone())]).map_err(internal)?;
        *frame = frame.clone().join(values, JoinType::Left, &["$id"], &[key.as_str()], None).map_err(internal)?;
        (column(&value), flag(column(&error)))
      }
      Derived::Arith { kind: op, left, right } => {
        let (l, left_failed) = derived_expr(snapshot, owner, kind, left, frame, joined).await?;
        let (r, right_failed) = derived_expr(snapshot, owner, kind, right, frame, joined).await?;
        let (l, r) = (number(l), number(r));
        let value = match op.as_str() {
          "add" => l + r, "subtract" => l - r, "multiply" => l * r,
          // Division by zero is null in the reference; null operands give null.
          "divide" => when(r.clone().eq(lit(0f64)), lit(ScalarValue::Float64(None))).otherwise(l / r).map_err(internal)?,
          other => return Err(invalid(format!("Unknown arithmetic {other}"))),
        };
        // The reference fails when an operand fails or the result is not a finite number.
        (value.clone(), left_failed.or(right_failed).or(not_finite(value)))
      }
      Derived::Linked { steps, aggregate, value } => {
        let n = *joined;
        *joined += 1;
        let (key, out, error) = (format!("$l{n}"), format!("$lv{n}"), format!("$le{n}"));
        let values = linked_frame(snapshot, owner, kind, steps, aggregate, value.as_deref()).await?
          .select(vec![column("$src").alias(key.clone()), column("$agg").alias(out.clone()), column("$aerr").alias(error.clone())]).map_err(internal)?;
        *frame = frame.clone().join(values, JoinType::Left, &["$id"], &[key.as_str()], None).map_err(internal)?;
        (if aggregate == "count" { coalesce(vec![column(&out), lit(0i64)]) } else { column(&out) }, flag(column(&error)))
      }
    })
  })
}

/// The value a linked aggregation reads on each readable row of `kind`: (`$vid`, `$v`, `$verr`).
async fn value_frame(snapshot: &Snapshot, owner: &Ctx, kind: &str, value: &Derived) -> Result<DataFrame, Failure> {
  let mut frame = base(snapshot, owner, kind).await?;
  let mut joined = 0usize;
  let (v, failed) = derived_expr(snapshot, owner, kind, value, &mut frame, &mut joined).await?;
  frame.select(vec![column("$id").alias("$vid"), v.alias("$v"), failed.alias("$verr")]).map_err(internal)
}

/// One row per readable source row (`$src`, `$agg`, `$aerr`): the aggregation over the distinct visible objects the path
/// reaches from it, each step deduplicated like the reference's traversal, and whether the reference fails for the row:
/// a step that reaches more than 10,000 objects, a `select` over more than one object, a failing value, or a sum or
/// average that is not finite.
async fn linked_frame(snapshot: &Snapshot, owner: &Ctx, kind: &str, steps: &[LinkStep], aggregate: &str, value: Option<&Derived>) -> Result<DataFrame, Failure> {
  let sources = base(snapshot, owner, kind).await?.select(vec![column("$id").alias("$src")]).map_err(internal)?;
  let mut reach = sources.clone().select(vec![column("$src"), column("$src").alias("$node")]).map_err(internal)?;
  let mut crowded: Option<DataFrame> = None;
  let mut target = kind.to_string();
  for step in steps {
    if !step.visible { reach = reach.filter(lit(false)).map_err(internal)?; break; }
    if !snapshot.links.contains(&step.link) { return Err(invalid(format!("Link {} is not loaded", step.link))); }
    let (from, to) = if step.forward { ("from_id", "to_id") } else { ("to_id", "from_id") };
    let edges = edges(snapshot, owner, &step.link)?
      .select(vec![column(from).alias("$efrom"), column(to).alias("$eto")]).map_err(internal)?;
    let visible = base(snapshot, owner, &step.target).await?.select(vec![column("$id").alias("$visible")]).map_err(internal)?;
    reach = reach.join(edges, JoinType::Inner, &["$node"], &["$efrom"], None).map_err(internal)?
      .select(vec![column("$src"), column("$eto").alias("$node")]).map_err(internal)?
      .join(visible, JoinType::LeftSemi, &["$node"], &["$visible"], None).map_err(internal)?
      .distinct().map_err(internal)?;
    let over = reach.clone().aggregate(vec![column("$src")], vec![count(column("$node")).alias("$n")]).map_err(internal)?
      .filter(column("$n").gt(lit(DERIVED_REACH))).map_err(internal)?.select(vec![column("$src").alias("$over")]).map_err(internal)?;
    crowded = Some(match crowded { None => over, Some(previous) => previous.union(over).map_err(internal)? });
    target = step.target.clone();
  }
  let grouped = if aggregate == "count" {
    reach.aggregate(vec![column("$src")], vec![count(column("$node")).alias("$gagg")]).map_err(internal)?
      .select(vec![column("$src").alias("$gsrc"), column("$gagg"), lit(false).alias("$gerr")]).map_err(internal)?
  } else if let Some(value) = value {
    let values = value_frame(snapshot, owner, &target, value).await?;
    let number = |e: Expr| cast(e, DataType::Float64);
    let agg = match aggregate {
      "select" => max(column("$v")), "max" => max(number(column("$v"))), "min" => min(number(column("$v"))),
      "sum" => sum(number(column("$v"))), "avg" => avg(number(column("$v"))),
      other => return Err(invalid(format!("Unknown linked aggregate {other}"))),
    };
    let grouped = reach.join(values, JoinType::Left, &["$node"], &["$vid"], None).map_err(internal)?
      .aggregate(vec![column("$src")], vec![agg.alias("$gagg"), bool_or(column("$verr")).alias("$verr"), count(column("$node")).alias("$n")]).map_err(internal)?;
    let mut failed = flag(column("$verr"));
    if aggregate == "select" { failed = failed.or(column("$n").gt(lit(1i64))); }
    if aggregate == "sum" || aggregate == "avg" { failed = failed.or(not_finite(column("$gagg"))); }
    grouped.select(vec![column("$src").alias("$gsrc"), column("$gagg"), failed.alias("$gerr")]).map_err(internal)?
  } else {
    // A path the principal cannot follow reaches nothing, so no value is read.
    if steps.iter().all(|s| s.visible) { return Err(invalid("A linked aggregation needs a value")); }
    reach.aggregate(vec![column("$src")], vec![count(column("$node")).alias("$n")]).map_err(internal)?
      .select(vec![column("$src").alias("$gsrc"), lit(ScalarValue::Float64(None)).alias("$gagg"), lit(false).alias("$gerr")]).map_err(internal)?
  };
  let mut result = sources.join(grouped, JoinType::Left, &["$src"], &["$gsrc"], None).map_err(internal)?;
  let mut failed = flag(column("$gerr"));
  if let Some(over) = crowded {
    result = result.join(over.distinct().map_err(internal)?, JoinType::Left, &["$src"], &["$over"], None).map_err(internal)?;
    failed = failed.or(column("$over").is_not_null());
  }
  result.select(vec![column("$src"), column("$gagg").alias("$agg"), failed.alias("$aerr")]).map_err(internal)
}

fn as_refs(frame: DataFrame, kind: &str) -> Result<DataFrame, Failure> {
  frame.select(vec![lit(kind.to_string()).alias("$type"), column("$id"), column("$key")]).map_err(internal)
}

fn distinct_union(ctx: &SessionContext, frames: Vec<DataFrame>) -> Result<DataFrame, Failure> {
  let mut iter = frames.into_iter();
  let Some(first) = iter.next() else { return refs_frame(ctx, &[]) };
  iter.try_fold(first, |acc, next| acc.union(next)).map_err(internal)?.distinct().map_err(internal)
}

/// Cardinality estimates order work; authorization, membership and read evidence are evaluated for every operand.
fn estimated_rows(snapshot: &Snapshot, node: &SetNode) -> usize {
  let population = |kind: &str| snapshot.types.get(kind).map_or(0, |t| t.base_rows.saturating_add(t.changed.len()));
  match node {
    SetNode::Empty => 0,
    SetNode::Refs { refs, .. } => refs.len(),
    SetNode::Scan { r#type, filter, .. } => match filter {
      Some(Predicate::Const { value: false }) => 0,
      Some(Predicate::Eq { column, .. }) if column == "$id" => 1,
      Some(Predicate::In { column, values }) if column == "$id" => values.len(),
      _ => population(r#type),
    },
    SetNode::Union { sets } => sets.iter().map(|s| estimated_rows(snapshot,s)).fold(0,usize::saturating_add),
    SetNode::Intersect { sets } => sets.iter().map(|s| estimated_rows(snapshot,s)).min().unwrap_or(0),
    SetNode::Except { left, .. } => estimated_rows(snapshot,left),
    SetNode::Traverse { set, steps } | SetNode::BoundedTraverse { set, steps, .. } => {
      steps.iter().fold(estimated_rows(snapshot,set), |current, step| {
        step.iter().map(|m| {
          let edges = snapshot.edges.get(&m.link).map_or(0, |link| link.base_rows.saturating_add(link.changed.len()));
          current.saturating_mul(edges).div_ceil(population(&m.source).max(1)).min(population(&m.target))
        }).fold(0,usize::saturating_add)
      })
    }
  }
}

/// Consume visible target batches only up to the first excess distinct identity. Never return a truncated complete set.
async fn bounded_frontier(ctx: &SessionContext, frames: Vec<DataFrame>, limit: usize) -> Result<DataFrame, Failure> {
  let mut seen = HashSet::new();
  for frame in frames {
    let frame = frame.select(vec![cast(column("$type"), DataType::Utf8), cast(column("$id"), DataType::Utf8)]).map_err(internal)?;
    let mut stream = frame.execute_stream().await.map_err(internal)?;
    while let Some(batch) = stream.try_next().await.map_err(internal)? {
      let types = batch.column(0).as_string::<i32>();
      let ids = batch.column(1).as_string::<i32>();
      for row in 0..batch.num_rows() {
        seen.insert((types.value(row).to_owned(),ids.value(row).to_owned()));
        if seen.len() > limit { return Err(fallback("traversal exceeds the selected frontier limit")); }
      }
    }
  }
  refs_frame(ctx,&seen.into_iter().collect::<Vec<_>>())
}

/// Evaluates a set node and records the rows the reference reads for it: a scan's matches (every readable row when its
/// filter reads derived values), the existing references, and every traversal step's targets.
fn set_frame<'a>(snapshot: &'a Snapshot, owner: &'a Ctx, node: &'a SetNode) -> futures_util::future::BoxFuture<'a, Result<DataFrame, Failure>> {
  Box::pin(async move {
    let ctx = &snapshot.ctx;
    match node {
      SetNode::Empty => refs_frame(ctx, &[]),
      SetNode::Scan { r#type, filter, candidates } => {
        let matched = objects(snapshot, owner, r#type, filter.as_ref()).await?;
        owner.read(r#type, if *candidates { base(snapshot, owner, r#type).await? } else { matched.clone() }, true)?;
        as_refs(matched, r#type)
      }
      SetNode::Refs { refs, enrich } => {
        // Only references to existing objects of loaded types remain.
        let mut by_type: HashMap<&str, Vec<(String, String)>> = HashMap::new();
        for r in refs { if snapshot.kinds.contains_key(&r.r#type) { by_type.entry(&r.r#type).or_default().push((r.r#type.clone(), r.id.clone())); } }
        let mut frames = Vec::new();
        for (kind, items) in by_type {
          let wanted = refs_frame(ctx, &items)?.select(vec![column("$id").alias("wanted")]).map_err(internal)?;
          let existing = objects(snapshot, owner, kind, None).await?.join(wanted, JoinType::LeftSemi, &["$id"], &["wanted"], None).map_err(internal)?;
          owner.read(kind, existing.clone(), *enrich)?;
          frames.push(as_refs(existing, kind)?);
        }
        distinct_union(ctx, frames)
      }
      SetNode::Union { sets } => {
        let mut frames = Vec::new();
        for s in sets { frames.push(set_frame(snapshot, owner, s).await?); }
        distinct_union(ctx, frames)
      }
      SetNode::Intersect { sets } => {
        let mut operands: Vec<_> = sets.iter().collect();
        operands.sort_by_cached_key(|s| estimated_rows(snapshot,s));
        let mut iter = operands.into_iter();
        let first = iter.next().ok_or_else(|| invalid("Empty intersection"))?;
        let mut frame = set_frame(snapshot, owner, first).await?;
        for other in iter {
          frame = frame.join(set_frame(snapshot,owner,other).await?, JoinType::LeftSemi, &["$key"], &["$key"], None).map_err(internal)?;
        }
        Ok(frame)
      }
      SetNode::Except { left, right } => {
        let left_small = estimated_rows(snapshot,left) <= estimated_rows(snapshot,right);
        if left_small {
          // The original left-minus-right plan already starts with the narrower side.
          set_frame(snapshot, owner, left).await?.except(set_frame(snapshot, owner, right).await?)
            .map_err(internal)?.distinct().map_err(internal)
        } else {
          let exclusions = set_frame(snapshot, owner, right).await?;
          exclusions.join(set_frame(snapshot, owner, left).await?, JoinType::RightAnti, &["$key"], &["$key"], None).map_err(internal)
        }
      }
      SetNode::Traverse { set, steps } | SetNode::BoundedTraverse { set, steps, .. } => {
        let mut current = set_frame(snapshot, owner, set).await?;
        for step in steps {
          let mut frames = Vec::new();
          for m in step {
            if !snapshot.links.contains(&m.link) { return Err(invalid(format!("Link {} is not loaded", m.link))); }
            let sources = current.clone().filter(column("$type").eq(lit(m.source.clone()))).map_err(internal)?
              .select(vec![column("$id").alias("source")]).map_err(internal)?;
            let (from, to) = if m.forward { ("from_id", "to_id") } else { ("to_id", "from_id") };
            let edges = edges(snapshot, owner, &m.link)?
              .join(sources, JoinType::LeftSemi, &[from], &["source"], None).map_err(internal)?
              .select(vec![column(to).alias("target")]).map_err(internal)?;
            let reached = objects(snapshot, owner, &m.target, None).await?.join(edges, JoinType::LeftSemi, &["$id"], &["target"], None).map_err(internal)?;
            let targets = match &m.filter {
              Some(p) => reached.clone().filter(predicate(p, &kinds_of(snapshot, owner, &m.target)?)?).map_err(internal)?,
              None => reached.clone(),
            };
            owner.read(&m.target, if m.candidates { reached } else { targets.clone() }, true)?;
            frames.push(as_refs(targets, &m.target)?);
          }
          current = match node {
            SetNode::BoundedTraverse { limit, .. } => bounded_frontier(ctx,frames,*limit).await?,
            _ => distinct_union(ctx,frames)?,
          };
        }
        Ok(current)
      }
    }
  })
}

/// Records what evaluating the derived properties of every row the reference enriches reads, and fails over to the
/// reference when it would fail to evaluate one of them.
async fn enrich(snapshot: &Snapshot, owner: &Ctx) -> Result<(), Failure> {
  let enriched: Vec<(String, DataFrame)> = owner.reads.lock().unwrap().iter()
    .filter(|read| read.enrich && owner.derived.contains_key(&read.kind)).map(|read| (read.kind.clone(), read.ids.clone())).collect();
  for (kind, ids) in enriched {
    let wanted = ids.clone().select(vec![column("$id").alias("$rid")]).map_err(internal)?;
    for spec in owner.derived.get(&kind).into_iter().flatten() {
      let failed = derived_column(snapshot, owner, &kind, &spec.column).await?.filter(column("$err")).map_err(internal)?
        .join(wanted.clone(), JoinType::LeftSemi, &["$did"], &["$rid"], None).map_err(internal)?
        .limit(0, Some(1)).map_err(internal)?.count().await.map_err(internal)?;
      if failed > 0 { return Err(fallback(&format!("the reference fails to evaluate {kind}.{}", spec.column))); }
      expression_reads(snapshot, owner, &kind, &spec.expr, ids.clone()).await?;
    }
  }
  Ok(())
}

/// Records the rows the reference reads to evaluate `expr` on the rows `ids` (one `$id` column) of `kind`: every object
/// each step of a relationship path reaches, and what evaluating a derived value on the reached objects reads.
fn expression_reads<'a>(snapshot: &'a Snapshot, owner: &'a Ctx, kind: &'a str, expr: &'a Derived, ids: DataFrame)
  -> futures_util::future::BoxFuture<'a, Result<(), Failure>> {
  Box::pin(async move {
    match expr {
      Derived::Literal { .. } | Derived::Field { .. } => Ok(()),
      Derived::Derived { column: name } => {
        let spec = owner.derived.get(kind).into_iter().flatten().find(|s| &s.column == name)
          .ok_or_else(|| invalid(format!("Derived column {name} is not defined")))?;
        expression_reads(snapshot, owner, kind, &spec.expr, ids).await
      }
      Derived::Arith { left, right, .. } => {
        expression_reads(snapshot, owner, kind, left, ids.clone()).await?;
        expression_reads(snapshot, owner, kind, right, ids).await
      }
      Derived::Linked { steps, aggregate, value } => {
        let mut frontier = ids;
        let mut target = kind;
        for step in steps {
          if !step.visible { return Ok(()); }
          let (from, to) = if step.forward { ("from_id", "to_id") } else { ("to_id", "from_id") };
          let sources = frontier.select(vec![column("$id").alias("$fid")]).map_err(internal)?;
          let edges = edges(snapshot, owner, &step.link)?
            .join(sources, JoinType::LeftSemi, &[from], &["$fid"], None).map_err(internal)?
            .select(vec![column(to).alias("$tid")]).map_err(internal)?;
          frontier = base(snapshot, owner, &step.target).await?.join(edges, JoinType::LeftSemi, &["$id"], &["$tid"], None).map_err(internal)?
            .select(vec![column("$id")]).map_err(internal)?;
          owner.read(&step.target, frontier.clone(), false)?;
          target = &step.target;
        }
        match (aggregate.as_str(), value.as_deref()) {
          ("count", _) | (_, None) => Ok(()),
          (_, Some(value)) => expression_reads(snapshot, owner, target, value, frontier).await,
        }
      }
    }
  })
}

async fn rows(frame: DataFrame) -> Result<Vec<Value>, Failure> {
  let batches = frame.collect().await.map_err(internal)?;
  let mut writer = datafusion::arrow::json::ArrayWriter::new(Vec::new());
  for batch in &batches { writer.write(batch).map_err(internal)?; }
  writer.finish().map_err(internal)?;
  let bytes = writer.into_inner();
  if bytes.is_empty() { return Ok(Vec::new()); }
  let parsed: Value = serde_json::from_slice(&bytes).map_err(internal)?;
  Ok(parsed.as_array().cloned().unwrap_or_default())
}

/// The distinct strings of a string-list column over `frame`'s rows, sorted.
async fn distinct_strings(frame: DataFrame, name: &str) -> Result<Vec<String>, Failure> {
  let values = rows(frame.filter(column(name).is_not_null()).map_err(internal)?.select(vec![column(name)]).map_err(internal)?.distinct().map_err(internal)?).await?;
  let mut out: Vec<String> = values.iter().flat_map(|row| row[name].as_array().cloned().unwrap_or_default())
    .filter_map(|item| item.as_str().map(String::from)).collect();
  out.sort();
  out.dedup();
  Ok(out)
}

/// The most row ids a tracked type reports, the reference's complete-evaluation limit.
const TRACKED: usize = 10000;

/**
 * For each type the evaluation reads, over the distinct rows read: how many; for a classified type, the highest row
 * sensitivity rank and every compartment; for a tracked (policy-bound) type, every id, or `overLimit`; and the markings
 * the rows carry. The caller records these as the reference does for each row it reads.
 */
async fn read_stats(snapshot: &Snapshot, owner: &Ctx, specs: &[MemberSpec]) -> Result<Vec<Value>, Failure> {
  let mut by_type: HashMap<String, (Vec<DataFrame>, Vec<DataFrame>)> = HashMap::new();
  for read in owner.reads.lock().unwrap().iter() {
    let entry = by_type.entry(read.kind.clone()).or_default();
    entry.0.push(read.ids.clone());
    if read.enrich { entry.1.push(read.ids.clone()); }
  }
  let mut out = Vec::new();
  for (kind, (frames, enriched)) in by_type {
    let spec = specs.iter().find(|s| s.r#type == kind).ok_or_else(|| invalid(format!("The planner did not describe {kind}")))?;
    let mut iter = frames.into_iter().map(|frame| frame.select(vec![column("$id").alias("$rid")]));
    let first = iter.next().ok_or_else(|| invalid("No reads"))?.map_err(internal)?;
    let ids = iter.try_fold(first, |acc, next| acc.union(next?)).map_err(internal)?;
    let rows_frame = base(snapshot, owner, &kind).await?.join(ids, JoinType::LeftSemi, &["$id"], &["$rid"], None).map_err(internal)?;
    let mut entry = serde_json::Map::new();
    let total = if snapshot.classified.contains(&kind) {
      let summary = rows(rows_frame.clone().aggregate(vec![], vec![count(lit(1i64)).alias("count"), max(column("$rank")).alias("rank")]).map_err(internal)?).await?;
      let total = summary.first().and_then(|row| row["count"].as_i64()).unwrap_or(0) as usize;
      entry.insert("rank".into(), summary.first().and_then(|row| row.get("rank").cloned()).unwrap_or(Value::Null));
      entry.insert("compartments".into(), json!(distinct_strings(rows_frame.clone(), "$compartments").await?));
      total
    } else {
      rows_frame.clone().count().await.map_err(internal)?
    };
    if total == 0 { continue; }
    entry.insert("type".into(), json!(kind));
    entry.insert("count".into(), json!(total));
    if spec.track {
      if total > TRACKED { entry.insert("overLimit".into(), json!(true)); }
      else {
        let listed = rows(rows_frame.clone().select(vec![column("$id")]).map_err(internal)?).await?;
        entry.insert("ids".into(), json!(listed.iter().filter_map(|row| row["$id"].as_str()).collect::<Vec<_>>()));
      }
    }
    if let Some(name) = &spec.markings {
      if snapshot.kinds.get(&kind).and_then(|k| k.get(name)) != Some(&Kind::Strings) { return Err(invalid(format!("{name} is not a string list"))); }
      entry.insert("markings".into(), json!(distinct_strings(rows_frame, name).await?));
    }
    // Whether the reference reads some of these rows with their derived values, and so checks their visibility.
    if owner.derived.contains_key(&kind) && !enriched.is_empty() {
      let mut iter = enriched.into_iter();
      let first = iter.next().ok_or_else(|| invalid("No reads"))?;
      let any = iter.try_fold(first, |acc, next| acc.union(next)).map_err(internal)?.limit(0, Some(1)).map_err(internal)?.count().await.map_err(internal)?;
      if any > 0 { entry.insert("enriched".into(), json!(true)); }
    }
    out.push(Value::Object(entry));
  }
  Ok(out)
}

/// FNV-1a: a hash that stays the same across processes and builds.
fn fnv1a(text: &str) -> u64 {
  let mut hash = 0xcbf2_9ce4_8422_2325u64;
  for byte in text.bytes() { hash ^= byte as u64; hash = hash.wrapping_mul(0x0000_0100_0000_01b3); }
  hash
}

/// An order-independent digest of a set's members, so a cursor can tell whether the membership changed between pages.
async fn membership(set: &DataFrame) -> Result<String, Failure> {
  let (mut count, mut sum) = (0u64, 0u64);
  for batch in set.clone().select(vec![column("$key")]).map_err(internal)?.collect().await.map_err(internal)? {
    let keys = batch.column(0).as_string_opt::<i32>().ok_or_else(|| internal("Member keys are not strings"))?;
    for key in keys.iter().flatten() { count += 1; sum = sum.wrapping_add(fnv1a(key)); }
  }
  Ok(format!("{count:x}-{sum:016x}"))
}

/// A string function over a Utf8 column, null for null.
fn string_udf(name: &str, output: DataType, each: fn(&str, &mut Vec<u8>)) -> ScalarUDF {
  let binary = output == DataType::Binary;
  create_udf(name, vec![DataType::Utf8], output, Volatility::Immutable, Arc::new(move |args: &[ColumnarValue]| {
    let arrays = ColumnarValue::values_to_arrays(args)?;
    let strings = arrays[0].as_string::<i32>();
    let mut buffer = Vec::new();
    let array: ArrayRef = if binary {
      let mut out = BinaryBuilder::with_capacity(strings.len(), strings.value_data().len() * 2);
      for value in strings.iter() { match value { None => out.append_null(), Some(s) => { buffer.clear(); each(s, &mut buffer); out.append_value(&buffer); } } }
      Arc::new(out.finish())
    } else {
      let mut out = StringBuilder::with_capacity(strings.len(), strings.value_data().len() + 2 * strings.len());
      for value in strings.iter() { match value { None => out.append_null(), Some(s) => {
        buffer.clear(); each(s, &mut buffer);
        out.append_value(std::str::from_utf8(&buffer).map_err(|e| datafusion::error::DataFusionError::Execution(e.to_string()))?);
      } } }
      Arc::new(out.finish())
    };
    Ok(ColumnarValue::Array(array))
  }))
}
/// The string's UTF-16 code units, big-endian: their bytes order as JavaScript orders strings, by code unit.
fn utf16_key(value: Expr) -> Expr {
  string_udf("utf16_key", DataType::Binary, |s, out| for unit in s.encode_utf16() { out.extend_from_slice(&unit.to_be_bytes()); }).call(vec![value])
}
/// The string as a JSON string literal, as `JSON.stringify` writes it.
fn json_string(value: Expr) -> Expr {
  string_udf("json_string", DataType::Utf8, |s, out| out.extend_from_slice(serde_json::to_string(s).unwrap().as_bytes())).call(vec![value])
}

/// One member type's members with `leading` columns, then each part field as an aggregation or a query order reads it:
/// from the type's own column, cast to the field's kind across member types, hidden for every row or shown where a cell
/// policy permits, or null where the type does not map the field.
async fn part_frame(snapshot: &Snapshot, owner: &Ctx, set: &DataFrame, part: &Part, kinds: &HashMap<String, Kind>, leading: Vec<Expr>) -> Result<DataFrame, Failure> {
  let local = kinds_of(snapshot, owner, &part.r#type)?;
  let members = set.clone().filter(column("$type").eq(lit(part.r#type.clone()))).map_err(internal)?.select(vec![column("$id").alias("member")]).map_err(internal)?;
  let rows = objects(snapshot, owner, &part.r#type, None).await?.join(members, JoinType::LeftSemi, &["$id"], &["member"], None).map_err(internal)?;
  let mut projection = leading;
  for field in &part.fields {
    let kind = *kinds.get(&field.name).ok_or_else(|| invalid(format!("No kind for {}", field.name)))?;
    let null = || ScalarValue::try_from(&data_type(kind)).map(lit).map_err(internal);
    let value = match &field.column {
      None => null()?,
      Some(_) if field.hidden => null()?,
      Some(name) => {
        if !local.contains_key(name) { return Err(invalid(format!("Unknown column {name} of {}", part.r#type))); }
        let value = cast(column(name), data_type(kind));
        match &field.policy { Some(policy) => when(predicate(policy, &local)?, value).otherwise(null()?).map_err(internal)?, None => value }
      }
    };
    projection.push(value.alias(field.name.clone()));
  }
  rows.select(projection).map_err(internal)
}

async fn query(snapshot: &Snapshot, request: QueryRequest, overlay: Option<Arc<Overlay>>) -> Result<Value, Failure> {
  let started = Instant::now();
  let owner = Ctx { owner: request.owner.clone(), rows: request.rows, derived: request.derived, columns: Default::default(), reads: Default::default(),
    scenario: overlay.map(|overlay| (overlay, request.scenario.map(|s| s.single).unwrap_or_default())) };
  // The set is computed once and reused by the page, the total and the read statistics.
  let set = set_frame(snapshot, &owner, &request.set).await?.cache().await.map_err(internal)?;
  enrich(snapshot, &owner).await?;
  let reads = read_stats(snapshot, &owner, &request.members).await?;
  match request.output {
    Output::Page { offset, limit } => {
      let total = set.clone().count().await.map_err(internal)?;
      let page = set.clone().sort(vec![column("$key").sort(true, false)]).map_err(internal)?
        .limit(offset, Some(limit)).map_err(internal)?.select(vec![column("$type"), column("$id")]).map_err(internal)?;
      let refs: Vec<Value> = rows(page).await?.into_iter().map(|row| json!({ "type": row["$type"], "id": row["$id"] })).collect();
      // The types of the members, which a view must be able to show.
      let types: Vec<Value> = rows(set.clone().select(vec![column("$type")]).map_err(internal)?.distinct().map_err(internal)?).await?
        .into_iter().map(|row| row["$type"].clone()).collect();
      Ok(json!({ "total": total, "refs": refs, "types": types, "membership": membership(&set).await?, "reads": reads,
        "elapsedMs": started.elapsed().as_secs_f64() * 1000.0 }))
    }
    Output::Query { offset, limit, parts, kinds, order } => {
      let total = set.clone().count().await.map_err(internal)?;
      let covered: HashSet<&str> = parts.iter().map(|part| part.r#type.as_str()).collect();
      for row in rows(set.clone().select(vec![column("$type")]).map_err(internal)?.distinct().map_err(internal)?).await? {
        if !row["$type"].as_str().is_some_and(|t| covered.contains(t)) { return Err(invalid(format!("No order part for members of {}", row["$type"]))); }
      }
      let mut frames = Vec::new();
      for part in &parts {
        let leading = vec![column("$key"), lit(part.r#type.clone()).alias("$type"), column("$id"),
          lit(serde_json::to_string(&part.r#type).unwrap()).alias("$jtype"), json_string(column("$id")).alias("$jid")];
        frames.push(part_frame(snapshot, &owner, &set, part, &kinds, leading).await?);
      }
      let mut iter = frames.into_iter();
      let (refs, membership): (Vec<Value>, String) = match iter.next() {
        None => (Vec::new(), membership(&set).await?),
        Some(first) => {
          let members = iter.try_fold(first, |acc, next| acc.union(next)).map_err(internal)?.cache().await.map_err(internal)?;
          // As the reference orders a query it evaluates completely: each order key with nulls last in either direction,
          // numbers as JavaScript numbers and strings by UTF-16 code unit; then the JSON-encoded type and id, by byte.
          let mut keys = Vec::new();
          for key in &order {
            let value = match kinds.get(&key.name) {
              Some(Kind::String) => utf16_key(column(&key.name)),
              Some(Kind::Integer) | Some(Kind::Number) => cast(column(&key.name), DataType::Float64),
              Some(Kind::Boolean) => column(&key.name),
              _ => return Err(invalid(format!("Cannot order by {}", key.name))),
            };
            keys.push(value.sort(!key.desc, false));
          }
          keys.push(column("$jtype").sort(true, false));
          keys.push(column("$jid").sort(true, false));
          let page = members.clone().sort(keys).map_err(internal)?.limit(offset, Some(limit)).map_err(internal)?
            .select(vec![column("$type"), column("$id")]).map_err(internal)?;
          let refs = rows(page).await?.into_iter().map(|row| json!({ "type": row["$type"], "id": row["$id"] })).collect();
          // The members and the values they are ordered by: a cursor continues only while neither changed.
          let mut digested = vec![column("$key")];
          for key in &order { digested.push(coalesce(vec![cast(column(&key.name), DataType::Utf8), lit("\u{1}")])); }
          let keyed = members.select(vec![concat_ws(lit("\u{0}"), digested).alias("$key")]).map_err(internal)?;
          (refs, membership(&keyed).await?)
        }
      };
      Ok(json!({ "total": total, "refs": refs, "membership": membership, "reads": reads,
        "elapsedMs": started.elapsed().as_secs_f64() * 1000.0 }))
    }
    Output::Aggregate { parts, kinds, group_by, metrics } => {
      // Each member type's fields as the aggregation reads them, under one kind per field, then all members together.
      let mut frames = Vec::new();
      for part in &parts { frames.push(part_frame(snapshot, &owner, &set, part, &kinds, vec![column("$key")]).await?); }
      let mut iter = frames.into_iter();
      let first = iter.next().ok_or_else(|| invalid("An aggregation needs a member type"))?;
      let objects = iter.try_fold(first, |acc, next| acc.union(next)).map_err(internal)?;
      let mut aggregates = vec![min(column("$key")).alias("$first"), count(lit(1i64)).alias("$count")];
      for m in &metrics {
        let target = || m.column.as_ref().filter(|c| kinds.contains_key(*c)).map(|c| column(c)).ok_or_else(|| invalid(format!("Metric {} needs a loaded column", m.name)));
        aggregates.push(match (m.op.as_str(), &m.column) {
          ("count", None) => count(lit(1i64)),
          ("count", Some(_)) => count(target()?),
          ("sum", _) => sum(target()?),
          ("min", _) => min(target()?),
          ("max", _) => max(target()?),
          ("avg", _) => avg(target()?),
          (other, _) => return Err(invalid(format!("Unknown metric {other}"))),
        }.alias(format!("m:{}", m.name)));
      }
      for g in &group_by { if !kinds.contains_key(g) { return Err(invalid(format!("Unknown group column {g}"))); } }
      let grouped = objects.aggregate(group_by.iter().map(|g| column(g)).collect(), aggregates).map_err(internal)?
        .sort(vec![column("$first").sort(true, false)]).map_err(internal)?;
      let mut total = 0i64;
      let items: Vec<Value> = rows(grouped).await?.into_iter().map(|row| {
        total += row["$count"].as_i64().unwrap_or(0);
        let group: serde_json::Map<String, Value> = group_by.iter().map(|g| (g.clone(), row.get(g).cloned().unwrap_or(Value::Null))).collect();
        let values: serde_json::Map<String, Value> = metrics.iter().map(|m| (m.name.clone(), row.get(&format!("m:{}", m.name)).cloned().unwrap_or(Value::Null))).collect();
        json!({ "group": group, "metrics": values })
      }).collect();
      Ok(json!({ "count": total, "items": items, "reads": reads, "elapsedMs": started.elapsed().as_secs_f64() * 1000.0 }))
    }
  }
}

/// What this kernel answers: 1, Object Set pages and aggregations; 2, also query pages (C4b) and Scenario overlays (C5a).
const PROTOCOL: u32 = 2;

async fn health(State(state): State<Shared>) -> Json<Value> {
  let snapshot = state.snapshot.read().await.clone();
  Json(match snapshot {
    Some(s) => json!({ "status": "ok", "protocol": PROTOCOL, "loaded": true, "loads": state.loads.load(std::sync::atomic::Ordering::Relaxed),
      "projection": s.request.projection, "objects": s.objects, "edges": s.edge_count,
      "changed": s.types.values().map(|t| t.changed.len()).sum::<usize>() + s.edges.values().map(|l| l.changed.len()).sum::<usize>() }),
    None => json!({ "status": "ok", "protocol": PROTOCOL, "loaded": false }),
  })
}

/// The last commit applied for each owner.
async fn positions(State(state): State<Shared>) -> Json<Value> {
  let snapshot = state.snapshot.read().await.clone();
  Json(json!(snapshot.map(|s| s.applied.clone()).unwrap_or_default()))
}

/// Loads a projection: from its last checkpoint when that matches the database, otherwise from storage.
async fn load_route(State(state): State<Shared>, Json(request): Json<LoadRequest>) -> Result<Json<Value>, Failure> {
  let started = Instant::now();
  let (snapshot, restored) = {
    // The Funnel waits, so no commit is applied to the version this load replaces.
    let _writer = state.funnel.lock().await;
    let (snapshot, restored) = match restore(&request).await? { Some(snapshot) => (snapshot, true), None => (load(request).await?, false) };
    let snapshot = Arc::new(snapshot);
    *state.snapshot.write().await = Some(snapshot.clone());
    state.loads.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    (snapshot, restored)
  };
  if restored {
    // A restored version is as old as its checkpoint, so every owner's commits since are applied before the load answers.
    let found = { let mut funnel = state.funnel.lock().await; latest_commits(&mut funnel, &snapshot, 0).await };
    let found = match found { Ok(found) => found, Err(error) => { *state.funnel.lock().await = None; return Err(error); } };
    for (owner, latest) in found { if latest > snapshot.position(&owner) { catch_up(&state, &owner).await?; } }
  } else if data_dir().is_some() {
    // A checkpoint of the loaded version lets the next start skip the full load.
    let (state, snapshot) = (state.clone(), snapshot.clone());
    tokio::spawn(async move { let _ = checkpoint(&state, &snapshot).await; });
  }
  let current = state.snapshot.read().await.clone().unwrap_or(snapshot);
  Ok(Json(json!({ "objects": current.objects, "edges": current.edge_count, "bytes": current.bytes, "restored": restored,
    "elapsedMs": started.elapsed().as_secs_f64() * 1000.0 })))
}

/// Writes a checkpoint of the current version now.
async fn checkpoint_route(State(state): State<Shared>) -> Result<Json<Value>, Failure> {
  let snapshot = state.snapshot.read().await.clone().ok_or_else(|| failure(StatusCode::SERVICE_UNAVAILABLE, "No projection is loaded"))?;
  Ok(Json(checkpoint(&state, &snapshot).await?))
}

/// Waits for SIGTERM or SIGINT, then writes a last checkpoint so the next start restores the latest version.
async fn shutdown(state: Shared) {
  let terminate = async { if let Ok(mut signal) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) { signal.recv().await; } };
  tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate => {} }
  if data_dir().is_some() { if let Some(snapshot) = state.snapshot.read().await.clone() { let _ = checkpoint(&state, &snapshot).await; } }
}

async fn query_route(State(state): State<Shared>, Json(request): Json<QueryRequest>) -> Result<Json<Value>, Failure> {
  let unloaded = || failure(StatusCode::SERVICE_UNAVAILABLE, "No projection is loaded");
  let mut snapshot = state.snapshot.read().await.clone().ok_or_else(unloaded)?;
  if request.projection.as_ref().is_some_and(|p| p != &snapshot.request.projection) { return Err(stale("the kernel holds another projection")); }
  if let Some(needed) = request.min_commit {
    if snapshot.position(&request.owner) < needed {
      // The owner's commits are applied in a task of their own, so a query that stops waiting does not interrupt them.
      let task = tokio::spawn({ let state = state.clone(); let owner = request.owner.clone(); async move { catch_up(&state, &owner).await } });
      match tokio::time::timeout(Duration::from_millis(request.wait_ms.unwrap_or(2000)), task).await {
        Ok(Ok(result)) => result?,
        Ok(Err(error)) => return Err(internal(error)),
        Err(_) => return Err(stale("the kernel is still applying the owner's commits")),
      }
      snapshot = state.snapshot.read().await.clone().ok_or_else(unloaded)?;
      if snapshot.position(&request.owner) < needed { return Err(stale("the kernel has not seen the commit")); }
    }
  }
  let commit = snapshot.position(&request.owner);
  let overlay = match &request.scenario { Some(scenario) => Some(overlay(&state, &snapshot, &request.owner, scenario).await?), None => None };
  let mut value = query(&snapshot, request, overlay).await?;
  value["commit"] = json!(commit);
  Ok(Json(value))
}

#[tokio::main]
async fn main() {
  // Loopback only: the kernel holds every owner's data of the projection and has no authentication of its own.
  let port: u16 = std::env::var("EIGOS_KERNEL_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(0);
  let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port))).await.expect("bind loopback");
  println!("{}", json!({ "event": "kernel_listening", "port": listener.local_addr().unwrap().port() }));
  let state: Shared = Arc::new(AppState { snapshot: RwLock::new(None), funnel: Mutex::new(None), checkpointed: Mutex::new(None), loads: Default::default(),
    overlays: Default::default() });
  // EIGOS_KERNEL_POLL_MS sets how often the Funnel looks for new commits; 0 leaves it to the queries.
  let every = std::env::var("EIGOS_KERNEL_POLL_MS").ok().and_then(|v| v.parse::<u64>().ok()).unwrap_or(1000);
  if every > 0 { tokio::spawn(follow(state.clone(), Duration::from_millis(every))); }
  // EIGOS_KERNEL_CHECKPOINT_S sets how often a changed version is written as a checkpoint; 0 writes them only after a
  // load, on request and at shutdown.
  let every = std::env::var("EIGOS_KERNEL_CHECKPOINT_S").ok().and_then(|v| v.parse::<u64>().ok()).unwrap_or(300);
  if every > 0 && data_dir().is_some() { tokio::spawn(checkpoints(state.clone(), Duration::from_secs(every))); }
  let app = Router::new().route("/health", get(health)).route("/positions", get(positions)).route("/load", post(load_route)).route("/query", post(query_route))
    .route("/checkpoint", post(checkpoint_route))
    .layer(axum::extract::DefaultBodyLimit::max(64 * 1024 * 1024)).with_state(state.clone());
  axum::serve(listener, app).with_graceful_shutdown(shutdown(state)).await.expect("serve");
}
