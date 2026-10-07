# Vercel 배포 스크립트 — deploy.bat 에서 실행됩니다
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Set-Location -LiteralPath $PSScriptRoot
function Say($t, $c = 'Gray') { Write-Host $t -ForegroundColor $c }
function Vc { & npx --yes vercel@latest @args }

Say ''
Say '=== AI × 현업 장표 Vercel 배포 ===' 'Green'
if (-not (Get-Command npx -ErrorAction SilentlyContinue)) { Say 'Node.js 가 필요합니다. https://nodejs.org 에서 설치 후 다시 실행하세요.' 'Red'; exit 1 }

# 1) 로그인 + 프로젝트 연결 (처음 한 번만 브라우저 로그인 창이 뜹니다)
Say ''
Say '[1/4] Vercel 로그인과 프로젝트 연결' 'Cyan'
$auth = Join-Path $env:APPDATA 'com.vercel.cli\Data\auth.json'
if (-not (Test-Path $auth)) { Vc login }
if (-not (Test-Path '.vercel\project.json')) { Vc link --yes --project ai-vibecoding-keynote }

# 2) 발표자 키 (휴대폰 쪽에서 장표를 조작하지 못하게 막는 비밀번호)
Say ''
Say '[2/4] 발표자 키 설정' 'Cyan'
$keyFile = Join-Path $PSScriptRoot 'presenter-key.txt'
if (Test-Path $keyFile) { $key = (Get-Content -LiteralPath $keyFile -Raw).Trim(); Say '  기존 발표자 키를 사용합니다.' }
else { $key = -join ((48..57) + (97..122) | Get-Random -Count 12 | ForEach-Object { [char]$_ }); Set-Content -LiteralPath $keyFile -Value $key -Encoding ASCII; Say '  발표자 키를 새로 만들었습니다.' }
$hash = -join ([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($key)) | ForEach-Object { $_.ToString('x2') })
Set-Content -LiteralPath (Join-Path $PSScriptRoot 'api\_key.js') -Value "module.exports = '$hash';" -Encoding ASCII

# 3) 실시간 저장소(Upstash Redis) 연결 확인
Say ''
Say '[3/4] 실시간 저장소 확인' 'Cyan'
$envList = (Vc env ls production 2>&1 | Out-String)
if ($envList -notmatch 'KV_REST_API_URL|UPSTASH_REDIS_REST_URL') {
  Say '  워드 클라우드·투표·퀴즈용 무료 저장소를 한 번만 연결해야 합니다.' 'Yellow'
  Say '  지금 열리는 Vercel 화면에서:' 'Yellow'
  Say '    프로젝트 ai-vibecoding-keynote 선택 > Storage 탭 > Create Database > Upstash (Redis) > 무료 플랜 > Connect' 'Yellow'
  Start-Process 'https://vercel.com/dashboard/stores'
  Read-Host '  연결을 마쳤으면 Enter'
}

# 4) 배포
Say ''
Say '[4/4] 배포 중... (1~2분)' 'Cyan'
$out = (Vc deploy --prod --yes 2>&1 | ForEach-Object { "$_" })
if ($LASTEXITCODE -ne 0) { $out | Select-Object -Last 15 | ForEach-Object { Say $_ 'Red' }; Say '배포에 실패했습니다. 위 메시지를 확인하세요.' 'Red'; exit 1 }
$urls = @($out | ForEach-Object { [regex]::Matches($_, 'https://[a-z0-9.-]+\.vercel\.app') | ForEach-Object { $_.Value } })
if ($urls.Count -gt 0) {
  $ins = (Vc inspect ($urls | Select-Object -Last 1) 2>&1 | ForEach-Object { "$_" })
  $urls += @($ins | ForEach-Object { [regex]::Matches($_, 'https://[a-z0-9.-]+\.vercel\.app') | ForEach-Object { $_.Value } })
}
$alias = ($urls | Sort-Object Length | Select-Object -First 1)
if (-not $alias) { Say '배포 주소를 찾지 못했습니다. Vercel 대시보드에서 Domains 를 확인하세요.' 'Red'; exit 1 }

$presenter = "$alias/?key=$key"
@(
  "발표자 주소 (이 주소로 장표를 여세요. 외부에 공유 금지):",
  $presenter,
  "",
  "공유용 주소 (장표만 보기, 조작 불가):",
  $alias,
  "",
  "수강생 참여 주소 (장표의 QR과 같음):",
  "$alias/live"
) | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'presenter-url.txt') -Encoding UTF8

Say ''
Say '=== 배포 완료 ===' 'Green'
Say "발표자 주소 : $presenter" 'White'
Say "공유용 주소 : $alias"
Say "수강생 참여 : $alias/live"
Say '(같은 내용이 presenter-url.txt 에 저장됐습니다)'
Start-Process $presenter
