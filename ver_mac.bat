@echo off
setlocal enabledelayedexpansion
echo.
echo ============================================================
echo   DIRECCION MAC E IP DEL EQUIPO
echo ============================================================
echo.
echo [Detalle de adaptadores]
echo.
getmac /v /fo list
echo.
echo ============================================================
echo   MAC ACTIVA
echo ============================================================
echo.
for /f "usebackq delims=" %%A in (`powershell -NoProfile -Command "Get-NetAdapter | Where-Object {$_.Status -eq 'Up' -and $_.MacAddress -ne ''} | Select-Object -First 1 -ExpandProperty MacAddress | ForEach-Object {$_ -replace '-',':'}"`) do (
    echo %%A
)
:ipblock
echo.
echo ============================================================
echo   IP PUBLICA
echo ============================================================
echo.
curl -s https://api.ipify.org
echo.
echo.
echo ============================================================
echo   IP LOCAL
echo ============================================================
echo.
ipconfig | findstr /i IPv4
echo.
pause
