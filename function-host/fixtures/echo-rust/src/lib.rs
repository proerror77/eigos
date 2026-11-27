// Test component for the function host. It echoes its input, or on request returns a given answer, spins, allocates,
// writes a long output, writes to stderr, fails or panics.
wit_bindgen::generate!({ world: "handler", path: "../../wit" });

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

impl Guest for Function {
    fn invoke(input: String) -> Result<String, Failure> {
        if let Some(result) = ontology(&input) { return result; }
        if let Some(value) = answer(&input) { return Ok(value.to_string()); }
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
