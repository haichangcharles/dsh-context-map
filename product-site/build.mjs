/** Overlay the static product homepage without removing documentation routes. */
import { access, cp, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
const output = new URL('../website/.dist/', import.meta.url)
await access(new URL('en/index.html', output))
await cp(fileURLToPath(new URL('./public/', import.meta.url)), fileURLToPath(output), { recursive: true })
await writeFile(new URL('.nojekyll', output), '')
await writeFile(new URL('index.md', output), '# DSH Context Map\n\nIndependent community project built on DeepSeek Harness. Visualize native Session branches and choose which messages enter the next request.\n\nThe homepage presents real application screenshots of native branching, cross-branch context selection, review and undo, archive and restore, and the prompt dashboard. Conversations and review suggestions are prepared samples, not live AI results.\n\n[Source and installation](https://github.com/haichangcharles/dsh-context-map) · [Documentation](./en/)\n')
console.log('Product homepage installed; existing documentation routes retained.')
