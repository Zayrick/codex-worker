/// Supported action suffixes in the Gemini v1beta model API.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GeminiAction {
    GenerateContent,
    StreamGenerateContent,
    CountTokens,
}

impl GeminiAction {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::GenerateContent => "generateContent",
            Self::StreamGenerateContent => "streamGenerateContent",
            Self::CountTokens => "countTokens",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GeminiActionPath {
    pub model: String,
    pub action: GeminiAction,
}

pub fn match_gemini_action_path(pathname: &str) -> Option<GeminiActionPath> {
    let path = pathname.strip_suffix('/').unwrap_or(pathname);
    let remainder = path.strip_prefix("/v1beta/models/")?;
    let (encoded_model, action) = remainder.rsplit_once(':')?;
    if encoded_model.is_empty() || encoded_model.contains('/') || encoded_model.contains(':') {
        return None;
    }
    let action = match action {
        "generateContent" => GeminiAction::GenerateContent,
        "streamGenerateContent" => GeminiAction::StreamGenerateContent,
        "countTokens" => GeminiAction::CountTokens,
        _ => return None,
    };
    Some(GeminiActionPath {
        model: decode_model(encoded_model)?,
        action,
    })
}

pub fn match_gemini_model_path(pathname: &str) -> Option<String> {
    let path = pathname.strip_suffix('/').unwrap_or(pathname);
    let encoded_model = path.strip_prefix("/v1beta/models/")?;
    if encoded_model.is_empty() || encoded_model.contains(['/', ':']) {
        return None;
    }
    decode_model(encoded_model)
}

fn decode_model(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            decoded.push(bytes[index]);
            index += 1;
            continue;
        }
        let high = *bytes.get(index + 1)?;
        let low = *bytes.get(index + 2)?;
        decoded.push((hex(high)? << 4) | hex(low)?);
        index += 3;
    }
    let model = String::from_utf8(decoded).ok()?.trim().to_owned();
    (!model.is_empty() && !model.contains('/')).then_some(model)
}

const fn hex(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}
