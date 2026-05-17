import contentHmrPort from 'client/es/hmr-content-port.ts'
import { filter, Subscription } from 'rxjs'
import { build, ConfigEnv, UserConfig, ViteDevServer } from 'vite'
import {
  contentScripts,
  createDevLoader,
  createDevMainAsyncLoader,
  createProLoader,
} from './contentScripts'
import { add } from './fileWriter'
import {
  formatFileData,
  getFileName,
  prefix,
} from './fileWriter-utilities'
import { getOptions } from './plugin-optionsProvider'
import { basename, isAbsolute, join } from './path'
import { RxMap } from './RxMap'
import { CrxPluginFn } from './types'
import { contentHmrPortId, preambleId, viteClientId } from './virtualFileIds'
import colors from 'picocolors'

/** The set of main-world script ids (e.g. "/src/content.ts"). Populated at config time. */
export const worldMainIds = new Set<string>()

/**
 * Returns the static output filename for a main-world script.
 * This is deterministic and known at config time.
 */
export function getMainWorldFileName(id: string): string {
  // e.g. "/src/content.ts" -> "assets/content.js"
  const name = id.replace(/^.*\//, '').replace(/\.[^.]+$/, '')
  return `assets/${name}.js`
}

export const pluginContentScripts: CrxPluginFn = () => {
  const pluginName = 'crx:content-scripts'

  let server: ViteDevServer
  let preambleCode: string | false | undefined
  let hmrTimeout: number | undefined
  let liveReload = true
  let mainLoaderAsync = false
  let sub = new Subscription()

  return [
    {
      name: pluginName,
      apply: 'serve',
      async config(config, env) {
        const { manifest: _manifest } = await getOptions(config)
        const manifest = await (typeof _manifest === 'function' ? _manifest(env) : _manifest)

        worldMainIds.clear()
        ;(manifest.content_scripts || []).forEach(({ world, js }) => {
          if (world === 'MAIN' && js)
            js.forEach((path) => worldMainIds.add(prefix('/', path)))
        })

        const opts = await getOptions(config)
        const { contentScripts = {} } = opts
        hmrTimeout = contentScripts.hmrTimeout ?? 5000
        preambleCode = preambleCode ?? contentScripts.preambleCode
        liveReload = opts.liveReload !== false
        mainLoaderAsync = opts.mainLoaderAsync ?? false

        if (worldMainIds.size) {
          console.log(colors.yellow(
            [`[${pluginName}] Content scripts with world MAIN (no HMR):`,
              ...[...worldMainIds].map((id) => `  ${id}`)].join('\r\n'),
          ))

          // Register main-world environment: IIFE, static filenames, watched build
          const input: Record<string, string> = {}
          for (const id of worldMainIds) {
            const rel = id.slice(1)
            const name = rel.replace(/^.*\//, '').replace(/\.[^.]+$/, '')
            input[name] = rel
          }

          return {
            environments: {
              mainWorld: {
                build: {
                  outDir: config.build?.outDir ?? 'dist',
                  emptyOutDir: false,
                  lib: {
                    entry: input,
                    formats: ['iife'], name: 'mainWorld',
                  },
                  rollupOptions: {
                    output: { entryFileNames: () => 'assets/[name].js' },
                  },
                  watch: {},
                },
              },
            },
          }
        }
      },
      async configureServer(_server) {
        server = _server
        if (typeof preambleCode === 'undefined' &&
          server.config.plugins.some(({ name = 'none' }) =>
            name.toLowerCase().includes('react') && !name.toLowerCase().includes('preact'))) {
          try {
            const react = await import('@vitejs/plugin-react')
            preambleCode = react.default.preambleCode
          } catch { preambleCode = false }
        }

        if (worldMainIds.size) {
          // The mainWorld environment is registered but never built in serve mode.
          // Call build() directly with the same config, scoped to just mainWorld entries.
          const input: Record<string, string> = {}
          for (const id of worldMainIds) {
            const rel = id.slice(1)
            const name = rel.replace(/^.*\//, '').replace(/\.[^.]+$/, '')
            input[name] = rel
          }
          const outDir = server.config.build.outDir
          const absOutDir = isAbsolute(outDir) ? outDir : join(server.config.root, outDir)

          if (mainLoaderAsync) {
            // Serve the outDir on the dev server so built IIFEs are accessible
            // (e.g. GET /assets/main-world.js → build/assets/main-world.js)
            server.middlewares.use(async (req, res, next) => {
              if (!req.url) return next()
              const filePath = join(absOutDir, req.url.split('?')[0])
              try {
                const data = await import('fs').then(fs => fs.promises.readFile(filePath))
                res.setHeader('Content-Type', 'text/javascript')
                res.setHeader('Cache-Control', 'no-cache')
                res.end(data)
              } catch {
                next()
              }
            })
          }

          server.httpServer?.on('listening', () => {
            build({
              configFile: false,
              root: server.config.root,
              mode: server.config.mode,
              logLevel: 'warn',
              build: {
                outDir: absOutDir,
                emptyOutDir: false,
                copyPublicDir: false,
                lib: { entry: input, formats: ['iife'], name: 'mainWorld' },
                rollupOptions: { output: { entryFileNames: () => 'assets/[name].js' } },
                watch: {},
              },
            }).catch(console.error)
          })
        }

        sub.add(
          contentScripts.change$
            .pipe(filter(RxMap.isChangeType.set))
            .subscribe(({ value: script }) => {
              const { type, id } = script
              if (type === 'loader') {
                if (worldMainIds.has(prefix('/', id))) {
                  if (mainLoaderAsync) {
                    // Async loader: import() the built IIFE from the dev server.
                    // The IIFE is served from outDir via sirv middleware — faster than
                    // importing raw TS which causes recursive dep resolution.
                    const proto = server.config.server.https ? 'https' : 'http'
                    const addr = server.httpServer?.address()
                    const port = (addr && typeof addr === 'object' ? addr.port : null) ?? server.config.server.port ?? 5173
                    const iifePath = getMainWorldFileName(prefix('/', id))
                    const scriptUrl = `${proto}://localhost:${port}/${iifePath}`
                    const loaderFileName = getFileName({ type: 'loader', id })
                    const loader = add({
                      type: 'asset',
                      id: loaderFileName,
                      source: createDevMainAsyncLoader({ scriptUrl }),
                    })
                    script.fileName = loader.fileName
                  } else {
                    // Default: point directly at the pre-built IIFE (synchronous)
                    script.fileName = getMainWorldFileName(prefix('/', id))
                  }
                } else {
                  let preamble = { fileName: '' }
                  if (preambleCode) preamble = add({ type: 'module', id: preambleId })
                  const client = add({ type: 'module', id: viteClientId })
                  const file = add({ type: 'module', id })
                  const loader = add({
                    type: 'asset',
                    id: getFileName({ type: 'loader', id }),
                    source: createDevLoader({ preamble: preamble.fileName, client: client.fileName, fileName: file.fileName }),
                  })
                  script.fileName = loader.fileName
                }
              } else if (type === 'iife') {
                throw new Error('IIFE content scripts are not implemented')
              } else {
                script.fileName = add({ type: 'module', id }).fileName
              }
            }),
        )
      },
      resolveId(source) {
        if (source === preambleId) return preambleId
        if (source === contentHmrPortId) return contentHmrPortId
      },
      load(id) {
        if (id === preambleId && typeof preambleCode === 'string')
          return preambleCode.replace(/__BASE__/g, server.config.base)
        if (id === contentHmrPortId)
          return contentHmrPort
            .replace('__CRX_HMR_TIMEOUT__', JSON.stringify(hmrTimeout))
            .replace('__CRX_LIVE_RELOAD__', JSON.stringify(liveReload))
      },
      closeBundle() { sub.unsubscribe(); sub = new Subscription() },
    },
    {
      name: pluginName,
      apply: 'build',
      enforce: 'pre',
      async config(config, env) {
        const { manifest: _manifest } = await getOptions(config)
        const manifest = await (typeof _manifest === 'function' ? _manifest(env) : _manifest)

        worldMainIds.clear()
        ;(manifest.content_scripts || []).forEach(({ world, js }) => {
          if (world === 'MAIN' && js)
            js.forEach((path) => worldMainIds.add(prefix('/', path)))
        })


        if (worldMainIds.size) {
          console.log(colors.yellow(
            [`[${pluginName}] Content scripts with world MAIN (no HMR):`,
              ...[...worldMainIds].map((id) => `  ${id}`)].join('\r\n'),
          ))

          const input: Record<string, string> = {}
          for (const id of worldMainIds) {
            const rel = id.slice(1)
            const name = rel.replace(/^.*\//, '').replace(/\.[^.]+$/, '')
            input[name] = rel
          }

          return {
            environments: {
              mainWorld: {
                build: {
                  emptyOutDir: false,
                  copyPublicDir: false,
                  lib: {
                    entry: input,
                    formats: ['iife'], name: 'mainWorld',
                  },
                  rollupOptions: {
                    output: { entryFileNames: () => 'assets/[name].js' },
                  },
                },
              },
            },
            builder: {
              buildApp: async (builder) => {
                if (builder.environments.mainWorld)
                  await builder.build(builder.environments.mainWorld)
                await builder.build(builder.environments.client)
              },
            },
            build: {
              ...config.build,
              emptyOutDir: false,
              rollupOptions: {
                ...config.build?.rollupOptions,
                preserveEntrySignatures: config.build?.rollupOptions?.preserveEntrySignatures ?? 'exports-only',
              },
            },
          }
        }

        return {
          build: {
            ...config.build,
            rollupOptions: {
              ...config.build?.rollupOptions,
              preserveEntrySignatures: config.build?.rollupOptions?.preserveEntrySignatures ?? 'exports-only',
            },
          },
        }
      },
      generateBundle(_options, bundle) {
        for (const [key, script] of contentScripts)
          if (key === script.refId) {
            if (script.type === 'module') {
              script.fileName = this.getFileName(script.refId)
            } else if (script.type === 'loader') {
              if (worldMainIds.has(script.id)) {
                // Main-world: built by mainWorld environment, use static filename
                script.fileName = getMainWorldFileName(script.id)
              } else {
                const fileName = this.getFileName(script.refId)
                script.fileName = fileName
                const chunk = bundle[fileName]
                const shouldUseLoader = chunk.type === 'chunk' &&
                  (chunk.imports.length > 0 || chunk.dynamicImports.length > 0 || chunk.exports.length > 0)
                if (shouldUseLoader) {
                  const refId = this.emitFile({
                    type: 'asset',
                    name: getFileName({ type: 'loader', id: basename(script.id) }),
                    source: createProLoader({ fileName }),
                  })
                  script.loaderName = this.getFileName(refId)
                } else {
                  chunk.code = `(function(){${chunk.code}})()\n`
                }
              }
            } else if (script.type === 'iife') {
              throw new Error('IIFE content scripts are not implemented')
            }
            contentScripts.set(script.refId, formatFileData(script))
          }
      },
    },
  ]
}
