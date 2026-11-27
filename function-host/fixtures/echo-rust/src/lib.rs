// Test component for the function host. It echoes its input, or on request returns a given answer, spins, allocates,
// writes a long output, writes to stderr, fails or panics.
wit_bindgen::generate!({ world: "handler", path: "../../wit", generate_all });

struct Function;

/// The number after `"key":` in the input, if any. The tests send flat JSON objects.
fn number(input: &str, key: &str) -> Option<u64> {
    let at = input.find(&format!("\"{key}\""))? + key.len() + 2;
    let rest = input[at..].trim_start_matches([' ', ':']);
    rest.chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().ok()
}

/// The JSON value after `"answer":`, up to the input's last `}`.
fn answer(input: &str) -> Option<&str> {
    let at = input.find("\"answer\"")? + "\"answer\"".len();
    let rest = input[at..].trim_start().strip_prefix(':')?;
    Some(rest[..rest.rfind('}')?].trim())
}

/// `{"ontology": {"op": "get" | "follow" | "query" | "evaluate" | "aggregate", "args": [...], "times"?: n}}` calls the
/// host's Ontology `times` times and returns `{"result": <the last answer>}`, or the host's failure.
fn ontology(input: &str) -> Option<Result<String, Failure>> {
    let value: serde_json::Value = serde_json::from_str(input).ok()?;
    let request = value.get("ontology")?;
    let op = request.get("op")?.as_str()?;
    let args: Vec<String> = request.get("args")?.as_array()?.iter()
        .map(|arg| arg.as_str().map(str::to_string).unwrap_or_else(|| arg.to_string())).collect();
    let arg = |index: usize| args.get(index).cloned().unwrap_or_default();
    let times = request.get("times").and_then(|n| n.as_u64()).unwrap_or(1);
    let mut last = None;
    for _ in 0..times {
        let answer = match op {
            "get" => eigos::function::ontology::get(&arg(0), &arg(1)),
            "outgoing" => eigos::http::outgoing::send(&arg(0)).map(Some)
                .map_err(|failure| Failure { code: failure.code, message: failure.message }),
            "follow" => eigos::function::ontology::follow(&arg(0), &arg(1)).map(Some),
            "query" => eigos::function::ontology::query(&arg(0)).map(Some),
            "evaluate" => eigos::function::ontology::evaluate(&arg(0)).map(Some),
            "aggregate" => eigos::function::ontology::aggregate(&arg(0)).map(Some),
            _ => return Some(Err(Failure { code: "invalid".into(), message: format!("unknown operation {op}") })),
        };
        match answer { Ok(answer) => last = answer, Err(failure) => return Some(Err(failure)) }
    }
    Some(Ok(format!("{{\"result\":{}}}", last.unwrap_or_else(|| "null".into()))))
}

/// `{"script": [{"op", "args", "expect"?: {"pointer", "equals"}}, …], "return": <json>}` runs Ontology calls in order. A
/// read with `expect` fails the call unless the JSON at `pointer` in its answer equals `equals`. The call returns `return`.
fn script(input: &str) -> Option<Result<String, Failure>> {
    let value: serde_json::Value = serde_json::from_str(input).ok()?;
    let steps = value.get("script")?.as_array()?;
    let fail = |code: &str, message: String| Failure { code: code.into(), message };
    for (index, step) in steps.iter().enumerate() {
        let op = step.get("op").and_then(|op| op.as_str()).unwrap_or_default();
        let args: Vec<String> = step.get("args").and_then(|args| args.as_array()).cloned().unwrap_or_default().iter()
            .map(|arg| arg.as_str().map(str::to_string).unwrap_or_else(|| arg.to_string())).collect();
        let arg = |n: usize| args.get(n).cloned().unwrap_or_default();
        use eigos::function::ontology as o;
        let answer = match op {
            "get" => o::get(&arg(0), &arg(1)),
            "follow" => o::follow(&arg(0), &arg(1)).map(Some),
            "query" => o::query(&arg(0)).map(Some),
            "evaluate" => o::evaluate(&arg(0)).map(Some),
            "aggregate" => o::aggregate(&arg(0)).map(Some),
            "create" => o::create(&arg(0), &arg(1), &arg(2)).map(|_| None),
            "update" => o::update(&arg(0), &arg(1)).map(|_| None),
            "delete" => o::delete(&arg(0)).map(|_| None),
            "link" => o::link(&arg(0), &arg(1), &arg(2)).map(|_| None),
            "unlink" => o::unlink(&arg(0), &arg(1), &arg(2)).map(|_| None),
            "fail" => return Some(Err(fail("asked", format!("step {index} asked to fail")))),
            _ => return Some(Err(fail("invalid", format!("step {index}: unknown operation {op}")))),
        };
        let answer = match answer { Ok(answer) => answer, Err(failure) => return Some(Err(failure)) };
        if let Some(expect) = step.get("expect") {
            let got: serde_json::Value = answer.as_deref().and_then(|text| serde_json::from_str(text).ok()).unwrap_or(serde_json::Value::Null);
            let pointer = expect.get("pointer").and_then(|p| p.as_str()).unwrap_or("");
            let found = got.pointer(pointer).cloned().unwrap_or(serde_json::Value::Null);
            if Some(&found) != expect.get("equals") {
                return Some(Err(fail("assertion", format!("step {index}: {pointer} is {found}, expected {}", expect.get("equals").cloned().unwrap_or_default()))));
            }
        }
    }
    Some(Ok(value.get("return").cloned().unwrap_or(serde_json::Value::Null).to_string()))
}

/// Recognizes the semantic search fixture's text without changing the ordinary echo contract.
fn embedding(input: &str) -> Option<&'static str> {
    let value: serde_json::Value = serde_json::from_str(input).ok()?;
    let text = value.get("text")?.as_str()?.strip_prefix("f5-vector: ")?;
    Some(if text.contains("north") { "[1,0]" } else { "[0,1]" })
}

impl Guest for Function {
    fn invoke(input: String) -> Result<String, Failure> {
        if let Some(result) = script(&input) { return result; }
        if let Some(result) = ontology(&input) { return result; }
        if let Some(value) = answer(&input) { return Ok(value.to_string()); }
        if let Some(vector) = embedding(&input) { return Ok(vector.to_string()); }
        if let Some(n) = number(&input, "spin") {
            let mut x: u64 = 0;
            for i in 0..n { x = x.wrapping_add(std::hint::black_box(i % 7)); }
            return Ok(format!("{{\"x\":{x}}}"));
        }
        if let Some(n) = number(&input, "allocate") {
            let chunks: Vec<Vec<u8>> = (0..n).map(|i| vec![i as u8; 1 << 20]).collect();
            return Ok(format!("{{\"chunks\":{}}}", chunks.len()));
        }
        if let Some(n) = number(&input, "repeat") { return Ok(format!("\"{}\"", "x".repeat(n as usize))); }
        if input.contains("\"log\"") { eprintln!("diagnostic line"); }
        if input.contains("\"fail\"") { return Err(Failure { code: "asked".into(), message: "asked to fail".into() }); }
        if input.contains("\"panic\"") { panic!("asked to panic"); }
        Ok(format!("{{\"echo\":{input}}}"))
    }
}

export!(Function);
