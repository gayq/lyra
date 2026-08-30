#[derive(Clone)]
pub struct IsaoConfig {
    pub port: u16,
}

impl IsaoConfig {
    pub fn from_env() -> Self {
        let port = std::env::var("ISAO_PORT")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(4003);

        Self { port }
    }
}
