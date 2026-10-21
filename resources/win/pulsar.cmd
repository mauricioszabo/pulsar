@echo off

SET EXPECT_OUTPUT=
SET WAIT=
SET PSARGS=%*
SET ELECTRON_ENABLE_LOGGING=
SET ATOM_ADD=
SET ATOM_CHANNEL=
SET ATOM_NEW_WINDOW=
SET PACKAGE_MODE=

FOR %%a IN (%*) DO (
  IF /I "%%a"=="-f"                         SET EXPECT_OUTPUT=YES
  IF /I "%%a"=="--foreground"               SET EXPECT_OUTPUT=YES
  IF /I "%%a"=="-h"                         SET EXPECT_OUTPUT=YES
  IF /I "%%a"=="--help"                     SET EXPECT_OUTPUT=YES
  IF /I "%%a"=="-t"                         SET EXPECT_OUTPUT=YES
  IF /I "%%a"=="--test"                     SET EXPECT_OUTPUT=YES
  IF /I "%%a"=="--benchmark"                SET EXPECT_OUTPUT=YES
  IF /I "%%a"=="--benchmark-test"           SET EXPECT_OUTPUT=YES
  IF /I "%%a"=="-v"                         SET EXPECT_OUTPUT=YES
  IF /I "%%a"=="--version"                  SET EXPECT_OUTPUT=YES
  IF /I "%%a"=="--enable-electron-logging"  SET ELECTRON_ENABLE_LOGGING=YES
  IF /I "%%a"=="-a"                         SET ATOM_ADD=YES
  IF /I "%%a"=="--add"                      SET ATOM_ADD=YES
  IF /I "%%a"=="-n"                         SET ATOM_NEW_WINDOW=YES
  IF /I "%%a"=="--new-window"               SET ATOM_NEW_WINDOW=YES
  IF /I "%%a"=="-p" (
    SET PACKAGE_MODE=YES
    SET EXPECT_OUTPUT=YES
  )
  IF /I "%%a"=="--package" (
    SET PACKAGE_MODE=YES
    SET EXPECT_OUTPUT=YES
  )
  IF /I "%%a"=="-w"           (
    SET EXPECT_OUTPUT=YES
    SET WAIT=YES
  )
  IF /I "%%a"=="--wait"       (
    SET EXPECT_OUTPUT=YES
    SET WAIT=YES
  )
)

set EXE_NAME=
set ATOM_CHANNEL=

REM Use the name of the executable to infer a release channel.
set ATOM_BASE_NAME=%~n0

if "%ATOM_BASE_NAME%"=="pulsar-next" (
  set ATOM_CHANNEL=next
  set EXE_NAME=PulsarNext
)

if "%ATOM_BASE_NAME%"=="pulsar" (
  set ATOM_CHANNEL=stable
  set EXE_NAME=Pulsar
)

IF "%ATOM_ADD%"=="YES" (
  IF "%ATOM_NEW_WINDOW%"=="YES" (
    SET EXPECT_OUTPUT=YES
  )
)

REM Package mode and other "expect output" cases run Pulsar in the foreground
REM so stdio is inherited. The in-process package-manager handles `-p` itself.
IF "%EXPECT_OUTPUT%"=="YES" (
  IF "%WAIT%"=="YES" (
    powershell -noexit "Start-Process -FilePath \"%~dp0\..\%EXE_NAME%.exe\" -ArgumentList \"--pid=$pid $env:PSARGS\" ; wait-event"
    exit 0
  ) ELSE (
    "%~dp0\..\%EXE_NAME%.exe" %*
  )
) ELSE (
  start "" "%~dp0\..\%EXE_NAME%.exe" %*
)
