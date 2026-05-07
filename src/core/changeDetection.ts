/** Результат 3-way сравнения: baseline = hash из `_meta.files[path].hash`. */
export type ChangeAction = "none" | "push" | "pull" | "conflict";

/**
 * @param baseHash — `_meta.files[path]?.hash` (последний согласованный канонический хэш)
 * @param localCurrent — актуальный локальный канонический хэш
 * @param cloudCurrent — актуальный облачный канонический хэш; `""` если файла в облаке ещё нет
 */
export function detectChange(
  baseHash: string | undefined,
  localCurrent: string,
  cloudCurrent: string,
): ChangeAction {
  if (!baseHash) {
    if (cloudCurrent === "") {
      return localCurrent === "" ? "none" : "push";
    }
    if (localCurrent === cloudCurrent) {
      return "none";
    }
    if (localCurrent === "") {
      return "pull";
    }
    return "conflict";
  }

  /** Локальный файл ещё не создан (хэш ""), baseline из `_meta` есть, облако совпадает с baseline — первый pull на второй машине / после clone. */
  if (localCurrent === "" && cloudCurrent !== "" && cloudCurrent === baseHash) {
    return "pull";
  }

  if (localCurrent === cloudCurrent) {
    return "none";
  }
  if (localCurrent !== baseHash && cloudCurrent === baseHash) {
    return "push";
  }
  if (localCurrent === baseHash && cloudCurrent !== baseHash) {
    return "pull";
  }
  return "conflict";
}
