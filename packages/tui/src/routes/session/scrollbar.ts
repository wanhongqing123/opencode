export const SESSION_SCROLLBAR_VISIBLE_KEY = "scrollbar_visible"
export const SESSION_SCROLLBAR_DEFAULT_MIGRATION_KEY = "scrollbar_visible_default_v1"

export function shouldApplySessionScrollbarDefault(input: { visible: unknown; migrated: unknown }) {
  return input.migrated !== true && input.visible !== true
}
