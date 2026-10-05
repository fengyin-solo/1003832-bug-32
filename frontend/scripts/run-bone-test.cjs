// 测试引导：用 esbuild 把 TS 测试打包成 CJS 再执行，前置注入 localStorage 桩。
const { build } = require('esbuild')
const path = require('path')
const Module = require('module')

const store = new Map()
globalThis.window = {
  localStorage: {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => void store.set(key, String(value)),
    removeItem: (key) => void store.delete(key),
  },
}

async function run() {
  const result = await build({
    entryPoints: [path.join(__dirname, 'bone-domain-test.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    logLevel: 'silent',
  })
  const code = result.outputFiles[0].text
  const mod = new Module('bone-domain-test')
  mod._compile(code, path.join(__dirname, 'bone-domain-test.cjs'))
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
