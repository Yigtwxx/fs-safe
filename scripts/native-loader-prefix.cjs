// This prefix replaces napi-rs's generated libc probe. Keep it CommonJS because
// it is copied verbatim into native/index.js, which is itself CommonJS.
const { closeSync, openSync, readSync, readdirSync } = require('fs')
let nativeBinding = null
const loadErrors = []

const isFileMusl = (file) => file.includes('libc.musl-') || file.includes('ld-musl-')

const isMuslFromReport = () => {
  try {
    if (!process.report || typeof process.report.getReport !== 'function') {
      return null
    }
    const report = process.report.getReport()
    if (report && report.header && report.header.glibcVersionRuntime) {
      return false
    }
    if (report && Array.isArray(report.sharedObjects) && report.sharedObjects.some(isFileMusl)) {
      return true
    }
  } catch {
    // Continue with filesystem and ELF inspection.
  }
  return null
}

const isMuslFromFilesystem = () => {
  for (const directory of ['/lib', '/usr/lib']) {
    try {
      if (readdirSync(directory).some(isFileMusl)) {
        return true
      }
    } catch {
      // A missing or unreadable conventional library directory is inconclusive.
    }
  }
  return null
}

const readUInt = (buffer, offset, bytes, littleEndian) => {
  if (offset < 0 || offset + bytes > buffer.length) {
    return null
  }
  if (bytes === 2) {
    return littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset)
  }
  if (bytes === 4) {
    return littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset)
  }
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
    if (readSync(fd, header, 0, header.length, 0) < 52) {
      return null
    }
    if (header[0] !== 0x7f || header[1] !== 0x45 || header[2] !== 0x4c || header[3] !== 0x46) {
      return null
    }

    const elfClass = header[4]
    const dataEncoding = header[5]
    if ((elfClass !== 1 && elfClass !== 2) || (dataEncoding !== 1 && dataEncoding !== 2)) {
      return null
    }
    const littleEndian = dataEncoding === 1
    const is64Bit = elfClass === 2
    const programHeaderOffset = readUInt(header, is64Bit ? 32 : 28, is64Bit ? 8 : 4, littleEndian)
    const programHeaderSize = readUInt(header, is64Bit ? 54 : 42, 2, littleEndian)
    const programHeaderCount = readUInt(header, is64Bit ? 56 : 44, 2, littleEndian)
    if (
      programHeaderOffset === null ||
      programHeaderSize === null ||
      programHeaderCount === null ||
      programHeaderSize < (is64Bit ? 56 : 32) ||
      programHeaderCount > 1024
    ) {
      return null
    }

    const programHeader = Buffer.alloc(programHeaderSize)
    for (let index = 0; index < programHeaderCount; index += 1) {
      const offset = programHeaderOffset + index * programHeaderSize
      if (readSync(fd, programHeader, 0, programHeader.length, offset) !== programHeader.length) {
        return null
      }
      const type = readUInt(programHeader, 0, 4, littleEndian)
      if (type !== 3) continue // PT_INTERP

      const interpreterOffset = readUInt(programHeader, is64Bit ? 8 : 4, is64Bit ? 8 : 4, littleEndian)
      const interpreterSize = readUInt(programHeader, is64Bit ? 32 : 16, is64Bit ? 8 : 4, littleEndian)
      if (
        interpreterOffset === null ||
        interpreterSize === null ||
        interpreterSize < 1 ||
        interpreterSize > 4096
      ) {
        return null
      }
      const interpreter = Buffer.alloc(interpreterSize)
      if (readSync(fd, interpreter, 0, interpreter.length, interpreterOffset) !== interpreter.length) {
        return null
      }
      return isFileMusl(interpreter.toString('utf8'))
    }
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // The loader must not turn a failed best-effort close into an import failure.
      }
    }
  }
  return null
}

const isMusl = () => {
  if (process.platform !== 'linux') {
    return false
  }
  for (const detector of [isMuslFromReport, isMuslFromFilesystem, isMuslFromElfInterpreter]) {
    const result = detector()
    if (result !== null) {
      return result
    }
  }
  // Unknown Linux libc: try the glibc package and let its require fail normally.
  return false
}
