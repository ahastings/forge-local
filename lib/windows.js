import { spawn } from 'node:child_process';
import { MAX_COMMAND_CHARS } from '../public/input-limits.js';

export const powershell = process.platform === 'win32' ? `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : 'pwsh';
export function cleanEnv() {
  const safe = /^(?:PATH|PATHEXT|SystemRoot|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMFILES(?:\(X86\))?|PROGRAMDATA|HOMEDRIVE|HOMEPATH|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|OS|PSModulePath|TERM|COLORTERM)$/i;
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => safe.test(name)));
  // Windows PowerShell must not import PowerShell 7 modules inherited from its parent.
  if (process.platform === 'win32') env.PSModulePath = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\Modules;${process.env.ProgramFiles || 'C:\\Program Files'}\\WindowsPowerShell\\Modules`;
  return env;
}
export function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => child.kill());
    killer.on('close', code => { if (code !== 0 && child.exitCode === null) child.kill(); });
  } else child.kill('SIGKILL');
}
export function runShell(command, { cwd, signal, onOutput = () => {}, timeout = 120_000 } = {}) {
  if (typeof command !== 'string' || !command.trim() || command.length > MAX_COMMAND_CHARS) throw new Error(`Enter a PowerShell command of at most ${MAX_COMMAND_CHARS.toLocaleString('en-US')} characters.`);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Stopped.'));
    // Feed source through stdin: no command interpolation, profile, or persistent policy changes.
    const prefix = "$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); $ErrorActionPreference='Stop';\n";
    const runner = "$code=[Console]::In.ReadToEnd(); try { & ([ScriptBlock]::Create($code)); $forgeSuccess=$?; if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; if (-not $forgeSuccess) { exit 1 } } catch { [Console]::Error.WriteLine(($_ | Out-String)); exit 1 }";
    const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', runner], { cwd, env: cleanEnv(), windowsHide: true, stdio: ['pipe','pipe','pipe'] });
    let output = '', timedOut = false, truncated = false;
    const take = (chunk, stream) => {
      const text = chunk.toString('utf8');
      if (output.length < 60_000) { const clipped = text.slice(0, 60_000-output.length); output += clipped; onOutput({ text: clipped, stream }); }
      else truncated = true;
    };
    child.stdout.on('data', chunk => take(chunk, 'stdout')); child.stderr.on('data', chunk => take(chunk, 'stderr'));
    const abort = () => stopProcess(child);
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; stopProcess(child); }, timeout);
    child.on('error', error => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(error); });
    child.on('close', code => { clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve({ exitCode: code, output: output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''), timedOut, stopped: !!signal?.aborted, truncated }); });
    child.stdin.on('error', () => {});
    child.stdin.end(prefix + command + '\n');
  });
}
export function dpapi(value, decrypt = false) {
  if (process.platform !== 'win32') throw new Error('Encrypted key storage requires Windows. Use OPENAI_API_KEY on other systems.');
  const script = decrypt
    ? "$s = [Console]::In.ReadToEnd() | ConvertTo-SecureString; $p = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); try { [Console]::Write([System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($p)) } finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p) }"
    : "$s = [Console]::In.ReadToEnd() | ConvertTo-SecureString -AsPlainText -Force; [Console]::Write(($s | ConvertFrom-SecureString))";
  return new Promise((resolve,reject) => {
    const child = spawn(powershell, ['-NoLogo','-NoProfile','-NonInteractive','-Command',script], { windowsHide:true, env:cleanEnv(), stdio:['pipe','pipe','pipe'] });
    let out = ''; child.stdout.on('data', b => out += b); child.stderr.resume();
    child.on('error', reject); child.on('close', code => code === 0 && out ? resolve(out.trim()) : reject(new Error('Windows could not protect or unlock the key for this account.')));
    child.stdin.end(value);
  });
}
export function browseFolder() {
  return new Promise((resolve,reject) => {
    const script = "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Choose a project folder for Local API Dev Lab'; $d.ShowNewFolderButton = $true; if ($d.ShowDialog() -eq 'OK') { [Console]::Write($d.SelectedPath) }; $d.Dispose()";
    const child = spawn(powershell, ['-NoLogo','-NoProfile','-STA','-Command',script], { windowsHide:true, stdio:['ignore','pipe','pipe'] });
    let out = ''; child.stdout.on('data',b => out += b); child.stderr.resume(); child.on('error', reject);
    const timer = setTimeout(() => stopProcess(child), 180_000);
    child.on('close', () => { clearTimeout(timer); resolve({ path:out.trim() }); });
  });
}
