use napi::bindgen_prelude::{AsyncTask, Task};
use napi::{Env, Error, Result, Status};
use napi_derive::napi;
use sha2::{Digest, Sha256};
use std::fmt::Write as _;

use crate::{into_napi, platform};

#[napi(object)]
pub struct FileHash {
    pub bytes: f64,
    pub digest: String,
}

#[napi(object)]
pub struct NativeCopyResult {
    pub fd: i32,
    pub bytes: f64,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

#[napi(js_name = "cloneFileExclusive")]
pub fn clone_file_exclusive(
    env: Env,
    source_fd: i32,
    target_root_fd: i32,
    target_rel_path: String,
) -> Result<i32> {
    into_napi(
        env,
        crate::validate_relative_path(&target_rel_path, false).and_then(|()| {
            platform::clone_file_exclusive(source_fd, target_root_fd, &target_rel_path)
        }),
    )
}

pub struct CopyFileRangeTask {
    source_fd: i32,
    target_root_fd: i32,
    target_rel_path: String,
}

impl Task for CopyFileRangeTask {
    type Output = crate::NativeResult<(i32, u64)>;
    type JsValue = NativeCopyResult;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(platform::copy_file_range_exclusive(
            self.source_fd,
            self.target_root_fd,
            &self.target_rel_path,
        ))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(match output {
            Ok((fd, bytes)) => NativeCopyResult {
                fd,
                bytes: bytes as f64,
                error_code: None,
                error_message: None,
            },
            Err(error) => NativeCopyResult {
                fd: -1,
                bytes: 0.0,
                error_code: Some(error.status),
                error_message: Some(error.reason),
            },
        })
    }
}

#[napi(js_name = "copyFileRangeExclusive")]
pub fn copy_file_range_exclusive(
    source_fd: i32,
    target_root_fd: i32,
    target_rel_path: String,
) -> Result<AsyncTask<CopyFileRangeTask>> {
    crate::validate_relative_path(&target_rel_path, false)
        .map_err(|error| Error::new(Status::InvalidArg, error.reason))?;
    Ok(AsyncTask::new(CopyFileRangeTask {
        source_fd,
        target_root_fd,
        target_rel_path,
    }))
}

pub struct HashTask {
    fd: i32,
}

impl Task for HashTask {
    type Output = (u64, String);
    type JsValue = FileHash;

    fn compute(&mut self) -> Result<Self::Output> {
        let mut hasher = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        let mut bytes = 0_u64;
        loop {
            let read = platform::read_at(self.fd, &mut buffer, bytes)
                .map_err(|error| Error::new(Status::GenericFailure, error.reason))?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
            bytes += read as u64;
        }
        let mut digest = String::with_capacity(64);
        for byte in hasher.finalize() {
            write!(&mut digest, "{byte:02x}").unwrap();
        }
        Ok((bytes, digest))
    }

    fn resolve(&mut self, _env: Env, (bytes, digest): Self::Output) -> Result<Self::JsValue> {
        Ok(FileHash {
            bytes: bytes as f64,
            digest,
        })
    }
}

#[napi(js_name = "sha256File")]
pub fn sha256_file(fd: i32) -> AsyncTask<HashTask> {
    AsyncTask::new(HashTask { fd })
}
