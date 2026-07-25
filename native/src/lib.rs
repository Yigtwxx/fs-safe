#![deny(unsafe_op_in_unsafe_fn)]

use napi::bindgen_prelude::*;
use napi_derive::napi;

mod archive;
mod tar_meter;
#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

#[napi(object)]
pub struct FileIdentity {
    pub dev: f64,
    pub ino: f64,
    pub mode: u32,
    pub nlink: f64,
    pub size: f64,
    pub is_file: bool,
    pub is_directory: bool,
    pub is_symbolic_link: bool,
}

pub(crate) type NativeResult<T> = std::result::Result<T, Error<String>>;

pub(crate) fn native_error(code: impl Into<String>, message: impl Into<String>) -> Error<String> {
    Error::new(code.into(), message.into())
}

fn invalid_path(message: impl Into<String>) -> Error<String> {
    native_error("EINVAL", message)
}

fn validate_relative_path(path: &str, allow_root: bool) -> NativeResult<()> {
    if path.as_bytes().contains(&0) {
        return Err(invalid_path("relative path contains a NUL byte"));
    }
    if path.is_empty() || path == "." {
        return if allow_root {
            Ok(())
        } else {
            Err(invalid_path("operation requires a non-root path"))
        };
    }
    if path.starts_with('/') || path.starts_with('\\') {
        return Err(invalid_path(
            "path must be relative to the supplied root descriptor",
        ));
    }
    if path.split(['/', '\\']).any(|segment| segment == "..") {
        return Err(invalid_path("relative path must not contain '..'"));
    }
    Ok(())
}

fn into_napi<T>(env: Env, result: NativeResult<T>) -> Result<T> {
    match result {
        Ok(value) => Ok(value),
        Err(error) => {
            let reason = error.reason;
            env.throw_error(&reason, Some(error.status.as_ref()))?;
            Err(Error::new(Status::PendingException, reason))
        }
    }
}

#[napi(js_name = "openBeneath")]
pub fn open_beneath(env: Env, root_fd: i32, rel_path: String, flags: i32) -> Result<i32> {
    into_napi(
        env,
        validate_relative_path(&rel_path, true)
            .and_then(|()| platform::open_beneath(root_fd, &rel_path, flags)),
    )
}

#[napi(js_name = "mkdirBeneath")]
pub fn mkdir_beneath(env: Env, root_fd: i32, rel_path: String, mode: u32) -> Result<()> {
    into_napi(
        env,
        validate_relative_path(&rel_path, true)
            .and_then(|()| platform::mkdir_beneath(root_fd, &rel_path, mode)),
    )
}

#[napi(js_name = "linkBeneath")]
pub fn link_beneath(
    env: Env,
    source_root_fd: i32,
    source_rel_path: String,
    target_root_fd: i32,
    target_rel_path: String,
) -> Result<()> {
    into_napi(
        env,
        validate_relative_path(&source_rel_path, false)
            .and_then(|()| validate_relative_path(&target_rel_path, false))
            .and_then(|()| {
                platform::link_beneath(
                    source_root_fd,
                    &source_rel_path,
                    target_root_fd,
                    &target_rel_path,
                )
            }),
    )
}

#[napi(js_name = "renameNoReplace")]
pub fn rename_no_replace(
    env: Env,
    source_root_fd: i32,
    source_rel_path: String,
    target_root_fd: i32,
    target_rel_path: String,
) -> Result<()> {
    into_napi(
        env,
        validate_relative_path(&source_rel_path, false)
            .and_then(|()| validate_relative_path(&target_rel_path, false))
            .and_then(|()| {
                platform::rename_no_replace(
                    source_root_fd,
                    &source_rel_path,
                    target_root_fd,
                    &target_rel_path,
                )
            }),
    )
}

#[napi(js_name = "fstatIdentity")]
pub fn fstat_identity(env: Env, fd: i32) -> Result<FileIdentity> {
    into_napi(env, platform::fstat_identity(fd))
}

pub use archive::{
    NativeArchiveEntry, NativeArchivePlanEntry, extract_archive_native, inspect_archive_native,
    read_archive_entry_native,
};

#[cfg(unix)]
use unix as platform;
#[cfg(windows)]
use windows as platform;
