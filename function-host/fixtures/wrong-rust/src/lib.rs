// Test component for the function host: it exports `invoke` with another type than the EIGOS world's, so the host
// must refuse it.
wit_bindgen::generate!({ inline: "package test:wrong; world wrong { export invoke: func(input: string) -> string; }" });

struct Function;

impl Guest for Function {
    fn invoke(input: String) -> String { input }
}

export!(Function);
