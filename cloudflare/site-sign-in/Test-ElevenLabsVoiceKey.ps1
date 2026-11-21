$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http

$endpoint = 'https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=agent_9001m7x29v7kekz8wm2tek94vg2v&include_conversation_id=true'
$secret = Read-Host 'Paste the ElevenLabs Verity demo voice API key and press Enter' -AsSecureString
$secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
$handler = [System.Net.Http.HttpClientHandler]::new()
$handler.AllowAutoRedirect = $false
$client = [System.Net.Http.HttpClient]::new($handler)
$client.Timeout = [TimeSpan]::FromSeconds(15)
$request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, $endpoint)
$response = $null

try {
    $value = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer).Trim()
    if ($value -notmatch '^[A-Za-z0-9_-]{24,256}$' -or $value.StartsWith('key_')) {
        Write-Host 'The input does not look like an API key. Copy the secret value shown after creating the key.'
        return
    }
    $request.Headers.Add('xi-api-key', $value)
    $response = $client.SendAsync($request).GetAwaiter().GetResult()
    $status = [int]$response.StatusCode
    if ($response.IsSuccessStatusCode) {
        Write-Host 'ElevenLabs accepted this key for signed voice sessions. No call was started.'
        return
    }

    $reason = $null
    try { $reason = ($response.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json).detail.status } catch {}
    $knownReasons = @('invalid_api_key', 'missing_permissions', 'quota_exceeded', 'rate_limited', 'unauthorized')
    if ($knownReasons -ccontains $reason) {
        Write-Host "ElevenLabs returned HTTP $status ($reason)."
    } else {
        Write-Host "ElevenLabs returned HTTP $status."
    }
} catch {
    Write-Host 'The connection could not be verified. Check your network and try again.'
} finally {
    if ($null -ne $response) { $response.Dispose() }
    $request.Dispose()
    $client.Dispose()
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer)
    $secret.Dispose()
    $value = $null
}
