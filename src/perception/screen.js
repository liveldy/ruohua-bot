/**
 * 屏幕截图服务：优先让 Python 侧车去截（GDI / PowerShell），侧车不在时用 PowerShell 兜底。
 *
 * 契约见 docs/INTERFACES.md 第 12 节：createScreenService({ config, sidecar, logger })
 *   → { async capture({ path }), lastPath }
 *
 * 截图一律存成 BMP（标准库/系统工具都能直接写），文件名带时间戳；
 * 传进来的路径如果扩展名不是 .bmp，会被改写成 .bmp，免得内容与后缀不符。
 */

import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureDir, fileExists } from '../util/io.js';
import { t } from '../i18n/index.js';

const execFileAsync = promisify(execFile);
const POWERSHELL_TIMEOUT_MS = 25000;

function stamp(now = new Date()) {
  const pad = (value, size = 2) => String(value).padStart(size, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}`
  );
}

/** PowerShell 兜底脚本：整屏或多显示器第 N 块，存 BMP，末行回尺寸。 */
function powershellScript(target, monitor) {
  const safePath = String(target).replace(/'/g, "''");
  return `
$ErrorActionPreference = 'Stop'
# DPI awareness must be set before WinForms is loaded, otherwise scaled displays can only capture a shrunken logical-resolution image
$nativeReady = $false
try {
  Add-Type -Namespace Ruohua -Name ScreenNative -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);'
  $null = [Ruohua.ScreenNative]::SetProcessDPIAware()
  $nativeReady = $true
} catch { $nativeReady = $false }
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$screens = [System.Windows.Forms.Screen]::AllScreens
$idx = ${Number(monitor) || 0}
if ($idx -lt 0 -or $idx -ge $screens.Count) { $idx = 0 }
$bounds = $screens[$idx].Bounds
$x = $bounds.X; $y = $bounds.Y; $w = $bounds.Width; $h = $bounds.Height
if ($nativeReady) {
  # Once physical pixels are perceived, WinForms still reports logical coordinates; convert them back. The main screen uses system metrics directly.
  $logicalW = $screens[0].Bounds.Width
  $physicalW = [Ruohua.ScreenNative]::GetSystemMetrics(0)
  $physicalH = [Ruohua.ScreenNative]::GetSystemMetrics(1)
  if ($idx -eq 0 -and $physicalW -gt 0 -and $physicalH -gt 0) {
    $x = 0; $y = 0; $w = $physicalW; $h = $physicalH
  } elseif ($logicalW -gt 0 -and $physicalW -gt 0 -and $physicalW -ne $logicalW) {
    $scale = $physicalW / $logicalW
    $x = [int][math]::Round($bounds.X * $scale); $y = [int][math]::Round($bounds.Y * $scale)
    $w = [int][math]::Round($bounds.Width * $scale); $h = [int][math]::Round($bounds.Height * $scale)
  }
}
$bitmap = New-Object System.Drawing.Bitmap($w, $h)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($x, $y, 0, 0, $bitmap.Size)
$bitmap.Save('${safePath}', [System.Drawing.Imaging.ImageFormat]::Bmp)
$graphics.Dispose()
$bitmap.Dispose()
Write-Output ("{0} {1}" -f $w, $h)
`;
}

function encodePowerShell(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

export function createScreenService({ config, sidecar = null, logger = null } = {}) {
  const log = logger?.child ? logger.child('screen') : logger;
  const screenshotDir = config?.sidecar?.screenshotDir ?? path.join(config?.dataDir ?? process.cwd(), 'screenshots');
  let lastPath = null;
  let warned = false;

  function warnOnce(message) {
    if (warned) return;
    warned = true;
    log?.warn?.(message);
  }

  function targetPath(explicit) {
    const base = explicit ? path.resolve(config?.rootDir ?? process.cwd(), String(explicit)) : path.join(screenshotDir, `screen-${stamp()}.bmp`);
    return base.toLowerCase().endsWith('.bmp') ? base : `${base.replace(/\.[^./\\]+$/, '')}.bmp`;
  }

  async function viaSidecar(target, monitor) {
    if (!sidecar?.screenshot) return null;
    const result = await sidecar.screenshot({ path: target, monitor });
    if (!result?.ok || !result.path) {
      if (result?.error) log?.debug?.(t('perception.screen.sidecarFailed', { error: result.error }));
      return null;
    }
    if (!(await fileExists(result.path))) return null;
    return { path: result.path, width: result.width ?? null, height: result.height ?? null, via: 'sidecar' };
  }

  async function viaPowerShell(target, monitor) {
    if (process.platform !== 'win32') return null;
    try {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShell(powershellScript(target, monitor))],
        { timeout: POWERSHELL_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
      );
      const match = /(\d+)\s+(\d+)/.exec(String(stdout ?? ''));
      if (!(await fileExists(target))) return null;
      return {
        path: target,
        width: match ? Number(match[1]) : null,
        height: match ? Number(match[2]) : null,
        via: 'powershell',
      };
    } catch (error) {
      log?.debug?.(t('perception.screen.powershellFailed', { error: error.message }));
      return null;
    }
  }

  /**
   * 截一张屏。
   * @param {{ path?: string, monitor?: number }} opts 目标路径（默认为侧车截图目录 + 时间戳）、显示器序号（0 = 主屏）
   * @returns {Promise<{ path: string, width: number|null, height: number|null, via: string } | null>}
   */
  async function capture({ path: explicit = null, monitor = 0 } = {}) {
    const target = targetPath(explicit);
    try {
      await ensureDir(path.dirname(target));
    } catch (error) {
      warnOnce(t('perception.screen.dirFailed', { error: error.message }));
      return null;
    }

    const fromSidecar = await viaSidecar(target, monitor);
    if (fromSidecar) {
      lastPath = fromSidecar.path;
      warned = false;
      return fromSidecar;
    }

    const fromPowerShell = await viaPowerShell(target, monitor);
    if (fromPowerShell) {
      lastPath = fromPowerShell.path;
      warned = false;
      log?.debug?.(t('perception.screen.sidecarFallback'));
      return fromPowerShell;
    }

    warnOnce(
      process.platform === 'win32'
        ? t('perception.screen.captureFailed')
        : t('perception.screen.captureFailedOnPlatform', { platform: process.platform }),
    );
    return null;
  }

  return {
    capture,
    get lastPath() {
      return lastPath;
    },
    get screenshotDir() {
      return screenshotDir;
    },
  };
}
