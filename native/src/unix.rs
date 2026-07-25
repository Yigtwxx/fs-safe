use std::os::fd::{AsFd, AsRawFd, BorrowedFd, FromRawFd, OwnedFd};

use rustix::fs::{AtFlags, FileType, Mode, OFlags, RenameFlags};

use crate::{FileIdentity, NativeResult, native_error};

fn borrowed(fd: i32) -> BorrowedFd<'static> {
    // SAFETY: Every public operation borrows the descriptor only for the
    // duration of the call. Ownership stays with Node.js.
    unsafe { BorrowedFd::borrow_raw(fd) }
}

fn os_error(error: rustix::io::Errno, operation: &str) -> napi::Error<String> {
    let code = match error {
        rustix::io::Errno::EXIST => "EEXIST",
        rustix::io::Errno::NOENT => "ENOENT",
        rustix::io::Errno::LOOP => "ELOOP",
        rustix::io::Errno::NOTDIR => "ENOTDIR",
        rustix::io::Errno::ACCESS => "EACCES",
        rustix::io::Errno::PERM => "EPERM",
        rustix::io::Errno::XDEV => "EXDEV",
        rustix::io::Errno::NOTEMPTY => "ENOTEMPTY",
        _ => "EIO",
    };
    native_error(code, format!("{operation}: {error}"))
}

fn validate_beneath_path(path: &str) -> NativeResult<()> {
    if path.starts_with('/') || path.split('/').any(|segment| segment == "..") {
        return Err(native_error(
            "EINVAL",
            "relative path must remain beneath root",
        ));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
pub fn open_beneath(root_fd: i32, rel_path: &str, flags: i32) -> NativeResult<i32> {
    use rustix::fs::{ResolveFlags, openat2};

    validate_beneath_path(rel_path)?;
    let path = if rel_path.is_empty() { "." } else { rel_path };
    let fd = openat2(
        borrowed(root_fd),
        path,
        OFlags::from_bits_retain(flags as u32),
        Mode::from_bits_retain(0o600),
        ResolveFlags::BENEATH | ResolveFlags::NO_MAGICLINKS,
    )
    .map_err(|error| os_error(error, "openat2 beneath root"))?;
    Ok(fd.into_raw_fd())
}

#[cfg(target_os = "macos")]
pub fn open_beneath(root_fd: i32, rel_path: &str, flags: i32) -> NativeResult<i32> {
    validate_beneath_path(rel_path)?;
    macos::open_beneath(root_fd, rel_path, flags)
}

fn split_parent(path: &str) -> NativeResult<(&str, &str)> {
    match path.rsplit_once('/') {
        Some((parent, basename)) if !basename.is_empty() => Ok((parent, basename)),
        None if !path.is_empty() => Ok(("", path)),
        _ => Err(native_error("EINVAL", "operation requires a basename")),
    }
}

fn directory_open_flags() -> i32 {
    (OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC).bits() as i32
}

fn open_parent(root_fd: i32, path: &str) -> NativeResult<(OwnedFd, &str)> {
    let (parent, basename) = split_parent(path)?;
    let fd = open_beneath(root_fd, parent, directory_open_flags())?;
    // SAFETY: open_beneath returns a newly owned descriptor.
    Ok((unsafe { OwnedFd::from_raw_fd(fd) }, basename))
}

pub fn mkdir_beneath(root_fd: i32, rel_path: &str, mode: u32) -> NativeResult<()> {
    if rel_path.is_empty() || rel_path == "." {
        return Ok(());
    }
    let mut current = rustix::io::dup(borrowed(root_fd))
        .map_err(|error| os_error(error, "duplicate root descriptor"))?;
    for segment in rel_path
        .split('/')
        .filter(|segment| !segment.is_empty() && *segment != ".")
    {
        match rustix::fs::mkdirat(
            current.as_fd(),
            segment,
            Mode::from_bits_retain(mode as u16),
        ) {
            Ok(()) | Err(rustix::io::Errno::EXIST) => {}
            Err(error) => return Err(os_error(error, "mkdirat beneath root")),
        }
        let next = open_beneath(current.as_fd().as_raw_fd(), segment, directory_open_flags())?;
        // SAFETY: open_beneath returns a newly owned descriptor.
        current = unsafe { OwnedFd::from_raw_fd(next) };
    }
    Ok(())
}

pub fn link_beneath(
    source_root_fd: i32,
    source_rel_path: &str,
    target_root_fd: i32,
    target_rel_path: &str,
) -> NativeResult<()> {
    let (source_parent, source_name) = open_parent(source_root_fd, source_rel_path)?;
    let (target_parent, target_name) = open_parent(target_root_fd, target_rel_path)?;
    rustix::fs::linkat(
        source_parent.as_fd(),
        source_name,
        target_parent.as_fd(),
        target_name,
        AtFlags::empty(),
    )
    .map_err(|error| os_error(error, "linkat beneath roots"))
}

pub fn rename_no_replace(
    source_root_fd: i32,
    source_rel_path: &str,
    target_root_fd: i32,
    target_rel_path: &str,
) -> NativeResult<()> {
    let (source_parent, source_name) = open_parent(source_root_fd, source_rel_path)?;
    let (target_parent, target_name) = open_parent(target_root_fd, target_rel_path)?;
    rustix::fs::renameat_with(
        source_parent.as_fd(),
        source_name,
        target_parent.as_fd(),
        target_name,
        RenameFlags::NOREPLACE,
    )
    .map_err(|error| os_error(error, "rename without replacement"))
}

pub fn fstat_identity(fd: i32) -> NativeResult<FileIdentity> {
    let stat = rustix::fs::fstat(borrowed(fd)).map_err(|error| os_error(error, "fstat"))?;
    let file_type = FileType::from_raw_mode(stat.st_mode);
    Ok(FileIdentity {
        dev: stat.st_dev as f64,
        ino: stat.st_ino as f64,
        mode: stat.st_mode as u32,
        nlink: stat.st_nlink as f64,
        size: stat.st_size as f64,
        is_file: file_type.is_file(),
        is_directory: file_type.is_dir(),
        is_symbolic_link: file_type.is_symlink(),
    })
}

#[cfg(target_os = "macos")]
mod macos {
    use std::collections::VecDeque;
    use std::ffi::{CStr, CString};
    use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd, OwnedFd, RawFd};

    use crate::{NativeResult, native_error};

    const MAX_SYMLINKS: usize = 40;

    fn last_error(operation: &str) -> napi::Error<String> {
        let error = std::io::Error::last_os_error();
        let code = match error.raw_os_error() {
            Some(libc::EEXIST) => "EEXIST",
            Some(libc::ENOENT) => "ENOENT",
            Some(libc::ELOOP) => "ELOOP",
            Some(libc::ENOTDIR) => "ENOTDIR",
            Some(libc::EACCES) => "EACCES",
            Some(libc::EPERM) => "EPERM",
            _ => "EIO",
        };
        native_error(code, format!("{operation}: {error}"))
    }

    fn duplicate(fd: RawFd) -> NativeResult<OwnedFd> {
        // SAFETY: dup does not borrow beyond this call and returns a fresh fd.
        let duplicated = unsafe { libc::dup(fd) };
        if duplicated < 0 {
            return Err(last_error("duplicate root descriptor"));
        }
        // SAFETY: duplicated is a new owned descriptor.
        Ok(unsafe { OwnedFd::from_raw_fd(duplicated) })
    }

    fn root_path(fd: RawFd) -> NativeResult<String> {
        let mut buffer = vec![0_i8; libc::PATH_MAX as usize];
        // SAFETY: buffer is writable for PATH_MAX bytes.
        if unsafe { libc::fcntl(fd, libc::F_GETPATH, buffer.as_mut_ptr()) } < 0 {
            return Err(last_error("resolve root descriptor path"));
        }
        // SAFETY: F_GETPATH writes a NUL-terminated string on success.
        Ok(unsafe { CStr::from_ptr(buffer.as_ptr()) }
            .to_string_lossy()
            .into_owned())
    }

    fn read_link(fd: RawFd, name: &CString) -> NativeResult<String> {
        let mut buffer = vec![0_u8; libc::PATH_MAX as usize];
        // SAFETY: pointers are valid for this call and the buffer is writable.
        let read = unsafe {
            libc::readlinkat(fd, name.as_ptr(), buffer.as_mut_ptr().cast(), buffer.len())
        };
        if read < 0 {
            return Err(last_error("read symlink beneath root"));
        }
        buffer.truncate(read as usize);
        String::from_utf8(buffer)
            .map_err(|_| native_error("EINVAL", "symlink target is not valid UTF-8"))
    }

    fn normalize(mut base: Vec<String>, target: &str) -> NativeResult<Vec<String>> {
        for segment in target.split('/') {
            match segment {
                "" | "." => {}
                ".." => {
                    if base.pop().is_none() {
                        return Err(native_error("EXDEV", "symlink target escapes root"));
                    }
                }
                value => base.push(value.to_owned()),
            }
        }
        Ok(base)
    }

    fn absolute_target_segments(root_fd: RawFd, target: &str) -> NativeResult<Vec<String>> {
        let root = root_path(root_fd)?;
        let relative = target
            .strip_prefix(&root)
            .and_then(|value| {
                value
                    .strip_prefix('/')
                    .or(Some(value))
                    .filter(|_| target == root || target.as_bytes().get(root.len()) == Some(&b'/'))
            })
            .ok_or_else(|| native_error("EXDEV", "absolute symlink target escapes root"))?;
        normalize(Vec::new(), relative)
    }

    pub fn open_beneath(root_fd: RawFd, rel_path: &str, flags: i32) -> NativeResult<i32> {
        if rel_path.is_empty() || rel_path == "." {
            return Ok(duplicate(root_fd)?.into_raw_fd());
        }
        let mut queue: VecDeque<String> = rel_path
            .split('/')
            .filter(|segment| !segment.is_empty() && *segment != ".")
            .map(ToOwned::to_owned)
            .collect();
        let mut current = duplicate(root_fd)?;
        let mut logical: Vec<String> = Vec::new();
        let mut followed = 0;

        while let Some(segment) = queue.pop_front() {
            let name = CString::new(segment.as_bytes())
                .map_err(|_| native_error("EINVAL", "path segment contains a NUL byte"))?;
            let is_final = queue.is_empty();
            let open_flags = if is_final {
                flags | libc::O_CLOEXEC | libc::O_NOFOLLOW
            } else {
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW
            };
            // SAFETY: current and name stay valid for the duration of openat.
            let opened =
                unsafe { libc::openat(current.as_raw_fd(), name.as_ptr(), open_flags, 0o600) };
            if opened >= 0 {
                if is_final {
                    return Ok(opened);
                }
                // SAFETY: opened is a new owned directory descriptor.
                current = unsafe { OwnedFd::from_raw_fd(opened) };
                logical.push(segment);
                continue;
            }
            let error = std::io::Error::last_os_error();
            let errno = error.raw_os_error();
            if !matches!(errno, Some(libc::ELOOP) | Some(libc::ENOTDIR))
                || (is_final && flags & libc::O_NOFOLLOW != 0)
            {
                return Err(last_error("open path beneath root"));
            }
            followed += 1;
            if followed > MAX_SYMLINKS {
                return Err(native_error("ELOOP", "too many symlinks beneath root"));
            }
            let target = match read_link(current.as_raw_fd(), &name) {
                Ok(target) => target,
                Err(_) => {
                    let code = if errno == Some(libc::ENOTDIR) {
                        "ENOTDIR"
                    } else {
                        "ELOOP"
                    };
                    return Err(native_error(
                        code,
                        format!("open path beneath root: {error}"),
                    ));
                }
            };
            let resolved = if target.starts_with('/') {
                absolute_target_segments(root_fd, &target)?
            } else {
                normalize(logical.clone(), &target)?
            };
            let remainder: Vec<String> = queue.drain(..).collect();
            queue = resolved.into_iter().chain(remainder).collect();
            current = duplicate(root_fd)?;
            logical.clear();
        }
        Err(native_error("EINVAL", "path did not resolve to an entry"))
    }
}

#[cfg(test)]
mod tests {
    use std::fs::{self, OpenOptions};
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    fn temp_root(label: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "fs-safe-native-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir(&path).unwrap();
        path
    }

    #[test]
    fn opens_and_creates_only_beneath_root() {
        let root = temp_root("open");
        fs::create_dir(root.join("nested")).unwrap();
        fs::write(root.join("nested/file"), b"ok").unwrap();
        let root_handle = OpenOptions::new().read(true).open(&root).unwrap();
        let fd = open_beneath(
            root_handle.as_raw_fd(),
            "nested/file",
            OFlags::RDONLY.bits() as i32,
        )
        .unwrap();
        // SAFETY: fd is uniquely owned after open_beneath.
        let file = unsafe { std::fs::File::from_raw_fd(fd) };
        assert_eq!(fstat_identity(file.as_raw_fd()).unwrap().size, 2.0);
        assert!(
            open_beneath(
                root_handle.as_raw_fd(),
                "../outside",
                OFlags::RDONLY.bits() as i32,
            )
            .is_err()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rename_no_replace_preserves_existing_target() {
        let root = temp_root("rename");
        fs::write(root.join("source"), b"source").unwrap();
        fs::write(root.join("target"), b"target").unwrap();
        let root_handle = OpenOptions::new().read(true).open(&root).unwrap();
        let error = rename_no_replace(
            root_handle.as_raw_fd(),
            "source",
            root_handle.as_raw_fd(),
            "target",
        )
        .unwrap_err();
        assert_eq!(error.status, "EEXIST");
        assert_eq!(fs::read(root.join("target")).unwrap(), b"target");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn follows_in_root_symlink_by_re_resolving_from_root() {
        use std::os::unix::fs::symlink;
        let root = temp_root("symlink");
        fs::create_dir(root.join("real")).unwrap();
        fs::write(root.join("real/file"), b"ok").unwrap();
        symlink("real", root.join("alias")).unwrap();
        let root_handle = OpenOptions::new().read(true).open(&root).unwrap();
        let fd = open_beneath(
            root_handle.as_raw_fd(),
            "alias/file",
            OFlags::RDONLY.bits() as i32,
        )
        .unwrap();
        // SAFETY: fd is uniquely owned after open_beneath.
        drop(unsafe { std::fs::File::from_raw_fd(fd) });
        fs::remove_dir_all(root).unwrap();
    }
}
