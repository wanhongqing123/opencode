import { expect, test } from "bun:test"
import { shouldApplySessionScrollbarDefault } from "../../../src/routes/session/scrollbar"

test("session scrollbar default migration enables old hidden default once", () => {
  expect(shouldApplySessionScrollbarDefault({ visible: false, migrated: undefined })).toBe(true)
  expect(shouldApplySessionScrollbarDefault({ visible: undefined, migrated: undefined })).toBe(true)
})

test("session scrollbar default migration preserves visible or already migrated state", () => {
  expect(shouldApplySessionScrollbarDefault({ visible: true, migrated: undefined })).toBe(false)
  expect(shouldApplySessionScrollbarDefault({ visible: false, migrated: true })).toBe(false)
})
