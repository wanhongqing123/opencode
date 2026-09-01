import { pathToFileURL } from "node:url"

export type RemoteImImageAttachment = {
  type: "image"
  localPath: string
  mimeType: string
  fileName?: string
}

export function remoteImPromptParts(
  text: string,
  displayText: string,
  attachments: RemoteImImageAttachment[] = [],
  options: {
    includeModelText?: boolean
    route?: { replyID?: string; taskID?: string }
  } = {},
) {
  return [
    ...(options.includeModelText === false
      ? []
      : [
          {
            type: "text" as const,
            text,
            synthetic: true,
            metadata: {
              kind: "remote_im_model_prompt",
              ...(options.route?.replyID ? { remoteImReplyID: options.route.replyID } : {}),
              ...(options.route?.taskID ? { remoteImTaskID: options.route.taskID } : {}),
            },
          },
        ]),
    ...attachments.map((attachment) => ({
      type: "file" as const,
      mime: attachment.mimeType,
      filename: attachment.fileName,
      url: pathToFileURL(attachment.localPath).href,
    })),
    {
      type: "text" as const,
      text: displayText,
      ignored: true,
      metadata: { kind: "remote_im_display_text" },
    },
  ]
}
