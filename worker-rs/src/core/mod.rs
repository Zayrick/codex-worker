//! Runtime-neutral application contracts shared by protocol adapters.

mod error;
mod json;

pub use error::{ApiError, AppResult};
pub use json::{JsonObject, number_field, object, object_mut, record_field, string_field};
