import { registerSW } from 'virtual:pwa-register'

export const useRegisterSW = () => {
  const updateSW = registerSW({
    onNeedRefresh() {},
    onOfflineReady() {}
  })
  return { updateSW }
}
