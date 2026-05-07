import * as path from "node:path";

/** Запись локальных путей в конфиг — всегда с `/`. */
export function toPosixPath(localPath: string): string {
  return localPath.split(path.sep).join("/");
}

/** Системный путь при чтении из конфига на Windows. */
export function fromPosixPath(posixPath: string): string {
  if (path.sep === "\\") {
    return posixPath.replace(/\//g, "\\");
  }
  return posixPath;
}
