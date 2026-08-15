import { createContext, useContext, type ParentProps } from "solid-js"

export type MultiAiCodeImInputOrigin = "remote-im" | "tui"

export type MultiAiCodeImLocalSubmitClaim = {
  wait?: Promise<void>
  release(): void
}

export type MultiAiCodeImOriginControl = {
  setInputOrigin?(origin: MultiAiCodeImInputOrigin, sessionID?: string): void
  takeoverForLocalSubmit?(sessionID: string): MultiAiCodeImLocalSubmitClaim
}

const context = createContext<MultiAiCodeImOriginControl>()

export function MultiAiCodeImProvider(props: ParentProps<{ control?: MultiAiCodeImOriginControl }>) {
  return <context.Provider value={props.control}>{props.children}</context.Provider>
}

export function useMultiAiCodeIm() {
  return useContext(context)
}
