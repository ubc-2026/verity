[CmdletBinding()]
param([switch]$Apply)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http
$agentId = 'agent_9001m7x29v7kekz8wm2tek94vg2v'
$mainBranchId = 'agtbrch_7301m7x29w34fr9tvy7c8vwc6zd2'
$agentUrl = "https://api.elevenlabs.io/v1/convai/agents/$agentId"
$signingUrl = "https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=$agentId&include_conversation_id=true"
$categories = @('harassment', 'sexual', 'violence', 'self_harm')

function Test-VerityVoiceAgent($Config) {
    return ($Config.agent_id -ceq $agentId -and
        $Config.platform_settings.auth.enable_auth -eq $true -and
        (-not $Config.branch_id -or $Config.branch_id -ceq $mainBranchId) -and
        (-not $Config.main_branch_id -or $Config.main_branch_id -ceq $mainBranchId))
}

function Get-SafeAgentError([string]$ResponseBody) {
    $detail = $null
    try { $detail = ($ResponseBody | ConvertFrom-Json -ErrorAction Stop).detail } catch {}

    $code = if ($detail.code) { $detail.code } else { $detail.status }
    switch ($code) {
        'missing_permissions' { return 'key permission denied' }
        'invalid_api_key' { return 'key rejected' }
        'missing_api_key' { return 'API key missing' }
        'agent_not_found' { return 'agent unavailable to this key' }
        'branch_not_found' { return 'branch unavailable to this key' }
    }
    $reason = if ($detail -is [string]) { $detail } else { $detail.message }
    if ($reason -match '(?i)zero[ -]retention') { return 'provider rejected the privacy configuration' }
    if ($reason -match '(?i)branch|versioning') { return 'provider rejected the branch or versioning context' }
    if ($reason -match '(?i)permission|access denied|not authori[sz]ed') { return 'provider rejected access to the agent' }
    if ($reason -match '(?i)guardrail') { return 'provider rejected the guardrail settings' }
    if ($reason -match '(?i)workspace|subscription|plan|entitlement') { return 'provider reported a workspace or plan restriction' }
    return 'no recognized provider reason'
}

function Invoke-ElevenLabsJson([string]$Method, [string]$Url, [string]$Body) {
    $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::new($Method), $Url)
    $response = $null
    try {
        $request.Headers.Add('xi-api-key', $value)
        if ($Body) {
            $request.Content = [System.Net.Http.StringContent]::new($Body, [Text.Encoding]::UTF8, 'application/json')
        }
        $response = $client.SendAsync($request).GetAwaiter().GetResult()
        $content = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        if (-not $response.IsSuccessStatusCode) {
            $failure = [InvalidOperationException]::new('ElevenLabs rejected the request.')
            $failure.Data['SafeStatus'] = [int]$response.StatusCode
            $failure.Data['SafeReason'] = Get-SafeAgentError $content
            throw $failure
        }
        return $content | ConvertFrom-Json
    } finally {
        if ($null -ne $response) { $response.Dispose() }
        $request.Dispose()
    }
}

function Enable-GuardrailField($Parent, [string]$Name) {
    if ($null -eq $Parent.$Name) {
        $Parent | Add-Member -NotePropertyName $Name -NotePropertyValue ([pscustomobject]@{}) -Force
    }
    $Parent.$Name | Add-Member -NotePropertyName 'is_enabled' -NotePropertyValue $true -Force
}

function Test-GuardrailsEnabled($Guardrails) {
    if ($Guardrails.focus.is_enabled -ne $true -or $Guardrails.prompt_injection.is_enabled -ne $true) { return $false }
    foreach ($category in $categories) {
        if ($Guardrails.content.config.$category.is_enabled -ne $true) { return $false }
    }
    return $true
}

$secret = Read-Host 'Paste the full Verity guardrails setup key and press Enter' -AsSecureString
$secretPointer = [IntPtr]::Zero
$client = $null
$phase = 'validate the pasted key'
try {
    $secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
    $value = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer).Trim()
    if ($value -notmatch '^[A-Za-z0-9_-]{24,256}$' -or $value.StartsWith('key_')) {
        Write-Host 'Use Copy to Clipboard in ElevenLabs and paste the full API key at the hidden prompt.'
        exit 1
    }
    $handler = [System.Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect = $false
    $client = [System.Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromSeconds(20)
    $null = Invoke-ElevenLabsJson 'GET' $signingUrl

    $phase = 'read configuration'
    $agentConfig = Invoke-ElevenLabsJson 'GET' $agentUrl
    if (-not (Test-VerityVoiceAgent $agentConfig)) {
        throw [InvalidOperationException]::new('The expected private agent was not returned.')
    }

    $guardrails = $agentConfig.platform_settings.guardrails
    if (Test-GuardrailsEnabled $guardrails) {
        Write-Host 'Verified Focus, Manipulation, and the four content filters are enabled.'
        return
    }
    if ($null -eq $guardrails) { $guardrails = [pscustomobject]@{ version = '1' } }
    if ($guardrails.version -ne '1') { throw [InvalidOperationException]::new('Unrecognized guardrail settings version.') }

    Write-Host 'Verity AI Second Opinion will enable Focus, Manipulation, and filters for harassment, sexual content, violence, and self-harm.'
    if (-not $Apply) {
        Write-Host 'Preview only. Use -Apply to save and verify the listed settings.'
        return
    }

    Enable-GuardrailField $guardrails 'focus'
    Enable-GuardrailField $guardrails 'prompt_injection'
    if ($null -eq $guardrails.content) {
        $guardrails | Add-Member -NotePropertyName 'content' -NotePropertyValue ([pscustomobject]@{}) -Force
    }
    if ($null -eq $guardrails.content.config) {
        $guardrails.content | Add-Member -NotePropertyName 'config' -NotePropertyValue ([pscustomobject]@{}) -Force
    }
    foreach ($category in $categories) { Enable-GuardrailField $guardrails.content.config $category }

    $phase = 'save guardrails'
    $body = @{ platform_settings = @{ guardrails = $guardrails } } | ConvertTo-Json -Depth 40 -Compress
    $null = Invoke-ElevenLabsJson 'PATCH' $agentUrl $body

    $phase = 'verify saved guardrails'
    $updated = Invoke-ElevenLabsJson 'GET' $agentUrl
    if (-not (Test-VerityVoiceAgent $updated) -or -not (Test-GuardrailsEnabled $updated.platform_settings.guardrails)) {
        throw [InvalidOperationException]::new('The saved configuration did not match the requested settings.')
    }
    Write-Host 'Verified Focus, Manipulation, and the four content filters are enabled.'
} catch {
    $status = $_.Exception.Data['SafeStatus']
    if ($null -ne $status) {
        $safeReason = $_.Exception.Data['SafeReason']
        Write-Host "Could not ${phase}. ElevenLabs returned HTTP $status ($safeReason)."
    } else {
        Write-Host "Could not ${phase}. The request or configuration could not be verified."
    }
    exit 1
} finally {
    if ($null -ne $client) { $client.Dispose() }
    if ($secretPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer) }
    $secret.Dispose()
    $value = $null
}
