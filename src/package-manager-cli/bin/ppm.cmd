@echo off
setlocal
set "DIR=%~dp0"

rem Channel name inferred from the script basename: ppm.cmd -> Pulsar.exe, ppm-next.cmd -> PulsarNext.exe.
if /I "%~n0"=="ppm-next" (
  set "EXE=PulsarNext.exe"
) else (
  set "EXE=Pulsar.exe"
)

rem `%DIR%` ends with `\resources\app\ppm\bin\`; Pulsar.exe lives four directories up.
set "PULSAR=%DIR%..\..\..\..\%EXE%"
if not exist "%PULSAR%" (
  echo ppm: cannot locate %EXE% at %PULSAR% 1>&2
  exit /b 1
)

"%PULSAR%" -p %*
exit /b %ERRORLEVEL%
