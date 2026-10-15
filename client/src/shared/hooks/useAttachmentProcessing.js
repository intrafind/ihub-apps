import { useCallback, useEffect, useId, useRef, useState } from 'react';

/**
 * The composer's side of "an attachment is still being processed" (extracting
 * the audio of a video takes a while, and a message sent meanwhile would go
 * without it).
 *
 * A composer hands `onProcessingChange` to its uploader. It always knows about
 * its own uploader; when the page shares the state through `useFileUploadHandler`
 * (`sharedBusy` and `report`), it knows about the other composers' uploaders too.
 * That matters where a page mounts two composers for one chat and hides one with
 * CSS: after a resize the other one is on screen, and must not send without the
 * attachment the first one is still processing.
 *
 * Without `sharedBusy` and `report` (a page that does not share), the composer
 * relies on its own uploader alone.
 *
 * @param {boolean} [sharedBusy=false] - Whether any uploader of the page is busy
 *   (`useFileUploadHandler().isAttachmentProcessing`)
 * @param {(id: string, busy: boolean) => void} [report] - Tells the page that this
 *   composer's uploader is busy or idle (`useFileUploadHandler().setAttachmentProcessing`)
 * @returns {{ attachmentProcessing: boolean, onProcessingChange: (busy: boolean) => void }}
 *   `attachmentProcessing`: sending has to wait; `onProcessingChange`: for the uploader
 */
export default function useAttachmentProcessing(sharedBusy = false, report = undefined) {
  // Tells this composer's uploader apart from the other composers' ones
  const id = useId();
  const [ownBusy, setOwnBusy] = useState(false);

  // Read through a ref, so a caller's new callback does not restart the uploader's
  // report (it would be reported idle and busy again on every render)
  const reportRef = useRef(report);
  useEffect(() => {
    reportRef.current = report;
  });

  const onProcessingChange = useCallback(
    busy => {
      setOwnBusy(busy);
      reportRef.current?.(id, busy);
    },
    [id]
  );

  // A composer that goes away must not leave the page waiting for its uploader
  useEffect(() => () => reportRef.current?.(id, false), [id]);

  return { attachmentProcessing: ownBusy || sharedBusy === true, onProcessingChange };
}
