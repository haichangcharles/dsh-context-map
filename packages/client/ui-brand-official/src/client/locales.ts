/** Product name shared by the official brand mark and name slots. */
/** Chinese source of truth for the product identity. */
export const zh = { name: 'DSH Context Map' }
/** Typed dictionary keys for the official brand slots. */
export type BrandKey = keyof typeof zh
/** English dictionary, complete against the Chinese key set. */
export const en = { name: 'DSH Context Map' } satisfies Record<BrandKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The official Context Map product identity. */
    contextMapBrand: BrandKey
  }
}
