/** Preserve the repository projects and setup files while adding a diagnostic runner. */
import { fileURLToPath } from 'node:url'
import config from '../vitest.config.ts'

export default {
  ...config,
  test: {
    ...config.test,
    projects: config.test!.projects!.map((project) => {
      if (typeof project !== 'object') throw new Error('Native diagnostic requires the existing inline projects')
      return { ...project, test: { ...project.test,
        runner: fileURLToPath(new URL('./worker-death-repeats.ts', import.meta.url)),
      } }
    }),
  },
}
