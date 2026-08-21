import { dlopen, FFIType, ptr, read } from "bun:ffi"
import { constants } from "node:fs"
import { open } from "node:fs/promises"
import { createResult, createResultError, type PromiseResult } from "#result"

// 437 is the x86-64 Linux openat2 syscall. Other runtimes fail closed rather than risking a wrong syscall number.
const openat2SyscallNumber = process.platform === "linux" && process.arch === "x64" ? 437 : undefined
const resolveBeneath = 0x08
const resolveNoXdev = 0x01
const resolveNoSymlinks = 0x04
const resolveFlags = resolveBeneath | resolveNoXdev | resolveNoSymlinks
const rootResolveFlags = resolveBeneath | resolveNoSymlinks
const openHowByteLength = 24
const noFollowFlag = constants.O_NOFOLLOW ?? 0
const createFlag = constants.O_CREAT ?? 0
const exclusiveFlag = constants.O_EXCL ?? 0
const truncateFlag = constants.O_TRUNC ?? 0

type Openat2Syscall = (syscallNumber: number, directoryFd: number, path: string, how: number, size: number) => number
type ErrnoLocation = () => Parameters<typeof read.i32>[0]
type Close = (fileDescriptor: number) => number

type Openat2Symbols = {
  openat2: Openat2Syscall
  errnoLocation: ErrnoLocation
  close: Close
}

const openat2Symbols: Openat2Symbols | undefined = (() => {
  if (openat2SyscallNumber === undefined) return undefined
  try {
    const libc = dlopen("libc.so.6", {
      syscall: {
        args: [FFIType.i64, FFIType.i32, FFIType.cstring, FFIType.ptr, FFIType.u64],
        returns: FFIType.i32,
      },
      __errno_location: {
        args: [],
        returns: FFIType.ptr,
      },
      close: {
        args: [FFIType.i32],
        returns: FFIType.i32,
      },
    })
    return {
      openat2: libc.symbols.syscall as unknown as Openat2Syscall,
      errnoLocation: libc.symbols.__errno_location as unknown as ErrnoLocation,
      close: libc.symbols.close as unknown as Close,
    }
  } catch {
    return undefined
  }
})()

export type ProjectAccessLogOpenat2Options = {
  directoryFd: number
  name: string
  flags: number
  mode?: number
  path: string
  rootAnchor?: boolean
}

function openat2Error(message: string, path: string): ReturnType<typeof createResultError> {
  return createResultError("projectAccessLogOpenat2", message, path)
}

function openat2How(flags: number, mode: number, selectedResolveFlags: number): ArrayBuffer {
  const how = new ArrayBuffer(openHowByteLength)
  const view = new DataView(how)
  view.setBigUint64(0, BigInt(flags), true)
  view.setBigUint64(8, BigInt(mode), true)
  // The root anchor is only used for components before the configured root; retention descendants always use all
  // three resolution constraints.
  view.setBigUint64(16, BigInt(selectedResolveFlags), true)
  return how
}

function openat2ErrnoMessage(errno: number): string {
  if (errno === 18) return "openat2 rejected a mount boundary or path escape"
  if (errno === 17) return "openat2 found an existing entry"
  if (errno === 40) return "openat2 rejected a symbolic link"
  if (errno === 22 || errno === 38) return "openat2 is unavailable"
  return "openat2 could not open the retention path"
}

function openat2DuplicateFlags(flags: number): number {
  return flags & ~(createFlag | exclusiveFlag | truncateFlag | noFollowFlag)
}

export async function projectAccessLogOpenat2(
  options: ProjectAccessLogOpenat2Options,
): PromiseResult<Awaited<ReturnType<typeof open>> | undefined> {
  const op = "projectAccessLogOpenat2"
  if (
    !Number.isSafeInteger(options.directoryFd) ||
    options.directoryFd < 0 ||
    typeof options.name !== "string" ||
    options.name.length === 0 ||
    options.name.includes("\u0000") ||
    !Number.isSafeInteger(options.flags) ||
    options.flags < 0 ||
    (options.mode !== undefined &&
      (!Number.isSafeInteger(options.mode) || options.mode < 0 || options.mode > 0o7777)) ||
    (options.rootAnchor !== undefined && typeof options.rootAnchor !== "boolean")
  ) {
    return createResultError(op, "openat2 options are invalid", options.path)
  }
  if (openat2Symbols === undefined || openat2SyscallNumber === undefined) {
    return openat2Error("openat2 is unavailable", options.path)
  }

  const { openat2, errnoLocation, close } = openat2Symbols
  const how = openat2How(options.flags, options.mode ?? 0, options.rootAnchor ? rootResolveFlags : resolveFlags)
  let fileDescriptor = -1
  try {
    fileDescriptor = openat2(openat2SyscallNumber, options.directoryFd, options.name, ptr(how), openHowByteLength)
    if (fileDescriptor < 0) {
      const errno = read.i32(errnoLocation())
      if (errno === 2) return createResult(undefined)
      return openat2Error(openat2ErrnoMessage(errno), options.path)
    }

    try {
      // The descriptor was opened by openat2. Opening its proc link only duplicates that already-resolved object;
      // O_NOFOLLOW must be omitted here because the proc descriptor itself is a kernel magic link.
      return createResult(await open(`/proc/self/fd/${fileDescriptor}`, openat2DuplicateFlags(options.flags)))
    } catch {
      return openat2Error("openat2 descriptor could not be duplicated", options.path)
    }
  } catch {
    return openat2Error("openat2 could not be called", options.path)
  } finally {
    if (fileDescriptor >= 0) {
      try {
        close(fileDescriptor)
      } catch {
        // The opened Node descriptor owns the successful result; raw descriptor cleanup cannot change it.
      }
    }
  }
}
