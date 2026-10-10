@echo off
chcp 65001 >nul
title Dong bo cham an - Truong Ngoi Sao Hoang Mai
cd /d "%~dp0"

REM Task Scheduler goi kem --quiet: cua so chay an nen khong ai doc duoc man
REM hinh, vi vay ghi toan bo ket qua vao dong-bo.log canh file nay, va khong
REM dung lai cho bam phim.
echo %* | find "--quiet" >nul
if errorlevel 1 goto chay_tay

REM Log qua 5 MB thi doi ten thanh dong-bo.old.log (giu mot ban cu), tranh
REM file lon dan mai sau nhieu nam chay moi ngay.
if exist "%~dp0dong-bo.log" for %%F in ("%~dp0dong-bo.log") do if %%~zF GTR 5000000 move /y "%%~fF" "%~dp0dong-bo.old.log" >nul

>>"%~dp0dong-bo.log" echo.
>>"%~dp0dong-bo.log" echo ===== %date% %time% ===== tham so: %*
node sync-checkins.mjs %* >>"%~dp0dong-bo.log" 2>&1
set "RC=%errorlevel%"
>>"%~dp0dong-bo.log" echo ===== ket thuc, ma thoat %RC% =====

REM Tra lai dung ma thoat cua node de Task Scheduler hien "Last Run Result"
REM khac 0 khi co may loi: 0 = on, 1 = co may loi, 2 = loi o pha canh bao.
exit /b %RC%

:chay_tay
node sync-checkins.mjs %*
set "RC=%errorlevel%"

REM Chay tay (bam dup) thi dung lai de doc ket qua.
echo.
pause
exit /b %RC%
