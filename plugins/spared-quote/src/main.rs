use std::cell::RefCell;

use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use wstd::http::{Body, Error, Method, Request, Response, StatusCode};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PartnerQuote {
    label: String,
    price: String,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Quote {
    name: String,
    amount_minor: String,
    currency: &'static str,
}

thread_local! {
    static DATABASE: RefCell<Option<Connection>> = const { RefCell::new(None) };
}

fn amount_minor(price: &str) -> Option<String> {
    let price = price.trim();
    let price = price.strip_prefix(['¥', '￥']).unwrap_or(price);
    let price = price.strip_suffix('元').unwrap_or(price);
    let (whole, fractional) = match price.split_once('.') {
        Some((whole, fraction))
            if (1..=2).contains(&fraction.len())
                && fraction.bytes().all(|byte| byte.is_ascii_digit()) =>
        {
            let cents = fraction.parse::<u64>().ok()? * if fraction.len() == 1 { 10 } else { 1 };
            (whole, cents)
        }
        Some(_) => return None,
        None => (price, 0),
    };
    if !(1..=13).contains(&whole.len())
        || (whole.len() > 1 && whole.starts_with('0'))
        || !whole.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    Some((whole.parse::<u64>().ok()? * 100 + fractional).to_string())
}

fn normalize(raw: &PartnerQuote) -> Option<Quote> {
    let name = raw.label.trim();
    if name.is_empty() || raw.label.chars().count() > 120 || raw.price.chars().count() > 32 {
        return None;
    }
    Some(Quote {
        name: name.to_owned(),
        amount_minor: amount_minor(&raw.price)?,
        currency: "CNY",
    })
}

fn cached(database: &Connection, raw: &PartnerQuote) -> rusqlite::Result<Option<Quote>> {
    let found = database
        .query_row(
            "SELECT name, amount_minor FROM last_quote WHERE label = ?1 AND price = ?2",
            params![raw.label, raw.price],
            |row| {
                Ok(Quote {
                    name: row.get(0)?,
                    amount_minor: row.get(1)?,
                    currency: "CNY",
                })
            },
        )
        .optional()?;
    if let Some(previous) = found {
        return Ok(Some(previous));
    }
    let Some(quote) = normalize(raw) else {
        return Ok(None);
    };
    database.execute(
        "INSERT INTO last_quote (slot, label, price, name, amount_minor) VALUES (1, ?1, ?2, ?3, ?4)
         ON CONFLICT(slot) DO UPDATE SET label=excluded.label, price=excluded.price,
           name=excluded.name, amount_minor=excluded.amount_minor",
        params![raw.label, raw.price, quote.name, quote.amount_minor],
    )?;
    Ok(Some(quote))
}

fn store(raw: &PartnerQuote) -> rusqlite::Result<Option<Quote>> {
    DATABASE.with(|database| {
        let mut slot = database.borrow_mut();
        if slot.is_none() {
            let connection = Connection::open_with_flags_and_vfs(
                "/data/app.db",
                OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE,
                "unix-none",
            )?;
            let _: String = connection.query_row("PRAGMA journal_mode=TRUNCATE", [], |row| row.get(0))?;
            connection.execute_batch(
                "CREATE TABLE IF NOT EXISTS last_quote (
                   slot INTEGER PRIMARY KEY CHECK(slot = 1), label TEXT NOT NULL, price TEXT NOT NULL,
                   name TEXT NOT NULL, amount_minor TEXT NOT NULL)",
            )?;
            *slot = Some(connection);
        }
        cached(slot.as_ref().expect("initialized above"), raw)
    })
}

fn empty(status: StatusCode) -> Result<Response<Body>, Error> {
    Ok(Response::builder().status(status).body(Body::empty())?)
}

#[wstd::http_server]
async fn main(mut request: Request<Body>) -> Result<Response<Body>, Error> {
    if request.uri().path() != "/normalize" {
        return empty(StatusCode::NOT_FOUND);
    }
    if request.method() != Method::POST {
        return empty(StatusCode::METHOD_NOT_ALLOWED);
    }
    let Ok(raw) = request.body_mut().json::<PartnerQuote>().await else {
        return empty(StatusCode::BAD_REQUEST);
    };
    let quote = match store(&raw) {
        Ok(Some(quote)) => quote,
        Ok(None) => return empty(StatusCode::BAD_REQUEST),
        Err(_) => return empty(StatusCode::INTERNAL_SERVER_ERROR),
    };
    Ok(Response::builder()
        .header("content-type", "application/json")
        .body(Body::from_json(&quote)?)?)
}
