param(
  [int]$BackendPort = 18000,
  [int]$FrontendPort = 13000,
  [switch]$KeepRunning
)

$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$BackendDir = Join-Path $Root "backend"
$FrontendDir = Join-Path $Root "frontend"
$RunDir = Join-Path $Root ".remote-web-test"
$DbPath = Join-Path $RunDir "workspace_remote_test.db"
$BackendLog = Join-Path $RunDir "backend.log"
$BackendErrLog = Join-Path $RunDir "backend.err.log"
$FrontendLog = Join-Path $RunDir "frontend.log"
$FrontendErrLog = Join-Path $RunDir "frontend.err.log"
$ChromeProfile = Join-Path $RunDir "chrome-profile"
$ChromePort = 19225

function Stop-Port([int]$Port) {
  Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
}

function Wait-Url([string]$Url, [int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) { return }
    } catch {}
    Start-Sleep -Seconds 1
  }
  throw "Timed out waiting for $Url"
}

New-Item -ItemType Directory -Force -Path $RunDir | Out-Null
Remove-Item -LiteralPath $DbPath -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $ChromeProfile -Recurse -Force -ErrorAction SilentlyContinue

Stop-Port $BackendPort
Stop-Port $FrontendPort
Stop-Port $ChromePort

Write-Host "Starting remote-mode backend on :$BackendPort"
$backendArgs = @(
  "-NoProfile",
  "-Command",
  "cd '$BackendDir'; `$env:DATABASE_URL='sqlite:///$($DbPath.Replace('\','/'))'; `$env:CORS_ORIGINS='http://localhost:$FrontendPort'; `$env:WORKSPACE_CREATION_ENABLED='false'; `$env:WORKSPACE_DIRECTORY_ENABLED='false'; python local_server.py --host 127.0.0.1 --port $BackendPort"
)
$backend = Start-Process -FilePath "powershell" -ArgumentList $backendArgs -PassThru -RedirectStandardOutput $BackendLog -RedirectStandardError $BackendErrLog -WindowStyle Hidden

try {
  Wait-Url "http://127.0.0.1:$BackendPort/v1/agent-catalog" 60

  Write-Host "Seeding TestSpace through backend app internals"
  $seed = @"
import secrets
from app.database import SessionLocal
from app.models import Workspace, Channel
from datetime import datetime, timezone

db = SessionLocal()
slug = "remoteqa" + secrets.token_hex(2)
token = secrets.token_urlsafe(32)
now = datetime.now(timezone.utc)
ws = Workspace(slug=slug, name="RemoteQaSpace", password_hash=token, status="active", created_at=now, last_activity_at=now)
db.add(ws)
db.flush()
db.add(Channel(workspace_id=ws.id, name="session-remoteqa", title="Session 1", visibility="public", mention_policy="members_only", status="active", last_event_at=int(now.timestamp() * 1000)))
db.commit()
print(slug)
print(token)
db.close()
"@
  $seedOut = $seed | & powershell -NoProfile -Command "cd '$BackendDir'; `$env:DATABASE_URL='sqlite:///$($DbPath.Replace('\','/'))'; python -"
  $WorkspaceName = "RemoteQaSpace"
  $WorkspaceSlug = $seedOut[0].Trim()
  $WorkspaceToken = $seedOut[1].Trim()

  Write-Host "Starting remote-mode frontend on :$FrontendPort"
  $frontendArgs = @(
    "-NoProfile",
    "-Command",
    "cd '$FrontendDir'; `$env:NEXT_PUBLIC_API_URL='http://127.0.0.1:$BackendPort'; `$env:NEXT_PUBLIC_WORKSPACE_CREATION_ENABLED='false'; `$env:NEXT_PUBLIC_WORKSPACE_DIRECTORY_ENABLED='false'; npm run dev -- --port $FrontendPort"
  )
  $frontend = Start-Process -FilePath "powershell" -ArgumentList $frontendArgs -PassThru -RedirectStandardOutput $FrontendLog -RedirectStandardError $FrontendErrLog -WindowStyle Hidden
  Wait-Url "http://localhost:$FrontendPort" 90

  $Chrome = "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe"
  if (!(Test-Path $Chrome)) {
    $Chrome = "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
  }
  if (!(Test-Path $Chrome)) {
    throw "Chrome was not found; install Chrome or adjust this script."
  }
  Start-Process -FilePath $Chrome -ArgumentList @("--headless=new", "--disable-gpu", "--remote-debugging-port=$ChromePort", "--user-data-dir=$ChromeProfile", "about:blank") -WindowStyle Hidden
  Wait-Url "http://127.0.0.1:$ChromePort/json/version" 20

  $nodeScript = @"
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
async function page(){
  const target=await (await fetch('http://127.0.0.1:$ChromePort/json/new?about%3Ablank',{method:'PUT'})).json();
  const ws=new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res,rej)=>{ws.addEventListener('open',res,{once:true});ws.addEventListener('error',rej,{once:true})});
  let id=0,p=new Map();
  ws.addEventListener('message',ev=>{const m=JSON.parse(ev.data);if(m.id&&p.has(m.id)){const h=p.get(m.id);p.delete(m.id);m.error?h.reject(new Error(JSON.stringify(m.error))):h.resolve(m.result)}});
  const send=(method,params={})=>new Promise((resolve,reject)=>{const mid=++id;p.set(mid,{resolve,reject});ws.send(JSON.stringify({id:mid,method,params}))});
  await send('Runtime.enable'); await send('Page.enable'); await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  const ev=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value};
  const wait=async(pred,timeout=20000)=>{const s=Date.now();while(Date.now()-s<timeout){try{if(await ev('Boolean('+pred+')'))return true}catch{}await sleep(250)}throw new Error('timeout '+pred)};
  const nav=async url=>{await send('Page.navigate',{url});await wait('document.readyState === "complete" || document.readyState === "interactive"')};
  return {ev,wait,nav,close:()=>ws.close()};
}
async function fillAndOpen(pg, workspace, token){
  await pg.nav('http://localhost:$FrontendPort');
  await pg.wait("document.querySelector('#workspace-slug') && document.querySelector('#workspace-token')");
  const expression = "(()=>{const slug=document.querySelector('#workspace-slug'); const tok=document.querySelector('#workspace-token'); const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(slug," + JSON.stringify(workspace) + "); slug.dispatchEvent(new Event('input',{bubbles:true})); set.call(tok," + JSON.stringify(token) + "); tok.dispatchEvent(new Event('input',{bubbles:true})); tok.closest('form').querySelector('button[type=\"submit\"]').click();})()";
  await pg.ev(expression);
}
const pg=await page();
try {
  await fillAndOpen(pg, '$WorkspaceName', 'wrong-token');
  await pg.wait("document.body.innerText.includes('token/password')");
  const wrong = await pg.ev("document.body.innerText");

  await fillAndOpen(pg, '$WorkspaceName', '$WorkspaceToken');
  await pg.wait("location.pathname.includes('/$WorkspaceSlug')");
  await pg.wait("document.body.innerText.includes('$WorkspaceName')");
  const ok = await pg.ev("({href: location.href, text: document.body.innerText.slice(0, 800)})");

  if (!wrong.includes('token/password')) throw new Error('wrong token did not show explicit error: '+wrong.slice(0,300));
  if (!ok.href.includes('/$WorkspaceSlug')) throw new Error('valid login did not route to slug: '+JSON.stringify(ok));
  if (!ok.text.includes('$WorkspaceName')) throw new Error('valid login did not load workspace: '+JSON.stringify(ok));
  console.log(JSON.stringify({ok:true, workspace:'$WorkspaceName', slug:'$WorkspaceSlug', backendPort:$BackendPort, frontendPort:$FrontendPort}));
} finally {
  pg.close();
}
"@
  $nodeScript | node -
  if ($LASTEXITCODE -ne 0) {
    throw "Remote-mode browser smoke failed"
  }

  Write-Host "Remote-mode Web smoke passed."
  Write-Host "Backend log:  $BackendLog"
  Write-Host "Backend err:  $BackendErrLog"
  Write-Host "Frontend log: $FrontendLog"
  Write-Host "Frontend err: $FrontendErrLog"
} finally {
  if (!$KeepRunning) {
    if ($frontend -and !$frontend.HasExited) { Stop-Process -Id $frontend.Id -Force -ErrorAction SilentlyContinue }
    if ($backend -and !$backend.HasExited) { Stop-Process -Id $backend.Id -Force -ErrorAction SilentlyContinue }
    Stop-Port $FrontendPort
    Stop-Port $BackendPort
    Stop-Port $ChromePort
  } else {
    Write-Host "Kept services running: backend :$BackendPort, frontend :$FrontendPort"
  }
}
