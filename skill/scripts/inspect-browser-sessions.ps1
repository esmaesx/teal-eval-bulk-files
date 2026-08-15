[CmdletBinding()]
param(
    [string]$CdpEndpoint = '',

    [ValidateRange(1, 10)]
    [int]$TimeoutSeconds = 2
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function ConvertTo-LoopbackEndpoint {
    param([Parameter(Mandatory = $true)][string]$Value)

    try {
        $uri = [Uri]$Value
    } catch {
        throw 'The CDP endpoint is not a valid URL.'
    }
    if ($uri.Scheme -notin @('http', 'https')) {
        throw 'The CDP endpoint must use HTTP or HTTPS.'
    }
    if ($uri.Host -notin @('127.0.0.1', '::1', '[::1]')) {
        throw 'The CDP endpoint must use an explicit loopback address.'
    }
    if ($uri.IsDefaultPort) {
        throw 'The CDP endpoint must include an explicit port.'
    }
    if ($uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -ne '/') {
        throw 'The CDP endpoint must not include credentials, a path, a query, or a fragment.'
    }
    return "$($uri.Scheme)://$($uri.Authority)"
}

function Get-CommandLineArgument {
    param(
        [string]$CommandLine,
        [Parameter(Mandatory = $true)][string]$Name
    )

    if (-not $CommandLine) { return '' }
    $escapedName = [Regex]::Escape($Name)
    $pattern = '(?:^|\s)--' + $escapedName + '(?:=|\s+)(?:"([^"]*)"|(\S+))'
    $match = [Regex]::Match($CommandLine, $pattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if (-not $match.Success) { return '' }
    if ($match.Groups[1].Success) { return $match.Groups[1].Value }
    return $match.Groups[2].Value
}

function Get-IssueIdentifier {
    param([string]$Url)

    try { $uri = [Uri]$Url } catch { return '' }
    if ($uri.Query -or $uri.Fragment -or $uri.UserInfo) { return '' }
    $match = [Regex]::Match($uri.AbsolutePath, '^/issue/([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)/?$')
    if (-not $match.Success) { return '' }
    $production = $uri.Scheme -eq 'https' -and $uri.Host -eq 'platform-teal-alpha.vercel.app'
    $localTest = $uri.Scheme -eq 'http' -and $uri.Host -eq '127.0.0.1' -and $uri.Port -eq 8769 -and $match.Groups[1].Value.ToUpperInvariant() -eq 'TAB-TEST'
    if (-not ($production -or $localTest)) { return '' }
    return $match.Groups[1].Value.ToUpperInvariant()
}

$candidates = @()
if ($CdpEndpoint) {
    $candidates += [pscustomobject]@{
        Browser = 'User-selected endpoint'
        BrowserKey = ''
        ProcessId = $null
        CdpEndpoint = ConvertTo-LoopbackEndpoint -Value $CdpEndpoint
        UserDataDir = ''
        ProfileDirectory = ''
        AttachMode = 'HttpCdp'
        SetupUrl = ''
    }
} else {
    $browserNames = @{
        'msedge.exe' = 'Microsoft Edge'
        'chrome.exe' = 'Google Chrome'
        'brave.exe' = 'Brave'
        'chromium.exe' = 'Chromium'
    }
    $browserKeys = @{
        'msedge.exe' = 'edge'
        'chrome.exe' = 'chrome'
        'brave.exe' = 'brave'
        'chromium.exe' = 'chromium'
    }
    $rootProcesses = Get-CimInstance Win32_Process | Where-Object {
        $browserNames.ContainsKey($_.Name.ToLowerInvariant()) -and $_.CommandLine -notmatch '(?:^|\s)--type='
    }
    foreach ($process in ($rootProcesses | Where-Object { $_.CommandLine -match '--remote-debugging-port' })) {
        $portText = Get-CommandLineArgument -CommandLine $process.CommandLine -Name 'remote-debugging-port'
        $port = 0
        if (-not [int]::TryParse($portText, [ref]$port) -or $port -lt 1 -or $port -gt 65535) { continue }
        $address = Get-CommandLineArgument -CommandLine $process.CommandLine -Name 'remote-debugging-address'
        if ($address -and $address -notin @('127.0.0.1', 'localhost', '::1', '[::1]')) { continue }
        $candidates += [pscustomobject]@{
            Browser = $browserNames[$process.Name.ToLowerInvariant()]
            BrowserKey = $browserKeys[$process.Name.ToLowerInvariant()]
            ProcessId = [int]$process.ProcessId
            CdpEndpoint = "http://127.0.0.1:$port"
            UserDataDir = Get-CommandLineArgument -CommandLine $process.CommandLine -Name 'user-data-dir'
            ProfileDirectory = Get-CommandLineArgument -CommandLine $process.CommandLine -Name 'profile-directory'
            AttachMode = 'HttpCdp'
            SetupUrl = ''
        }
    }

    $localAppData = [Environment]::GetFolderPath('LocalApplicationData')
    $liveSessionRoots = @(
        [pscustomobject]@{ ProcessName = 'chrome.exe'; Browser = 'Google Chrome'; BrowserKey = 'chrome'; UserDataDir = Join-Path $localAppData 'Google\Chrome\User Data'; SetupUrl = 'chrome://inspect/#remote-debugging' },
        [pscustomobject]@{ ProcessName = 'msedge.exe'; Browser = 'Microsoft Edge'; BrowserKey = 'edge'; UserDataDir = Join-Path $localAppData 'Microsoft\Edge\User Data'; SetupUrl = 'edge://inspect/#remote-debugging' }
    )
    foreach ($sessionRoot in $liveSessionRoots) {
        $process = $rootProcesses | Where-Object { $_.Name.ToLowerInvariant() -eq $sessionRoot.ProcessName } | Select-Object -First 1
        if (-not $process) { continue }
        if ($candidates | Where-Object { $_.ProcessId -eq [int]$process.ProcessId -and $_.AttachMode -eq 'HttpCdp' }) { continue }
        $activePortPath = Join-Path $sessionRoot.UserDataDir 'DevToolsActivePort'
        $activeRecordValid = $false
        if (Test-Path -LiteralPath $activePortPath -PathType Leaf) {
            try {
                $lines = @(Get-Content -LiteralPath $activePortPath -ErrorAction Stop)
                $port = 0
                $activeRecordValid = $lines.Count -ge 2 -and [int]::TryParse($lines[0].Trim(), [ref]$port) -and $port -ge 1 -and $port -le 65535 -and $lines[1].Trim() -match '^/devtools/browser/[A-Za-z0-9._-]+$'
            } catch {
                $activeRecordValid = $false
            }
        }
        $candidates += [pscustomobject]@{
            Browser = $sessionRoot.Browser
            BrowserKey = $sessionRoot.BrowserKey
            ProcessId = [int]$process.ProcessId
            CdpEndpoint = ''
            UserDataDir = $sessionRoot.UserDataDir
            ProfileDirectory = ''
            AttachMode = if ($activeRecordValid) { 'BrowserSession' } else { 'RemoteDebuggingDisabled' }
            SetupUrl = $sessionRoot.SetupUrl
        }
    }
}

$sessions = foreach ($candidate in ($candidates | Sort-Object AttachMode, CdpEndpoint, Browser, UserDataDir -Unique)) {
    if ($candidate.AttachMode -eq 'BrowserSession') {
        [pscustomobject]@{
            Browser = $candidate.Browser
            BrowserKey = $candidate.BrowserKey
            ProcessId = $candidate.ProcessId
            AttachMode = $candidate.AttachMode
            CdpEndpoint = ''
            UserDataDir = $candidate.UserDataDir
            ProfileDirectory = $candidate.ProfileDirectory
            Available = $true
            RequiresConnectionApproval = $true
            SetupUrl = $candidate.SetupUrl
            IssueTargets = @()
            Error = ''
        }
        continue
    }
    if ($candidate.AttachMode -eq 'RemoteDebuggingDisabled') {
        [pscustomobject]@{
            Browser = $candidate.Browser
            BrowserKey = $candidate.BrowserKey
            ProcessId = $candidate.ProcessId
            AttachMode = $candidate.AttachMode
            CdpEndpoint = ''
            UserDataDir = $candidate.UserDataDir
            ProfileDirectory = $candidate.ProfileDirectory
            Available = $false
            RequiresConnectionApproval = $true
            SetupUrl = $candidate.SetupUrl
            IssueTargets = @()
            Error = "Enable remote debugging at $($candidate.SetupUrl)."
        }
        continue
    }
    try {
        $targets = Invoke-RestMethod -Uri "$($candidate.CdpEndpoint)/json/list" -Method Get -TimeoutSec $TimeoutSeconds
        $issueTargets = foreach ($target in @($targets)) {
            $issue = Get-IssueIdentifier -Url ([string]$target.url)
            if (-not $issue -or $target.type -ne 'page') { continue }
            [pscustomobject]@{
                Issue = $issue
                Title = [string]$target.title
                Url = [string]$target.url
                TargetId = [string]$target.id
            }
        }
        [pscustomobject]@{
            Browser = $candidate.Browser
            BrowserKey = $candidate.BrowserKey
            ProcessId = $candidate.ProcessId
            AttachMode = $candidate.AttachMode
            CdpEndpoint = $candidate.CdpEndpoint
            UserDataDir = $candidate.UserDataDir
            ProfileDirectory = $candidate.ProfileDirectory
            Available = $true
            RequiresConnectionApproval = $false
            SetupUrl = $candidate.SetupUrl
            IssueTargets = @($issueTargets)
            Error = ''
        }
    } catch {
        [pscustomobject]@{
            Browser = $candidate.Browser
            BrowserKey = $candidate.BrowserKey
            ProcessId = $candidate.ProcessId
            AttachMode = $candidate.AttachMode
            CdpEndpoint = $candidate.CdpEndpoint
            UserDataDir = $candidate.UserDataDir
            ProfileDirectory = $candidate.ProfileDirectory
            Available = $false
            RequiresConnectionApproval = $false
            SetupUrl = $candidate.SetupUrl
            IssueTargets = @()
            Error = $_.Exception.Message
        }
    }
}

[pscustomobject]@{
    Ok = $true
    Sessions = @($sessions)
} | ConvertTo-Json -Depth 8
