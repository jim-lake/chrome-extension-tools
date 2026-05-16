declare const __SCRIPT_URL__: string
const injectTime = performance.now()
;(async () => {
  const { onExecute } = await import(/* @vite-ignore */ __SCRIPT_URL__) as ContentScriptAPI.ModuleExports
  onExecute?.({ perf: { injectTime, loadTime: performance.now() - injectTime } })
})().catch(console.error)

export {}
