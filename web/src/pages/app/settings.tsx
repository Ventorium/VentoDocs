import { CheckOutlined } from '@ant-design/icons'
import { Card, Segmented } from 'antd'
import { WALLPAPERS } from '@/lib/wallpapers'
import { useSettings } from '@/store/useSettings'
import type { ThemeMode } from '@/store/useSettings'

/**
 * 外观设置（借鉴 VentoOS 桌面设置）。
 * 主题三态（浅色/深色/跟随系统）+ 内置壁纸库；变更本地立即生效，500ms 防抖后持久化。
 */
const SettingsPage = () => {
  const { themeMode, setThemeMode, wallpaper, setWallpaper } = useSettings()

  return (
    <div className="flex flex-col gap-16px">
      <h1 className="text-18px font-semibold m-0">外观设置</h1>

      <Card title="主题" size="small">
        <Segmented<ThemeMode>
          value={themeMode}
          onChange={(v) => setThemeMode(v)}
          options={[
            { label: '浅色', value: 'light' },
            { label: '深色', value: 'dark' },
            { label: '跟随系统', value: 'auto' },
          ]}
        />
      </Card>

      <Card title="壁纸" size="small">
        <p className="text-13px m-0 text-#6B7280">
          壁纸将显示在桌面背景上，内容区为半透明窗口；选择「无」恢复纯色背景。
        </p>
        <div className="grid grid-cols-4 gap-12px mt-12px">
          {WALLPAPERS.map((w) => {
            const selected = wallpaper === w.value
            return (
              <button
                key={w.id}
                type="button"
                onClick={() => setWallpaper(w.value)}
                className="relative p-0 border-0 m-0 cursor-pointer bg-transparent"
              >
                <div
                  className={
                    selected
                      ? 'relative rounded-8px ring-2 ring-#2563EB ring-offset-2'
                      : 'relative rounded-8px hover:ring-2 hover:ring-#2563EB/40'
                  }
                >
                  {w.value ? (
                    <img
                      src={w.value}
                      alt={w.name}
                      className="w-full aspect-video object-cover rounded-8px"
                    />
                  ) : (
                    <div className="w-full aspect-video rounded-8px border-1px border-#E5E7EB bg-#F7F8FA flex items-center justify-center text-13px text-#9CA3AF">
                      无
                    </div>
                  )}
                  {selected && (
                    <span className="absolute right-6px bottom-6px bg-#2563EB text-white rounded-full w-18px h-18px flex items-center justify-center">
                      <CheckOutlined className="text-10px" />
                    </span>
                  )}
                </div>
                <div className="text-12px mt-4px text-center text-#4B5563">{w.name}</div>
              </button>
            )
          })}
        </div>
      </Card>
    </div>
  )
}

export default SettingsPage
