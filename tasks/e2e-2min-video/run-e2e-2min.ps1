# E2E: ~2min episode full production (novel gates + batch to final.mp4)
# ASCII-only comments to avoid PS5.1 BOM/GBK issues.
# Usage: powershell -ExecutionPolicy Bypass -File tasks\e2e-2min-video\run-e2e-2min.ps1
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$base = 'http://localhost:3003/api'
$hdr = @{ Authorization = 'Bearer mock_test_u10001' }
$novelPath = Join-Path $PSScriptRoot '..\e2e-novel-pipeline\novel.txt'
$novel = [System.IO.File]::ReadAllText((Resolve-Path $novelPath), [System.Text.UTF8Encoding]::new($false))
$epTargetSec = 120
$batchBudget = 4000
# Full chain: design + script + ~12 shots video + compose. Allow long poll.
$pollTimeoutMin = 45

function J($o) { $o | ConvertTo-Json -Depth 8 -Compress }
# 2026-09-24:分步耗时(之前 STEP8 的 "spent~" 是写死的字面量,从没算过)
$script:t0 = Get-Date
function Elapsed() {
    $s = [int]((Get-Date) - $script:t0).TotalSeconds
    return ('{0:D2}:{1:D2}:{2:D2}' -f [int]($s / 3600), [int](($s % 3600) / 60), ($s % 60))
}
function PostJson($url, $obj) {
    $body = [System.Text.UTF8Encoding]::new($false).GetBytes((J $obj))
    Invoke-RestMethod -Method Post -Uri $url -Headers $hdr -ContentType 'application/json; charset=utf-8' -Body $body
}
function Unwrap($r) { if ($r.PSObject.Properties['data']) { $r.data } else { $r } }

Write-Output "STEP0 create drama [$(Elapsed)]"
$r = Unwrap (PostJson "$base/dramas" @{ title = 'E2E 2min quality'; topic = 'novel-to-drama'; storyMode = 'serial' })
$uuid = $r.uuid
Write-Output "  uuid=$uuid"

Write-Output "STEP1 ingest novel epTargetSec=$epTargetSec [$(Elapsed)]"
$r = Unwrap (PostJson "$base/dramas/$uuid/novel/ingest" @{ novelText = $novel; title = 'E2E 2min quality'; source = 'uploaded'; epTargetSec = $epTargetSec })
$eps = $r.episodeCount
$g1 = ($r.gates | Where-Object { $_.gate -eq 'gate1_budget' })
Write-Output "  episodes=$eps gate1=$($g1.status)"

# repack (beats/装箱重算报价) runs async after ingest — decide returns 409 until ready.
function PostJsonRetry($url, $obj, $attempts, $sleepSec) {
    for ($i = 1; $i -le $attempts; $i++) {
        try { return PostJson $url $obj }
        catch {
            $resp = $_.Exception.Response
            if ($resp -and [int]$resp.StatusCode -eq 409 -and $i -lt $attempts) {
                Write-Output ("  409 repack not ready, retry {0}/{1} in {2}s" -f $i, $attempts, $sleepSec)
                Start-Sleep -Seconds $sleepSec
                continue
            }
            throw
        }
    }
}

Write-Output "STEP2 pass gate1 (retry on 409 repack) [$(Elapsed)]"
$r = Unwrap (PostJsonRetry "$base/dramas/$uuid/novel/gates/gate1_budget/decide" @{ decision = 'passed' } 40 8)
Write-Output "  gate1 passed"

Write-Output "STEP3 poll gate2 design (max 6 min) [$(Elapsed)]"
$deadline = (Get-Date).AddMinutes(6)
$state = ''
$g2 = $null
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 6
    $l = Unwrap (Invoke-RestMethod -Uri "$base/dramas/$uuid/novel/ledger" -Headers $hdr)
    $g2 = ($l.gates | Where-Object { $_.gate -eq 'gate2_design' })
    $state = $g2.payload.state
    Write-Output ("  gate2 state={0} chars={1}" -f $state, $g2.payload.characters.Count)
    if ($state -eq 'ready' -or $state -eq 'failed') { break }
}
if ($state -ne 'ready') { Write-Output "FAIL gate2 state=$state err=$($g2.payload.error)"; exit 1 }
Write-Output "  design ready: characters=$(($g2.payload.characters | ForEach-Object { $_.name }) -join ',')"

Write-Output "STEP4 pass gate2"
Unwrap (PostJson "$base/dramas/$uuid/novel/gates/gate2_design/decide" @{ decision = 'passed' }) | Out-Null

Write-Output "STEP5 poll gate3 script (max 8 min) [$(Elapsed)]"
$deadline = (Get-Date).AddMinutes(8)
$state = ''
$g3 = $null
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 8
    $l = Unwrap (Invoke-RestMethod -Uri "$base/dramas/$uuid/novel/ledger" -Headers $hdr)
    $g3 = ($l.gates | Where-Object { $_.gate -eq 'gate3_script' })
    $state = $g3.payload.state
    Write-Output ("  gate3 state={0} done={1}/{2}" -f $state, $g3.payload.episodesDone, $g3.payload.episodesTotal)
    if ($state -eq 'ready' -or $state -eq 'failed') { break }
}
if ($state -ne 'ready') { Write-Output "FAIL gate3 state=$state err=$($g3.payload.error)"; exit 1 }
Write-Output "  script ready eps=$($g3.payload.episodes.Count)"

Write-Output "STEP6 pass gate3 -> production batch [$(Elapsed)]"
Unwrap (PostJson "$base/dramas/$uuid/novel/gates/gate3_script/decide" @{ decision = 'passed' }) | Out-Null

Write-Output "STEP7 wait for producing batch + policy.epTargetSec"
$deadline = (Get-Date).AddMinutes(3)
$batchUuid = ''
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 5
    $l = Unwrap (Invoke-RestMethod -Uri "$base/dramas/$uuid/novel/ledger" -Headers $hdr)
    $g3 = ($l.gates | Where-Object { $_.gate -eq 'gate3_script' })
    if ($g3.payload.state -eq 'producing' -and $g3.payload.batchUuid) {
        $batchUuid = $g3.payload.batchUuid
        break
    }
    if ($g3.payload.state -eq 'failed') { Write-Output "FAIL producing err=$($g3.payload.error)"; exit 1 }
    Write-Output "  waiting batch... state=$($g3.payload.state)"
}
if (-not $batchUuid) {
    # fallback: list drama batches
    $bs = Unwrap (Invoke-RestMethod -Uri "$base/dramas/$uuid/batches" -Headers $hdr)
    if (@($bs).Count -gt 0) { $batchUuid = @($bs)[-1].uuid }
}
if (-not $batchUuid) { Write-Output "FAIL no batch"; exit 1 }
$b = Unwrap (Invoke-RestMethod -Uri "$base/dramas/batches/$batchUuid" -Headers $hdr)
$storedEp = $b.policy.epTargetSec
Write-Output "  batch=$batchUuid status=$($b.status) policy.epTargetSec=$storedEp (expect $epTargetSec)"
if ($storedEp -ne $epTargetSec) { Write-Output "WARN policy.epTargetSec not persisted (got '$storedEp')" }

Write-Output "STEP8 poll batch until done/failed (max $pollTimeoutMin min)"
$deadline = (Get-Date).AddMinutes($pollTimeoutMin)
$final = ''
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 12
    $b = Unwrap (Invoke-RestMethod -Uri "$base/dramas/batches/$batchUuid" -Headers $hdr)
    $last = ($b.log | Select-Object -Last 1)
    Write-Output ("  [{0}] status={1} cursor=EP{2}/step{3} last={4}" -f (Elapsed), $b.status, $b.cursorEp, $b.cursorStep, $last.msg)
    if ($b.status -in @('done', 'failed', 'cancelled')) { $final = $b.status; break }
}
if (-not $final) { Write-Output "FAIL batch timeout"; exit 1 }
Write-Output "  batch final=$final"

Write-Output "STEP9 episode + ffprobe"
$epsOut = Unwrap (Invoke-RestMethod -Uri "$base/dramas/$uuid/episodes" -Headers $hdr)
$ep = $epsOut | Sort-Object epNo | Select-Object -First 1
Write-Output "  epNo=$($ep.epNo) status=$($ep.status) final=$($ep.finalUrl) durationSec=$($ep.durationSec) shots=$($ep.shotCount) step=$($ep.step)"
$step5 = $ep.stepData.'5'.output
if ($step5) {
    Write-Output ("  step5 planned={0} composed={1} duration={2}" -f $step5.planned_shots, $step5.composed_shots, $step5.duration_sec)
}
$local = $null
if ($ep.finalUrl -and $ep.finalUrl.StartsWith('/uploads/')) {
    $local = Join-Path 'D:\ai369\agentshop-minmax3\backend' ($ep.finalUrl -replace '/', '\')
}
if ($local -and (Test-Path $local)) {
    $fi = Get-Item $local
    Write-Output "  file=$($fi.FullName) bytes=$($fi.Length)"
    $probe = & ffprobe -v error -show_entries format=duration -show_entries stream=codec_name,width,height -of default=noprint_wrappers=1 $local 2>&1
    Write-Output "  ffprobe:`n$($probe -join "`n")"
} else {
    Write-Output "  local file missing: $local"
}

$ok = ($final -eq 'done')
$durOk = $false
if ($ep.durationSec) { $durOk = ([double]$ep.durationSec -ge 90) }
if ($ok -and $durOk) {
    Write-Output "PASS drama=$uuid batch=$batchUuid durationSec=$($ep.durationSec) total=$(Elapsed)"
    Write-Output "NOTE: drama kept for manual review (not deleted)"
    exit 0
} else {
    Write-Output "FAIL final=$final durationSec=$($ep.durationSec) total=$(Elapsed)"
    exit 1
}
