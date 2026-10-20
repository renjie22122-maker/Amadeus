function Get-BotBridgePage($config) {
    $page = [string]$config.bridgePage
    if (-not $config.bridgeWebUiConfig) { return $page }
    $uri = $null
    if (-not [Uri]::TryCreate($page, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -notin @('http','https') -or $uri.Host -notin @('127.0.0.1','localhost','[::1]','::1') -or $uri.UserInfo) {
        throw 'WebUI token prefill requires a loopback HTTP(S) page.'
    }
    try { $web = Get-Content -LiteralPath $config.bridgeWebUiConfig -Raw -Encoding UTF8 | ConvertFrom-Json } catch { throw 'Cannot read local bridge WebUI configuration.' }
    if (-not $web.token) { throw 'Local bridge WebUI token is missing.' }
    $builder = New-Object UriBuilder($uri)
    $builder.Path = '/webui/web_login'
    $builder.Query = 'token=' + [Uri]::EscapeDataString([string]$web.token)
    $builder.Fragment = ''
    return $builder.Uri.AbsoluteUri
}