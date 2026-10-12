#[derive(Clone)]
pub struct IsaoConfig {
    pub port: u16,
    pub host: std::net::IpAddr,
}

impl IsaoConfig {
    pub fn from_env() -> Self {
        let port = std::env::var("ISAO_PORT")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(4003);

        let host = std::env::var("ISAO_HOST")
            .unwrap_or_else(|_| "127.0.0.1".into())
            .parse()
            .expect("invalid isao bind address... /ᐠ - ˕ -マ");

        Self { port, host }
    }
}
