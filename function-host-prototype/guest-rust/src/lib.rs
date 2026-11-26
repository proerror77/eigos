// PROTOTYPE guest: the same three behaviours as the TypeScript guest, without a JSON library.
wit_bindgen::generate!({ world: "handler", path: "../wit" });

struct Function;

fn number(input: &str, key: &str) -> Option<u64> {
    let at = input.find(&format!("\"{key}\""))? + key.len() + 2;
    let rest = input[at..].trim_start_matches([' ', ':']);
    rest.chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().ok()
}

impl Guest for Function {
    fn invoke(input: String) -> Result<String, String> {
        if let Some(n) = number(&input, "spin") {
            let mut x: u64 = 0;
            for i in 0..n { x = x.wrapping_add(i % 7); }
            return Ok(format!("{{\"x\":{x}}}"));
        }
        if let Some(n) = number(&input, "allocate") {
            let mut chunks: Vec<Vec<u8>> = Vec::new();
            for i in 0..n { chunks.push(vec![i as u8; 1 << 20]); }
            return Ok(format!("{{\"chunks\":{}}}", chunks.len()));
        }
        if input.contains("\"fail\"") { return Err("asked to fail".into()); }
        Ok(format!("{{\"echo\":{input}}}"))
    }
}

export!(Function);
