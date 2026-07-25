// prettier-ignore
/* eslint-disable */
// @ts-nocheck
/* Checked-in N-API loader for the seven platform packages this project ships. */

const { closeSync, openSync, readSync, readdirSync } = require('fs')
const loadErrors = []

const isFileMusl = (file) => file.includes('libc.musl-') || file.includes('ld-musl-')

const isMuslFromReport = () => {
  try {
    if (!process.report || typeof process.report.getReport !== 'function') return null
    const report = process.report.getReport()
    if (report?.header?.glibcVersionRuntime) return false
    if (report?.sharedObjects?.some(isFileMusl)) return true
  } catch {
    // Continue with filesystem and ELF inspection.
  }
  return null
}

const isMuslFromFilesystem = () => {
  for (const directory of ['/lib', '/usr/lib']) {
    try {
      if (readdirSync(directory).some(isFileMusl)) return true
    } catch {
      // A missing or unreadable conventional library directory is inconclusive.
    }
  }
  return null
}

const readUInt = (buffer, offset, bytes, littleEndian) => {
  if (offset < 0 || offset + bytes > buffer.length) return null
  if (bytes === 2) return littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset)
  if (bytes === 4) return littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset)
  if (bytes === 8) {
    const value = littleEndian ? buffer.readBigUInt64LE(offset) : buffer.readBigUInt64BE(offset)
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null
  }
  return null
}

const isMuslFromElfInterpreter = () => {
  let fd
  try {
    fd = openSync(process.execPath, 'r')
    const header = Buffer.alloc(64)
    if (readSync(fd, header, 0, header.length, 0) < 52) return null
    if (!header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return null

    const elfClass = header[4]
    const dataEncoding = header[5]
    if ((elfClass !== 1 && elfClass !== 2) || (dataEncoding !== 1 && dataEncoding !== 2)) {
      return null
    }
    const littleEndian = dataEncoding === 1
    const is64Bit = elfClass === 2
    const tableOffset = readUInt(header, is64Bit ? 32 : 28, is64Bit ? 8 : 4, littleEndian)
    const entrySize = readUInt(header, is64Bit ? 54 : 42, 2, littleEndian)
    const entryCount = readUInt(header, is64Bit ? 56 : 44, 2, littleEndian)
    if (tableOffset === null || entrySize === null || entryCount === null ||
        entrySize < (is64Bit ? 56 : 32) || entryCount > 1024) return null

    const programHeader = Buffer.alloc(entrySize)
    for (let index = 0; index < entryCount; index += 1) {
      const offset = tableOffset + index * entrySize
      if (readSync(fd, programHeader, 0, entrySize, offset) !== entrySize) return null
      if (readUInt(programHeader, 0, 4, littleEndian) !== 3) continue // PT_INTERP
      const interpreterOffset = readUInt(programHeader, is64Bit ? 8 : 4, is64Bit ? 8 : 4, littleEndian)
      const interpreterSize = readUInt(programHeader, is64Bit ? 32 : 16, is64Bit ? 8 : 4, littleEndian)
      if (interpreterOffset === null || interpreterSize === null ||
          interpreterSize < 1 || interpreterSize > 4096) return null
      const interpreter = Buffer.alloc(interpreterSize)
      if (readSync(fd, interpreter, 0, interpreterSize, interpreterOffset) !== interpreterSize) {
        return null
      }
      return isFileMusl(interpreter.toString('utf8'))
    }
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch {
        // Best-effort detection must never turn close failure into import failure.
      }
    }
  }
  return null
}

const isMusl = () => {
  if (process.platform !== 'linux') return false
  for (const detector of [isMuslFromReport, isMuslFromFilesystem, isMuslFromElfInterpreter]) {
    const result = detector()
    if (result !== null) return result
  }
  // Unknown Linux libc: try the glibc package and let its require fail normally.
  return false
}

const targetSuffix = () => {
  if (process.platform === 'win32' && process.arch === 'x64') return 'win32-x64-msvc'
  if (process.platform === 'darwin' && process.arch === 'x64') return 'darwin-x64'
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'darwin-arm64'
  if (process.platform === 'linux' && (process.arch === 'x64' || process.arch === 'arm64')) {
    return `linux-${process.arch}-${isMusl() ? 'musl' : 'gnu'}`
  }
  return null
}

const tryRequire = (specifier) => {
  try {
    return require(specifier)
  } catch (error) {
    loadErrors.push(error)
    return null
  }
}

const requireNative = () => {
  if (process.env.NAPI_RS_NATIVE_LIBRARY_PATH) {
    const explicit = tryRequire(process.env.NAPI_RS_NATIVE_LIBRARY_PATH)
    if (explicit) return explicit
  }

  const suffix = targetSuffix()
  if (!suffix) {
    loadErrors.push(new Error(`Unsupported OS or architecture: ${process.platform}-${process.arch}`))
    return null
  }
  const local = tryRequire(`./fs-safe-native.${suffix}.node`)
  if (local) return local

  const packageName = `@openclaw/fs-safe-native-${suffix}`
  const binding = tryRequire(packageName)
  if (!binding) return null
  if (process.env.NAPI_RS_ENFORCE_VERSION_CHECK && process.env.NAPI_RS_ENFORCE_VERSION_CHECK !== '0') {
    const expectedVersion = require('./package.json').version
    const bindingVersion = require(`${packageName}/package.json`).version
    if (bindingVersion !== expectedVersion) {
      loadErrors.push(new Error(
        `Native binding package version mismatch, expected ${expectedVersion} but got ${bindingVersion}. ` +
        'Reinstall dependencies to fix this issue.',
      ))
      return null
    }
  }
  return binding
}

const nativeBinding = requireNative()
if (!nativeBinding) {
  const error = new Error(
    `Cannot find native binding for ${process.platform}-${process.arch}; ` +
    'install the matching optional @openclaw/fs-safe-native platform package.',
  )
  error.cause = loadErrors.reduceRight((cause, current) => {
    current.cause = cause
    return current
  }, undefined)
  throw error
}

module.exports = nativeBinding
module.exports.cloneFileExclusive = nativeBinding.cloneFileExclusive
module.exports.copyFileRangeExclusive = nativeBinding.copyFileRangeExclusive
module.exports.createPrivateDirectory = nativeBinding.createPrivateDirectory
module.exports.extractArchiveNative = nativeBinding.extractArchiveNative
module.exports.fstatIdentity = nativeBinding.fstatIdentity
module.exports.inspectArchiveNative = nativeBinding.inspectArchiveNative
module.exports.linkBeneath = nativeBinding.linkBeneath
module.exports.mkdirBeneath = nativeBinding.mkdirBeneath
module.exports.openBeneath = nativeBinding.openBeneath
module.exports.readArchiveEntryNative = nativeBinding.readArchiveEntryNative
module.exports.readOwnerAndDacl = nativeBinding.readOwnerAndDacl
module.exports.renameNoReplace = nativeBinding.renameNoReplace
module.exports.sha256File = nativeBinding.sha256File
