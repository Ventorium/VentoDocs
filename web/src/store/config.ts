export type AppConfig = {
  /** 目录发布域名（未配置时为 null，发布功能关闭） */
  publishDomain: string | null
}

const defaultConfig: AppConfig = {
  publishDomain: null
}

let config: AppConfig = defaultConfig

export async function fetchConfig() {
  return fetch('/_env')
    .then(resp => {
      if (!resp.ok) throw new Error(`/_env HTTP ${resp.status}`)
      return resp.json()
    })
    .then((conf: Partial<AppConfig>) => {
      config = { ...defaultConfig, ...conf }
    })
}

export function getConfig() {
  return config
}
