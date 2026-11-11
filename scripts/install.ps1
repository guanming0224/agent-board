# Agent Board 安裝腳本（Windows）。不需要系統管理員，只寫使用者目錄，不送出任何資料。
#
#   .\install.ps1 hub [--port 8787] [--host IP]
#   .\install.ps1 daemon --hub 'https://hub.example' --code ABCD-1234 [--name 機器名稱]
#   .\install.ps1 --uninstall [--purge]
#
# 其他選項：--from <發布檔.tar.gz 或資料夾>、--claude-bin <路徑>、--repair、--no-service、--no-start、
#           --restart-session-host（session host 換版時才加：重啟會結束所有 session，之後用 --resume 接回）
# 可重複執行：內容沒變就不重裝、不重啟服務。
# daemon 角色會一起裝 session host：工作排程器多一個「登入時」工作 AgentBoard-session-host（設定由
# scripts/installer.mjs 產生，和 daemon 同一份 task.xml 模板）。agent 掛在它底下，daemon 重啟時不中斷
# （CONTRACTS §20）。Windows 換程式檔時 node-pty 被鎖住，更新一定會停掉 session host，session 會用 --resume 接回。
# 發布檔自帶 Node（runtime\node\node.exe，CONTRACTS §21.10）：有的話安裝程式與服務都用它，這台不必裝 Node.js；
# 只有舊版（沒自帶 Node）的發布檔才需要系統的 node 與 npm。
# 未在 Windows 實機驗證。
$ErrorActionPreference = 'Stop'

$minMajor = 22
$minMinor = 18
$releaseUrl = if ($env:AGENT_BOARD_RELEASE_URL) { $env:AGENT_BOARD_RELEASE_URL } else {
  'https://github.com/OWNER/agent-board/releases/latest/download/agent-board.tar.gz'
}

# 不是中文語系就用英文。
$isZh = (Get-Culture).Name -like 'zh*'
function T([string] $zh, [string] $en) { if ($isZh) { $zh } else { $en } }

function Fail([string] $message) {
  [Console]::Error.WriteLine("$(T '安裝失敗' 'Install failed'): $message")
  exit 1
}

# 系統的 node：只有沒自帶 Node 的發布檔才需要。
function Require-SystemNode {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Fail (T "找不到 node。這個發布檔沒有自帶 Node，請先安裝 Node.js $minMajor.$minMinor 以上（https://nodejs.org）。" "Cannot find node. This release has no bundled Node: install Node.js $minMajor.$minMinor or newer (https://nodejs.org).")
  }
  $version = [version](node -p "process.versions.node")
  if ($version -lt [version]"$minMajor.$minMinor.0") {
    Fail (T "Node.js 版本太舊（目前 $version），需要 $minMajor.$minMinor 以上。" "Node.js is too old ($version). $minMajor.$minMinor or newer is required.")
  }
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Fail (T '找不到 npm。它通常隨 Node.js 一起安裝。' 'Cannot find npm. It normally comes with Node.js.')
  }
  'node'
}

# 發布檔資料夾裡自帶的 node.exe；沒有就用系統的。
function Node-For([string] $dir) {
  $bundled = Join-Path $dir 'runtime\node\node.exe'
  if (Test-Path $bundled) { $bundled } else { Require-SystemNode }
}

$root = Join-Path $env:LOCALAPPDATA 'agent-board'
$binDir = Join-Path $root 'bin'

function Set-UserPath([scriptblock] $edit) {
  $current = [Environment]::GetEnvironmentVariable('Path', 'User')
  $parts = @(if ($current) { $current -split ';' | Where-Object { $_ } })
  [Environment]::SetEnvironmentVariable('Path', ((& $edit $parts) -join ';'), 'User')
}

$rest = [System.Collections.Generic.List[string]]::new()
$from = $null
$uninstall = $false
for ($i = 0; $i -lt $args.Count; $i++) {
  switch ($args[$i]) {
    '--from' { $i++; $from = $args[$i] }
    '--uninstall' { $uninstall = $true }
    default { $rest.Add([string]$args[$i]) }
  }
}

if ($uninstall) {
  # 新配置是 current\（指向 releases\<版本>），舊配置是 app\。
  $installer = Join-Path $root 'current\scripts\installer.mjs'
  if (-not (Test-Path $installer)) { $installer = Join-Path $root 'app\scripts\installer.mjs' }
  if (-not (Test-Path $installer)) { Fail (T '這台機器沒有安裝 Agent Board。' 'Agent Board is not installed on this machine.') }
  $node = Node-For (Split-Path (Split-Path $installer))
  $copy = $null
  if ($node -ne 'node') {
    # Windows 鎖住執行中的 node.exe，解除安裝刪不掉 current：先複製到暫存資料夾再跑。
    $copy = Join-Path ([System.IO.Path]::GetTempPath()) ("agent-board-node-" + [guid]::NewGuid() + ".exe")
    Copy-Item $node $copy
    $node = $copy
  }
  & $node $installer uninstall @rest
  $code = $LASTEXITCODE
  if ($copy) {
    # 用完就刪；node.exe 剛結束可能還被鎖著，刪不掉就開一個背景 cmd 約 5 秒後再刪。
    Remove-Item -Force $copy -ErrorAction SilentlyContinue
    if (Test-Path $copy) {
      Start-Process -WindowStyle Hidden cmd.exe -ArgumentList '/c', "ping -n 6 127.0.0.1 >nul & del /f /q `"$copy`""
    }
  }
  if ($code -ne 0) { exit $code }
  Set-UserPath { param($parts) $parts | Where-Object { $_ -ne $binDir } }
  exit 0
}

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("agent-board-install-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  if (-not $from -and $PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot '..\BUILD_ID'))) {
    # 從已解開的發布檔裡執行。
    $from = Join-Path $PSScriptRoot '..'
  }
  if (-not $from) {
    if ($releaseUrl -like '*/OWNER/*') {
      Fail (T '這份腳本沒有設定下載位址。請從原始碼建置後用 --from 指定發布檔（見 README）。' 'This script has no download address set. Build from source and pass the release file with --from (see the README).')
    }
    Write-Host "$(T '下載' 'Downloading') $releaseUrl"
    $tarball = Join-Path $tmp 'agent-board.tar.gz'
    Invoke-WebRequest -UseBasicParsing -Uri $releaseUrl -OutFile $tarball
    Invoke-WebRequest -UseBasicParsing -Uri "$releaseUrl.sha256" -OutFile "$tarball.sha256"
    $expected = ((Get-Content "$tarball.sha256" -Raw).Trim() -split '\s+')[0]
    if ((Get-FileHash -Algorithm SHA256 $tarball).Hash -ne $expected) {
      Fail (T '檔案校驗不符，下載內容可能損壞。' 'Checksum mismatch. The download may be corrupt.')
    }
    $from = $tarball
  }
  if (Test-Path $from -PathType Container) {
    $source = (Resolve-Path $from).Path
  } else {
    if (-not (Test-Path $from)) { Fail (T "找不到 --from 指定的檔案：$from" "Cannot find the --from file: $from") }
    tar -xf $from -C $tmp
    if ($LASTEXITCODE -ne 0) { Fail (T "解壓縮失敗：$from" "Could not extract: $from") }
    $source = Join-Path $tmp 'agent-board'
  }
  if (-not (Test-Path (Join-Path $source 'BUILD_ID'))) { Fail (T "$source 不是 Agent Board 發布檔。" "$source is not an Agent Board release.") }

  $node = Node-For $source
  & $node (Join-Path $source 'scripts\installer.mjs') install --source $source @rest
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  Set-UserPath { param($parts) if ($parts -contains $binDir) { $parts } else { $parts + $binDir } }
  Write-Host (T "已把 $binDir 加進使用者 PATH，新開的終端機才會生效。" "Added $binDir to your user PATH. It takes effect in new terminals.")
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
