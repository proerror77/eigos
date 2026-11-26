//! The commit log archive codec (platform plan, "提交日志保留"). It turns rows of `edit_history`, `link_history` or
//! `change_commits` into Parquet files and reads them back, with DataFusion as the query kernel does. Every value
//! travels as a string or null: integers as decimal text, times as `YYYY-MM-DDTHH:MM:SS.ffffffZ`, and JSON columns as
//! their JSON text, so a row read back is byte for byte the row written. Which rows to archive, the verification, the
//! manifest and the deletion belong to the runtime (`packages/runtime/log-retention.ts`).
//!
//! ```text
//! eigos-archive write <table> <file.parquet>          NDJSON rows on stdin; prints {"rows": n}
//! eigos-archive read <table> <filter-json> <file>...  NDJSON rows on stdout, in history or commit order
//! ```

use std::io::{BufRead, Write};
use std::sync::Arc;

use datafusion::arrow::array::{Array, ArrayRef, Int64Array, Int64Builder, StringArray, StringBuilder, TimestampMicrosecondArray, TimestampMicrosecondBuilder};
use datafusion::arrow::datatypes::{DataType, Field, Schema, SchemaRef, TimeUnit};
use datafusion::arrow::record_batch::RecordBatch;
use datafusion::parquet::arrow::ArrowWriter;
use datafusion::parquet::basic::{Compression, ZstdLevel};
use datafusion::parquet::file::properties::WriterProperties;
use datafusion::prelude::{col, lit, ParquetReadOptions, SessionContext};
use datafusion::scalar::ScalarValue;
use serde_json::{Map, Value};

#[derive(Clone, Copy, PartialEq)]
enum Kind { Int, Text, Time, Json }
use Kind::*;

/// The columns of each archived table, in the order of the PostgreSQL tables, with whether they may be null.
fn columns(table: &str) -> Option<&'static [(&'static str, Kind, bool)]> {
    const EDIT_HISTORY: &[(&str, Kind, bool)] = &[
        ("sequence", Int, false), ("projection", Text, false), ("release", Text, false), ("owner", Text, false),
        ("type", Text, false), ("id", Text, false), ("operation", Text, false), ("source", Text, true),
        ("before_values", Json, true), ("after_values", Json, true), ("actor", Text, false), ("happened_at", Time, false),
        ("action", Text, true), ("request_id", Text, true), ("task_id", Text, true), ("observed_at", Time, true),
        ("executor_kind", Text, true), ("executor_id", Text, true), ("xact", Text, true), ("commit_seq", Int, true),
    ];
    const LINK_HISTORY: &[(&str, Kind, bool)] = &[
        ("sequence", Int, false), ("projection", Text, false), ("release", Text, false), ("owner", Text, false),
        ("type", Text, false), ("from_type", Text, false), ("from_id", Text, false), ("to_type", Text, false),
        ("to_id", Text, false), ("operation", Text, false), ("source", Text, true), ("actor", Text, false),
        ("action", Text, true), ("request_id", Text, true), ("task_id", Text, true), ("executor_kind", Text, true),
        ("executor_id", Text, true), ("happened_at", Time, false), ("xact", Text, false), ("commit_seq", Int, true),
    ];
    const CHANGE_COMMITS: &[(&str, Kind, bool)] = &[
        ("owner", Text, false), ("xact", Text, false), ("commit_seq", Int, false), ("committed_at", Time, false),
    ];
    match table { "edit_history" => Some(EDIT_HISTORY), "link_history" => Some(LINK_HISTORY), "change_commits" => Some(CHANGE_COMMITS), _ => None }
}

fn schema(table: &str) -> SchemaRef {
    Arc::new(Schema::new(columns(table).unwrap().iter().map(|(name, kind, nullable)| Field::new(*name, match kind {
        Int => DataType::Int64,
        Text | Json => DataType::Utf8,
        Time => DataType::Timestamp(TimeUnit::Microsecond, Some("UTC".into())),
    }, *nullable)).collect::<Vec<_>>()))
}

fn fail(message: impl std::fmt::Display) -> ! {
    eprintln!("{}", serde_json::json!({ "error": message.to_string() }));
    std::process::exit(1)
}

/// Microseconds since the epoch of `YYYY-MM-DDTHH:MM:SS[.ffffff]Z`.
fn parse_time(text: &str) -> Option<i64> {
    let text = text.strip_suffix('Z')?;
    let (date, time) = text.split_once('T')?;
    let mut date = date.split('-').map(|part| part.parse::<i64>());
    let (year, month, day) = (date.next()?.ok()?, date.next()?.ok()?, date.next()?.ok()?);
    let (clock, fraction) = time.split_once('.').unwrap_or((time, ""));
    let mut clock = clock.split(':').map(|part| part.parse::<i64>());
    let (hour, minute, second) = (clock.next()?.ok()?, clock.next()?.ok()?, clock.next()?.ok()?);
    if fraction.len() > 6 || !fraction.bytes().all(|b| b.is_ascii_digit()) || !(1..=12).contains(&month) || !(1..=31).contains(&day) { return None; }
    let micros = if fraction.is_empty() { 0 } else { format!("{fraction:0<6}").parse::<i64>().ok()? };
    // Days from the civil date (Howard Hinnant's algorithm).
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some(((days * 86400 + hour * 3600 + minute * 60 + second) * 1_000_000) + micros)
}

fn format_time(micros: i64) -> String {
    let (seconds, fraction) = (micros.div_euclid(1_000_000), micros.rem_euclid(1_000_000));
    let (days, rest) = (seconds.div_euclid(86400), seconds.rem_euclid(86400));
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + if month <= 2 { 1 } else { 0 };
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{fraction:06}Z", rest / 3600, rest % 3600 / 60, rest % 60)
}

/// Builders for one batch of a table's columns.
enum Builder { Int(Int64Builder), Text(StringBuilder), Time(TimestampMicrosecondBuilder) }

fn batch(table: &str, rows: &[Map<String, Value>]) -> RecordBatch {
    let specs = columns(table).unwrap();
    let mut builders: Vec<Builder> = specs.iter().map(|(_, kind, _)| match kind {
        Int => Builder::Int(Int64Builder::with_capacity(rows.len())),
        Text | Json => Builder::Text(StringBuilder::with_capacity(rows.len(), rows.len() * 32)),
        Time => Builder::Time(TimestampMicrosecondBuilder::with_capacity(rows.len()).with_timezone("UTC")),
    }).collect();
    for (index, row) in rows.iter().enumerate() {
        if row.len() != specs.len() { fail(format!("row {index} has {} columns, {table} has {}", row.len(), specs.len())); }
        for ((name, kind, nullable), builder) in specs.iter().zip(builders.iter_mut()) {
            let value = match row.get(*name) {
                Some(Value::Null) if *nullable => None,
                Some(Value::String(text)) => Some(text.as_str()),
                _ => fail(format!("row {index}: {name} must be a string{}", if *nullable { " or null" } else { "" })),
            };
            match (builder, value) {
                (Builder::Int(b), Some(text)) => b.append_value(text.parse().unwrap_or_else(|_| fail(format!("row {index}: {name} is not an integer")))),
                (Builder::Text(b), Some(text)) => {
                    if *kind == Json && serde_json::from_str::<Value>(text).is_err() { fail(format!("row {index}: {name} is not JSON")); }
                    b.append_value(text)
                }
                (Builder::Time(b), Some(text)) => b.append_value(parse_time(text).unwrap_or_else(|| fail(format!("row {index}: {name} is not a UTC time")))),
                (Builder::Int(b), None) => b.append_null(),
                (Builder::Text(b), None) => b.append_null(),
                (Builder::Time(b), None) => b.append_null(),
            }
        }
    }
    let arrays: Vec<ArrayRef> = builders.into_iter().map(|builder| match builder {
        Builder::Int(mut b) => Arc::new(b.finish()) as ArrayRef,
        Builder::Text(mut b) => Arc::new(b.finish()) as ArrayRef,
        Builder::Time(mut b) => Arc::new(b.finish()) as ArrayRef,
    }).collect();
    RecordBatch::try_new(schema(table), arrays).unwrap_or_else(|e| fail(e))
}

fn write(table: &str, path: &str) {
    let file = std::fs::File::create_new(path).unwrap_or_else(|e| fail(format!("cannot create {path}: {e}")));
    let properties = WriterProperties::builder().set_compression(Compression::ZSTD(ZstdLevel::default())).build();
    let mut writer = ArrowWriter::try_new(file, schema(table), Some(properties)).unwrap_or_else(|e| fail(e));
    let (mut rows, mut pending) = (0usize, Vec::with_capacity(8192));
    for line in std::io::stdin().lock().lines() {
        let line = line.unwrap_or_else(|e| fail(e));
        if line.is_empty() { continue; }
        match serde_json::from_str::<Value>(&line) {
            Ok(Value::Object(row)) => pending.push(row),
            _ => fail(format!("line {} is not a JSON object", rows + pending.len() + 1)),
        }
        if pending.len() == 8192 {
            writer.write(&batch(table, &pending)).unwrap_or_else(|e| fail(e));
            rows += pending.len();
            pending.clear();
        }
    }
    if !pending.is_empty() { writer.write(&batch(table, &pending)).unwrap_or_else(|e| fail(e)); rows += pending.len(); }
    writer.close().unwrap_or_else(|e| fail(e));
    println!("{}", serde_json::json!({ "rows": rows }));
}

fn text(filter: &Map<String, Value>, key: &str) -> Option<String> {
    match filter.get(key) {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) => Some(value.clone()),
        Some(_) => fail(format!("filter {key} must be a string")),
    }
}

async fn read(table: &str, filter: &str, files: &[String]) {
    let filter: Map<String, Value> = serde_json::from_str(filter).unwrap_or_else(|e| fail(format!("filter: {e}")));
    let known = ["owner", "type", "id", "fromType", "fromId", "toType", "toId", "requestId", "taskId", "after", "from", "to", "limit"];
    if let Some(unknown) = filter.keys().find(|key| !known.contains(&key.as_str())) { fail(format!("unknown filter {unknown}")); }
    let ctx = SessionContext::new();
    let order = if table == "change_commits" { "commit_seq" } else { "sequence" };
    let time = if table == "change_commits" { "committed_at" } else { "happened_at" };
    let mut frames = Vec::new();
    for file in files {
        frames.push(ctx.read_parquet(file.as_str(), ParquetReadOptions::default()).await.unwrap_or_else(|e| fail(format!("{file}: {e}"))));
    }
    let Some(mut frame) = frames.pop() else { return };
    for other in frames { frame = frame.union(other).unwrap_or_else(|e| fail(e)); }
    for (key, column) in [("owner", "owner"), ("type", "type"), ("id", "id"), ("fromType", "from_type"), ("fromId", "from_id"),
        ("toType", "to_type"), ("toId", "to_id"), ("requestId", "request_id"), ("taskId", "task_id")] {
        if let Some(value) = text(&filter, key) { frame = frame.filter(col(column).eq(lit(value))).unwrap_or_else(|e| fail(e)); }
    }
    if let Some(after) = text(&filter, "after") {
        let after: i64 = after.parse().unwrap_or_else(|_| fail("filter after must be an integer"));
        frame = frame.filter(col(order).gt(lit(after))).unwrap_or_else(|e| fail(e));
    }
    for (key, inclusive) in [("from", true), ("to", false)] {
        if let Some(value) = text(&filter, key) {
            let at = parse_time(&value).unwrap_or_else(|| fail(format!("filter {key} must be a UTC time")));
            let bound = lit(ScalarValue::TimestampMicrosecond(Some(at), Some("UTC".into())));
            frame = frame.filter(if inclusive { col(time).gt_eq(bound) } else { col(time).lt(bound) }).unwrap_or_else(|e| fail(e));
        }
    }
    frame = frame.sort(vec![col(order).sort(true, false)]).unwrap_or_else(|e| fail(e));
    if let Some(limit) = text(&filter, "limit") {
        frame = frame.limit(0, Some(limit.parse().unwrap_or_else(|_| fail("filter limit must be an integer")))).unwrap_or_else(|e| fail(e));
    }
    let (specs, expected) = (columns(table).unwrap(), schema(table));
    let mut out = std::io::BufWriter::new(std::io::stdout().lock());
    for batch in frame.collect().await.unwrap_or_else(|e| fail(e)) {
        // DataFusion reads Parquet strings as string views; cast each column back to the archive's own type.
        let cast: Vec<ArrayRef> = expected.fields().iter().map(|field| {
            let column = batch.column_by_name(field.name()).unwrap_or_else(|| fail(format!("the file has no column {}", field.name())));
            datafusion::arrow::compute::cast(column, field.data_type()).unwrap_or_else(|e| fail(e))
        }).collect();
        for row in 0..batch.num_rows() {
            let mut object = Map::new();
            for (index, (name, kind, _)) in specs.iter().enumerate() {
                let column = &cast[index];
                let value = if column.is_null(row) { Value::Null } else { Value::String(match kind {
                    Int => column.as_any().downcast_ref::<Int64Array>().unwrap().value(row).to_string(),
                    Text | Json => column.as_any().downcast_ref::<StringArray>().unwrap().value(row).to_string(),
                    Time => format_time(column.as_any().downcast_ref::<TimestampMicrosecondArray>().unwrap().value(row)),
                }) };
                object.insert((*name).to_string(), value);
            }
            serde_json::to_writer(&mut out, &Value::Object(object)).unwrap_or_else(|e| fail(e));
            out.write_all(b"\n").unwrap_or_else(|e| fail(e));
        }
    }
    out.flush().unwrap_or_else(|e| fail(e));
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [mode, table, path] if mode == "write" && columns(table).is_some() => write(table, path),
        [mode, table, filter, files @ ..] if mode == "read" && columns(table).is_some() => read(table, filter, files).await,
        _ => fail("usage: eigos-archive write <edit_history|link_history|change_commits> <file> | read <table> <filter-json> <file>..."),
    }
}
