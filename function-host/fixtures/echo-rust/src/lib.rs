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

impl Guest for Function {
    fn invoke(input: String) -> Result<String, Failure> {
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
