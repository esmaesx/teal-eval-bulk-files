[CmdletBinding(DefaultParameterSetName = 'Cdp')]
param(
    [Parameter(Mandatory = $true, ParameterSetName = 'PersistentBridge')]
    [string]$PersistentBridgePath,

    [Parameter(ParameterSetName = 'PersistentBridge')]
    [ValidateRange(1, 300)]
    [int]$BridgeWaitSeconds = 120,

    [Parameter(Mandatory = $true, ParameterSetName = 'Cdp')]
    [string]$CdpEndpoint,

    [Parameter(Mandatory = $true, ParameterSetName = 'Browser')]
    [ValidateSet('chrome', 'edge')]
    [string]$Browser,

    [Parameter(ParameterSetName = 'Browser')]
    [string]$UserDataDir = '',

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$')]
    [string]$Issue,

    [Parameter(Mandatory = $true)]
    [ValidateSet('status', 'list', 'plan-upload', 'apply-upload', 'plan-download', 'apply-download', 'plan-delete', 'apply-delete', 'verify', 'stop')]
    [string]$Command,

    [Alias('Names', 'Files', 'Paths', 'PlanToken')]
    [string[]]$Operands = @(),

    [string]$StatePath = '',

    [ValidateRange(1, 3600)]
    [int]$TtlSeconds = 300,

    [ValidatePattern('^[A-Za-z0-9_-]{1,128}$')]
    [string]$TargetId = '',

    [string]$ExtensionRoot = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $ExtensionRoot) {
    if ($env:TEAL_EVAL_BULK_EXTENSION_ROOT) {
        $ExtensionRoot = $env:TEAL_EVAL_BULK_EXTENSION_ROOT
    } else {
        $repositorySibling = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\extension'))
        if (Test-Path -LiteralPath (Join-Path $repositorySibling 'manifest.json') -PathType Leaf) {
            $ExtensionRoot = $repositorySibling
        } else {
            throw 'Set TEAL_EVAL_BULK_EXTENSION_ROOT or pass -ExtensionRoot with the unpacked extension directory.'
        }
    }
}

$resolvedExtensionRoot = [IO.Path]::GetFullPath($ExtensionRoot)
$cliPath = Join-Path $resolvedExtensionRoot 'teal-eval-bulk-cli.mjs'
$manifestPath = Join-Path $resolvedExtensionRoot 'manifest.json'
if (-not (Test-Path -LiteralPath $cliPath -PathType Leaf)) {
    throw "The Teal bulk CLI was not found at $cliPath"
}
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "The extension manifest was not found at $manifestPath"
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.version -ne '0.9.7') {
    throw "This skill requires Teal Eval Bulk Files 0.9.7. Found $($manifest.version)."
}

$node = Get-Command node -ErrorAction Stop
$arguments = @(
    $cliPath,
    '--issue', $Issue.ToUpperInvariant(),
    '--ttl-seconds', [string]$TtlSeconds
)
if ($PSCmdlet.ParameterSetName -eq 'Browser') {
    $arguments += @('--browser', $Browser)
    if ($UserDataDir) {
        $arguments += @('--user-data-dir', [IO.Path]::GetFullPath($UserDataDir))
    }
} elseif ($PSCmdlet.ParameterSetName -eq 'PersistentBridge') {
    $persistentBridgeUri = $null
    if (-not [Uri]::TryCreate($PersistentBridgePath, [UriKind]::Absolute, [ref]$persistentBridgeUri) -or -not $persistentBridgeUri.IsFile) {
        throw 'PersistentBridgePath must be an absolute local file path.'
    }
    $resolvedPersistentBridgePath = [IO.Path]::GetFullPath($persistentBridgeUri.LocalPath)
    if (-not (Test-Path -LiteralPath $resolvedPersistentBridgePath -PathType Leaf)) {
        throw "The persistent Chrome stdio proxy was not found at $resolvedPersistentBridgePath"
    }
    $arguments += @(
        '--persistent-bridge', $resolvedPersistentBridgePath,
        '--bridge-wait-seconds', [string]$BridgeWaitSeconds
    )
} else {
    $arguments += @('--cdp', $CdpEndpoint)
}
if ($StatePath) {
    $arguments += @('--state', [IO.Path]::GetFullPath($StatePath))
}
if ($TargetId) {
    $arguments += @('--target-id', $TargetId)
}
$arguments += $Command
$arguments += $Operands

& $node.Source @arguments
exit $LASTEXITCODE
