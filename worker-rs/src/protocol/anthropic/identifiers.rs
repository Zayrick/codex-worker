use std::collections::{HashMap, HashSet};

pub const CODEX_IDENTIFIER_LIMIT: usize = 64;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ToolNameMaps {
    pub forward: HashMap<String, String>,
    pub reverse: HashMap<String, String>,
}

pub fn build_tool_name_maps<'a>(names: impl IntoIterator<Item = &'a str>) -> ToolNameMaps {
    let mut maps = ToolNameMaps::default();
    let mut used = HashSet::new();

    for name in names {
        if maps.forward.contains_key(name) {
            continue;
        }
        let base = tool_name_candidate(name);
        let mut candidate = base.clone();
        let mut suffix = 1usize;
        while used.contains(&candidate) {
            let ending = format!("_{suffix}");
            candidate = format!(
                "{}{}",
                truncate_utf16(&base, CODEX_IDENTIFIER_LIMIT.saturating_sub(ending.len())),
                ending
            );
            suffix += 1;
        }
        used.insert(candidate.clone());
        maps.forward.insert(name.to_owned(), candidate.clone());
        maps.reverse.insert(candidate, name.to_owned());
    }
    maps
}

pub fn codex_tool_name(name: &str, forward: &HashMap<String, String>) -> String {
    forward
        .get(name)
        .cloned()
        .unwrap_or_else(|| tool_name_candidate(name))
}

pub fn claude_tool_name(name: &str, reverse: &HashMap<String, String>) -> String {
    reverse
        .get(name)
        .cloned()
        .unwrap_or_else(|| name.to_owned())
}

pub fn shorten_codex_call_id(id: &str) -> String {
    if utf16_len(id) <= CODEX_IDENTIFIER_LIMIT {
        return id.to_owned();
    }
    let suffix = format!("_{}", stable_hash(id));
    format!(
        "{}{}",
        truncate_utf16(id, CODEX_IDENTIFIER_LIMIT.saturating_sub(suffix.len())),
        suffix
    )
}

pub fn claude_tool_use_id(id: &str, fallback: &str) -> String {
    let sanitized = sanitize_claude_tool_id(id);
    shorten_codex_call_id(if sanitized.is_empty() {
        fallback
    } else {
        &sanitized
    })
}

fn tool_name_candidate(name: &str) -> String {
    if utf16_len(name) <= CODEX_IDENTIFIER_LIMIT {
        return name.to_owned();
    }
    if name.starts_with("mcp__")
        && let Some(separator) = name.rfind("__").filter(|index| *index > 0)
    {
        return truncate_utf16(
            &format!("mcp__{}", &name[separator + 2..]),
            CODEX_IDENTIFIER_LIMIT,
        );
    }
    truncate_utf16(name, CODEX_IDENTIFIER_LIMIT)
}

fn sanitize_claude_tool_id(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for unit in value.encode_utf16() {
        let byte = u8::try_from(unit).ok();
        match byte {
            Some(byte) if byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-' => {
                output.push(char::from(byte));
            }
            _ => output.push('_'),
        }
    }
    output
}

fn stable_hash(value: &str) -> String {
    let mut left = 0x811c_9dc5u32;
    let mut right = 0x9e37_79b9u32;
    for code in value.encode_utf16() {
        left = (left ^ u32::from(code)).wrapping_mul(0x0100_0193);
        right = (right ^ u32::from(code)).wrapping_mul(0x85eb_ca6b);
    }
    format!("{left:08x}{right:08x}")
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn truncate_utf16(value: &str, max_units: usize) -> String {
    let mut units = 0usize;
    value
        .chars()
        .take_while(|character| {
            let width = character.len_utf16();
            if units + width > max_units {
                false
            } else {
                units += width;
                true
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shortens_long_mcp_names_and_resolves_collisions() {
        let first = format!("mcp__one__{}", "lookup".repeat(12));
        let second = format!("mcp__two__{}", "lookup".repeat(12));
        let maps = build_tool_name_maps([first.as_str(), second.as_str()]);
        let one = maps.forward.get(&first).unwrap();
        let two = maps.forward.get(&second).unwrap();
        assert_eq!(one.encode_utf16().count(), CODEX_IDENTIFIER_LIMIT);
        assert_eq!(two.encode_utf16().count(), CODEX_IDENTIFIER_LIMIT);
        assert_ne!(one, two);
        assert_eq!(maps.reverse.get(one), Some(&first));
    }

    #[test]
    fn call_id_hash_is_stable() {
        let id = format!("toolu_{}", "x".repeat(90));
        let shortened = shorten_codex_call_id(&id);
        assert_eq!(shortened.len(), CODEX_IDENTIFIER_LIMIT);
        assert_eq!(&shortened[47..], "_fc4e5ec3f1048e97");
    }
}
