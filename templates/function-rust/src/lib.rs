//! An EIGOS Function in Rust: JSON input in, JSON output out. See README.md for building and publishing it.
wit_bindgen::generate!({ world: "handler", path: "wit", generate_all });

use serde::{Deserialize, Serialize};

/// The Function's input, as the `parameters` schema of its definition describes it.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    values: Vec<f64>,
}

/// The Function's output, as the `returns` schema of its definition describes it.
#[derive(Serialize)]
struct Output {
    sum: f64,
    count: usize,
}

fn run(input: Input) -> Result<Output, Failure> {
    if input.values.is_empty() {
        return Err(fail("empty", "Give at least one value"));
    }
    Ok(Output { sum: input.values.iter().sum(), count: input.values.len() })
}

/// A failure for the caller: a stable code it can act on, and a message for people.
fn fail(code: &str, message: impl Into<String>) -> Failure {
    Failure { code: code.into(), message: message.into() }
}

struct Function;

impl Guest for Function {
    fn invoke(input: String) -> Result<String, Failure> {
        let input = serde_json::from_str(&input).map_err(|error| fail("invalid-input", error.to_string()))?;
        serde_json::to_string(&run(input)?).map_err(|error| fail("invalid-output", error.to_string()))
    }
}

export!(Function);
