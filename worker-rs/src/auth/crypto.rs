use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit, Payload},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use thiserror::Error;

const AES_KEY_BYTES: usize = 32;
const AES_GCM_IV_BYTES: usize = 12;
const AES_GCM_TAG_BYTES: usize = 16;

#[derive(Debug, Error)]
#[error("Secret material is unavailable.")]
pub struct SecretEnvelopeError;

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct EncryptedEnvelope {
    v: u8,
    alg: String,
    iv: String,
    ciphertext: String,
}

/// Seal JSON in the exact v1 envelope used by the former TypeScript Worker.
pub fn seal_json(
    value: &Value,
    encoded_master_key: &str,
    purpose: &str,
) -> Result<String, SecretEnvelopeError> {
    let cipher = cipher(encoded_master_key)?;
    let mut iv = [0_u8; AES_GCM_IV_BYTES];
    getrandom::fill(&mut iv).map_err(|_| SecretEnvelopeError)?;
    seal_json_with_iv(value, &cipher, purpose, iv)
}

fn seal_json_with_iv(
    value: &Value,
    cipher: &Aes256Gcm,
    purpose: &str,
    iv: [u8; AES_GCM_IV_BYTES],
) -> Result<String, SecretEnvelopeError> {
    let plaintext = serde_json::to_vec(value).map_err(|_| SecretEnvelopeError)?;
    let nonce = Nonce::try_from(iv.as_slice()).map_err(|_| SecretEnvelopeError)?;
    let ciphertext = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: &plaintext,
                aad: purpose.as_bytes(),
            },
        )
        .map_err(|_| SecretEnvelopeError)?;
    serde_json::to_string(&EncryptedEnvelope {
        v: 1,
        alg: "A256GCM".into(),
        iv: URL_SAFE_NO_PAD.encode(iv),
        ciphertext: URL_SAFE_NO_PAD.encode(ciphertext),
    })
    .map_err(|_| SecretEnvelopeError)
}

pub fn open_json(
    serialized_envelope: &str,
    encoded_master_key: &str,
    purpose: &str,
) -> Result<Value, SecretEnvelopeError> {
    let envelope: EncryptedEnvelope =
        serde_json::from_str(serialized_envelope).map_err(|_| SecretEnvelopeError)?;
    if envelope.v != 1 || envelope.alg != "A256GCM" {
        return Err(SecretEnvelopeError);
    }
    let iv = decode_base64_url(&envelope.iv)?;
    let ciphertext = decode_base64_url(&envelope.ciphertext)?;
    if iv.len() != AES_GCM_IV_BYTES || ciphertext.len() < AES_GCM_TAG_BYTES {
        return Err(SecretEnvelopeError);
    }
    let cipher = cipher(encoded_master_key)?;
    let nonce = Nonce::try_from(iv.as_slice()).map_err(|_| SecretEnvelopeError)?;
    let plaintext = cipher
        .decrypt(
            &nonce,
            Payload {
                msg: &ciphertext,
                aad: purpose.as_bytes(),
            },
        )
        .map_err(|_| SecretEnvelopeError)?;
    serde_json::from_slice(&plaintext).map_err(|_| SecretEnvelopeError)
}

fn cipher(encoded_master_key: &str) -> Result<Aes256Gcm, SecretEnvelopeError> {
    let key = decode_base64_url(encoded_master_key)?;
    if key.len() != AES_KEY_BYTES {
        return Err(SecretEnvelopeError);
    }
    Aes256Gcm::new_from_slice(&key).map_err(|_| SecretEnvelopeError)
}

fn decode_base64_url(value: &str) -> Result<Vec<u8>, SecretEnvelopeError> {
    if value.is_empty()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(SecretEnvelopeError);
    }
    URL_SAFE_NO_PAD
        .decode(value.as_bytes())
        .map_err(|_| SecretEnvelopeError)
}

pub fn sha256(value: &str) -> [u8; 32] {
    Sha256::digest(value.as_bytes()).into()
}

pub fn constant_time_equal(left: &str, right: &str) -> bool {
    bool::from(sha256(left).ct_eq(&sha256(right)))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const KEY: &str = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";
    const OAUTH_FIXTURE: &str = "{\"v\":1,\"alg\":\"A256GCM\",\"iv\":\"AAECAwQFBgcICQoL\",\"ciphertext\":\"Y6OfFW96sCYZkN-tznoNmYJZxf1MDRxUeOxZmOi-FXGrHSPP9qxSmIeW4Zp-hdBVhlUvEYC6j_MfbY6uxqljuzg9ZpHoNn7iTUbPnh2tTvraO7m7NXxTwZrtSSZmASZ1j8AkLz4YMnOtWzdmEGoFxu8sXb3t3mbSV3ZogLMHoCxz4DvqAY89KsydwolZyIlwoV9wTPp8VEA4SXjUOWk\"}";

    #[test]
    fn decrypts_the_typescript_v1_fixture() {
        let value = open_json(OAUTH_FIXTURE, KEY, "codex-worker/oauth/v1").unwrap();
        assert_eq!(value["accessToken"], "fixture-access");
        assert_eq!(value["refreshToken"], "fixture-refresh");
        assert_eq!(value["expiresAt"], 4_102_444_800_000_i64);
    }

    #[test]
    fn seals_without_exposing_plaintext_and_binds_the_purpose() {
        let value = json!({"token": "sensitive"});
        let sealed = seal_json(&value, KEY, "purpose-a").unwrap();
        assert!(!sealed.contains("sensitive"));
        assert_eq!(open_json(&sealed, KEY, "purpose-a").unwrap(), value);
        assert!(open_json(&sealed, KEY, "purpose-b").is_err());
    }

    #[test]
    fn comparisons_hash_both_inputs() {
        assert!(constant_time_equal("same", "same"));
        assert!(!constant_time_equal("same", "different"));
    }
}
