/** Opt-in product screenshot capture; never part of the normal Web regression lane. */
import { defineConfig } from 'vitest/config'
import webConfig from '../vitest.web.config.ts'

export default defineConfig({
  ...webConfig,
  test: { ...webConfig.test, include: ['apps/web/tests/product-walkthrough.capture.ts'] },
})
