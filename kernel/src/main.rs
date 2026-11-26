//! EIGOS Ontology query kernel (prototype C1).
//!
//! Loads a snapshot of one publication projection from PostgreSQL into per-type object tables and per-link edge
//! tables, and executes Object Set plans compiled by the TypeScript planner (`packages/runtime/kernel/`) on
//! Apache DataFusion. Value semantics follow the reference implementation: predicates are two-valued (a missing value
//! is null, `ne` holds for null, `not` never sees an unknown), and sets are ordered by the canonical reference key.

use std::{collections::HashMap, net::SocketAddr, sync::Arc, time::Instant};

use axum::{extract::State, http::StatusCode, routing::{get, post}, Json, Router};
use datafusion::arrow::array::{ArrayRef, BooleanBuilder, Float64Builder, Int64Builder, ListBuilder, RecordBatch, StringBuilder};
use datafusion::arrow::datatypes::{DataType, Field, Schema, SchemaRef};
use datafusion::common::{Column, TableReference};
use datafusion::datasource::MemTable;
use datafusion::functions::core::expr_fn::coalesce;
use datafusion::functions::unicode::expr_fn::strpos;
use datafusion::functions_aggregate::expr_fn::{avg, count, max, min, sum};
use datafusion::functions_nested::expr_fn::{array_has_all, array_has_any, cardinality, make_array};
use datafusion::common::ScalarValue;
use datafusion::logical_expr::when;
use datafusion::logical_expr::{lit, Expr, JoinType};
use datafusion::prelude::{DataFrame, SessionConfig, SessionContext};
use futures_util::{pin_mut, TryStreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::RwLock;
use tokio_postgres::NoTls;

type Failure = (StatusCode, Json<Value>);
fn failure(status: StatusCode, message: impl ToString) -> Failure { (status, Json(json!({ "error": message.to_string() }))) }
fn internal(error: impl ToString) -> Failure { failure(StatusCode::INTERNAL_SERVER_ERROR, error) }
fn invalid(error: impl ToString) -> Failure { failure(StatusCode::BAD_REQUEST, error) }

#[derive(Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "lowercase")]
enum Kind { String, Integer, Number, Boolean, Strings }

#[derive(Deserialize)]
struct ColumnDef { name: String, kind: Kind }
#[derive(Deserialize)]
struct TypeDef { name: String, columns: Vec<ColumnDef>, classification: Option<String> }
#[derive(Deserialize)]
struct LoadRequest { database: String, schema: String, projection: String, types: Vec<TypeDef>, links: Vec<String>, ranks: HashMap<String, i64> }

/// A loaded projection: the DataFusion context with its tables, each type's column kinds, and the types whose rows carry
/// a classification (as `$rank` and comma-joined `$compartments`).
struct Snapshot { ctx: SessionContext, kinds: HashMap<String, HashMap<String, Kind>>, classified: std::collections::HashSet<String>, links: Vec<String>, objects: usize, edges: usize, bytes: usize }
type Shared = Arc<RwLock<Option<Snapshot>>>;

fn column(name: &str) -> Expr { Expr::Column(Column::new_unqualified(name)) }
fn data_type(kind: Kind) -> DataType {
  match kind {
    Kind::String => DataType::Utf8, Kind::Integer => DataType::Int64, Kind::Number => DataType::Float64, Kind::Boolean => DataType::Boolean,
    Kind::Strings => DataType::List(Arc::new(Field::new("item", DataType::Utf8, true))),
  }
}
fn object_table(kind: &str) -> TableReference { TableReference::bare(format!("o:{kind}")) }
fn edge_table(link: &str) -> TableReference { TableReference::bare(format!("l:{link}")) }
/// The canonical reference key: `canonical({type,id})` orders by the JSON-encoded id, then the JSON-encoded type.
fn ref_key(kind: &str, id: &str) -> String { format!("{}{}", serde_json::to_string(id).unwrap(), serde_json::to_string(kind).unwrap()) }
fn quote(identifier: &str) -> String { format!("\"{}\"", identifier.replace('"', "\"\"")) }

const BATCH: usize = 65536;

fn partitions() -> usize { std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4) }

/// Spreads batches over the session's partitions so scans run in parallel.
fn spread(batches: Vec<RecordBatch>, parts: usize) -> Vec<Vec<RecordBatch>> {
  let mut out = vec![Vec::new(); parts.max(1)];
  for (i, batch) in batches.into_iter().enumerate() { out[i % parts.max(1)].push(batch); }
  out
}

async fn load(request: LoadRequest) -> Result<Snapshot, Failure> {
  let (client, connection) = tokio_postgres::connect(&request.database, NoTls).await.map_err(internal)?;
  tokio::spawn(async move { let _ = connection.await; });
  let parts = partitions();
  let ctx = SessionContext::new_with_config(SessionConfig::new().with_target_partitions(parts));
  let schema = quote(&request.schema);
  let mut kinds = HashMap::new();
  let mut classified = std::collections::HashSet::new();
  let (mut objects, mut edges, mut bytes) = (0, 0, 0usize);
  for kind in &request.types {
    let mut fields = vec![Field::new("$owner", DataType::Utf8, false), Field::new("$id", DataType::Utf8, false),
      Field::new("$key", DataType::Utf8, false), Field::new("$revision", DataType::Int64, false)];
    for c in &kind.columns {
      fields.push(Field::new(&c.name, data_type(c.kind), true));
    }
    if kind.classification.is_some() {
      fields.push(Field::new("$rank", DataType::Int64, true));
      fields.push(Field::new("$compartments", data_type(Kind::Strings), true));
      classified.insert(kind.name.clone());
    }
    let table: SchemaRef = Arc::new(Schema::new(fields));
    let sql = format!("SELECT owner, id, revision::bigint, properties::text FROM {schema}.objects WHERE projection::text=$1 AND type=$2");
    let params: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = vec![&request.projection, &kind.name];
    let rows = client.query_raw(sql.as_str(), params).await.map_err(internal)?;
    pin_mut!(rows);
    let mut batches = Vec::new();
    let mut builder = ObjectBuilder::new(&kind.columns, kind.classification.is_some());
    while let Some(row) = rows.try_next().await.map_err(internal)? {
      let owner: String = row.get(0);
      let id: String = row.get(1);
      let revision: i64 = row.get(2);
      let properties: Value = serde_json::from_str(row.get::<_, &str>(3)).map_err(internal)?;
      builder.push(&kind.name, &owner, &id, revision, &properties, &kind.columns, kind.classification.as_deref(), &request.ranks);
      objects += 1;
      if builder.len == BATCH { batches.push(builder.finish(table.clone())?); builder = ObjectBuilder::new(&kind.columns, kind.classification.is_some()); }
    }
    if builder.len > 0 || batches.is_empty() { batches.push(builder.finish(table.clone())?); }
    bytes += batches.iter().map(RecordBatch::get_array_memory_size).sum::<usize>();
    let memory = MemTable::try_new(table.clone(), spread(batches, parts)).map_err(internal)?;
    ctx.register_table(object_table(&kind.name), Arc::new(memory)).map_err(internal)?;
    kinds.insert(kind.name.clone(), kind.columns.iter().map(|c| (c.name.clone(), c.kind)).collect());
  }
  let edge_schema: SchemaRef = Arc::new(Schema::new(vec![Field::new("$owner", DataType::Utf8, false),
    Field::new("from_id", DataType::Utf8, false), Field::new("to_id", DataType::Utf8, false)]));
  let mut by_link: HashMap<String, (StringBuilder, StringBuilder, StringBuilder, Vec<RecordBatch>, usize)> = HashMap::new();
  for link in &request.links { by_link.insert(link.clone(), (StringBuilder::new(), StringBuilder::new(), StringBuilder::new(), Vec::new(), 0)); }
  let sql = format!("SELECT owner, type, from_id, to_id FROM {schema}.links WHERE projection::text=$1");
  let params: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = vec![&request.projection];
  let rows = client.query_raw(sql.as_str(), params).await.map_err(internal)?;
  pin_mut!(rows);
  while let Some(row) = rows.try_next().await.map_err(internal)? {
    let link: String = row.get(1);
    let Some(entry) = by_link.get_mut(&link) else { continue };
    entry.0.append_value(row.get::<_, &str>(0));
    entry.1.append_value(row.get::<_, &str>(2));
    entry.2.append_value(row.get::<_, &str>(3));
    entry.4 += 1;
    edges += 1;
    if entry.4 == BATCH {
      let batch = RecordBatch::try_new(edge_schema.clone(), vec![Arc::new(entry.0.finish()) as ArrayRef, Arc::new(entry.1.finish()), Arc::new(entry.2.finish())]).map_err(internal)?;
      entry.3.push(batch);
      entry.4 = 0;
    }
  }
  for (link, mut entry) in by_link {
    if entry.4 > 0 || entry.3.is_empty() {
      let batch = RecordBatch::try_new(edge_schema.clone(), vec![Arc::new(entry.0.finish()) as ArrayRef, Arc::new(entry.1.finish()), Arc::new(entry.2.finish())]).map_err(internal)?;
      entry.3.push(batch);
    }
    bytes += entry.3.iter().map(RecordBatch::get_array_memory_size).sum::<usize>();
    let memory = MemTable::try_new(edge_schema.clone(), spread(entry.3, parts)).map_err(internal)?;
    ctx.register_table(edge_table(&link), Arc::new(memory)).map_err(internal)?;
  }
  Ok(Snapshot { ctx, kinds, classified, links: request.links, objects, edges, bytes })
}

enum ValueBuilder { String(StringBuilder), Integer(Int64Builder), Number(Float64Builder), Boolean(BooleanBuilder), Strings(ListBuilder<StringBuilder>) }

struct ObjectBuilder { owner: StringBuilder, id: StringBuilder, key: StringBuilder, revision: Int64Builder, values: Vec<ValueBuilder>,
  label: Option<(Int64Builder, ListBuilder<StringBuilder>)>, len: usize }

impl ObjectBuilder {
  fn new(columns: &[ColumnDef], classified: bool) -> Self {
    let values = columns.iter().map(|c| match c.kind {
      Kind::String => ValueBuilder::String(StringBuilder::new()), Kind::Integer => ValueBuilder::Integer(Int64Builder::new()),
      Kind::Number => ValueBuilder::Number(Float64Builder::new()), Kind::Boolean => ValueBuilder::Boolean(BooleanBuilder::new()),
      Kind::Strings => ValueBuilder::Strings(ListBuilder::new(StringBuilder::new())),
    }).collect();
    Self { owner: StringBuilder::new(), id: StringBuilder::new(), key: StringBuilder::new(), revision: Int64Builder::new(), values,
      label: classified.then(|| (Int64Builder::new(), ListBuilder::new(StringBuilder::new()))), len: 0 }
  }
  fn push(&mut self, kind: &str, owner: &str, id: &str, revision: i64, properties: &Value, columns: &[ColumnDef],
    classification: Option<&str>, ranks: &HashMap<String, i64>) {
    self.owner.append_value(owner);
    self.id.append_value(id);
    self.key.append_value(ref_key(kind, id));
    self.revision.append_value(revision);
    for (builder, c) in self.values.iter_mut().zip(columns) {
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
    if let (Some((rank, compartments)), Some(name)) = (self.label.as_mut(), classification) {
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
    let mut arrays: Vec<ArrayRef> = vec![Arc::new(self.owner.finish()), Arc::new(self.id.finish()), Arc::new(self.key.finish()), Arc::new(self.revision.finish())];
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

#[derive(Deserialize)]
struct Move { source: String, link: String, forward: bool, target: String, filter: Option<Predicate> }

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum SetNode {
  Empty,
  Scan { r#type: String, filter: Option<Predicate> },
  Refs { refs: Vec<Reference> },
  Union { sets: Vec<SetNode> },
  Intersect { sets: Vec<SetNode> },
  Except { left: Box<SetNode>, right: Box<SetNode> },
  /// Each step lists one move per possible source type; a set's objects of other types do not continue.
  Traverse { set: Box<SetNode>, steps: Vec<Vec<Move>> },
}

#[derive(Deserialize)]
struct Metric { name: String, op: String, column: Option<String> }

/// A field an aggregation reads through a mask: hidden for every row, or shown only where a cell policy permits.
#[derive(Deserialize)]
struct Mask { column: String, hidden: bool, policy: Option<Predicate> }

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Output {
  Page { offset: usize, limit: usize },
  #[serde(rename_all = "camelCase")]
  Aggregate { r#type: String, group_by: Vec<String>, metrics: Vec<Metric>, #[serde(default)] masks: Vec<Mask> },
}

/// What one member type reports: the ids of every member when its rows are tracked, and the markings its members carry.
#[derive(Deserialize)]
struct MemberSpec { r#type: String, #[serde(default)] track: bool, markings: Option<String> }

#[derive(Deserialize)]
struct QueryRequest { owner: String, set: SetNode, output: Output, #[serde(default)] members: Vec<MemberSpec>,
  #[serde(default)] rows: HashMap<String, Predicate> }

/// The owner a query reads and the row predicate of each type, applied to every read of that type's table.
struct Ctx { owner: String, rows: HashMap<String, Predicate> }

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

async fn objects(snapshot: &Snapshot, owner: &Ctx, kind: &str, filter: Option<&Predicate>) -> Result<DataFrame, Failure> {
  let kinds = snapshot.kinds.get(kind).ok_or_else(|| invalid(format!("Type {kind} is not loaded")))?;
  let mut frame = snapshot.ctx.table(object_table(kind)).await.map_err(internal)?.filter(column("$owner").eq(lit(owner.owner.clone()))).map_err(internal)?;
  if let Some(rows) = owner.rows.get(kind) { frame = frame.filter(predicate(rows, kinds)?).map_err(internal)?; }
  if let Some(p) = filter { frame = frame.filter(predicate(p, kinds)?).map_err(internal)?; }
  Ok(frame)
}

fn as_refs(frame: DataFrame, kind: &str) -> Result<DataFrame, Failure> {
  frame.select(vec![lit(kind.to_string()).alias("$type"), column("$id"), column("$key")]).map_err(internal)
}

fn distinct_union(ctx: &SessionContext, frames: Vec<DataFrame>) -> Result<DataFrame, Failure> {
  let mut iter = frames.into_iter();
  let Some(first) = iter.next() else { return refs_frame(ctx, &[]) };
  iter.try_fold(first, |acc, next| acc.union(next)).map_err(internal)?.distinct().map_err(internal)
}

fn set_frame<'a>(snapshot: &'a Snapshot, owner: &'a Ctx, node: &'a SetNode) -> futures_util::future::BoxFuture<'a, Result<DataFrame, Failure>> {
  Box::pin(async move {
    let ctx = &snapshot.ctx;
    match node {
      SetNode::Empty => refs_frame(ctx, &[]),
      SetNode::Scan { r#type, filter } => as_refs(objects(snapshot, owner, r#type, filter.as_ref()).await?, r#type),
      SetNode::Refs { refs } => {
        // Only references to existing objects of loaded types remain.
        let mut by_type: HashMap<&str, Vec<(String, String)>> = HashMap::new();
        for r in refs { if snapshot.kinds.contains_key(&r.r#type) { by_type.entry(&r.r#type).or_default().push((r.r#type.clone(), r.id.clone())); } }
        let mut frames = Vec::new();
        for (kind, items) in by_type {
          let wanted = refs_frame(ctx, &items)?.select(vec![column("$id").alias("wanted")]).map_err(internal)?;
          let existing = objects(snapshot, owner, kind, None).await?.join(wanted, JoinType::LeftSemi, &["$id"], &["wanted"], None).map_err(internal)?;
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
        let mut iter = sets.iter();
        let first = iter.next().ok_or_else(|| invalid("Empty intersection"))?;
        let mut frame = set_frame(snapshot, owner, first).await?;
        for s in iter { frame = frame.intersect(set_frame(snapshot, owner, s).await?).map_err(internal)?; }
        frame.distinct().map_err(internal)
      }
      SetNode::Except { left, right } => set_frame(snapshot, owner, left).await?
        .except(set_frame(snapshot, owner, right).await?).map_err(internal)?.distinct().map_err(internal),
      SetNode::Traverse { set, steps } => {
        let mut current = set_frame(snapshot, owner, set).await?;
        for step in steps {
          let mut frames = Vec::new();
          for m in step {
            if !snapshot.links.contains(&m.link) { return Err(invalid(format!("Link {} is not loaded", m.link))); }
            let sources = current.clone().filter(column("$type").eq(lit(m.source.clone()))).map_err(internal)?
              .select(vec![column("$id").alias("source")]).map_err(internal)?;
            let (from, to) = if m.forward { ("from_id", "to_id") } else { ("to_id", "from_id") };
            let edges = ctx.table(edge_table(&m.link)).await.map_err(internal)?.filter(column("$owner").eq(lit(owner.owner.clone()))).map_err(internal)?
              .join(sources, JoinType::LeftSemi, &[from], &["source"], None).map_err(internal)?
              .select(vec![column(to).alias("target")]).map_err(internal)?;
            let targets = objects(snapshot, owner, &m.target, m.filter.as_ref()).await?
              .join(edges, JoinType::LeftSemi, &["$id"], &["target"], None).map_err(internal)?;
            frames.push(as_refs(targets, &m.target)?);
          }
          current = distinct_union(ctx, frames)?;
        }
        Ok(current)
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

/**
 * For each requested type present in the set: how many members it has and, for a classified type, the highest row
 * sensitivity rank and every compartment its members carry. The caller observes the combined label, as the reference
 * observes each member it reads.
 */
/// The distinct strings of a string-list column over `frame`'s rows, sorted.
async fn distinct_strings(frame: DataFrame, name: &str) -> Result<Vec<String>, Failure> {
  let values = rows(frame.filter(column(name).is_not_null()).map_err(internal)?.select(vec![column(name)]).map_err(internal)?.distinct().map_err(internal)?).await?;
  let mut out: Vec<String> = values.iter().flat_map(|row| row[name].as_array().cloned().unwrap_or_default())
    .filter_map(|item| item.as_str().map(String::from)).collect();
  out.sort();
  out.dedup();
  Ok(out)
}

/// The most member ids a tracked type reports, the reference's complete-evaluation limit.
const TRACKED: usize = 10000;

/**
 * For each requested type present in the set: how many members it has; for a classified type, the highest row
 * sensitivity rank and every compartment; for a tracked (policy-bound) type, every member id, or `overLimit`; and the
 * markings its members carry. The caller records these as the reference does for each member it reads.
 */
async fn members(snapshot: &Snapshot, owner: &Ctx, set: &DataFrame, specs: &[MemberSpec]) -> Result<Vec<Value>, Failure> {
  let mut out = Vec::new();
  for spec in specs {
    let kind = &spec.r#type;
    if !snapshot.kinds.contains_key(kind) { continue; }
    let ids = set.clone().filter(column("$type").eq(lit(kind.clone()))).map_err(internal)?.select(vec![column("$id").alias("member")]).map_err(internal)?;
    let rows_frame = objects(snapshot, owner, kind, None).await?.join(ids, JoinType::LeftSemi, &["$id"], &["member"], None).map_err(internal)?;
    let mut entry = serde_json::Map::new();
    let total = if snapshot.classified.contains(kind) {
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
      if snapshot.kinds.get(kind).and_then(|k| k.get(name)) != Some(&Kind::Strings) { return Err(invalid(format!("{name} is not a string list"))); }
      entry.insert("markings".into(), json!(distinct_strings(rows_frame, name).await?));
    }
    out.push(Value::Object(entry));
  }
  Ok(out)
}

async fn query(snapshot: &Snapshot, request: QueryRequest) -> Result<Value, Failure> {
  let started = Instant::now();
  // The set is computed once and reused by the page, the total and the member statistics.
  let owner = Ctx { owner: request.owner.clone(), rows: request.rows };
  let set = set_frame(snapshot, &owner, &request.set).await?.cache().await.map_err(internal)?;
  let observed = members(snapshot, &owner, &set, &request.members).await?;
  match request.output {
    Output::Page { offset, limit } => {
      let total = set.clone().count().await.map_err(internal)?;
      let page = set.sort(vec![column("$key").sort(true, false)]).map_err(internal)?
        .limit(offset, Some(limit)).map_err(internal)?.select(vec![column("$type"), column("$id")]).map_err(internal)?;
      let refs: Vec<Value> = rows(page).await?.into_iter().map(|row| json!({ "type": row["$type"], "id": row["$id"] })).collect();
      Ok(json!({ "total": total, "refs": refs, "members": observed, "elapsedMs": started.elapsed().as_secs_f64() * 1000.0 }))
    }
    Output::Aggregate { r#type, group_by, metrics, masks } => {
      let kinds = snapshot.kinds.get(&r#type).ok_or_else(|| invalid(format!("Type {} is not loaded", r#type)))?;
      let members = set.filter(column("$type").eq(lit(r#type.clone()))).map_err(internal)?.select(vec![column("$id").alias("member")]).map_err(internal)?;
      let mut objects = objects(snapshot, &owner, &r#type, None).await?.join(members, JoinType::LeftSemi, &["$id"], &["member"], None).map_err(internal)?;
      // Masked fields read as the reference shows them: hidden fields are null, and a cell policy keeps the value only where it permits.
      if !masks.is_empty() {
        let mut projection = vec![column("$key")];
        for name in kinds.keys() {
          let null = || ScalarValue::try_from(&data_type(kinds[name])).map(lit).map_err(internal);
          let value = match masks.iter().find(|m| &m.column == name) {
            None => column(name),
            Some(mask) if mask.hidden => null()?,
            Some(Mask { policy: Some(policy), .. }) => when(predicate(policy, kinds)?, column(name)).otherwise(null()?).map_err(internal)?,
            Some(_) => column(name),
          };
          projection.push(value.alias(name.clone()));
        }
        objects = objects.select(projection).map_err(internal)?;
      }
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
      Ok(json!({ "count": total, "items": items, "members": observed, "elapsedMs": started.elapsed().as_secs_f64() * 1000.0 }))
    }
  }
}

async fn health(State(state): State<Shared>) -> Json<Value> {
  let snapshot = state.read().await;
  Json(match snapshot.as_ref() {
    Some(s) => json!({ "status": "ok", "loaded": true, "objects": s.objects, "edges": s.edges }),
    None => json!({ "status": "ok", "loaded": false }),
  })
}

async fn load_route(State(state): State<Shared>, Json(request): Json<LoadRequest>) -> Result<Json<Value>, Failure> {
  let started = Instant::now();
  let snapshot = load(request).await?;
  let summary = json!({ "objects": snapshot.objects, "edges": snapshot.edges, "bytes": snapshot.bytes, "elapsedMs": started.elapsed().as_secs_f64() * 1000.0 });
  *state.write().await = Some(snapshot);
  Ok(Json(summary))
}

async fn query_route(State(state): State<Shared>, Json(request): Json<QueryRequest>) -> Result<Json<Value>, Failure> {
  let snapshot = state.read().await;
  let snapshot = snapshot.as_ref().ok_or_else(|| failure(StatusCode::SERVICE_UNAVAILABLE, "No projection is loaded"))?;
  Ok(Json(query(snapshot, request).await?))
}

#[tokio::main]
async fn main() {
  // Loopback only: the kernel holds every owner's data of the projection and has no authentication of its own.
  let port: u16 = std::env::var("EIGOS_KERNEL_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(0);
  let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port))).await.expect("bind loopback");
  println!("{}", json!({ "event": "kernel_listening", "port": listener.local_addr().unwrap().port() }));
  let state: Shared = Arc::new(RwLock::new(None));
  let app = Router::new().route("/health", get(health)).route("/load", post(load_route)).route("/query", post(query_route))
    .layer(axum::extract::DefaultBodyLimit::max(64 * 1024 * 1024)).with_state(state);
  axum::serve(listener, app).await.expect("serve");
}
