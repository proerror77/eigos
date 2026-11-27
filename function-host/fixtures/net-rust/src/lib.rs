// Test component for the function host: it opens a network connection, so it imports wasi:sockets and the host
// must refuse it.
wit_bindgen::generate!({ world: "handler", path: "../../wit", generate_all });

struct Function;

impl Guest for Function {
    fn invoke(input: String) -> Result<String, Failure> {
        std::net::TcpStream::connect(input.as_str()).map(|_| "connected".to_string()).map_err(|e| Failure { code: "io".into(), message: e.to_string() })
    }
}

export!(Function);
