# Installs the OpenManager environment server on Windows from a GitHub Release.
#
#   irm https://raw.githubusercontent.com/calledforth/openmanager/main/scripts/install.ps1 | iex
#
# Needs nothing but Windows PowerShell 5.1 or PowerShell 7: the release is a
# single openmanager.exe with Node built in. Running it again upgrades in place
# and moves an installed background service to the new version.
#
# Environment overrides:
#   OPENMANAGER_VERSION           install this version (for example 0.2.0) instead of the newest
#   OPENMANAGER_INSTALL_DIR       install folder (default %LOCALAPPDATA%\OpenManager)
#   OPENMANAGER_BIN_DIR           folder for the openmanager command (default <install folder>\bin)
#   OPENMANAGER_RELEASE_BASE_URL  mirror of https://github.com/calledforth/openmanager/releases/download

& {
  $ErrorActionPreference = 'Stop'
  # The progress bar makes Invoke-WebRequest many times slower in Windows PowerShell.
  $ProgressPreference = 'SilentlyContinue'
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $repo = 'calledforth/openmanager'
  $headers = @{ 'User-Agent' = 'openmanager-install' }

  function Step([string] $message) { Write-Host "  $message" }

  # Piped into iex, `exit` would close the user's terminal; throwing stops just this script.
  function Fail([string] $message) { throw "OpenManager install: $message" }

  function Download([string] $url, [string] $file, [string] $what) {
    try {
      Invoke-WebRequest -UseBasicParsing -Headers $headers -Uri $url -OutFile $file
    } catch {
      Fail "could not download $what from $url ($($_.Exception.Message))"
    }
  }

  switch ($env:PROCESSOR_ARCHITECTURE) {
    'AMD64' { }
    # Windows 11 on Arm runs x64 programs through emulation.
    'ARM64' { Step 'Arm64 Windows: installing the x64 build, which runs under emulation.' }
    default { Fail "no build for a $($env:PROCESSOR_ARCHITECTURE) processor; OpenManager needs 64-bit Windows." }
  }

  $version = $env:OPENMANAGER_VERSION
  if (-not $version) {
    Step 'Finding the newest release...'
    # Newest first; desktop releases share the list, so read on until a page has a server one.
    $newest = $null
    for ($page = 1; $page -le 5 -and -not $newest; $page++) {
      try {
        $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases?per_page=100&page=$page" -Headers $headers
      } catch {
        Fail "could not ask GitHub for the newest release ($($_.Exception.Message)). Set OPENMANAGER_VERSION to skip the lookup."
      }
      $newest = $releases |
        Where-Object { $_.tag_name -match '^server-v\d+\.\d+\.\d+$' -and -not $_.draft -and -not $_.prerelease } |
        ForEach-Object { [version] $_.tag_name.Substring(8) } |
        Sort-Object -Descending |
        Select-Object -First 1
      if (@($releases).Count -lt 100) { break }
    }
    if (-not $newest) { Fail 'GitHub lists no published OpenManager server release yet.' }
    $version = $newest.ToString()
  }
  if ($version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') { Fail "'$version' is not a version number." }

  $root = if ($env:OPENMANAGER_INSTALL_DIR) { $env:OPENMANAGER_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'OpenManager' }
  $binDir = if ($env:OPENMANAGER_BIN_DIR) { $env:OPENMANAGER_BIN_DIR } else { Join-Path $root 'bin' }
  # Absolute paths: PATH and the launcher must not depend on this shell's folder.
  $root = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($root)
  $binDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($binDir)
  $baseUrl = if ($env:OPENMANAGER_RELEASE_BASE_URL) { $env:OPENMANAGER_RELEASE_BASE_URL.TrimEnd('/') } else { "https://github.com/$repo/releases/download" }
  # cmd.exe expands %NAME% in a .cmd file's own path, so the launcher could not run.
  if ($root.Contains('%') -or $binDir.Contains('%')) { Fail "the install folder cannot contain '%': $root" }
  $versionsDir = Join-Path $root 'versions'
  $versionDir = Join-Path $versionsDir $version
  $exe = Join-Path $versionDir 'openmanager.exe'
  $marker = Join-Path $versionDir '.install-complete'
  $archive = "openmanager-$version-win32-x64.zip"

  if ((Test-Path $marker) -and ((Get-Content $marker -Raw).Trim() -eq $version)) {
    Step "OpenManager $version is already downloaded."
  } else {
    New-Item -ItemType Directory -Force -Path $versionsDir | Out-Null
    $staging = Join-Path $versionsDir ('.staging-' + [IO.Path]::GetRandomFileName())
    New-Item -ItemType Directory -Path $staging | Out-Null
    try {
      Step "Downloading $archive..."
      $sums = Join-Path $staging 'SHA256SUMS'
      Download "$baseUrl/server-v$version/SHA256SUMS" $sums "the checksums of $version"
      $line = Get-Content $sums | Where-Object { $_ -match ('^([0-9a-fA-F]{64})\s+\*?' + [regex]::Escape($archive) + '\s*$') } | Select-Object -First 1
      if (-not $line) { Fail "SHA256SUMS of $version does not list $archive." }
      $expected = $line.Substring(0, 64).ToLowerInvariant()
      $zip = Join-Path $staging $archive
      Download "$baseUrl/server-v$version/$archive" $zip $archive
      $actual = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLowerInvariant()
      if ($actual -ne $expected) { Fail "checksum mismatch for $archive (expected $expected, got $actual). Nothing was installed." }

      Step 'Unpacking...'
      $unpacked = Join-Path $staging 'unpacked'
      New-Item -ItemType Directory -Path $unpacked | Out-Null
      $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
      if (Test-Path $tar) {
        & $tar -xf $zip -C $unpacked
        if ($LASTEXITCODE -ne 0) { Fail "could not unpack $archive." }
      } else {
        Expand-Archive -Path $zip -DestinationPath $unpacked -Force
      }
      $reported = (& (Join-Path $unpacked 'openmanager.exe') --version | Out-String).Trim()
      if ($reported -ne $version) { Fail "the downloaded openmanager.exe reports '$reported', expected $version." }
      Set-Content -Path (Join-Path $unpacked '.install-complete') -Value $version -NoNewline
      if (Test-Path $versionDir) { Remove-Item $versionDir -Recurse -Force }
      Move-Item -Path $unpacked -Destination $versionDir
    } finally {
      if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
    }
  }

  # Put the command folder on the user's PATH, keeping the value's registry
  # type so entries such as %USERPROFILE%\bin stay expandable.
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
  $userPath = [string] $key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
  $onPath = @($userPath -split ';' | Where-Object { $_ -and ($_.TrimEnd('\') -ieq $binDir.TrimEnd('\')) }).Count -gt 0
  if (-not $onPath) {
    $kind = if ($key.GetValueNames() -contains 'Path') { $key.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
    $key.SetValue('Path', ((@($userPath -split ';' | Where-Object { $_ }) + $binDir) -join ';'), $kind)
    # Setting and clearing a variable tells Explorer and new terminals about the change.
    [Environment]::SetEnvironmentVariable('OPENMANAGER_PATH_REFRESH', '1', 'User')
    [Environment]::SetEnvironmentVariable('OPENMANAGER_PATH_REFRESH', $null, 'User')
  }
  $key.Close()
  if (-not (($env:Path -split ';') -contains $binDir)) { $env:Path = "$env:Path;$binDir" }

  # Writes the launcher and moves an installed service to this version.
  & $exe activate
  if ($LASTEXITCODE -ne 0) { Fail 'activating the new version failed; see the message above.' }

  Write-Host ''
  Write-Host 'Next: run the environment server in the background, starting at every sign-in:'
  Write-Host ''
  Write-Host '  openmanager service install'
  Write-Host ''
  Write-Host 'Add --tunnel-hostname and --allowed-origin for remote access. Guide:'
  Write-Host "  https://github.com/$repo/blob/main/docs/install.md"
}
