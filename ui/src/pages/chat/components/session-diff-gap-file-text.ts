import { splitSessionDiffFileText } from "../../../lib/chat/session-diff-gaps.ts";
import type { SessionDiffProps } from "./chat-sidebar-content-types.ts";
import type { FileSource, FileView } from "./session-diff-types.ts";

export function createSessionDiffGapFileText(loadFileText: () => SessionDiffProps["loadFileText"]) {
  const fileTextCache = new WeakMap<FileSource, Promise<string[] | null>>();
  const unavailableFileText = new WeakSet<FileSource>();
  return {
    read(view: FileView) {
      const cached = fileTextCache.get(view.source);
      if (cached) {
        return cached;
      }
      const load = loadFileText();
      const result = load
        ? load(view.file.path)
            .then((text) => (text === null ? null : splitSessionDiffFileText(text)))
            .catch(() => null)
        : Promise.resolve(null);
      fileTextCache.set(view.source, result);
      return result;
    },
    invalidate(source: FileSource) {
      fileTextCache.delete(source);
    },
    isUnavailable: (source: FileSource) => unavailableFileText.has(source),
    markUnavailable(source: FileSource) {
      unavailableFileText.add(source);
    },
    restoreUnavailable(views: readonly FileView[]) {
      // Keep prepared diff state, but let an accepted reload retry failed context reads.
      let restoredGapActions = false;
      for (const { source } of views) {
        if (unavailableFileText.delete(source)) {
          fileTextCache.delete(source);
          restoredGapActions = true;
        }
      }
      return restoredGapActions;
    },
  };
}
