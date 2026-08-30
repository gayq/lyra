use std::{path::PathBuf, sync::Arc};

use ed25519_dalek::{pkcs8::DecodePublicKey, VerifyingKey};
use sha2::{Digest, Sha256};
use wisp_mux::extensions::cert::VerifyKey;

pub async fn get_certificates_from_paths(paths: Vec<PathBuf>) -> anyhow::Result<Vec<VerifyKey>> {
    let mut certificates = Vec::new();
    for path in paths {
        let certificate = tokio::fs::read_to_string(path).await?;
        let verifier = VerifyingKey::from_public_key_pem(&certificate)?;
        let binary_key = verifier.to_bytes();

        let mut hasher = Sha256::new();
        hasher.update(binary_key);
        let hash: [u8; 32] = hasher.finalize().into();
        certificates.push(VerifyKey::new_ed25519(Arc::new(verifier), hash));
    }
    Ok(certificates)
}
