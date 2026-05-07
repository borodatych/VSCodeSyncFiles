import * as path from "node:path";

/**
 * Запись локальных путей в конфиг — всегда с `/`.
 *
 * Replaces backslashes regardless of `path.sep` so the function is
 * cross-platform (callers on Linux that received a Windows-style path
 * still get a normalised result). On Windows `path.sep === "\\"`, so the
 * behaviour is identical to the old `split(path.sep).join("/")`.
 */
export function toPosixPath(localPath: string): string {
  return localPath.replace(/\\/g, "/");
}

/** Системный путь при чтении из конфига на Windows. */
export function fromPosixPath(posixPath: string): string {
  if (path.sep === "\\") {
    return posixPath.replace(/\//g, "\\");
  }
  return posixPath;
}
