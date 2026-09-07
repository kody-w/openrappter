$ErrorActionPreference = "Stop"
if (-not $IsWindows) { throw "Storage acceptance requires native Windows." }

$root = Join-Path $env:GITHUB_WORKSPACE ".windows-storage-tests"
$testHome = Join-Path $root "home"
$temporary = Join-Path $root "tmp"
New-Item -ItemType Directory -Force -Path $testHome, $temporary | Out-Null
@{
    HOME = $testHome
    USERPROFILE = $testHome
    OPENRAPPTER_HOME = (Join-Path $testHome ".openrappter")
    TMPDIR = $temporary
    TEMP = $temporary
    TMP = $temporary
    PYTHONDONTWRITEBYTECODE = "1"
    TSX_DISABLE_CACHE = "1"
}.GetEnumerator() | ForEach-Object {
    "$($_.Key)=$($_.Value)" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
}

node -e "if(process.platform!=='win32')throw Error('Native Windows Node required')"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
python -c "import sqlite3,sys; assert sys.platform=='win32'; print('Native Windows Python SQLite',sqlite3.sqlite_version)"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$env:STORAGE_PROBE_DIR = $temporary
node -e "const fs=require('node:fs'),p=require('node:path');const root=fs.mkdtempSync(p.join(process.env.STORAGE_PROBE_DIR,'links-'));try{const file=p.join(root,'file');fs.writeFileSync(file,'probe');fs.symlinkSync(file,p.join(root,'link'),'file');fs.symlinkSync(root,p.join(root,'junction'),'junction');if(fs.readFileSync(p.join(root,'link'),'utf8')!=='probe')throw Error('File symlink prerequisite failed');console.log('Native file symlink and junction prerequisites available')}finally{fs.rmSync(root,{recursive:true,force:true})}"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
