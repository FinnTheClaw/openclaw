import { createEffect, onSettled } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import "../../../components/tooltip.ts";
import { registerChatComposerEnglish } from "../../../i18n/locales/en-chat-composer.ts";
import { registerFilePreviewEnglish } from "../../../i18n/locales/en-file-preview.ts";
import { downloadBlobFile } from "../../../lib/download.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { t, registerEnglishCatalog } from "../../../lib/reactive/i18n.ts";
import { showToast } from "../../../lib/toast.ts";
import { createDetailOperationPresentation } from "./chat-detail-panel-operation-lifetime.ts";
import type { FileReaderDownload } from "./chat-sidebar-content-types.ts";

registerEnglishCatalog(registerChatComposerEnglish);

registerFilePreviewEnglish();

export function FileDownloadButton(props: {
  scopeKey: string;
  download: (signal: AbortSignal) => Promise<FileReaderDownload | null>;
  class: string;
  disabled?: boolean;
  showLabel?: boolean;
}) {
  const presentation = createDetailOperationPresentation();
  const { pending } = presentation;
  let request: { controller: AbortController; scopeKey: string } | null = null;
  const retire = () => {
    const previous = request;
    request = null;
    presentation.retire();
    previous?.controller.abort();
  };
  createEffect(
    () => props.scopeKey,
    (scopeKey) => {
      if (request && request.scopeKey !== scopeKey) {
        retire();
      }
    },
  );
  onSettled(() => retire);
  const download = async () => {
    if (request || props.disabled) {
      return;
    }
    const controller = new AbortController();
    const scopeKey = props.scopeKey;
    const admitted = { controller, scopeKey };
    request = admitted;
    const current = () =>
      request === admitted && !controller.signal.aborted && props.scopeKey === scopeKey;
    const failed = (error: unknown) => {
      if (current()) {
        showToast({
          message: t("chat.detailPanel.downloadFailed", { error: formatUiError(error) }),
        });
      }
    };
    const completion = (async () => {
      try {
        const file = await props.download(controller.signal);
        if (file && current()) {
          if ("blob" in file) {
            downloadBlobFile(file.filename, file.blob);
            return;
          }
          // The browser owns the byte stream and save progress, not a JavaScript Blob.
          const link = document.createElement("a");
          link.href = file.url;
          link.download = file.filename;
          link.click();
        }
      } catch (error) {
        failed(error);
      } finally {
        if (request === admitted) {
          request = null;
        }
      }
    })();
    // Download callbacks may select their file. Let that owner update land first.
    if (current()) {
      await presentation.observe(completion, current).catch(failed);
    }
  };
  const label = () =>
    t(pending() ? "chat.detailPanel.downloading" : "chat.detailPanel.downloadFile");
  return (
    <openclaw-tooltip prop:content={label()}>
      <button
        class={props.class}
        type="button"
        aria-label={label()}
        disabled={props.disabled || pending()}
        onClick={(event) => {
          event.stopPropagation();
          void download();
        }}
      >
        <Icon name="download" />
        {props.showLabel ? (
          <span>{t(pending() ? "chat.detailPanel.downloading" : "chat.attachments.download")}</span>
        ) : undefined}
      </button>
    </openclaw-tooltip>
  );
}
